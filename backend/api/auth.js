// backend/api/auth.js
// ライセンス認証エンドポイント
// POST { email, licenseKey } → { valid, plan, expiresAt, reason }

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service_role（認証スキップ）
);

export default async function handler(req, res) {
  // CORS（Chrome拡張からのリクエストを許可）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false, reason: 'Method Not Allowed' });
  }

  const { email, licenseKey } = req.body || {};

  if (!email || !licenseKey) {
    return res.status(400).json({ valid: false, reason: 'メールアドレスとライセンスキーが必要です' });
  }

  try {
    // licensesテーブルを検索
    const { data, error } = await supabase
      .from('licenses')
.select('id, email, license_key, plan, expires_at, active, monthly_count, monthly_limit, monthly_reset_at')
      .eq('email', email.toLowerCase())
      .eq('license_key', licenseKey.toUpperCase())
      .single();

    if (error || !data) {
      return res.status(200).json({
        valid: false,
        reason: 'メールアドレスまたはライセンスキーが正しくありません'
      });
    }

    // 無効化フラグチェック
    if (!data.active) {
      return res.status(200).json({
        valid: false,
        reason: 'このライセンスは無効化されています'
      });
    }

    // 有効期限チェック
    const expiresAt = new Date(data.expires_at);
    const now = new Date();
    if (expiresAt < now) {
      return res.status(200).json({
        valid: false,
        reason: `ライセンスの有効期限が切れています（${expiresAt.toLocaleDateString('ja-JP')}）`,
        expiresAt: data.expires_at,
        plan: data.plan
      });
    }

    // 最終ログイン日時を更新
    await supabase
      .from('licenses')
      .update({ last_used_at: now.toISOString() })
      .eq('id', data.id);

    return res.status(200).json({
      valid: true,
      plan: data.plan,
      expiresAt: data.expires_at,
      monthly_count: data.monthly_count || 0,
      monthly_limit: data.monthly_limit || 0,
      monthly_reset_at: data.monthly_reset_at
    });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ valid: false, reason: 'サーバーエラーが発生しました' });
  }
}
