// Cloudflare D1 ヘルパー
// env.DB は wrangler.toml の [[d1_databases]] binding によって注入される

export function db(env) {
  if (!env.DB) {
    throw new Error('D1 binding "DB" is not configured. Add [[d1_databases]] to wrangler.toml.');
  }
  return env.DB;
}

export function uuid() {
  return crypto.randomUUID();
}

// 短いランダムトークン (マジックリンク・セッションID用)
// 32 byte = 64 hex chars
export function randomToken(byteLen = 32) {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function nowIso() {
  return new Date().toISOString();
}

// expires: nowIso() からN分後のISO文字列
export function isoMinutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

// =====================================================================
// accounts
// =====================================================================

export async function findAccountByEmail(env, email) {
  const r = await db(env)
    .prepare('SELECT * FROM accounts WHERE email = ? LIMIT 1')
    .bind(email.toLowerCase())
    .first();
  return r || null;
}

export async function findAccountById(env, id) {
  const r = await db(env)
    .prepare('SELECT * FROM accounts WHERE id = ? LIMIT 1')
    .bind(id)
    .first();
  return r || null;
}

export async function createAccount(env, { email, role = 'member', display_name = null, square_customer_id = null }) {
  const id = uuid();
  await db(env)
    .prepare(`INSERT INTO accounts (id, email, role, display_name, square_customer_id)
              VALUES (?, ?, ?, ?, ?)`)
    .bind(id, email.toLowerCase(), role, display_name, square_customer_id)
    .run();
  return await findAccountById(env, id);
}

export async function getOrCreateAccount(env, params) {
  const existing = await findAccountByEmail(env, params.email);
  if (existing) {
    // square_customer_id が無ければ補完
    if (params.square_customer_id && !existing.square_customer_id) {
      await db(env)
        .prepare('UPDATE accounts SET square_customer_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .bind(params.square_customer_id, existing.id)
        .run();
      return await findAccountById(env, existing.id);
    }
    return existing;
  }
  return await createAccount(env, params);
}

// =====================================================================
// members
// =====================================================================

export async function upsertMember(env, { account_id, square_subscription_id, current_facility_id }) {
  // 既存があれば facility_id 更新
  const existing = await db(env)
    .prepare('SELECT account_id FROM members WHERE account_id = ? LIMIT 1')
    .bind(account_id)
    .first();
  if (existing) {
    await db(env)
      .prepare(`UPDATE members SET square_subscription_id = ?, current_facility_id = ? WHERE account_id = ?`)
      .bind(square_subscription_id, current_facility_id, account_id)
      .run();
  } else {
    await db(env)
      .prepare(`INSERT INTO members (account_id, square_subscription_id, current_facility_id)
                VALUES (?, ?, ?)`)
      .bind(account_id, square_subscription_id, current_facility_id)
      .run();
  }
  return await db(env)
    .prepare('SELECT * FROM members WHERE account_id = ? LIMIT 1')
    .bind(account_id)
    .first();
}

export async function findMemberBySubscriptionId(env, subId) {
  return await db(env)
    .prepare('SELECT * FROM members WHERE square_subscription_id = ? LIMIT 1')
    .bind(subId)
    .first();
}

// =====================================================================
// login_tokens (マジックリンク)
// =====================================================================

export async function createLoginToken(env, account_id, ttlMinutes = 15) {
  const token = randomToken(32);
  const expires_at = isoMinutesFromNow(ttlMinutes);
  await db(env)
    .prepare(`INSERT INTO login_tokens (token, account_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, account_id, expires_at)
    .run();
  return { token, expires_at };
}

export async function consumeLoginToken(env, token) {
  const row = await db(env)
    .prepare(`SELECT * FROM login_tokens WHERE token = ? LIMIT 1`)
    .bind(token)
    .first();
  if (!row) return { error: 'token_not_found' };
  if (row.consumed_at) return { error: 'token_already_used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { error: 'token_expired' };

  await db(env)
    .prepare(`UPDATE login_tokens SET consumed_at = datetime('now') WHERE token = ?`)
    .bind(token)
    .run();

  const account = await findAccountById(env, row.account_id);
  if (!account) return { error: 'account_not_found' };
  return { account };
}

// =====================================================================
// sessions
// =====================================================================

export async function createSession(env, account_id, ttlDays = 30) {
  const id = randomToken(32);
  const expires_at = isoDaysFromNow(ttlDays);
  await db(env)
    .prepare(`INSERT INTO sessions (id, account_id, expires_at, last_seen_at) VALUES (?, ?, ?, datetime('now'))`)
    .bind(id, account_id, expires_at)
    .run();
  return { id, expires_at };
}

export async function findSession(env, session_id) {
  const row = await db(env)
    .prepare(`SELECT * FROM sessions WHERE id = ? LIMIT 1`)
    .bind(session_id)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export async function touchSession(env, session_id) {
  await db(env)
    .prepare(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`)
    .bind(session_id)
    .run();
}

export async function deleteSession(env, session_id) {
  await db(env)
    .prepare(`DELETE FROM sessions WHERE id = ?`)
    .bind(session_id)
    .run();
}

// =====================================================================
// webhook_events
// =====================================================================

export async function recordWebhookEvent(env, { id, event_type, payload_json }) {
  // INSERT OR IGNORE: 同じ event_id を二度受け取っても無害
  await db(env)
    .prepare(`INSERT OR IGNORE INTO webhook_events (id, event_type, payload_json) VALUES (?, ?, ?)`)
    .bind(id, event_type, payload_json)
    .run();
}

export async function markWebhookProcessed(env, id) {
  await db(env)
    .prepare(`UPDATE webhook_events SET processed_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();
}
