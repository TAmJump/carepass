// PLAN_VARIATION_IDS_JSON シークレットから plan_key → variation_id をひく

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

export function resolveVariationId(env, planKey) {
  const map = load(env);
  return map[planKey] || null;
}

// 申込タイプ別の許容キー
export const VALID_KEYS = {
  individual: ['care100', 'care300', 'care500', 'care1000'],
  partner:    ['local_partner', 'care_partner', 'sponsor_partner'],
  facility:   ['facility_s', 'facility_m', 'facility_l', 'facility_xl', 'facility_xxl'],
};

export function validatePlanKey(type, planKey) {
  const valid = VALID_KEYS[type];
  return valid && valid.includes(planKey);
}
