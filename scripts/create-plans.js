#!/usr/bin/env node
/**
 * Square Subscription Plan + Variation 作成スクリプト (v2: 月末アンカー)
 *
 * Care Support Pass は「月100円・月末課金・1プランのみ」の設計です。
 * 申込時の即時 ¥100 は別途 CreatePayment (単発決済) で処理し、
 * Subscription 自体は申込日の翌月初を start_date、月末を anchor として動かします。
 *
 * 使い方:
 *   set SQUARE_ENV=production
 *   set SQUARE_ACCESS_TOKEN=xxx
 *   node create-plans.js > plans.json
 *
 * 出力:
 *   plans.json に { "care100": "<plan_variation_id>" } が書かれる
 *   この値を Worker の PLAN_VARIATION_IDS_JSON シークレットに登録する
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

// 1プランだけ — 月100円・月末アンカー
const PLAN_DEFINITION = {
  plan_name: 'Care Support Pass — Monthly Membership (end-of-month)',
  plan_key: 'membership_eom',
  variations: [
    {
      key: 'care100',
      name: 'Care Support Pass 月額会員 (月末締め)',
      price: 100,
      // monthly_billing_anchor_date: 31 を指定すると、毎月の月末日 (4月は30日、2月は28/29日) に課金される
      // ref: https://developer.squareup.com/docs/subscriptions-api/subscription-billing
      anchor_date: 31,
    },
  ],
};

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
  const body = {
    idempotency_key: randomKey(),
    object: {
      type: 'SUBSCRIPTION_PLAN',
      id: `#${planDef.plan_key}_plan`,
      subscription_plan_data: {
        name: planDef.plan_name,
      },
    },
  };
  const res = await squareRequest('POST', '/v2/catalog/object', body);
  const plan = res.catalog_object;
  console.error(`✓ Plan created: ${planDef.plan_name} (id=${plan.id})`);
  return plan;
}

async function createPlanVariation(plan, variation) {
  const body = {
    idempotency_key: randomKey(),
    object: {
      type: 'SUBSCRIPTION_PLAN_VARIATION',
      id: `#${variation.key}_variation`,
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
          },
        ],
        subscription_plan_id: plan.id,
        monthly_billing_anchor_date: variation.anchor_date,
      },
    },
  };
  const res = await squareRequest('POST', '/v2/catalog/object', body);
  const v = res.catalog_object;
  console.error(`  ✓ Variation: ${variation.name} ¥${variation.price} anchor=${variation.anchor_date} (id=${v.id})`);
  return v;
}

async function main() {
  console.error(`Square API: ${BASE_URL}`);
  console.error(`Env: ${ENV}`);
  console.error('');

  const result = {};

  console.error(`--- Creating: ${PLAN_DEFINITION.plan_name} ---`);
  const plan = await createSubscriptionPlan(PLAN_DEFINITION);

  for (const variation of PLAN_DEFINITION.variations) {
    const v = await createPlanVariation(plan, variation);
    result[variation.key] = v.id;
  }

  console.error('');
  console.error('=== DONE ===');
  console.error('plan_variation_ids JSON (set this as PLAN_VARIATION_IDS_JSON secret):');
  console.error('');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
