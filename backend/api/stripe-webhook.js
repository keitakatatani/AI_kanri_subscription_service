// api/stripe-webhook.js
// Stripe決済完了時に自動でライセンス発行＋メール送信（3プラン対応版・支払い失敗対応版）

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

// プラン定義（価格IDからプラン情報を引く）
const PLANS = {
  'price_1TSRsbJSnFcpfzMA3jTKh63c': { name: 'ライト',     limit: 100 },
  'price_1TSRudJSnFcpfzMAvtenGzsj': { name: 'スタンダード', limit: 200 },
  'price_1TSRv0JSnFcpfzMAirK0wKwZ': { name: 'プロ',      limit: 300 },
};

export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segments = [];
  for (let i = 0; i < 4; i++) {
    let seg = '';
    for (let j = 0; j < 4; j++) {
      seg += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    segments.push(seg);
  }
  return segments.join('-');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ===== 決済完了（初回購入） =====
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;

      if (!email) {
        console.error('No email in session');
        return res.status(400).json({ error: 'No email' });
      }

      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const priceId = subscription.items.data[0].price.id;
      const planInfo = PLANS[priceId];

      if (!planInfo) {
        console.error('Unknown price ID:', priceId);
        return res.status(400).json({ error: 'Unknown plan' });
      }

      const licenseKey = generateLicenseKey();

      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);

      const { error: insertError } = await supabase
        .from('licenses')
        .insert({
          email: email,
          license_key: licenseKey,
          plan: planInfo.name,
          monthly_limit: planInfo.limit,
          monthly_count: 0,
          monthly_reset_at: new Date().toISOString(),
          expires_at: expiresAt.toISOString(),
          active: true,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
        });

      if (insertError) {
        console.error('Supabase insert error:', insertError);
        return res.status(500).json({ error: 'License creation failed' });
      }

      await resend.emails.send({
        from: 'noreply@ai-realestate-service.com',
        to: email,
        subject: '【見積転記アシスタント】ライセンス発行のお知らせ',
        html: `
          <div style="font-family: 'Hiragino Sans', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #4f6ef7;">ご購入ありがとうございます</h2>
            <p>見積転記アシスタント <strong>${planInfo.name}プラン</strong>のお申し込みを受け付けました。</p>
            <div style="background: #f5f5f7; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 0 0 10px;"><strong>メールアドレス：</strong>${email}</p>
              <p style="margin: 0 0 10px;"><strong>ライセンスキー：</strong><code style="background: #fff; padding: 4px 8px; border-radius: 4px; font-size: 16px;">${licenseKey}</code></p>
              <p style="margin: 0 0 10px;"><strong>プラン：</strong>${planInfo.name}（月${planInfo.limit}回まで）</p>
              <p style="margin: 0;"><strong>有効期限：</strong>${expiresAt.toLocaleDateString('ja-JP')}</p>
            </div>
            <h3>ご利用方法</h3>
            <ol>
              <li>Chrome拡張機能「見積転記アシスタント」を開く</li>
              <li>上記のメールアドレスとライセンスキーを入力</li>
              <li>「認証して開始」をクリック</li>
            </ol>
            <p style="color: #6b6b85; font-size: 12px; margin-top: 30px;">
              ご不明な点がございましたら、このメールにご返信ください。<br>
              Crevias Inc.
            </p>
          </div>
        `,
      });

      console.log(`License issued: ${email} - ${planInfo.name}`);
    }

    // ===== サブスク更新（プラン変更・支払い状況変化） =====
    if (event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const priceId = subscription.items.data[0].price.id;
      const planInfo = PLANS[priceId];
      const status = subscription.status;

      // active状態の判定：
      // - 'active', 'trialing', 'past_due' → 有効（past_dueはリトライ中なのでまだ使わせる）
      // - 'unpaid', 'canceled', 'incomplete_expired' → 無効
      const isActive = ['active', 'trialing', 'past_due'].includes(status);

      const updateData = {
        active: isActive,
      };

      // プラン情報が取れていれば、プラン名と上限も更新
      if (planInfo) {
        updateData.plan = planInfo.name;
        updateData.monthly_limit = planInfo.limit;
      }

      await supabase
        .from('licenses')
        .update(updateData)
        .eq('stripe_subscription_id', subscription.id);

      console.log(`Subscription updated: ${subscription.id} → status=${status}, active=${isActive}`);

      // 支払い失敗で無効化された場合、ユーザーにお知らせメール
      if (status === 'unpaid' || status === 'incomplete_expired') {
        try {
          const customer = await stripe.customers.retrieve(subscription.customer);
          if (customer.email) {
            await resend.emails.send({
              from: 'noreply@ai-realestate-service.com',
              to: customer.email,
              subject: '【見積転記アシスタント】お支払いに関する重要なお知らせ',
              html: `
                <div style="font-family: 'Hiragino Sans', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                  <h2 style="color: #ef4444;">お支払いができませんでした</h2>
                  <p>お支払い処理を複数回試みましたが、決済が完了できませんでした。</p>
                  <p>そのため、見積転記アシスタントのご利用を一時停止させていただきました。</p>

                  <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; margin: 20px 0;">
                    <p style="margin: 0;"><strong>考えられる原因：</strong></p>
                    <ul style="margin: 8px 0 0; padding-left: 20px;">
                      <li>クレジットカードの有効期限切れ</li>
                      <li>カード残高・利用限度額の不足</li>
                      <li>カード会社による取引拒否</li>
                    </ul>
                  </div>

                  <h3>ご利用を再開するには</h3>
                  <p>下記のお客様ポータルよりお支払い方法を更新してください。更新後、自動的にご利用を再開できます。</p>
                  <p>※ Chrome拡張機能の「💳 プラン管理・解約」ボタンからもアクセスいただけます。</p>

                  <p style="color: #6b6b85; font-size: 12px; margin-top: 30px;">
                    ご不明な点がございましたら、このメールにご返信ください。<br>
                    Crevias Inc.
                  </p>
                </div>
              `,
            });
            console.log(`Payment failed email sent to ${customer.email}`);
          }
        } catch (mailErr) {
          console.error('Failed to send payment failure email:', mailErr);
        }
      }
    }

    // ===== 支払い失敗（情報収集用ログ） =====
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      console.log(`Payment failed: subscription=${invoice.subscription}, attempt=${invoice.attempt_count}, customer=${invoice.customer}`);
      // 実際の無効化処理は customer.subscription.updated で行う
      // （3回失敗後にステータスが unpaid に変わるのを待つ）
    }

    // ===== サブスク解約 =====
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;

      await supabase
        .from('licenses')
        .update({ active: false })
        .eq('stripe_subscription_id', subscription.id);

      console.log(`Subscription canceled: ${subscription.id}`);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Handler error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
}
