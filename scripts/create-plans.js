#!/usr/bin/env node
/**
 * Square Subscription Plans + Plan Variations 一括作成スクリプト
 *
 * 使い方:
 *   SQUARE_ENV=sandbox SQUARE_ACCESS_TOKEN=xxx node scripts/create-plans.js
 *
 * 出力:
 *   - 12個のplan_variation_idをJSON形式で標準出力
 *   - これをWorkerのPLAN_VARIATION_IDS_JSONに設定する
 *
 * 注意:
 *   - 既に作成済みの場合はスキップしたいので、createした結果を保存しておく
 *   - 個人/加盟店/施設で 3つの SUBSCRIPTION_PLAN を作る
 *   - 各 plan に対し variation を作成（合計12）
 */

const SQUARE_VERSION = '2026-01-22';
const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const ENV = process.env.SQUARE_ENV || 'sandbox';
const BASE_URL = ENV === 'production'
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

if (!ACCESS_TOKEN) {
  console.error('ERROR: SQUARE_ACCESS_TOKEN が未設定');
  process.exit(1);
}

// プラン定義 — 引き継ぎ書のビジネス要件そのまま
const PLAN_DEFINITIONS = [
  {
    plan_name: 'Care Support Pass — Individual Membership',
    plan_key: 'individual',
    variations: [
      { key: 'care100',  name: 'Care 100',  price: 100 },
      { key: 'care300',  name: 'Care 300',  price: 300 },
      { key: 'care500',  name: 'Care 500',  price: 500 },
      { key: 'care1000', name: 'Care 1000', price: 1000 },
    ],
  },
  {
    plan_name: 'Care Support Pass — Partner Membership',
    plan_key: 'partner',
    variations: [
      { key: 'local_partner',   name: 'Local Partner',    price: 3000 },
      { key: 'care_partner',    name: 'Care Partner',     price: 10000 },
      { key: 'sponsor_partner', name: 'Sponsor Partner',  price: 30000 },
    ],
  },
  {
    plan_name: 'Care Support Pass — Facility Membership',
    plan_key: 'facility',
    variations: [
      { key: 'facility_s',   name: 'Facility S (9-29 rooms)',    price: 5000 },
      { key: 'facility_m',   name: 'Facility M (30-44 rooms)',   price: 10000 },
      { key: 'facility_l',   name: 'Facility L (45-59 rooms)',   price: 15000 },
      { key: 'facility_xl',  name: 'Facility XL (60-79 rooms)',  price: 20000 },
      { key: 'facility_xxl', name: 'Facility XXL (80+ rooms)',   price: 30000 },
    ],
  },
];

async function squareRequest(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    console.error('Square API error:', JSON.stringify(json, null, 2));
    throw new Error(`Square API ${res.status}`);
  }
  return json;
}

function randomKey() {
  return 'csp-' + crypto.randomUUID();
}

async function createSubscriptionPlan(planDef) {
  const idempotencyKey = randomKey();
  const planObjectId = `#${planDef.plan_key}_plan`;

  const body = {
    idempotency_key: idempotencyKey,
    object: {
      type: 'SUBSCRIPTION_PLAN',
      id: planObjectId,
      subscription_plan_data: {
        name: planDef.plan_name,
        // all_items は subscription_plan_data でなく eligible_*_ids で制御。
        // 月額サブスクで物販品紐付け不要なら eligible_item_ids/category_ids を省略可
      },
    },
  };

  const res = await squareRequest('POST', '/v2/catalog/object', body);
  const plan = res.catalog_object;
  console.error(`✓ Plan created: ${planDef.plan_name} (id=${plan.id})`);
  return plan;
}

async function createPlanVariation(plan, variation) {
  const idempotencyKey = randomKey();
  const variationObjectId = `#${variation.key}_variation`;

  const body = {
    idempotency_key: idempotencyKey,
    object: {
      type: 'SUBSCRIPTION_PLAN_VARIATION',
      id: variationObjectId,
      subscription_plan_variation_data: {
        name: variation.name,
        phases: [
          {
            ordinal: 0,
            cadence: 'MONTHLY',
            pricing: {
              type: 'STATIC',
              price_money: {
                amount: variation.price,
                currency: 'JPY',
              },
            },
            // periods 省略 = 無期限月額継続
          },
        ],
        subscription_plan_id: plan.id,
      },
    },
  };

  const res = await squareRequest('POST', '/v2/catalog/object', body);
  const v = res.catalog_object;
  console.error(`  ✓ Variation: ${variation.name} ¥${variation.price} (id=${v.id})`);
  return v;
}

async function main() {
  console.error(`Square API: ${BASE_URL}`);
  console.error(`Env: ${ENV}`);
  console.error('');

  const result = {};

  for (const planDef of PLAN_DEFINITIONS) {
    console.error(`--- Creating: ${planDef.plan_name} ---`);
    const plan = await createSubscriptionPlan(planDef);

    for (const variation of planDef.variations) {
      const v = await createPlanVariation(plan, variation);
      result[variation.key] = v.id;
    }
    console.error('');
  }

  console.error('=== DONE ===');
  console.error('plan_variation_ids JSON (set this as PLAN_VARIATION_IDS_JSON secret):');
  console.error('');
  // 標準出力には JSON だけ流すので、ダッシュボード/wrangler コピペで使える
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
