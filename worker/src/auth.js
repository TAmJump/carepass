// セッションクッキー & 認証ヘルパー
//
// クッキー名: __Host-csp_sess
//   ・__Host- プレフィックス: Path=/ + Secure + 同一オリジン (Domain属性なし) が必須
//   ・本Workerはサブドメイン (carepass-api.tamjump.com) で動くため、
//     mypage.html (carepass.tamjump.com) から見ると別オリジン扱い。
//     → クロスサイトでクッキーを送るためには SameSite=None; Secure が必要。
//     → __Host- プレフィックスは SameSite=None を許容するので問題なし。
//   ・CORS 側で credentials: 'include' を許可する設定が必要。

import { findSession, touchSession, findAccountById } from './db.js';

export const SESSION_COOKIE_NAME = '__Host-csp_sess';

export function buildSessionCookie(sessionId, expiresAtIso) {
  const exp = new Date(expiresAtIso);
  return [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=None',
    `Expires=${exp.toUTCString()}`,
  ].join('; ');
}

export function buildClearSessionCookie() {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=None',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

// リクエストから現在のセッション + アカウントを返す。なければ null。
export async function getCurrentAccount(env, request) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const sid = cookies[SESSION_COOKIE_NAME];
  if (!sid) return null;
  const sess = await findSession(env, sid);
  if (!sess) return null;
  const account = await findAccountById(env, sess.account_id);
  if (!account) return null;
  // last_seen_at を更新（非同期 fire-and-forget でも良いが、ここでは同期）
  await touchSession(env, sid);
  return { session: sess, account };
}

// 認証必須エンドポイント用
//   const auth = await requireAuth(env, request);
//   if (!auth.ok) return auth.response;
//   const { account, session } = auth;
export async function requireAuth(env, request, jsonResponseFn, origin, requiredRole = null) {
  const current = await getCurrentAccount(env, request);
  if (!current) {
    return { ok: false, response: jsonResponseFn({ error: 'unauthorized' }, 401, env, origin) };
  }
  if (requiredRole && current.account.role !== requiredRole) {
    return { ok: false, response: jsonResponseFn({ error: 'forbidden' }, 403, env, origin) };
  }
  return { ok: true, account: current.account, session: current.session };
}
