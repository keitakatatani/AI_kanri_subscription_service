// api/stripe-webhook.js
// Stripe決済完了時に自動でライセンス発行＋メール送信

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ランダムなライセンスキーを生成（XXXX-XXXX-XXXX-XXXX形式）
function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segment = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${segment()}-${segment()}-${segment()}-${segment()}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Stripeからのリクエストを検証
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {

      // ─── サブスク新規契約 ─────────────────────────────────
      case 'customer.subscription.created': {
        const subscription = event.data.object;
if (!['active', 'trialing'].includes(subscription.status)) break;

        const customer = await stripe.customers.retrieve(subscription.customer);
        const email = customer.email;
        if (!email) break;

        // 既存ライセンスチェック
        const { data: existing } = await supabase
          .from('licenses')
          .select('id')
          .eq('email', email.toLowerCase())
          .single();

        const licenseKey = generateLicenseKey();
const periodEnd = subscription.trial_end || subscription.current_period_end;
const expiresAt = new Date(periodEnd * 1000).toISOString();
        if (existing) {
          // 既存ライセンスを更新・再有効化
          await supabase
            .from('licenses')
            .update({
              active: true,
              expires_at: expiresAt,
              stripe_subscription_id: subscription.id,
              stripe_customer_id: subscription.customer
            })
            .eq('email', email.toLowerCase());
        } else {
          // 新規ライセンスを発行
          await supabase.from('licenses').insert({
            email: email.toLowerCase(),
            license_key: licenseKey,
            plan: 'スタンダード',
            expires_at: expiresAt,
            active: true,
            stripe_subscription_id: subscription.id,
            stripe_customer_id: subscription.customer
          });
        }

        // メール送信
        const { data: license } = await supabase
          .from('licenses')
          .select('license_key')
          .eq('email', email.toLowerCase())
          .single();

        await sendLicenseEmail(email, license.license_key, expiresAt);
        console.log(`✅ License issued for ${email}`);
        break;
      }

      // ─── サブスク更新（毎月の自動更新）──────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.billing_reason !== 'subscription_cycle') break;

        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const customer = await stripe.customers.retrieve(invoice.customer);
        const email = customer.email;
        if (!email) break;

        const expiresAt = new Date(subscription.current_period_end * 1000).toISOString();

        await supabase
          .from('licenses')
          .update({ expires_at: expiresAt, active: true })
          .eq('email', email.toLowerCase());

        console.log(`✅ License renewed for ${email} until ${expiresAt}`);
        break;
      }

      // ─── サブスク解約・支払い失敗 ─────────────────────────
      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const obj = event.data.object;
        const customerId = obj.customer;
        const customer = await stripe.customers.retrieve(customerId);
        const email = customer.email;
        if (!email) break;

        await supabase
          .from('licenses')
          .update({ active: false })
          .eq('email', email.toLowerCase());

        console.log(`⛔ License deactivated for ${email}`);
        break;
      }
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── メール送信（Resend API）─────────────────────────────
async function sendLicenseEmail(email, licenseKey, expiresAt) {
  const expDate = new Date(expiresAt).toLocaleDateString('ja-JP');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || 'noreply@yourdomain.com',
      to: email,
      subject: '【見積転記アシスタント】ライセンスキーのご案内',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #1d4ed8;">見積転記アシスタント</h2>
          <p>この度はご契約いただきありがとうございます。</p>
          <p>以下のライセンスキーでご利用いただけます。</p>

          <div style="background: #f1f5f9; border-radius: 8px; padding: 24px; margin: 24px 0; text-align: center;">
            <p style="font-size: 12px; color: #64748b; margin: 0 0 8px;">ライセンスキー</p>
            <p style="font-size: 24px; font-weight: bold; font-family: monospace; letter-spacing: 2px; color: #1e293b; margin: 0;">${licenseKey}</p>
          </div>

          <p style="font-size: 13px; color: #475569;">
            📧 登録メールアドレス: <strong>${email}</strong><br>
            📅 有効期限: <strong>${expDate}</strong>
          </p>

          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">

          <h3 style="font-size: 15px;">ご利用方法</h3>
          <ol style="font-size: 13px; color: #475569; line-height: 2;">
            <li>Chrome拡張機能をインストール</li>
            <li>拡張機能を開き、メールアドレスとライセンスキーを入力</li>
            <li>見積PDFをアップロードしてAI読み取り開始</li>
          </ol>

          <p style="font-size: 12px; color: #94a3b8; margin-top: 32px;">
            ご不明な点はお気軽にお問い合わせください。
          </p>
        </div>
      `
    })
  });

  if (!resp.ok) {
    const err = await resp.json();
    console.error('Email send failed:', err);
  }
}

// ─── Raw bodyを取得（Stripe署名検証用）───────────────────
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export const config = {
  api: { bodyParser: false }
};
