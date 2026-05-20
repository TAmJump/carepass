// Square Webhook 署名検証 + イベント処理 (Phase 1: D1 連携追加)

import { findMemberBySubscriptionId } from './db.js';

async function importHmacKey(keyString) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(keyString),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function base64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySquareSignature({ signatureKey, notificationUrl, rawBody, signatureHeader }) {
  if (!signatureHeader || !signatureKey) return false;
  const key = await importHmacKey(signatureKey);
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(notificationUrl + rawBody));
  const expected = base64FromBuffer(sig);
  return timingSafeEqual(expected, signatureHeader);
}

export async function handleEvent(env, event) {
  const type = event.type;
  const id = event.data && event.data.id;
  console.log(`[webhook] ${type} (id=${id})`);

  switch (type) {
    case 'subscription.created': {
      const sub = event.data.object?.subscription || {};
      console.log('  subscription created:', sub.id);
      break;
    }
    case 'subscription.updated': {
      // API 2026-01-22: cancel も updated として通知される
      const sub = event.data.object?.subscription || {};
      if (sub.status === 'CANCELED') {
        console.log('  subscription canceled:', sub.id);
      } else {
        console.log('  subscription updated:', sub.id, sub.status);
      }
      break;
    }
    case 'invoice.payment_made': {
      const invoice = event.data.object?.invoice || {};
      const subId = invoice.subscription_id;
      const amountMoney = invoice.payment_requests?.[0]?.computed_amount_money
        || invoice.payment_requests?.[0]?.total_completed_amount_money
        || null;
      const amountJpy = amountMoney?.amount || 0;
      console.log('  payment OK:', invoice.id, 'sub=', subId, 'jpy=', amountJpy);
      // D1 反映: members.total_paid_jpy 加算 + last_billed_at
      if (env.DB && subId) {
        try {
          const m = await findMemberBySubscriptionId(env, subId);
          if (m) {
            await env.DB.prepare(`UPDATE members SET total_paid_jpy = total_paid_jpy + ?, last_billed_at = datetime('now') WHERE square_subscription_id = ?`)
              .bind(amountJpy, subId).run();
          }
        } catch (e) { console.error('[webhook] payment D1 update failed:', e.message); }
      }
      break;
    }
    case 'invoice.scheduled_charge_failed': {
      const invoice = event.data.object?.invoice || {};
      console.log('  payment FAILED:', invoice.id);
      // TODO: ユーザーへリトライ案内メール
      break;
    }
    default:
      break;
  }
}
