// クーポン関連 API ヘルパー
//
// 仕様 (HANDOVER v10.1 §6-7):
//   state: 'available' → 'reserved' (30秒) → 'used' or 'available' (タイムアウト)
//   QR ペイロード: { v:1, mc: <member_coupon_id>, exp: unix_ts, sig: hmac_sha256_base64url }
//   署名鍵: env.COUPON_HMAC_KEY (Worker secret として投入)

import { uuid, isoMinutesFromNow, nowIso } from './db.js';

const RESERVE_TTL_SEC = 30;

// =====================================================================
// HMAC ユーティリティ
// =====================================================================
async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function base64UrlFromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBuffer(s) {
  const pad = (s.length % 4) ? '='.repeat(4 - (s.length % 4)) : '';
  const std = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// payload (オブジェクト) を base64url JSON 化し、署名 sig を末尾に付与する
// 戻り: "<base64url_payload>.<base64url_sig>"
async function signPayload(env, payload) {
  if (!env.COUPON_HMAC_KEY) throw new Error('COUPON_HMAC_KEY not set');
  const key = await importKey(env.COUPON_HMAC_KEY);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  const b64Payload = base64UrlFromBuffer(jsonBytes.buffer);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64Payload));
  const b64Sig = base64UrlFromBuffer(sig);
  return `${b64Payload}.${b64Sig}`;
}

async function verifyToken(env, token) {
  if (!env.COUPON_HMAC_KEY) throw new Error('COUPON_HMAC_KEY not set');
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: 'invalid_token' };
  }
  const [b64Payload, b64Sig] = token.split('.', 2);
  const key = await importKey(env.COUPON_HMAC_KEY);
  const ok = await crypto.subtle.verify('HMAC', key,
    base64UrlToBuffer(b64Sig),
    new TextEncoder().encode(b64Payload));
  if (!ok) return { ok: false, error: 'signature_invalid' };
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBuffer(b64Payload)));
  } catch {
    return { ok: false, error: 'payload_invalid' };
  }
  if (!payload.exp || typeof payload.exp !== 'number') {
    return { ok: false, error: 'no_exp' };
  }
  if (payload.exp * 1000 < Date.now()) {
    return { ok: false, error: 'token_expired' };
  }
  if (!payload.mc) return { ok: false, error: 'no_mc' };
  return { ok: true, payload };
}

// =====================================================================
// 会員: クーポン一覧
// =====================================================================
//   利用可能 / 利用済 / 期限切れ を分けて返す
export async function listMemberCoupons(env, accountId) {
  const rows = await env.DB.prepare(`
    SELECT
      mc.id              AS member_coupon_id,
      mc.state           AS state,
      mc.acquired_at     AS acquired_at,
      mc.used_at         AS used_at,
      mc.used_partner_location AS used_partner_location,
      c.id               AS coupon_id,
      c.title            AS title,
      c.description      AS description,
      c.discount_type    AS discount_type,
      c.discount_value   AS discount_value,
      c.conditions       AS conditions,
      c.valid_from       AS valid_from,
      c.valid_until      AS valid_until,
      c.status           AS coupon_status,
      p.id               AS partner_id,
      p.name             AS partner_name,
      p.category         AS partner_category,
      p.location         AS partner_location,
      p.website          AS partner_website
    FROM member_coupons mc
    JOIN coupons c ON c.id = mc.coupon_id
    JOIN partners p ON p.id = c.partner_id
    WHERE mc.account_id = ?
    ORDER BY mc.acquired_at DESC
  `).bind(accountId).all();

  const now = Date.now();
  const available = [];
  const used      = [];
  const expired   = [];
  for (const r of (rows?.results || rows || [])) {
    const validUntilMs = r.valid_until ? new Date(r.valid_until).getTime() : Infinity;
    const isExpired = validUntilMs < now || r.coupon_status === 'ended';
    if (r.state === 'used') {
      used.push(r);
    } else if (isExpired) {
      // 自動 expire
      if (r.state !== 'expired') {
        try {
          await env.DB.prepare(`UPDATE member_coupons SET state = 'expired' WHERE id = ?`)
            .bind(r.member_coupon_id).run();
        } catch {}
        r.state = 'expired';
      }
      expired.push(r);
    } else {
      available.push(r);
    }
  }
  return { available, used, expired };
}

// =====================================================================
// 会員: クーポン利用予約 (QR トークン発行)
// =====================================================================
export async function reserveCoupon(env, accountId, memberCouponId) {
  const row = await env.DB.prepare(`
    SELECT mc.*, c.valid_until AS valid_until, c.status AS coupon_status, c.partner_id AS partner_id
      FROM member_coupons mc
      JOIN coupons c ON c.id = mc.coupon_id
     WHERE mc.id = ? AND mc.account_id = ?
     LIMIT 1
  `).bind(memberCouponId, accountId).first();
  if (!row) return { ok: false, status: 404, error: 'not_found' };

  const now = Date.now();
  const validUntilMs = row.valid_until ? new Date(row.valid_until).getTime() : Infinity;
  if (validUntilMs < now || row.coupon_status === 'ended') {
    await env.DB.prepare(`UPDATE member_coupons SET state = 'expired' WHERE id = ?`)
      .bind(memberCouponId).run();
    return { ok: false, status: 410, error: 'expired' };
  }
  if (row.state === 'used') {
    return { ok: false, status: 409, error: 'already_used' };
  }

  const reservedUntil = isoMinutesFromNow(RESERVE_TTL_SEC / 60); // 30 sec
  await env.DB.prepare(`UPDATE member_coupons SET state = 'reserved', reserved_until = ? WHERE id = ?`)
    .bind(reservedUntil, memberCouponId).run();

  const expSec = Math.floor((Date.now() + RESERVE_TTL_SEC * 1000) / 1000);
  const token = await signPayload(env, {
    v: 1,
    mc: memberCouponId,
    pid: row.partner_id,
    exp: expSec,
  });
  return {
    ok: true,
    token,
    reserved_until: reservedUntil,
    expires_at_ms: expSec * 1000,
    ttl_sec: RESERVE_TTL_SEC,
  };
}

// =====================================================================
// 企業: スキャナーによる利用確定
// =====================================================================
//   { token, staff_id?, partner_id (店舗側で保持) } を受け、
//   - HMAC 検証
//   - 会員クーポンが reserved or available か (reservedなら期限内のみOK)
//   - クーポンの partner_id とリクエスト元 partner_id が一致するか
//   - 一致したら state=used に更新
export async function scanCoupon(env, { token, partnerId, staffId }) {
  const v = await verifyToken(env, token);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const memberCouponId = v.payload.mc;

  // 1. 会員クーポン取得
  const row = await env.DB.prepare(`
    SELECT mc.*, c.partner_id AS coupon_partner_id, c.status AS coupon_status,
           c.valid_until AS valid_until, c.title AS title, c.discount_type AS discount_type, c.discount_value AS discount_value
      FROM member_coupons mc
      JOIN coupons c ON c.id = mc.coupon_id
     WHERE mc.id = ? LIMIT 1
  `).bind(memberCouponId).first();
  if (!row) return { ok: false, status: 404, error: 'coupon_not_found' };

  // 2. パートナー所属確認 (リクエスト元 partner と クーポン発行 partner が一致するか)
  if (partnerId && row.coupon_partner_id !== partnerId) {
    return { ok: false, status: 403, error: 'other_partner_coupon', coupon_partner_id: row.coupon_partner_id };
  }

  // 3. 状態確認
  if (row.state === 'used') {
    return { ok: false, status: 409, error: 'already_used' };
  }
  const now = Date.now();
  if (row.state === 'reserved') {
    if (row.reserved_until && new Date(row.reserved_until).getTime() < now) {
      // 予約期限切れ → available に戻す
      await env.DB.prepare(`UPDATE member_coupons SET state = 'available', reserved_until = NULL WHERE id = ?`)
        .bind(memberCouponId).run();
      return { ok: false, status: 410, error: 'reservation_expired' };
    }
  }
  if (row.valid_until && new Date(row.valid_until).getTime() < now) {
    await env.DB.prepare(`UPDATE member_coupons SET state = 'expired' WHERE id = ?`)
      .bind(memberCouponId).run();
    return { ok: false, status: 410, error: 'coupon_expired' };
  }
  if (row.coupon_status === 'ended' || row.coupon_status === 'paused') {
    return { ok: false, status: 409, error: 'coupon_unavailable' };
  }

  // 4. used に更新
  await env.DB.prepare(`
    UPDATE member_coupons
       SET state = 'used',
           used_at = datetime('now'),
           staff_id = ?
     WHERE id = ?
  `).bind(staffId || null, memberCouponId).run();

  return {
    ok: true,
    member_coupon_id: memberCouponId,
    coupon_title: row.title,
    discount_type: row.discount_type,
    discount_value: row.discount_value,
  };
}

// =====================================================================
// 企業: スキャン履歴 (自社クーポンのみ)
// =====================================================================
export async function listScanHistory(env, partnerId, limit = 50) {
  const r = await env.DB.prepare(`
    SELECT mc.id AS member_coupon_id, mc.used_at, mc.staff_id, mc.account_id,
           c.title, c.discount_type, c.discount_value
      FROM member_coupons mc
      JOIN coupons c ON c.id = mc.coupon_id
     WHERE c.partner_id = ? AND mc.state = 'used'
     ORDER BY mc.used_at DESC
     LIMIT ?
  `).bind(partnerId, limit).all();
  return r?.results || r || [];
}

// =====================================================================
// 企業: 自社の概要KPI
// =====================================================================
export async function partnerDashboardStats(env, partnerId) {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC基準で十分)
  const [publishedRow, monthUsedRow, totalUsedRow, repeatersRow] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM coupons WHERE partner_id = ? AND status = 'published'`).bind(partnerId).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM member_coupons mc JOIN coupons c ON c.id=mc.coupon_id
                      WHERE c.partner_id = ? AND mc.state='used' AND substr(mc.used_at,1,7) = ?`)
      .bind(partnerId, month).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM member_coupons mc JOIN coupons c ON c.id=mc.coupon_id
                      WHERE c.partner_id = ? AND mc.state='used'`).bind(partnerId).first(),
    env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT mc.account_id FROM member_coupons mc JOIN coupons c ON c.id=mc.coupon_id
         WHERE c.partner_id = ? AND mc.state='used'
         GROUP BY mc.account_id HAVING COUNT(*) >= 2
      )
    `).bind(partnerId).first(),
  ]);
  return {
    published_coupons:    publishedRow?.n || 0,
    used_this_month:      monthUsedRow?.n || 0,
    used_total:           totalUsedRow?.n || 0,
    repeating_members:    repeatersRow?.n || 0,
  };
}

// =====================================================================
// 企業: 自社クーポンCRUD
// =====================================================================
export async function listPartnerCoupons(env, partnerId) {
  const r = await env.DB.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM member_coupons mc WHERE mc.coupon_id = c.id AND mc.state = 'used') AS used_count
    FROM coupons c WHERE c.partner_id = ? ORDER BY c.created_at DESC
  `).bind(partnerId).all();
  return r?.results || r || [];
}

export async function createPartnerCoupon(env, partnerId, body) {
  const id = uuid();
  await env.DB.prepare(`
    INSERT INTO coupons (id, partner_id, title, description, discount_type, discount_value, conditions, valid_from, valid_until, usage_limit_per_member, total_limit, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, partnerId,
    body.title, body.description || null,
    body.discount_type, body.discount_value ?? null,
    body.conditions || null,
    body.valid_from, body.valid_until,
    body.usage_limit_per_member ?? 1,
    body.total_limit ?? null,
    body.status || 'draft',
  ).run();
  return await env.DB.prepare(`SELECT * FROM coupons WHERE id = ?`).bind(id).first();
}

export async function updatePartnerCoupon(env, partnerId, couponId, body) {
  const existing = await env.DB.prepare(`SELECT * FROM coupons WHERE id = ? AND partner_id = ?`)
    .bind(couponId, partnerId).first();
  if (!existing) return null;
  const fields = ['title', 'description', 'discount_type', 'discount_value', 'conditions', 'valid_from', 'valid_until', 'usage_limit_per_member', 'total_limit', 'status'];
  const sets = []; const vals = [];
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(body[f]); }
  }
  if (sets.length === 0) return existing;
  vals.push(couponId);
  await env.DB.prepare(`UPDATE coupons SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return await env.DB.prepare(`SELECT * FROM coupons WHERE id = ?`).bind(couponId).first();
}

export async function deletePartnerCoupon(env, partnerId, couponId) {
  await env.DB.prepare(`DELETE FROM coupons WHERE id = ? AND partner_id = ?`).bind(couponId, partnerId).run();
  return { ok: true };
}
