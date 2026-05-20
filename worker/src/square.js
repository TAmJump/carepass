// Square API ラッパー — Cloudflare Workers の fetch だけで動く軽量実装
// 公式 SDK は重いし Workers ランタイムで動作確認が手間なので使わない

const SQUARE_VERSION = '2026-01-22';

function baseUrl(env) {
  return env.SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

async function sq(env, method, path, body) {
  const res = await fetch(`${baseUrl(env)}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    console.error('Square API error:', res.status, JSON.stringify(json));
    const err = new Error(`Square API ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function uuid() {
  return crypto.randomUUID();
}

// --- 日付ユーティリティ (JST=Asia/Tokyo 基準) ---

// 「Asia/Tokyo の今日」を YYYY-MM-DD で返す
export function todayJst() {
  // toLocaleString で TZ 変換した YYYY/M/D を YYYY-MM-DD に整形
  const now = new Date();
  const fmt = now.toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  // 'YYYY/MM/DD' → 'YYYY-MM-DD'
  return fmt.replace(/\//g, '-');
}

// 申込日 (JST) の翌月1日を YYYY-MM-DD で返す
//   2026-05-20 → 2026-06-01
//   2026-12-31 → 2027-01-01
export function firstDayOfNextMonthJst() {
  const today = todayJst(); // YYYY-MM-DD
  const [yStr, mStr] = today.split('-');
  let y = parseInt(yStr, 10);
  let m = parseInt(mStr, 10); // 1-12
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

// --- Customers ---

export async function searchCustomerByEmail(env, email) {
  const res = await sq(env, 'POST', '/v2/customers/search', {
    query: {
      filter: {
        email_address: { exact: email },
      },
    },
    limit: 1,
  });
  return (res.customers && res.customers[0]) || null;
}

export async function createCustomer(env, buyer) {
  const body = {
    idempotency_key: uuid(),
    given_name: buyer.given_name,
    family_name: buyer.family_name,
    email_address: buyer.email_address,
    phone_number: buyer.phone_number,
    company_name: buyer.company_name,
    address: buyer.address,
    note: buyer.metadata ? JSON.stringify(buyer.metadata) : undefined,
  };
  const res = await sq(env, 'POST', '/v2/customers', body);
  return res.customer;
}

export async function getOrCreateCustomer(env, buyer) {
  if (!buyer.email_address) {
    throw new Error('email_address is required');
  }
  const found = await searchCustomerByEmail(env, buyer.email_address);
  if (found) return found;
  return await createCustomer(env, buyer);
}

// --- Cards ---

export async function createCard(env, customerId, sourceId, verificationToken, billingAddress) {
  // billing_address: undefined/null は省略。空オブジェクトもSquareが嫌うので除去。
  const cleanedAddress = billingAddress && Object.keys(billingAddress).some(k => billingAddress[k])
    ? Object.fromEntries(Object.entries(billingAddress).filter(([_, v]) => v))
    : undefined;
  const body = {
    idempotency_key: uuid(),
    source_id: sourceId,
    ...(verificationToken ? { verification_token: verificationToken } : {}),
    card: {
      customer_id: customerId,
      ...(cleanedAddress ? { billing_address: cleanedAddress } : {}),
    },
  };
  console.log('createCard payload:', JSON.stringify({
    source_id_len: sourceId?.length,
    source_id_prefix: sourceId?.slice(0, 16),
    has_verification_token: !!verificationToken,
    verification_token_len: verificationToken?.length,
    customer_id: customerId,
    billing_address: cleanedAddress,
  }));
  const res = await sq(env, 'POST', '/v2/cards', body);
  return res.card;
}

// --- Payments (単発決済) ---

// CreatePayment: 申込時の即時 ¥100 を card_id (保存済カード) で課金する
//   ref: https://developer.squareup.com/reference/square/payments-api/create-payment
export async function chargeOneShotByCardId(env, { customerId, cardId, amount, currency = 'JPY', note }) {
  const body = {
    idempotency_key: uuid(),
    source_id: cardId,
    amount_money: { amount, currency },
    location_id: env.SQUARE_LOCATION_ID,
    customer_id: customerId,
    note: note || 'Care Support Pass / initial charge',
    autocomplete: true,
  };
  const res = await sq(env, 'POST', '/v2/payments', body);
  return res.payment;
}

// --- Subscriptions ---

// CreateSubscription: 翌月初を start_date、月末を anchor として作成
// 申込時の即時 ¥100 は本関数の責務ではなく、別途 chargeOneShotByCardId で処理する。
export async function createSubscription(env, { customerId, planVariationId, cardId, facilityId, startDate }) {
  const body = {
    idempotency_key: uuid(),
    location_id: env.SQUARE_LOCATION_ID,
    plan_variation_id: planVariationId,
    customer_id: customerId,
    card_id: cardId,
    timezone: 'Asia/Tokyo',
    source: {
      name: facilityId ? `Care Support Pass / ${facilityId}` : 'Care Support Pass',
    },
    ...(startDate ? { start_date: startDate } : {}),
  };
  const res = await sq(env, 'POST', '/v2/subscriptions', body);
  return res.subscription;
}

export async function retrieveSubscription(env, subscriptionId) {
  const res = await sq(env, 'GET', `/v2/subscriptions/${subscriptionId}`);
  return res.subscription;
}

export async function retrieveCustomer(env, customerId) {
  const res = await sq(env, 'GET', `/v2/customers/${customerId}`);
  return res.customer;
}

export async function cancelSubscription(env, subscriptionId) {
  // CancelSubscription: 現在の請求サイクル終了時に終了 = 翌月末から停止
  const res = await sq(env, 'POST', `/v2/subscriptions/${subscriptionId}/cancel`);
  return res.subscription;
}

// UpdateSubscription: source.name の書き換え等に使う (支援先施設の変更)
export async function updateSubscription(env, subscriptionId, patch) {
  const res = await sq(env, 'PUT', `/v2/subscriptions/${subscriptionId}`, {
    subscription: patch,
  });
  return res.subscription;
}
