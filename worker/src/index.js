// Care Support Pass — Cloudflare Workers Backend
// 役割: 個人会員の Square Subscription 作成・退会・Webhook 受信、
//       加盟店/介護施設の申込受付（課金なし）
//
// エンドポイント:
//   GET  /api/health      死活
//   GET  /api/config      フロント用 Application ID / Location ID / 施設一覧
//   POST /api/subscribe   個人会員: フォーム送信→Square Subscription 作成
//   POST /api/cancel      退会
//   POST /api/apply       加盟店/施設の申込受付（決済なし・通知のみ）
//   POST /api/webhook     Square Webhook (HMAC-SHA256 署名検証)

import { handleOptions, jsonResponse } from './cors.js';
import {
  getOrCreateCustomer,
  createCard,
  createSubscription,
  retrieveSubscription,
  retrieveCustomer,
  cancelSubscription,
  updateSubscription,
} from './square.js';
import {
  getMembershipVariationId,
  getFacilities,
  isValidFacilityId,
  parseFacilityFromSourceName,
  findFacility,
} from './plans.js';
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
          facilities: getFacilities(env),
        }, 200, env, origin);
      }

      if (path === '/api/subscribe' && request.method === 'POST') {
        return await handleSubscribe(request, env, origin);
      }

      if (path === '/api/apply' && request.method === 'POST') {
        return await handleApply(request, env, origin);
      }

      if (path === '/api/cancel' && request.method === 'POST') {
        return await handleCancel(request, env, origin);
      }

      if (path === '/api/lookup' && request.method === 'POST') {
        return await handleLookup(request, env, origin);
      }

      if (path === '/api/change-facility' && request.method === 'POST') {
        return await handleChangeFacility(request, env, origin);
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

// === /api/subscribe — 個人会員 ===

async function handleSubscribe(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'invalid_json' }, 400, env, origin);

  const { source_id, verification_token, buyer, facility_id } = body;

  // 入力検証
  if (!source_id || !buyer || !buyer.email_address) {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }
  if (!isValidFacilityId(env, facility_id)) {
    return jsonResponse({ error: 'invalid_facility' }, 400, env, origin);
  }
  const variationId = getMembershipVariationId(env);
  if (!variationId) {
    return jsonResponse({ error: 'plan_not_configured' }, 500, env, origin);
  }

  // 1. Customer 取得 or 作成（施設指名情報をメタデータに保存）
  const buyerWithMeta = {
    ...buyer,
    metadata: {
      ...(buyer.metadata || {}),
      facility_id, // どの施設に対する100円か
    },
  };
  const customer = await getOrCreateCustomer(env, buyerWithMeta);

  // 2. Card 永続化
  // Sandbox環境では Web Payments SDK の本物カード番号(4111...)からのnonceは
  // /v2/cards で INVALID_CARD_DATA が返るケースが多いため、Squareが提供する
  // Sandbox固定nonce `cnon:card-nonce-ok` に差し替えてテストを通せるようにする。
  // 本番(env=production)では絶対に差し替えない。
  let effectiveSourceId = source_id;
  if (env.SQUARE_ENV === 'sandbox' && source_id && source_id.startsWith('cnon:') && source_id !== 'cnon:card-nonce-ok') {
    console.log('Sandbox: replacing source_id with cnon:card-nonce-ok for /v2/cards compatibility');
    effectiveSourceId = 'cnon:card-nonce-ok';
  }
  const card = await createCard(
    env,
    customer.id,
    effectiveSourceId,
    env.SQUARE_ENV === 'sandbox' ? undefined : verification_token,
    buyer.address
  );

  // 3. Subscription 作成（施設IDを reference に埋め込む）
  const subscription = await createSubscription(env, {
    customerId: customer.id,
    planVariationId: variationId,
    cardId: card.id,
    facilityId: facility_id,
  });

  return jsonResponse({
    ok: true,
    subscription_id: subscription.id,
    customer_id: customer.id,
    status: subscription.status,
    facility_id,
  }, 200, env, origin);
}

// === /api/apply — 加盟店/施設の申込受付（決済なし） ===

async function handleApply(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'invalid_json' }, 400, env, origin);

  const { type, applicant } = body;
  if (!type || !['partner', 'facility'].includes(type)) {
    return jsonResponse({ error: 'invalid_type' }, 400, env, origin);
  }
  if (!applicant || !applicant.email_address) {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }

  // Square の Customer Directory に登録するだけ（タグで識別）
  // 後で運営側がダッシュボードから確認・連絡できるようにする
  const buyerLike = {
    ...applicant,
    note: JSON.stringify({
      kind: type, // "partner" or "facility"
      submitted_at: new Date().toISOString(),
      details: applicant.details || {},
    }),
  };
  const customer = await getOrCreateCustomer(env, buyerLike);

  // TODO: 運営者へのメール通知（Cloudflare Email Workers / 外部 SMTP）
  console.log(`[apply] ${type} application received:`, customer.id);

  return jsonResponse({
    ok: true,
    customer_id: customer.id,
    type,
  }, 200, env, origin);
}

// === /api/cancel — 退会 ===

async function handleCancel(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'invalid_json' }, 400, env, origin);

  // 互換: customer_email でも email でも受ける
  const subscription_id = body.subscription_id;
  const email = body.email || body.customer_email;
  if (!subscription_id || !email) {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }

  const auth = await authBySubAndEmail(env, subscription_id, email);
  if (auth.error) return jsonResponse({ error: auth.error }, auth.status, env, origin);

  const canceled = await cancelSubscription(env, subscription_id);
  return jsonResponse({
    ok: true,
    status: canceled.status,
    canceled_date: canceled.canceled_date,
  }, 200, env, origin);
}

// 共通: subscription_id + email でユーザー本人確認、sub と customer を返す
async function authBySubAndEmail(env, subscriptionId, email) {
  const sub = await retrieveSubscription(env, subscriptionId);
  if (!sub) return { error: 'not_found', status: 404 };
  const customer = await retrieveCustomer(env, sub.customer_id);
  const actualEmail = customer?.email_address;
  if (!actualEmail || actualEmail.toLowerCase() !== String(email).toLowerCase()) {
    return { error: 'email_mismatch', status: 403 };
  }
  return { sub, customer };
}

// === /api/lookup — マイページ用：subscription_id + email で現状取得 ===

async function handleLookup(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'invalid_json' }, 400, env, origin);

  const { subscription_id, email } = body;
  if (!subscription_id || !email) {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }

  const auth = await authBySubAndEmail(env, subscription_id, email);
  if (auth.error) return jsonResponse({ error: auth.error }, auth.status, env, origin);

  const { sub, customer } = auth;
  const facilityId = parseFacilityFromSourceName(sub.source?.name);
  const facility = findFacility(env, facilityId);

  return jsonResponse({
    ok: true,
    subscription: {
      id: sub.id,
      status: sub.status,
      start_date: sub.start_date,
      charged_through_date: sub.charged_through_date,
      paid_until_date: sub.paid_until_date,
      canceled_date: sub.canceled_date || null,
      next_billing_date: sub.charged_through_date || null,
    },
    customer: {
      given_name: customer?.given_name || '',
      family_name: customer?.family_name || '',
      email_address: customer?.email_address || '',
    },
    facility_id: facilityId,
    facility, // {id,name,location,accepting} or null
    facilities: getFacilities(env), // 切替候補
  }, 200, env, origin);
}

// === /api/change-facility — 支援先変更（解約せずに） ===

async function handleChangeFacility(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'invalid_json' }, 400, env, origin);

  const { subscription_id, email, new_facility_id } = body;
  if (!subscription_id || !email || !new_facility_id) {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }
  if (!isValidFacilityId(env, new_facility_id)) {
    return jsonResponse({ error: 'invalid_facility' }, 400, env, origin);
  }

  const auth = await authBySubAndEmail(env, subscription_id, email);
  if (auth.error) return jsonResponse({ error: auth.error }, auth.status, env, origin);

  // source.name を新 facility_id で書き換え
  const updated = await updateSubscription(env, subscription_id, {
    source: { name: `Care Support Pass / ${new_facility_id}` },
  });

  return jsonResponse({
    ok: true,
    subscription_id: updated.id,
    facility_id: new_facility_id,
    source_name: updated.source?.name,
  }, 200, env, origin);
}

// === /api/webhook === （変更なし）

async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get('x-square-hmacsha256-signature');
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

  await handleEvent(env, event);
  return new Response('ok', { status: 200 });
}
