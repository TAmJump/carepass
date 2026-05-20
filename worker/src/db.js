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
// パスワード検証 (PBKDF2-SHA256)
// =====================================================================
//
// 格納フォーマット: `pbkdf2$<iter>$<salt_hex>$<hash_hex>`
//   iter      : 反復回数 (例: 100000)
//   salt_hex  : 16 byte (32 hex chars)
//   hash_hex  : 32 byte (64 hex chars)
//
// node でハッシュ生成:
//   node -e "const c=require('crypto');const p=process.argv[1];
//            const s=c.randomBytes(16);
//            const h=c.pbkdf2Sync(p,s,100000,32,'sha256');
//            console.log('pbkdf2\\$100000\\$'+s.toString('hex')+'\\$'+h.toString('hex'));" "PASSWORD"
//
// Cloudflare Workers の Web Crypto で同じ計算をして比較する。
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
// 定数時間比較 (timing-safe)
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(plain, storedHash) {
  if (!plain || !storedHash) return false;
  const parts = String(storedHash).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  const saltHex = parts[2];
  const expectedHex = parts[3];
  if (!iter || !saltHex || !expectedHex) return false;

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(plain), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(saltHex),
      iterations: iter,
      hash: 'SHA-256',
    },
    keyMaterial,
    expectedHex.length * 4, // 32byte = 256bit (1 hex char = 4 bit)
  );
  const actualHex = bytesToHex(bits);
  return timingSafeEqualHex(actualHex, expectedHex);
}

// 新規パスワードを PBKDF2-SHA256 でハッシュ化 (登録/変更時)
export async function hashPassword(plain, iter = 100000) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(plain), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: iter, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return `pbkdf2$${iter}$${bytesToHex(saltBytes)}$${bytesToHex(bits)}`;
}

// account の password_hash を更新
export async function setAccountPassword(env, accountId, passwordHash) {
  await db(env)
    .prepare('UPDATE accounts SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(passwordHash, accountId)
    .run();
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
// member_coupons: 新規会員への自動配布
// =====================================================================
//
// 「公開中 (status='published') かつ 有効期間内」のクーポンを、
// その会員にまだ持たせていないものだけ 'available' で配布する。
// 申込時 + クーポン公開時 (将来) の両方から呼べる冪等な実装。
export async function grantPublishedCouponsToMember(env, accountId) {
  const nowIsoStr = nowIso();
  const candidates = await db(env)
    .prepare(`
      SELECT c.id FROM coupons c
       WHERE c.status = 'published'
         AND c.valid_from  <= ?
         AND c.valid_until >= ?
         AND NOT EXISTS (
           SELECT 1 FROM member_coupons mc
            WHERE mc.account_id = ? AND mc.coupon_id = c.id
         )
    `)
    .bind(nowIsoStr, nowIsoStr, accountId)
    .all();
  const rows = candidates?.results || candidates || [];
  let granted = 0;
  for (const c of rows) {
    try {
      await db(env)
        .prepare(`INSERT INTO member_coupons (id, account_id, coupon_id, state) VALUES (?, ?, ?, 'available')`)
        .bind(uuid(), accountId, c.id)
        .run();
      granted++;
    } catch (e) {
      console.warn('[grantCoupons] insert failed for coupon', c.id, e.message);
    }
  }
  return granted;
}

// =====================================================================
// member_coupons: クーポン公開時に全アクティブ会員へ自動配布
// =====================================================================
//
// 1つのクーポンを、全てのアクティブ会員(accounts.status='active' かつ
// members レコードを持つ会員) のうち、まだ持っていない人へ 'available' で配布。
// クーポンが status='published' かつ有効期間内であることを確認する。
// 冪等: 既に持っている会員には INSERT しない (UNIQUE 制約 + EXISTS チェック)。
//
// 呼び出し: クーポン新規作成時 (status='published'), クーポン公開遷移時
// (status: draft → published)。
//
// 戻り値: { granted: 配布数, skipped: スキップ理由 }
export async function grantCouponToAllActiveMembers(env, couponId) {
  const nowIsoStr = nowIso();
  // クーポンが配布対象か確認
  const coupon = await db(env)
    .prepare(`SELECT id, status, valid_from, valid_until FROM coupons WHERE id = ?`)
    .bind(couponId)
    .first();
  if (!coupon) return { granted: 0, skipped: 'coupon_not_found' };
  if (coupon.status !== 'published') return { granted: 0, skipped: 'not_published' };
  if (coupon.valid_until && coupon.valid_until < nowIsoStr) {
    return { granted: 0, skipped: 'already_expired' };
  }

  // 配布対象: members レコードを持つ active アカウント、かつ未配布
  const targets = await db(env)
    .prepare(`
      SELECT a.id AS account_id FROM accounts a
        JOIN members m ON m.account_id = a.id
       WHERE a.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM member_coupons mc
            WHERE mc.account_id = a.id AND mc.coupon_id = ?
         )
    `)
    .bind(couponId)
    .all();
  const rows = targets?.results || targets || [];
  let granted = 0;
  for (const t of rows) {
    try {
      await db(env)
        .prepare(`INSERT INTO member_coupons (id, account_id, coupon_id, state) VALUES (?, ?, ?, 'available')`)
        .bind(uuid(), t.account_id, couponId)
        .run();
      granted++;
    } catch (e) {
      console.warn('[grantCouponBroadcast] insert failed for account', t.account_id, e.message);
    }
  }
  return { granted, skipped: null };
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
