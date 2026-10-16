-- 0005_remove_tamj_names.sql
-- デモ施設の名称・説明から「タムジ」の表記を外す（サンプル表記に置き換え）。
UPDATE facilities SET
  name = REPLACE(REPLACE(name, 'タムジcare株式会社', 'サンプル運営会社'), 'タムジ', 'サンプル'),
  name_kana = REPLACE(name_kana, 'たむじ', 'さんぷる'),
  description = REPLACE(REPLACE(description, 'タムジcare株式会社', 'サンプル運営会社'), 'タムジ', 'サンプル')
WHERE name LIKE '%タムジ%' OR description LIKE '%タムジ%' OR name_kana LIKE '%たむじ%';
