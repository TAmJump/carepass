// PLAN_VARIATION_IDS_JSON シークレットから plan_key → variation_id をひく
// Care Support Pass は「月100円・1プランのみ」設計

let cached = null;

function load(env) {
  if (cached) return cached;
  try {
    cached = JSON.parse(env.PLAN_VARIATION_IDS_JSON || '{}');
  } catch (e) {
    console.error('PLAN_VARIATION_IDS_JSON parse error:', e);
    cached = {};
  }
  return cached;
}

// 唯一のプラン
export function getMembershipVariationId(env) {
  const map = load(env);
  return map.care100 || null;
}

// 施設ID — Worker 環境変数 FACILITIES_JSON で管理
// 例: [{"id":"facility_a","name":"施設A","location":"東京都...","accepting":true}]
export function getFacilities(env) {
  try {
    return JSON.parse(env.FACILITIES_JSON || '[]');
  } catch (e) {
    console.error('FACILITIES_JSON parse error:', e);
    return [];
  }
}

export function isValidFacilityId(env, facilityId) {
  if (!facilityId) return false;
  const facilities = getFacilities(env);
  return facilities.some((f) => f.id === facilityId && f.accepting !== false);
}

// source.name (例: "Care Support Pass / facility_a") から facility_id を抽出
export function parseFacilityFromSourceName(sourceName) {
  if (!sourceName || typeof sourceName !== 'string') return null;
  const m = sourceName.match(/Care Support Pass\s*\/\s*([\w-]+)/);
  return m ? m[1] : null;
}

// facility_id から表示用情報を取得
export function findFacility(env, facilityId) {
  if (!facilityId) return null;
  return getFacilities(env).find((f) => f.id === facilityId) || null;
}
