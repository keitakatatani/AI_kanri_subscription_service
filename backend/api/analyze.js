// backend/api/analyze.js
// AI解析エンドポイント（Anthropic APIを中継）
// POST { email, licenseKey, fileData, fileType, fileName } → { items }

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

export default async function handler(req, res) {
  // CORS
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

  // ─── ライセンス認証（毎回必ず確認）────────────────────────
  try {
    const { data, error } = await supabase
      .from('licenses')
      .select('id, plan, expires_at, active')
      .eq('email', email.toLowerCase())
      .eq('license_key', licenseKey.toUpperCase())
      .single();

    if (error || !data || !data.active) {
      return res.status(403).json({ reason: 'ライセンスが無効です' });
    }

    if (new Date(data.expires_at) < new Date()) {
      return res.status(403).json({ reason: 'ライセンスの有効期限が切れています。更新してください。' });
    }

    // ─── ファイルサイズ制限 ────────────────────────────────
    // base64文字数 × 0.75 ≈ バイト数
    const approxBytes = fileData.length * 0.75;
    const MAX_BYTES = 20 * 1024 * 1024; // 20MB
    if (approxBytes > MAX_BYTES) {
      return res.status(400).json({ error: 'ファイルサイズが大きすぎます（最大20MB）' });
    }

    // ─── Anthropic API呼び出し ─────────────────────────────
    const contentBlock = fileType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }
      : { type: 'image',    source: { type: 'base64', media_type: fileType, data: fileData } };

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
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

    // レスポンス解析
    const text  = (message.content || []).map(c => c.text || '').join('');
    const clean = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
    const start = clean.indexOf('[');
    const end   = clean.lastIndexOf(']');

    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'AI応答のパースに失敗しました' });
    }

    const items = JSON.parse(clean.substring(start, end + 1));

    // 利用ログを記録
    await supabase.from('usage_logs').insert({
      license_id: data.id,
      email: email.toLowerCase(),
      file_name: fileName || 'unknown',
      input_tokens: message.usage?.input_tokens || 0,
      output_tokens: message.usage?.output_tokens || 0,
      item_count: items.length,
      created_at: new Date().toISOString()
    });

    return res.status(200).json({ items });

  } catch (err) {
    console.error('Analyze error:', err);
    if (err.status === 401) {
      return res.status(500).json({ error: 'サーバー設定エラー（APIキー）' });
    }
    return res.status(500).json({ error: 'AI解析中にエラーが発生しました: ' + err.message });
  }
}
