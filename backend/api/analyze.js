// backend/api/analyze.js
// AI解析エンドポイント（プラン別回数制限付き）

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ─── モデル自動追従 ───────────────────────────────────────
// Anthropic の Models API (GET /v1/models) から Sonnet系の最新モデルIDを取得して使う。
// これで新モデルが出ても自動で追従し、旧モデルが廃止されても手修正なしで切り替わる。
//   ・取得失敗時は MODEL_FALLBACKS を上から順に使用
//   ・呼び出し側で404を検知したら exclude を渡して取り直し→1回だけ再試行
//   ・サーバーレスのウォーム起動を活かしモジュールスコープで数時間キャッシュ
const MODEL_FAMILY    = 'sonnet'; // 'sonnet' / 'opus' / 'haiku'
const MODEL_FALLBACKS = ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-20250514']; // 新しい順
const MODEL_TTL_MS    = 6 * 60 * 60 * 1000; // キャッシュ6時間
let _modelCache = { id: null, ts: 0 };

async function fetchLatestModel(exclude = []) {
  const r = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    }
  });
  if (!r.ok) throw new Error('models API ' + r.status);
  const data = await r.json();
  const list = (data.data || [])
    .filter(m => m && typeof m.id === 'string' && m.id.includes(MODEL_FAMILY))
    .filter(m => !exclude.includes(m.id))
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  if (!list.length) throw new Error('該当モデルなし');
  return list[0].id;
}

async function resolveModel({ force = false, exclude = [] } = {}) {
  if (!force && exclude.length === 0 && _modelCache.id && (Date.now() - _modelCache.ts) < MODEL_TTL_MS) {
    return _modelCache.id;
  }
  try {
    const id = await fetchLatestModel(exclude);          // ① 最新を自動取得
    _modelCache = { id, ts: Date.now() };
    return id;
  } catch (e) {
    const fb = MODEL_FALLBACKS.find(x => !exclude.includes(x)) || MODEL_FALLBACKS[0]; // ② 保険
    _modelCache = { id: fb, ts: Date.now() };
    return fb;
  }
}

// プラン別月間上限回数
const PLAN_LIMITS = {
  'ライト':       100,
  'スタンダード': 200,
  'プロ':         300,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, licenseKey, fileData, fileType, fileName } = req.body || {};

  if (!email || !licenseKey || !fileData || !fileType) {
    return res.status(400).json({ error: '必要なパラメータが不足しています' });
  }

  try {
    // ─── ライセンス認証 ────────────────────────────────────
    const { data, error } = await supabase
      .from('licenses')
      .select('id, plan, expires_at, active, monthly_count, monthly_reset_at')
      .eq('email', email.toLowerCase())
      .eq('license_key', licenseKey.toUpperCase())
      .single();

    if (error || !data || !data.active) {
      return res.status(403).json({ reason: 'ライセンスが無効です' });
    }

    if (new Date(data.expires_at) < new Date()) {
      return res.status(403).json({ reason: 'ライセンスの有効期限が切れています' });
    }

    // ─── 月間リセット判定 ──────────────────────────────────
    const now = new Date();
    const resetAt = new Date(data.monthly_reset_at);
    const needsReset = now.getMonth() !== resetAt.getMonth() || now.getFullYear() !== resetAt.getFullYear();

    let currentCount = needsReset ? 0 : (data.monthly_count || 0);

    // ─── 回数上限チェック ──────────────────────────────────
    const limit = PLAN_LIMITS[data.plan] ?? 100;
    if (currentCount >= limit) {
      return res.status(429).json({
        error: `今月の転記回数（${limit}回）に達しました。プランをアップグレードするか、来月までお待ちください。`,
        currentCount,
        limit,
        plan: data.plan
      });
    }

    // ─── ファイルサイズ制限 ────────────────────────────────
    const approxBytes = fileData.length * 0.75;
    if (approxBytes > 20 * 1024 * 1024) {
      return res.status(400).json({ error: 'ファイルサイズが大きすぎます（最大20MB）' });
    }

    // ─── Anthropic API呼び出し ─────────────────────────────
    const contentBlock = fileType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }
      : { type: 'image',    source: { type: 'base64', media_type: fileType, data: fileData } };

    // モデルを自動解決（最新Sonnetへ自動追従）
    let model = await resolveModel();
    console.log('Using model:', model);

    const makeMessage = (model) => anthropic.messages.create({
      model,
      max_tokens: 8192,
      system: `あなたは建設・工事業者の見積書を解析するアシスタントです。
見積書から工事・材料の明細行を全ページ漏れなく抽出し、JSONのみを返してください。
説明文やコードブロック記号（\`\`\`など）は一切含めないでください。
複数ページにわたる場合も全ての明細を抽出してください。

形式:
[{"name":"項目名","note":"備考・型番など（なければ空文字）","quantity":数値,"unit":"単位","cost":原価数値,"price":単価数値}]

注意: 小計・合計・消費税・次頁へ続く等の行は除外。数値はカンマ・円マーク不要。単位不明なら式。原価不明ならpriceと同値。`,
      messages: [{
        role: 'user',
        content: [
          contentBlock,
          { type: 'text', text: 'この見積書の明細をすべて抽出してJSON形式で返してください。' }
        ]
      }]
    });

    let message;
    try {
      message = await makeMessage(model);
    } catch (err) {
      // モデル廃止/不明(404) → 最新を取り直して1回だけ再試行
      if (err && err.status === 404) {
        console.warn('モデル廃止検知:', model, '→ 最新を取得し直して再試行');
        model = await resolveModel({ force: true, exclude: [model] });
        console.log('再試行モデル:', model);
        message = await makeMessage(model);
      } else {
        throw err;
      }
    }

    const text  = (message.content || []).map(c => c.text || '').join('');
    const clean = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
    const start = clean.indexOf('[');
    const end   = clean.lastIndexOf(']');

    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'AI応答のパースに失敗しました' });
    }

    const items = JSON.parse(clean.substring(start, end + 1));

    // ─── 回数カウントアップ ────────────────────────────────
    await supabase
      .from('licenses')
      .update({
        monthly_count: currentCount + 1,
        monthly_reset_at: needsReset ? now.toISOString() : data.monthly_reset_at,
        last_used_at: now.toISOString()
      })
      .eq('id', data.id);

    // ─── 利用ログ ──────────────────────────────────────────
    await supabase.from('usage_logs').insert({
      license_id: data.id,
      email: email.toLowerCase(),
      file_name: fileName || 'unknown',
      input_tokens: message.usage?.input_tokens || 0,
      output_tokens: message.usage?.output_tokens || 0,
      item_count: items.length,
      created_at: now.toISOString()
    });

    return res.status(200).json({
      items,
      currentCount: currentCount + 1,
      limit,
      remaining: limit - (currentCount + 1)
    });

  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: 'AI解析中にエラーが発生しました: ' + err.message });
  }
}
