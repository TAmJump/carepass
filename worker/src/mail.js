// 共通メール基盤 (tamjump-contact-api) 呼び出しラッパー
//
// メール送信は carepass-api からは直接行わず、tamjump-contact-api の
// /transactional エンドポイントに service-to-service で依頼する。
//
// 認証: Authorization: Bearer ${MAIL_API_TOKEN}
// テンプレート名はサーバー側で管理 (subscribe_welcome / magic_link / cancel_confirmation)。
//
// MAIL_API_URL / MAIL_API_TOKEN が未設定なら no-op (ログのみ)。

const DEFAULT_MAIL_API_URL = "https://tamjump-contact-api.animalb001.workers.dev/transactional";

async function postTransactional(env, { project = "carepass", template, to, vars }) {
  if (!env.MAIL_API_TOKEN) {
    console.warn("[mail] MAIL_API_TOKEN not set, skipping. template=", template, "to=", to);
    return { ok: true, skipped: true };
  }
  const endpoint = env.MAIL_API_URL || DEFAULT_MAIL_API_URL;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.MAIL_API_TOKEN}`,
    },
    body: JSON.stringify({ project, template, to, vars }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[mail] transactional error:", res.status, JSON.stringify(data));
    return { ok: false, status: res.status, error: data };
  }
  return { ok: true, ...data };
}

// =====================================================================
// 申込完了メール
// =====================================================================
export async function sendSubscribeWelcome(env, { to, displayName, subscriptionId, facilityName, mypageUrl, magicLinkUrl, initialAmountJpy, initialPaidAt, firstBillingDate }) {
  return await postTransactional(env, {
    template: "subscribe_welcome",
    to,
    vars: { displayName, subscriptionId, facilityName, mypageUrl, magicLinkUrl, initialAmountJpy, initialPaidAt, firstBillingDate },
  });
}

// =====================================================================
// マジックリンク
// =====================================================================
export async function sendMagicLink(env, { to, displayName, magicLinkUrl }) {
  return await postTransactional(env, {
    template: "magic_link",
    to,
    vars: { displayName, magicLinkUrl },
  });
}

// =====================================================================
// 解約完了
// =====================================================================
export async function sendCancelConfirmation(env, { to, displayName, subscriptionId, canceledDate }) {
  return await postTransactional(env, {
    template: "cancel_confirmation",
    to,
    vars: { displayName, subscriptionId, canceledDate },
  });
}
