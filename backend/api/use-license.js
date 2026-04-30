// api/use-license.js
// ライセンスの使用回数を1増やす（月次自動リセット付き）

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // CORS設定（Chrome拡張機能から呼べるようにする）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, license_key } = req.body;

  if (!email || !license_key) {
    return res.status(400).json({ error: 'メールアドレスとライセンスキーが必要です' });
  }

  try {
    // ライセンスを取得
    const { data: license, error: fetchError } = await supabase
      .from('licenses')
      .select('*')
      .eq('email', email)
      .eq('license_key', license_key)
      .eq('active', true)
      .single();

    if (fetchError || !license) {
      return res.status(404).json({ error: 'ライセンスが見つからないか、無効です' });
    }

    // 有効期限チェック
    if (license.expires_at && new Date(license.expires_at) < new Date()) {
      return res.status(403).json({ error: 'ライセンスの有効期限が切れています' });
    }

    // 月次リセット判定：前回リセットから1ヶ月以上経過しているか
    const now = new Date();
    const resetAt = new Date(license.monthly_reset_at);
    const isSameMonth =
      now.getFullYear() === resetAt.getFullYear() &&
      now.getMonth() === resetAt.getMonth();

    let currentCount = license.monthly_count || 0;
    let resetTimestamp = license.monthly_reset_at;

    // 月が変わっていたらリセット
    if (!isSameMonth) {
      currentCount = 0;
      resetTimestamp = now.toISOString();
    }

    // 上限チェック
    const limit = license.monthly_limit || 500;
    if (currentCount >= limit) {
      return res.status(429).json({
        error: `今月の利用上限（${limit}回）に達しました`,
        monthly_count: currentCount,
        monthly_limit: limit,
        reset_at: resetTimestamp
      });
    }

    // カウントを1増やす
    const newCount = currentCount + 1;

    const { error: updateError } = await supabase
      .from('licenses')
      .update({
        monthly_count: newCount,
        monthly_reset_at: resetTimestamp
      })
      .eq('id', license.id);

    if (updateError) {
      console.error('Update error:', updateError);
      return res.status(500).json({ error: 'カウント更新に失敗しました' });
    }

    return res.status(200).json({
      success: true,
      monthly_count: newCount,
      monthly_limit: limit,
      remaining: limit - newCount,
      reset_at: resetTimestamp
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
