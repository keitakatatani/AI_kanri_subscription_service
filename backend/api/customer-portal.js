// api/customer-portal.js
// Stripeカスタマーポータルへのリダイレクトリンクを生成

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, licenseKey } = req.body || {};

  if (!email || !licenseKey) {
    return res.status(400).json({ error: 'メールアドレスとライセンスキーが必要です' });
  }

  try {
    // ライセンス認証
    const { data, error } = await supabase
      .from('licenses')
      .select('stripe_customer_id')
      .eq('email', email.toLowerCase())
      .eq('license_key', licenseKey.toUpperCase())
      .single();

    if (error || !data) {
      return res.status(403).json({ error: 'ライセンスが無効です' });
    }

    if (!data.stripe_customer_id) {
      return res.status(400).json({ error: 'Stripe顧客情報が見つかりません' });
    }

    // カスタマーポータルセッションを作成
    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: 'https://project-5054c.vercel.app/portal-return',
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Customer portal error:', err);
    return res.status(500).json({ error: 'ポータルURLの生成に失敗しました: ' + err.message });
  }
}
