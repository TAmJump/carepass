-- 0004_facility_ab_realnames.sql
-- 加盟予定施設 facility_a / facility_b の実情報差替え。
-- 目的: 営業デモの導入施設ディレクトリ (facilities-directory.html) で、
--       タムジレジデンス日本橋(東京・住宅型有料老人ホーム)以外にも
--       加盟予定の施設として 京都 / 名古屋 の2施設を見せる。
-- 注意: HANDOVER v11 §2 で確認済の facilities スキーマに従う。
--       (description / accepting / category / prefecture など)
--       paid_months_count, short_description, is_accepting は **存在しない**。

-- facility_a: タムジ住まいの相談所 京都四条
UPDATE facilities SET
  name = 'タムジ住まいの相談所 京都四条',
  name_kana = 'たむじすまいのそうだんしょきょうとしじょう',
  prefecture = '京都府',
  category = '訪問介護・住まい相談',
  location = '京都府京都市中京区四条烏丸',
  description = '京都・四条烏丸の高齢者住まい相談窓口。タムジcare株式会社の関西拠点として、訪問介護・住まい探しの伴走支援・医療機関連携の3つを軸に運営。地域包括支援センターとの連携も実施。Care Support Pass 加盟準備中。',
  website = 'https://tamjump.com',
  report_base_url = NULL,
  logo_url = NULL,
  accepting = 1,
  rank = 'trial'
WHERE id = 'facility_a';

-- facility_b: タムジ サポートホーム 名古屋栄
UPDATE facilities SET
  name = 'タムジ サポートホーム 名古屋栄',
  name_kana = 'たむじさぽーとほーむなごやさかえ',
  prefecture = '愛知県',
  category = '小規模多機能型居宅介護',
  location = '愛知県名古屋市中区栄',
  description = '名古屋・栄の小規模多機能型居宅介護施設(定員18名)。タムジcare株式会社が運営する中部地区初の介護拠点。通い・泊まり・訪問の3サービスを柔軟に組み合わせ、ご家族の介護負担を軽減します。Care Support Pass 加盟準備中。',
  website = 'https://tamjump.com',
  report_base_url = NULL,
  logo_url = NULL,
  accepting = 1,
  rank = 'trial'
WHERE id = 'facility_b';
