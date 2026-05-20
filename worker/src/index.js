// Care Support Pass — Cloudflare Workers Backend (Phase 1)
//
// 役割: 個人会員の Square Subscription 作成・退会・Webhook 受信、
//       加盟店/介護施設の申込受付、
//       マイページ用の認証 (マジックリンク + 申込番号フォールバック)。
//
// エンドポイント:
//   既存:
//     GET  /api/health                    死活確認
//     GET  /api/config                    フロント用 Square 設定 + 施設一覧
//     POST /api/subscribe                 個人会員: フォーム送信→Square Subscription 作成 + account作成 + 申込完了メール
//     POST /api/apply                     加盟店/施設の申込受付
//     POST /api/cancel                    退会 (申込番号+メアド 互換: 旧 mypage)
//     POST /api/lookup                    申込番号+メアドで状態取得 (旧 mypage)
//     POST /api/change-facility           申込番号+メアドで支援先変更 (旧 mypage)
//     POST /api/webhook                   Square Webhook
//
//   Phase 1 新規 (マジックリンクログイン):
//     POST /api/auth/request-magic-link   {email} → トークン発行 + メール送信
//     GET  /api/auth/verify-magic-link    ?token=... → セッション作成 + サイトへ302
//     POST /api/auth/logout               セッション破棄
//     GET  /api/auth/me                   現在のセッション情報
//     GET  /api/me/subscription           ログイン中の Subscription 状態
//     POST /api/me/change-facility        ログイン中の支援先変更
//     POST /api/me/cancel                 ログイン中の解約

import { handleOptions, jsonResponse, redirectResponse } from './cors.js';
import {
  getOrCreateCustomer,
  createCard,
  createSubscription,
  retrieveSubscription,
  retrieveCustomer,
  cancelSubscription,
  updateSubscription,
  chargeOneShotByCardId,
  firstDayOfNextMonthJst,
} from './square.js';
import {
  getMembershipVariationId,
  getFacilities,
  isValidFacilityId,
  parseFacilityFromSourceName,
  findFacility,
} from './plans.js';
import { verifySquareSignature, handleEvent } from './webhook.js';
import {
  findAccountByEmail,
  getOrCreateAccount,
  upsertMember,
  findMemberBySubscriptionId,
  createLoginToken,
  consumeLoginToken,
  createSession,
  deleteSession,
  recordWebhookEvent,
  markWebhookProcessed,
} from './db.js';
import {
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  buildClearSessionCookie,
  getCurrentAccount,
  requireAuth,
} from './auth.js';
import { sendSubscribeWelcome, sendMagicLink, sendCancelConfirmation } from './mail.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const path = url.pathname;

    if (request.method === 'OPTIONS') return handleOptions(request, env);

    try {
      // --- 公開 ---
      if (path === '/api/health' && request.method === 'GET') {
        return jsonResponse({
          ok: true,
          env: env.SQUARE_ENV,
          db: !!env.DB,
          mail: !!env.MAIL_API_TOKEN,
        }, 200, env, origin);
      }

      if (path === '/api/config' && request.method === 'GET') {
        return jsonResponse({
          application_id: env.SQUARE_APPLICATION_ID,
          location_id: env.SQUARE_LOCATION_ID,
          env: env.SQUARE_ENV,
          facilities: getFacilities(env),
        }, 200, env, origin);
      }

      // --- 決済 / 申込 ---
      if (path === '/api/subscribe' && request.method === 'POST') {
        return await handleSubscribe(request, env, origin);
      }
      if (path === '/api/apply' && request.method === 'POST') {
        return await handleApply(request, env, origin);
      }

      // --- 旧 mypage (申込番号+メアド): 互換維持 ---
      if (path === '/api/cancel' && request.method === 'POST') {
        return await handleCancel(request, env, origin);
      }
      if (path === '/api/lookup' && request.method === 'POST') {
        return await handleLookup(request, env, origin);
      }
      if (path === '/api/change-facility' && request.method === 'POST') {
        return await handleChangeFacility(request, env, origin);
      }

      // --- 新 マジックリンク認証 ---
      if (path === '/api/auth/request-magic-link' && request.method === 'POST') {
        return await handleRequestMagicLink(request, env, origin);
      }
      if (path === '/api/auth/verify-magic-link' && request.method === 'GET') {
        return await handleVerifyMagicLink(request, env, origin, url);
      }
      if (path === '/api/auth/logout' && request.method === 'POST') {
        return await handleLogout(request, env, origin);
      }
      if (path === '/api/auth/me' && request.method === 'GET') {
        return await handleAuthMe(request, env, origin);
      }

      // --- 新 セッションベース me ---
      if (path === '/api/me/subscription' && request.method === 'GET') {
        return await handleMeSubscription(request, env, origin);
      }
      if (path === '/api/me/change-facility' && request.method === 'POST') {
        return await handleMeChangeFacility(request, env, origin);
      }
      if (path === '/api/me/cancel' && request.method === 'POST') {
        return await handleMeCancel(request, env, origin);
      }

      // --- Webhook ---
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

// =====================================================================
// /api/subscribe
// =====================================================================

async function handleSubscribe(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'invalid_json' }, 400, env, origin);

  const { source_id, verification_token, buyer, facility_id } = body;
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

  // 1. Square Customer
  const buyerWithMeta = {
    ...buyer,
    metadata: { ...(buyer.metadata || {}), facility_id },
  };
  const customer = await getOrCreateCustomer(env, buyerWithMeta);

  // 2. Card
  let effectiveSourceId = source_id;
  if (env.SQUARE_ENV === 'sandbox' && source_id && source_id.startsWith('cnon:') && source_id !== 'cnon:card-nonce-ok') {
    console.log('Sandbox: replacing source_id with cnon:card-nonce-ok');
    effectiveSourceId = 'cnon:card-nonce-ok';
  }
  const card = await createCard(
    env,
    customer.id,
    effectiveSourceId,
    env.SQUARE_ENV === 'sandbox' ? undefined : verification_token,
    buyer.address
  );

  // 3. 即時 ¥100 課金 (単発 CreatePayment, card_id 経由)
  //   - Subscription とは別。これが「申込時の決済」。
  //   - 失敗したら以降のステップに進まず BAD GATEWAY を返す (会員になっていない状態を維持)。
  let initialPayment;
  try {
    initialPayment = await chargeOneShotByCardId(env, {
      customerId: customer.id,
      cardId: card.id,
      amount: 100,
      currency: 'JPY',
      note: `Care Support Pass / initial ¥100 / facility=${facility_id}`,
    });
  } catch (e) {
    console.error('[subscribe] initial charge failed:', e.message, JSON.stringify(e.body || {}));
    return jsonResponse({
      error: 'initial_charge_failed',
      message: 'カードへの初回課金が拒否されました。カード情報をご確認ください。',
    }, 402, env, origin);
  }

  // 4. Subscription を翌月初 start_date で作成 (anchor=31 = 月末締め)
  //   - Square Plan Variation 側で monthly_billing_anchor_date=31 設定済みなので、
  //     start_date が翌月初なら最初の課金は翌月末になる。
  const subStartDate = firstDayOfNextMonthJst();
  const subscription = await createSubscription(env, {
    customerId: customer.id,
    planVariationId: variationId,
    cardId: card.id,
    facilityId: facility_id,
    startDate: subStartDate,
  });

  // 4. D1: account + member (DB が無くてもサイト本体機能は壊さない)
  let magicLinkUrl = null;
  if (env.DB) {
    try {
      const displayName = `${buyer.family_name || ''} ${buyer.given_name || ''}`.trim() || null;
      const account = await getOrCreateAccount(env, {
        email: buyer.email_address,
        role: 'member',
        display_name: displayName,
        square_customer_id: customer.id,
      });
      await upsertMember(env, {
        account_id: account.id,
        square_subscription_id: subscription.id,
        current_facility_id: facility_id,
      });
      // マジックリンク発行
      const { token } = await createLoginToken(env, account.id, 60 * 24 * 7); // 申込完了メール用は7日有効
      const siteBase = env.SITE_BASE_URL || 'https://carepass.tamjump.com';
      magicLinkUrl = `https://carepass-api.tamjump.com/api/auth/verify-magic-link?token=${token}&next=${encodeURIComponent(siteBase + '/mypage.html')}`;
    } catch (e) {
      // DB エラーはログだけしてレスポンスは成功扱い (Subscription は完了している)
      console.error('[subscribe] D1 sync failed:', e.message, e.stack);
    }
  }

  // 5. 申込完了メール (best-effort, 失敗してもサブスクは成立)
  //   firstBillingDate = subStartDate (= 翌月1日) の月末 = 翌月末
  try {
    const facility = findFacility(env, facility_id);
    // subStartDate "2026-06-01" → 翌月末 "2026-06-30"
    const [sy, sm] = subStartDate.split('-').map((x) => parseInt(x, 10));
    const lastDay = new Date(Date.UTC(sy, sm, 0)).getUTCDate(); // Date.UTC(year, month, 0) = 前月末日
    const firstBillingDate = `${sy}-${String(sm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    await sendSubscribeWelcome(env, {
      to: buyer.email_address,
      displayName: `${buyer.family_name || ''} ${buyer.given_name || ''}`.trim(),
      subscriptionId: subscription.id,
      facilityName: facility ? `${facility.name}${facility.location ? `（${facility.location}）` : ''}` : facility_id,
      mypageUrl: (env.SITE_BASE_URL || 'https://carepass.tamjump.com') + '/mypage.html',
      magicLinkUrl: magicLinkUrl || ((env.SITE_BASE_URL || 'https://carepass.tamjump.com') + `/mypage.html?sid=${subscription.id}&email=${encodeURIComponent(buyer.email_address)}`),
      initialAmountJpy: 100,
      initialPaidAt: new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      firstBillingDate,
    });
  } catch (e) {
    console.error('[subscribe] mail send failed:', e.message);
  }

  return jsonResponse({
    ok: true,
    subscription_id: subscription.id,
    customer_id: customer.id,
    status: subscription.status,
    facility_id,
    initial_payment_id: initialPayment?.id || null,
    next_billing_start: subStartDate,
  }, 200, env, origin);
}

// =====================================================================
// /api/apply (変更なし)
// =====================================================================

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

  const buyerLike = {
    ...applicant,
    note: JSON.stringify({
      kind: type,
      submitted_at: new Date().toISOString(),
      details: applicant.details || {},
    }),
  };
  const customer = await getOrCreateCustomer(env, buyerLike);
  console.log(`[apply] ${type} application received:`, customer.id);

  return jsonResponse({ ok: true, customer_id: customer.id, type }, 200, env, origin);
}

// =====================================================================
// 旧: /api/cancel /api/lookup /api/change-facility (申込番号+メアド)
// =====================================================================

async function handleCancel(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'invalid_json' }, 400, env, origin);
  const subscription_id = body.subscription_id;
  const email = body.email || body.customer_email;
  if (!subscription_id || !email) {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }
  const auth = await authBySubAndEmail(env, subscription_id, email);
  if (auth.error) return jsonResponse({ error: auth.error }, auth.status, env, origin);
  const canceled = await cancelSubscription(env, subscription_id);
  // 解約完了メール
  try {
    await sendCancelConfirmation(env, {
      to: auth.customer?.email_address || email,
      displayName: `${auth.customer?.family_name || ''} ${auth.customer?.given_name || ''}`.trim(),
      subscriptionId: subscription_id,
      canceledDate: canceled.canceled_date,
    });
  } catch (e) {
    console.error('[cancel] mail failed:', e.message);
  }
  return jsonResponse({
    ok: true,
    status: canceled.status,
    canceled_date: canceled.canceled_date,
  }, 200, env, origin);
}

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

async function handleLookup(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'invalid_json' }, 400, env, origin);
  const { subscription_id, email } = body;
  if (!subscription_id || !email) {
    return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  }
  const auth = await authBySubAndEmail(env, subscription_id, email);
  if (auth.error) return jsonResponse({ error: auth.error }, auth.status, env, origin);
  return jsonResponse(buildLookupPayload(env, auth.sub, auth.customer), 200, env, origin);
}

function buildLookupPayload(env, sub, customer) {
  const facilityId = parseFacilityFromSourceName(sub.source?.name);
  const facility = findFacility(env, facilityId);

  // 次回課金日の決定ロジック:
  //   - charged_through_date があればそれ (= 既に1回以上課金された Subscription)
  //   - 無ければ start_date の月末を返す (= PENDING / 初課金前の Subscription)
  let nextBillingDate = sub.charged_through_date || null;
  if (!nextBillingDate && sub.start_date) {
    nextBillingDate = endOfMonthOf(sub.start_date);
  }

  return {
    ok: true,
    subscription: {
      id: sub.id,
      status: sub.status,
      start_date: sub.start_date,
      charged_through_date: sub.charged_through_date,
      paid_until_date: sub.paid_until_date,
      canceled_date: sub.canceled_date || null,
      next_billing_date: nextBillingDate,
    },
    customer: {
      given_name: customer?.given_name || '',
      family_name: customer?.family_name || '',
      email_address: customer?.email_address || '',
    },
    facility_id: facilityId,
    facility,
    facilities: getFacilities(env),
  };
}

// "YYYY-MM-DD" → 同月の末日 "YYYY-MM-DD"
//   2026-06-01 → 2026-06-30
//   2026-02-15 → 2026-02-28 (2024-02-15 → 2024-02-29)
function endOfMonthOf(ymd) {
  const [y, m] = ymd.split('-').map((x) => parseInt(x, 10));
  // Date.UTC(year, month, 0) = month-1 月の末日
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

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
  const updated = await updateSubscription(env, subscription_id, {
    source: { name: `Care Support Pass / ${new_facility_id}` },
  });
  // D1 にも反映 (best-effort)
  if (env.DB) {
    try {
      const member = await findMemberBySubscriptionId(env, subscription_id);
      if (member) {
        await env.DB.prepare('UPDATE members SET current_facility_id = ? WHERE square_subscription_id = ?')
          .bind(new_facility_id, subscription_id).run();
      }
    } catch (e) { console.error('[change-facility] D1 sync failed:', e.message); }
  }
  return jsonResponse({
    ok: true,
    subscription_id: updated.id,
    facility_id: new_facility_id,
    source_name: updated.source?.name,
  }, 200, env, origin);
}

// =====================================================================
// 新: マジックリンク認証
// =====================================================================

// セキュリティ: メアドが accounts に存在するかは応答から判別できないようにする (oracle回避)
//   → 存在しなくても 200 ok を返す。送信は内部判定。
async function handleRequestMagicLink(request, env, origin) {
  if (!env.DB) {
    return jsonResponse({ error: 'db_not_configured' }, 500, env, origin);
  }
  const body = await request.json().catch(() => null);
  if (!body || !body.email) return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  const email = String(body.email).trim().toLowerCase();
  if (!email.includes('@')) return jsonResponse({ error: 'invalid_email' }, 400, env, origin);

  const account = await findAccountByEmail(env, email);
  if (account) {
    const { token } = await createLoginToken(env, account.id, 15);
    const siteBase = env.SITE_BASE_URL || 'https://carepass.tamjump.com';
    const magicLinkUrl = `https://carepass-api.tamjump.com/api/auth/verify-magic-link?token=${token}&next=${encodeURIComponent(siteBase + '/mypage.html')}`;
    try {
      await sendMagicLink(env, { to: email, magicLinkUrl, displayName: account.display_name });
    } catch (e) {
      console.error('[magic-link] mail failed:', e.message);
    }
  } else {
    // アカウント無し → 何もしないが応答は ok
    console.log('[magic-link] no account for:', email);
  }
  return jsonResponse({ ok: true, message: 'メールアドレス宛にログインリンクをお送りしました（登録のあるメールの場合のみ）。' }, 200, env, origin);
}

async function handleVerifyMagicLink(request, env, origin, url) {
  if (!env.DB) {
    return jsonResponse({ error: 'db_not_configured' }, 500, env, origin);
  }
  const token = url.searchParams.get('token');
  const next = url.searchParams.get('next') || ((env.SITE_BASE_URL || 'https://carepass.tamjump.com') + '/mypage.html');
  if (!token) {
    return jsonResponse({ error: 'missing_token' }, 400, env, origin);
  }
  const result = await consumeLoginToken(env, token);
  if (result.error) {
    // エラー時はマイページにエラーパラメータ付きでリダイレクト
    const errUrl = `${next}${next.includes('?') ? '&' : '?'}login_error=${encodeURIComponent(result.error)}`;
    return redirectResponse(errUrl, env, origin);
  }
  // セッション作成 + Set-Cookie + 302
  const { id: sid, expires_at } = await createSession(env, result.account.id, 30);
  const cookie = buildSessionCookie(sid, expires_at);
  return redirectResponse(next, env, origin, { 'Set-Cookie': cookie });
}

async function handleLogout(request, env, origin) {
  if (!env.DB) return jsonResponse({ ok: true }, 200, env, origin);
  const current = await getCurrentAccount(env, request);
  if (current) {
    await deleteSession(env, current.session.id);
  }
  return jsonResponse({ ok: true }, 200, env, origin, { 'Set-Cookie': buildClearSessionCookie() });
}

async function handleAuthMe(request, env, origin) {
  if (!env.DB) return jsonResponse({ authenticated: false, db_not_configured: true }, 200, env, origin);
  const current = await getCurrentAccount(env, request);
  if (!current) {
    return jsonResponse({ authenticated: false }, 200, env, origin);
  }
  return jsonResponse({
    authenticated: true,
    account: {
      id: current.account.id,
      email: current.account.email,
      role: current.account.role,
      display_name: current.account.display_name,
    },
  }, 200, env, origin);
}

// =====================================================================
// 新: セッションベース /api/me/*
// =====================================================================

async function handleMeSubscription(request, env, origin) {
  const auth = await requireAuth(env, request, jsonResponse, origin);
  if (!auth.ok) return auth.response;

  // members から sub_id を引き、Square から最新状態を取得
  if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500, env, origin);
  const member = await env.DB.prepare('SELECT * FROM members WHERE account_id = ? LIMIT 1')
    .bind(auth.account.id).first();
  if (!member) return jsonResponse({ error: 'no_membership' }, 404, env, origin);

  const sub = await retrieveSubscription(env, member.square_subscription_id);
  if (!sub) return jsonResponse({ error: 'subscription_not_found' }, 404, env, origin);
  const customer = auth.account.square_customer_id
    ? await retrieveCustomer(env, auth.account.square_customer_id)
    : { email_address: auth.account.email, given_name: '', family_name: '' };

  return jsonResponse(buildLookupPayload(env, sub, customer), 200, env, origin);
}

async function handleMeChangeFacility(request, env, origin) {
  const auth = await requireAuth(env, request, jsonResponse, origin);
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  if (!body || !body.new_facility_id) return jsonResponse({ error: 'missing_fields' }, 400, env, origin);
  if (!isValidFacilityId(env, body.new_facility_id)) {
    return jsonResponse({ error: 'invalid_facility' }, 400, env, origin);
  }
  const member = await env.DB.prepare('SELECT * FROM members WHERE account_id = ? LIMIT 1')
    .bind(auth.account.id).first();
  if (!member) return jsonResponse({ error: 'no_membership' }, 404, env, origin);

  const updated = await updateSubscription(env, member.square_subscription_id, {
    source: { name: `Care Support Pass / ${body.new_facility_id}` },
  });
  await env.DB.prepare('UPDATE members SET current_facility_id = ? WHERE account_id = ?')
    .bind(body.new_facility_id, auth.account.id).run();

  return jsonResponse({
    ok: true,
    subscription_id: updated.id,
    facility_id: body.new_facility_id,
    source_name: updated.source?.name,
  }, 200, env, origin);
}

async function handleMeCancel(request, env, origin) {
  const auth = await requireAuth(env, request, jsonResponse, origin);
  if (!auth.ok) return auth.response;
  const member = await env.DB.prepare('SELECT * FROM members WHERE account_id = ? LIMIT 1')
    .bind(auth.account.id).first();
  if (!member) return jsonResponse({ error: 'no_membership' }, 404, env, origin);

  const canceled = await cancelSubscription(env, member.square_subscription_id);
  // 解約完了メール
  try {
    await sendCancelConfirmation(env, {
      to: auth.account.email,
      displayName: auth.account.display_name,
      subscriptionId: member.square_subscription_id,
      canceledDate: canceled.canceled_date,
    });
  } catch (e) {
    console.error('[me/cancel] mail failed:', e.message);
  }
  return jsonResponse({
    ok: true,
    status: canceled.status,
    canceled_date: canceled.canceled_date,
  }, 200, env, origin);
}

// =====================================================================
// /api/webhook
// =====================================================================

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

  // D1 に冪等記録
  if (env.DB && event.event_id) {
    try {
      await recordWebhookEvent(env, {
        id: event.event_id,
        event_type: event.type,
        payload_json: rawBody,
      });
    } catch (e) { console.error('[webhook] record failed:', e.message); }
  }

  await handleEvent(env, event);

  if (env.DB && event.event_id) {
    try { await markWebhookProcessed(env, event.event_id); } catch (e) {}
  }
  return new Response('ok', { status: 200 });
}
