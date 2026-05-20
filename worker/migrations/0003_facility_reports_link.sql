-- Care Support Pass — facilities テーブル拡張 + facility_reports URL ベース再設計
-- HANDOVER v10.1 §6-2-3 + §11-3 準拠
-- 適用: npx wrangler d1 migrations apply carepass-db --remote

-- =====================================================================
-- 1. facilities に検索/表示用カラム追加
-- =====================================================================
ALTER TABLE facilities ADD COLUMN name_kana       TEXT;
ALTER TABLE facilities ADD COLUMN prefecture      TEXT;
ALTER TABLE facilities ADD COLUMN category        TEXT;
ALTER TABLE facilities ADD COLUMN website         TEXT;
ALTER TABLE facilities ADD COLUMN report_base_url TEXT;
ALTER TABLE facilities ADD COLUMN logo_url        TEXT;

-- 索引
CREATE INDEX IF NOT EXISTS idx_facilities_prefecture ON facilities(prefecture);
CREATE INDEX IF NOT EXISTS idx_facilities_category   ON facilities(category);
CREATE INDEX IF NOT EXISTS idx_facilities_accepting  ON facilities(accepting);

-- =====================================================================
-- 2. facility_reports を URL ベース仕様に作り直す
--
-- 旧仕様 (0001): 本文を CSP 側で保存 (body_md / metrics_json)
-- 新仕様 (v10.1): URL リンクと公開状態だけを管理。本文は施設側自社サイトに置く。
--
-- 旧テーブルにデータは入っていないことを前提に DROP → CREATE。
-- =====================================================================
DROP TABLE IF EXISTS facility_reports;

CREATE TABLE facility_reports (
  id            TEXT PRIMARY KEY,             -- UUID
  facility_id   TEXT NOT NULL REFERENCES facilities(id),
  period        TEXT NOT NULL,                -- "YYYY-MM"
  url           TEXT NOT NULL,                -- {facilities.report_base_url}/{period}.html (完全URL)
  status        TEXT NOT NULL DEFAULT 'published',  -- 'published' | 'retracted' | 'broken'
  published_at  TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at   TEXT,                         -- 最後に到達性確認できた日時
  notes         TEXT,                         -- 任意メモ
  UNIQUE (facility_id, period)
);

CREATE INDEX IF NOT EXISTS idx_facility_reports_facility ON facility_reports(facility_id);
CREATE INDEX IF NOT EXISTS idx_facility_reports_period   ON facility_reports(period);
CREATE INDEX IF NOT EXISTS idx_facility_reports_status   ON facility_reports(status);

-- =====================================================================
-- 3. seed (0002) で投入したデモ施設のメタデータを埋める
-- =====================================================================
UPDATE facilities SET
  name_kana       = 'でもかいごしせつ',
  prefecture      = '東京都',
  category        = 'グループホーム',
  website         = 'https://example.com/demo-facility',
  report_base_url = 'https://example.com/demo-facility/carepass',
  logo_url        = NULL
WHERE id = 'facility_demo';

UPDATE facilities SET name_kana = 'かめいよていしせつえー' WHERE id = 'facility_a';
UPDATE facilities SET name_kana = 'かめいよていしせつびー' WHERE id = 'facility_b';

-- デモ施設に過去の月次報告書URLを2件登録 (UI 表示確認用 / リンクは仮)
INSERT OR IGNORE INTO facility_reports (id, facility_id, period, url, status, published_at, verified_at, notes)
VALUES
  ('rep_demo_2026_04', 'facility_demo', '2026-04', 'https://example.com/demo-facility/carepass/2026-04.html',
   'published', '2026-05-05T10:00:00Z', '2026-05-05T10:00:00Z', 'デモ用ダミー'),
  ('rep_demo_2026_05', 'facility_demo', '2026-05', 'https://example.com/demo-facility/carepass/2026-05.html',
   'published', '2026-06-05T10:00:00Z', '2026-06-05T10:00:00Z', 'デモ用ダミー');
