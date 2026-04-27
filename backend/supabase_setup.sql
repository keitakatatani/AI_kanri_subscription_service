-- ============================================================
-- 見積転記アシスタント — Supabase テーブル定義
-- Supabase の SQL Editor で実行してください
-- ============================================================

-- ① ライセンステーブル
CREATE TABLE IF NOT EXISTS licenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  license_key     TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'スタンダード',  -- スタンダード / プロ など
  expires_at      TIMESTAMPTZ NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,

  CONSTRAINT licenses_email_key UNIQUE (email, license_key)
);

-- インデックス（認証クエリの高速化）
CREATE INDEX IF NOT EXISTS idx_licenses_email_key ON licenses (email, license_key);

-- ② 利用ログテーブル（API費用管理用）
CREATE TABLE IF NOT EXISTS usage_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id      UUID REFERENCES licenses(id),
  email           TEXT NOT NULL,
  file_name       TEXT,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  item_count      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_license_id ON usage_logs (license_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs (created_at);

-- ============================================================
-- サンプルライセンスの発行（テスト用）
-- ============================================================
-- INSERT INTO licenses (email, license_key, plan, expires_at)
-- VALUES (
--   'test@example.com',
--   'TEST-1234-ABCD-5678',
--   'スタンダード',
--   now() + interval '1 year'
-- );

-- ============================================================
-- 月別コスト確認クエリ（管理用）
-- ============================================================
-- SELECT
--   date_trunc('month', created_at) AS month,
--   COUNT(*) AS requests,
--   SUM(input_tokens) AS total_input_tokens,
--   SUM(output_tokens) AS total_output_tokens,
--   ROUND(SUM(input_tokens)  / 1000000.0 * 3.0  * 155, 0) AS input_cost_jpy,
--   ROUND(SUM(output_tokens) / 1000000.0 * 15.0 * 155, 0) AS output_cost_jpy
-- FROM usage_logs
-- GROUP BY 1
-- ORDER BY 1 DESC;
