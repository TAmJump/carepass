-- Care Support Pass — D1 初期スキーマ
-- HANDOVER v7 §7-2 準拠
-- 適用: npx wrangler d1 migrations apply carepass-db --remote

-- =====================================================================
-- 7-2-1. accounts: 4ロール共通アカウント
-- =====================================================================
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT,
  role            TEXT NOT NULL DEFAULT 'member',
  display_name    TEXT,
  square_customer_id TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_role  ON accounts(role);

-- =====================================================================
-- 7-2-2. members: 個人会員詳細
-- =====================================================================
CREATE TABLE IF NOT EXISTS members (
  account_id              TEXT PRIMARY KEY REFERENCES accounts(id),
  square_subscription_id  TEXT NOT NULL UNIQUE,
  current_facility_id     TEXT NOT NULL,
  applied_at              TEXT NOT NULL DEFAULT (datetime('now')),
  last_billed_at          TEXT,
  total_paid_jpy          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_members_facility ON members(current_facility_id);
CREATE INDEX IF NOT EXISTS idx_members_subid    ON members(square_subscription_id);

-- =====================================================================
-- 7-2-3. facilities: 加盟施設マスタ (FACILITIES_JSON から段階的に移行)
-- =====================================================================
CREATE TABLE IF NOT EXISTS facilities (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  location          TEXT,
  description       TEXT,
  rank              TEXT NOT NULL DEFAULT 'trial',
  accepting         INTEGER NOT NULL DEFAULT 1,
  target_supporters INTEGER,
  monthly_fixed_jpy INTEGER,
  contact_email     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =====================================================================
-- 7-2-4. facility_admins
-- =====================================================================
CREATE TABLE IF NOT EXISTS facility_admins (
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  facility_id      TEXT NOT NULL REFERENCES facilities(id),
  role_in_facility TEXT NOT NULL DEFAULT 'manager',
  PRIMARY KEY (account_id, facility_id)
);

-- =====================================================================
-- 7-2-5. facility_reports
-- =====================================================================
CREATE TABLE IF NOT EXISTS facility_reports (
  id           TEXT PRIMARY KEY,
  facility_id  TEXT NOT NULL REFERENCES facilities(id),
  period       TEXT NOT NULL,
  submitted_at TEXT,
  confirmed_at TEXT,
  published_at TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',
  body_md      TEXT,
  metrics_json TEXT,
  UNIQUE (facility_id, period)
);

-- =====================================================================
-- 7-2-6. partners
-- =====================================================================
CREATE TABLE IF NOT EXISTS partners (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT,
  location      TEXT,
  description   TEXT,
  website       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  contact_email TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =====================================================================
-- 7-2-7. partner_admins
-- =====================================================================
CREATE TABLE IF NOT EXISTS partner_admins (
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  partner_id      TEXT NOT NULL REFERENCES partners(id),
  role_in_partner TEXT NOT NULL DEFAULT 'manager',
  PRIMARY KEY (account_id, partner_id)
);

-- =====================================================================
-- 7-2-8. coupons
-- =====================================================================
CREATE TABLE IF NOT EXISTS coupons (
  id                     TEXT PRIMARY KEY,
  partner_id             TEXT NOT NULL REFERENCES partners(id),
  title                  TEXT NOT NULL,
  description            TEXT,
  discount_type          TEXT NOT NULL,
  discount_value         INTEGER,
  conditions             TEXT,
  valid_from             TEXT NOT NULL,
  valid_until            TEXT NOT NULL,
  usage_limit_per_member INTEGER DEFAULT 1,
  total_limit            INTEGER,
  status                 TEXT NOT NULL DEFAULT 'draft',
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coupons_partner ON coupons(partner_id);
CREATE INDEX IF NOT EXISTS idx_coupons_status  ON coupons(status);

-- =====================================================================
-- 7-2-9. member_coupons
-- =====================================================================
CREATE TABLE IF NOT EXISTS member_coupons (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(id),
  coupon_id             TEXT NOT NULL REFERENCES coupons(id),
  state                 TEXT NOT NULL DEFAULT 'available',
  acquired_at           TEXT NOT NULL DEFAULT (datetime('now')),
  reserved_until        TEXT,
  used_at               TEXT,
  used_partner_location TEXT,
  staff_id              TEXT
);
CREATE INDEX IF NOT EXISTS idx_mc_account ON member_coupons(account_id);
CREATE INDEX IF NOT EXISTS idx_mc_coupon  ON member_coupons(coupon_id);
CREATE INDEX IF NOT EXISTS idx_mc_state   ON member_coupons(state);

-- =====================================================================
-- 7-2-10. login_tokens: マジックリンク
-- =====================================================================
CREATE TABLE IF NOT EXISTS login_tokens (
  token       TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_account ON login_tokens(account_id);

-- =====================================================================
-- 7-2-11. sessions: クッキーセッション
-- =====================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

-- =====================================================================
-- 7-2-12. webhook_events: Square Webhook 受信ログ (冪等性確保用)
-- =====================================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
