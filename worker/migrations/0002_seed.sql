-- Care Support Pass — Seed data + デモ用アカウント (営業デモ・動作確認用)
-- 適用: npx wrangler d1 migrations apply carepass-db --remote
--
-- 目的:
--   1. facilities / partners / coupons に最低限のデモデータを投入
--   2. 営業デモ用に admin / facility / partner の3アカウントを作成
--      → これらのメアドでマジックリンクログインすれば、各ダッシュボードへ遷移できる
--
-- 注意:
--   ・本マイグレーションは facilities / partners カラム拡張 (0003) の前に走るが、
--     INSERT は 0001 時点に存在する基本カラムのみ使うので問題ない。
--   ・追加カラム (name_kana / prefecture / category / report_base_url 等) は
--     0003 適用後に UPDATE で埋める (本ファイル末尾の UPDATE は 0003 適用後に手動実行 or 0004 で別途)
--   ・冪等性: 全て INSERT OR IGNORE / INSERT OR REPLACE

-- =====================================================================
-- 施設マスタ (現状の FACILITIES_JSON と整合)
-- =====================================================================
INSERT OR IGNORE INTO facilities (id, name, location, description, rank, accepting, target_supporters, monthly_fixed_jpy, contact_email)
VALUES
  ('facility_a',    '加盟予定施設A',   '準備中', '加盟準備中の施設です。',          'trial', 1, NULL, NULL, NULL),
  ('facility_b',    '加盟予定施設B',   '準備中', '加盟準備中の施設です。',          'trial', 1, NULL, NULL, NULL),
  ('facility_demo', 'デモ介護施設',     '東京都新宿区', '営業デモ・動作確認用の架空施設。', 'trial', 1, 100,  10000, 'facility-demo@carepass.tamjump.com');

-- =====================================================================
-- 企業マスタ (デモ協力企業)
-- =====================================================================
INSERT OR IGNORE INTO partners (id, name, category, location, description, website, status, contact_email)
VALUES
  ('partner_demo',  'デモ協力企業',   '飲食',     '東京都新宿区',
   '営業デモ・動作確認用の架空企業 (1号店)。',
   'https://carepass.tamjump.com/partners.html', 'active', 'partner-demo@carepass.tamjump.com'),
  ('partner_demo2', 'デモカフェ KOTONOHA',  'カフェ',   '東京都渋谷区',
   '会員向けにドリンクサービスを提供 (デモ用)。',
   'https://carepass.tamjump.com/partners.html', 'active', NULL);

-- =====================================================================
-- クーポン定義
-- =====================================================================
INSERT OR IGNORE INTO coupons (id, partner_id, title, description, discount_type, discount_value, conditions, valid_from, valid_until, usage_limit_per_member, status)
VALUES
  ('coupon_demo_1', 'partner_demo',  'ドリンク1杯無料',
     '当店ご注文1,000円以上で1杯無料 (アルコール除く)。', 'item', NULL,
     '1日1回まで。他クーポンとの併用不可。',
     '2026-05-01T00:00:00Z', '2027-04-30T23:59:59Z', 1, 'published'),
  ('coupon_demo_2', 'partner_demo2', 'コーヒー1杯 30%OFF',
     '店内ご利用時。', 'percent', 30,
     '1日1回まで。', '2026-05-01T00:00:00Z', '2026-12-31T23:59:59Z', 1, 'published'),
  ('coupon_demo_3', 'partner_demo',  '300円割引',
     'お会計2,000円以上で300円割引。', 'amount', 300,
     '他クーポンとの併用不可。', '2026-05-01T00:00:00Z', '2026-12-31T23:59:59Z', 1, 'published');

-- =====================================================================
-- 営業デモ用アカウント (admin / facility / partner)
--
-- これらのメアドで /mypage.html からマジックリンクログイン可能。
-- ログイン後、accounts.role に応じて mypage.html がダッシュボードへ自動リダイレクトする。
--
-- IDは固定文字列 (uuid風) にして、再現性を確保
-- =====================================================================
INSERT OR IGNORE INTO accounts (id, email, role, display_name, status)
VALUES
  ('acct_admin_tamj',    'info@tamjump.com',                 'admin',    'TAmJump 運営',     'active'),
  ('acct_facility_demo', 'facility-demo@carepass.tamjump.com','facility', 'デモ介護施設 管理者', 'active'),
  ('acct_partner_demo',  'partner-demo@carepass.tamjump.com', 'partner',  'デモ協力企業 担当者', 'active');

-- 施設管理者の紐付け
INSERT OR IGNORE INTO facility_admins (account_id, facility_id, role_in_facility)
VALUES ('acct_facility_demo', 'facility_demo', 'manager');

-- 企業管理者の紐付け
INSERT OR IGNORE INTO partner_admins (account_id, partner_id, role_in_partner)
VALUES ('acct_partner_demo', 'partner_demo', 'manager');

-- =====================================================================
-- 営業デモ用: 既存マイページ会員のデモアカウント (任意)
--
-- すでに本番テストで tiger@tamjump.com の sub を作って解約しているため、
-- 「会員ロール」の見た目をデモするためのダミーアカウント。
-- members 行は実 Square subscription なしには成立しないので作らない。
-- mypage.html は accounts はあるが members 行が無い場合「契約なし」表示にする。
-- =====================================================================
INSERT OR IGNORE INTO accounts (id, email, role, display_name, status)
VALUES
  ('acct_member_demo', 'member-demo@carepass.tamjump.com', 'member', 'デモ個人会員', 'active');

-- このデモ会員に既存クーポンを2件配布 (UI 表示確認用)
INSERT OR IGNORE INTO member_coupons (id, account_id, coupon_id, state)
VALUES
  ('mc_demo_1', 'acct_member_demo', 'coupon_demo_1', 'available'),
  ('mc_demo_2', 'acct_member_demo', 'coupon_demo_2', 'available'),
  ('mc_demo_3', 'acct_member_demo', 'coupon_demo_3', 'available');
