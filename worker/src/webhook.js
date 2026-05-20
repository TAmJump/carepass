// Square Webhook 署名検証
// 検証ロジック: HMAC-SHA-256( signature_key, notification_url + body ) を base64 化したものが
// X-Square-HmacSha256-Signature ヘッダと一致するか比較
// ※ 旧 X-Square-Signature (HmacSHA1) は非推奨。HmacSha256 を使う

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

// イベントハンドラ — 当面は構造を log するだけ。
// 後で D1 / R2 / KV / メール通知に拡張する。
export async function handleEvent(env, event) {
  const type = event.type;
  const id = event.data && event.data.id;
  console.log(`[webhook] ${type} (id=${id})`);

  switch (type) {
    case 'subscription.created':
      console.log('  subscription created:', JSON.stringify(event.data.object?.subscription || {}));
      break;
    case 'subscription.updated': {
      // Square API 2026-01-22 では subscription.canceled が廃止され、
      // キャンセルも subscription.updated (status=CANCELED) として通知される
      const sub = event.data.object?.subscription || {};
      if (sub.status === 'CANCELED') {
        console.log('  subscription canceled:', JSON.stringify(sub));
      } else {
        console.log('  subscription updated:', JSON.stringify(sub));
      }
      break;
    }
    case 'invoice.payment_made':
      console.log('  invoice payment OK:', JSON.stringify(event.data.object?.invoice || {}));
      break;
    case 'invoice.scheduled_charge_failed':
      console.log('  invoice payment FAILED:', JSON.stringify(event.data.object?.invoice || {}));
      // TODO: 管理者にメール、ユーザーへリトライ案内
      break;
    default:
      // 未対応イベントは静かに無視
      break;
  }
}
