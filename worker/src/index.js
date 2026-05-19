// Care Support Pass — Cloudflare Workers Backend
// 役割: Square Subscriptions の作成・退会・Webhook受信
//
// エンドポイント:
//   GET  /api/config            フロントエンド用の application_id, location_id を返す
//   POST /api/subscribe         申込フォーム送信を受けてサブスク作成
//   POST /api/cancel            退会
//   POST /api/webhook           Square Webhook (署名検証)
//   GET  /api/health            稼働確認

import { handleOptions, jsonResponse, corsHeaders } from './cors.js';
import {
  getOrCreateCustomer,
  createCard,
  createSubscription,
  retrieveSubscription,
  cancelSubscription,
} from './square.js';
import { resolveVariationId, validatePlanKey } from './plans.js';
import { verifySquareSignature, handleEvent } from './webhook.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const path = url.pathname;

    if (request.method === 'OPTIONS') return handleOptions(request, env);

    try {
      if (path === '/api/health' && request.method === 'GET') {
        return jsonResponse({ ok: true, env: env.SQUARE_ENV }, 200, env, origin);
      }

      if (path === '/api/config' && request.method === 'GET') {
        return jsonResponse({
          application_id: env.SQUARE_APPLICATION_ID,
          location_id: env.SQUARE_LOCATION_ID,
          env: env.SQUARE_ENV,
        }, 200, env, origin);
      }

      if (path === '/api/subscribe' && request.method === 'POST') {
        return await handleSubscribe(request, env, origin);
      }

      if (path === '/api/cancel' && request.method === 'POST') {
        return await handleCancel(request, env, origin);
      }

      if (path === '/api/webhook' && request.method === 'POST') {
        return await handleWebhook(request, env);
      }

      return jsonResponse({ error: 'not_found' }, 404, env, origin);
    } catch (e) {
      console.error('Unhandled error:', e, e.stack);
      return jsonResponse({ error: 'internal_error', message: e.message }, 500, env, origin);
    }
  },
};

// === /api/subscribe ===

async function handleSubscribe(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'invalid_json' }, 400, env, origin);

  const { type, plan_key, source_id, verification_token, buyer } = body;

  // 入力検証
  if (!type || !plan_key || !source_id || !buyer || !buyer.email_address) {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }
  if (!validatePlanKey(type, plan_key)) {
    return jsonResponse({ error: 'invalid_plan_key' }, 400, env, origin);
  }
  const variationId = resolveVariationId(env, plan_key);
  if (!variationId) {
    return jsonResponse({ error: 'plan_not_configured' }, 500, env, origin);
  }

  // 1. Customer 取得 or 作成
  const customer = await getOrCreateCustomer(env, buyer);

  // 2. Card 永続化（payment token を card-on-file に変換）
  const card = await createCard(
    env,
    customer.id,
    source_id,
    verification_token,
    buyer.address
  );

  // 3. Subscription 作成
  const subscription = await createSubscription(env, {
    customerId: customer.id,
    planVariationId: variationId,
    cardId: card.id,
  });

  return jsonResponse({
    ok: true,
    subscription_id: subscription.id,
    customer_id: customer.id,
    status: subscription.status,
  }, 200, env, origin);
}

// === /api/cancel ===

async function handleCancel(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'invalid_json' }, 400, env, origin);

  const { subscription_id, customer_email } = body;
  if (!subscription_id || !customer_email) {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }

  // サブスクを取得して本人確認
  const sub = await retrieveSubscription(env, subscription_id);
  if (!sub) return jsonResponse({ error: 'not_found' }, 404, env, origin);

  // customer の email と照合 (簡易本人確認)
  // 厳密にはメール認証リンクを送るべき。最初はこれで運用 → 後で強化
  const customer = await fetch(
    (env.SQUARE_ENV === 'production'
      ? 'https://connect.squareup.com'
      : 'https://connect.squareupsandbox.com')
      + `/v2/customers/${sub.customer_id}`,
    {
      headers: {
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2026-01-22',
      },
    }
  ).then((r) => r.json());

  const actualEmail = customer?.customer?.email_address;
  if (!actualEmail || actualEmail.toLowerCase() !== customer_email.toLowerCase()) {
    return jsonResponse({ error: 'email_mismatch' }, 403, env, origin);
  }

  const canceled = await cancelSubscription(env, subscription_id);
  return jsonResponse({
    ok: true,
    status: canceled.status,
    canceled_date: canceled.canceled_date,
  }, 200, env, origin);
}

// === /api/webhook ===

async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get('x-square-hmacsha256-signature');

  // 通知URL — Square ダッシュボードに登録したURLと同じ文字列を使う必要がある
  // 通常 request.url で取れるが proxy 経由だと正規化されている可能性があるため、
  // 環境変数で固定推奨
  const notificationUrl = env.WEBHOOK_NOTIFICATION_URL || request.url;

  const valid = await verifySquareSignature({
    signatureKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY,
    notificationUrl,
    rawBody,
    signatureHeader,
  });

  if (!valid) {
    console.warn('Webhook signature invalid');
    return new Response('forbidden', { status: 403 });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch {
    return new Response('bad_json', { status: 400 });
  }

  // 200 を即返したいので、handleEventはctx.waitUntilで非同期可
  // (ここでは同期処理が軽いのでawaitで十分)
  await handleEvent(env, event);

  return new Response('ok', { status: 200 });
}
