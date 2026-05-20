var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js

// ══════════════════════════════════════
// ALLOWED_ORIGINS (carepass を追加)
// ══════════════════════════════════════
var ALLOWED_ORIGINS = [
  "https://tamjump.com",
  "https://www.tamjump.com",
  "https://develop.tamjump.com",
  "https://one-touch.tamjump.com",
  "https://sitecoding.tamjump.com",
  "https://entry.tamjump.com",
  // ── さかえケアサービス ──
  "https://scsgo.co.jp",
  "https://www.scsgo.co.jp",
  "https://site.scsgo.co.jp",
  // ── KINGMAKER 23:23 ──
  "https://king2323.tamjump.com",
  // ── Care Support Pass ──
  "https://carepass.tamjump.com",
  // GitHub Pages（ドメイン設定前のテスト用）
  "https://tamjump.github.io",
  // 開発時
  "http://localhost:3000",
  "http://127.0.0.1:5500",
  "null"
];

// ══════════════════════════════════════
// プロジェクト別設定 (carepass を追加)
// ══════════════════════════════════════
var PROJECT_CONFIG = {
  tamjump: {
    prefix: "TAMJ",
    adminEmail: null,
    fromEmail: null,
    subjectPrefix: "【タムジ】",
    companyName: "タムジ株式会社",
    siteUrl: "https://tamjump.com",
    contactEmail: "info@tamjump.com"
  },
  scsgo: {
    prefix: "SCS",
    adminEmail: "info@scsgo.co.jp",
    fromEmail: null,
    subjectPrefix: "【さかえケア】",
    companyName: "株式会社さかえケアサービス",
    siteUrl: "https://scsgo.co.jp",
    contactEmail: "info@scsgo.co.jp"
  },
  kingmaker: {
    prefix: "KM",
    adminEmail: null,
    fromEmail: null,
    subjectPrefix: "【KINGMAKER 23:23】",
    companyName: "KINGMAKER 23:23 / タムジ株式会社",
    siteUrl: "https://king2323.tamjump.com",
    contactEmail: "info@tamjump.com"
  },
  carepass: {
    prefix: "CSP",
    adminEmail: null,                                    // env.ADMIN_EMAIL を使う
    fromEmail: null,                                     // env.FROM_EMAIL を使う
    subjectPrefix: "【Care Support Pass】",
    companyName: "Care Support Pass / TAMJ.Corp",
    siteUrl: "https://carepass.tamjump.com",
    contactEmail: "info@tamjump.com"
  }
};

function getProjectConfig(project) {
  return PROJECT_CONFIG[project] || PROJECT_CONFIG["tamjump"];
}
__name(getProjectConfig, "getProjectConfig");

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
__name(corsHeaders, "corsHeaders");

var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    try {
      if (url.pathname === "/contact" && request.method === "POST") {
        return await handleContact(request, env, origin);
      }
      if (url.pathname === "/entry" && request.method === "POST") {
        return await handleEntry(request, env, origin);
      }
      if (url.pathname === "/transactional" && request.method === "POST") {
        return await handleTransactional(request, env, origin);
      }
      if (url.pathname === "/admin/contacts" && request.method === "GET") {
        return await handleAdminList(request, env, origin);
      }
      return jsonResponse({ error: "Not Found" }, 404, origin);
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Internal Server Error" }, 500, origin);
    }
  }
};

// ══════════════════════════════════════
// handleContact（既存・変更なし）
// ══════════════════════════════════════
async function handleContact(request, env, origin) {
  const body = await request.json();
  const { name, email, phone, category, message, project, turnstileToken } = body;
  if (!name || !email || !message) {
    return jsonResponse({ error: "必須項目を入力してください（名前・メール・メッセージ）" }, 400, origin);
  }
  if (!isValidEmail(email)) {
    return jsonResponse({ error: "メールアドレスの形式が正しくありません" }, 400, origin);
  }
  if (env.TURNSTILE_SECRET) {
    const turnstileOk = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, request);
    if (!turnstileOk) {
      return jsonResponse({ error: "スパム検証に失敗しました。ページを再読み込みしてください。" }, 403, origin);
    }
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const proj = project || "tamjump";
  const config = getProjectConfig(proj);
  const ticketNumber = await generateTicketNumber(env, config.prefix);

  await env.DB.prepare(
    `INSERT INTO contacts (project, name, email, phone, category, message, ip, ticket_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(proj, name, email, phone || null, category || null, message, ip, ticketNumber).run();

  const adminTo = config.adminEmail || env.ADMIN_EMAIL;
  const fromAddr = config.fromEmail || env.FROM_EMAIL;

  await sendSES(env, {
    to: adminTo,
    from: fromAddr,
    subject: `${config.subjectPrefix}お問い合わせ [${ticketNumber}]:${category || "一般"}`,
    body: buildAdminEmail({ name, email, phone, category, message, project: proj, ticketNumber, config })
  });

  try {
    await sendSES(env, {
      to: email,
      from: fromAddr,
      subject: `${config.subjectPrefix}お問い合わせを受け付けました`,
      body: buildAutoReplyEmail({ name, category, ticketNumber, config })
    });
  } catch (e) {
    console.error("自動返信送信失敗:", e.message);
  }
  return jsonResponse({ success: true, message: "送信が完了しました", ticketNumber }, 200, origin);
}
__name(handleContact, "handleContact");

// ══════════════════════════════════════
// handleEntry (既存・変更なし)
// ══════════════════════════════════════
async function handleEntry(request, env, origin) {
  const body = await request.json();
  const { payment_email, receipt_id, mission_name, country, mission_summary, sns, agree_rules, turnstileToken } = body;

  if (!payment_email || !mission_name || !mission_summary || !country) {
    return jsonResponse({ error: "必須項目を入力してください / Required fields missing" }, 400, origin);
  }
  if (!isValidEmail(payment_email)) {
    return jsonResponse({ error: "メールアドレスの形式が正しくありません / Invalid email format" }, 400, origin);
  }
  if (!agree_rules) {
    return jsonResponse({ error: "利用規約への同意が必要です / Agreement to rules is required" }, 400, origin);
  }

  if (env.TURNSTILE_SECRET) {
    const turnstileOk = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, request);
    if (!turnstileOk) {
      return jsonResponse({ error: "スパム検証に失敗しました / Spam check failed" }, 403, origin);
    }
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const config = getProjectConfig("kingmaker");
  const ticketNumber = await generateTicketNumber(env, config.prefix);

  const messageWithSns = mission_summary + (sns ? `\n\n[Website/SNS] ${sns}` : '');
  await env.DB.prepare(
    `INSERT INTO contacts (project, name, email, phone, category, message, ip, ticket_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind('kingmaker', mission_name, payment_email, receipt_id || null, country, messageWithSns, ip, ticketNumber).run();

  const adminTo = config.adminEmail || env.ADMIN_EMAIL;
  const fromAddr = config.fromEmail || env.FROM_EMAIL;

  await sendSES(env, {
    to: adminTo,
    from: fromAddr,
    subject: `${config.subjectPrefix}Mission Entry [${ticketNumber}]: ${mission_name}`,
    body: buildKingmakerAdminEmail({ payment_email, receipt_id, mission_name, country, mission_summary, sns, ticketNumber, config })
  });

  try {
    await sendSES(env, {
      to: payment_email,
      from: fromAddr,
      subject: `${config.subjectPrefix}Mission Entry を受け付けました / received`,
      body: buildKingmakerAutoReplyEmail({ mission_name, country, ticketNumber, config })
    });
  } catch (e) {
    console.error("自動返信送信失敗:", e.message);
  }

  return jsonResponse({
    success: true,
    message: "Mission Entry を受け付けました / Mission Entry received",
    ticketNumber
  }, 200, origin);
}
__name(handleEntry, "handleEntry");

// ══════════════════════════════════════
// 【新規】handleTransactional
// service-to-service: 他Workerからメール送信を依頼する内部API
//
// 認証: Authorization: Bearer <env.INTERNAL_TOKEN>
//
// リクエスト:
//   {
//     project: "carepass",
//     template: "subscribe_welcome" | "magic_link" | "cancel_confirmation",
//     to: "user@example.com",
//     vars: { ...テンプレ固有の変数 }
//   }
//
// 返却:
//   { success: true } or { error: "..." }
// ══════════════════════════════════════
async function handleTransactional(request, env, origin) {
  // 認証
  const auth = request.headers.get("Authorization") || "";
  if (!env.INTERNAL_TOKEN || auth !== `Bearer ${env.INTERNAL_TOKEN}`) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400, origin);

  const { project, template, to, vars } = body;
  if (!project || !template || !to) {
    return jsonResponse({ error: "missing_fields", required: ["project", "template", "to"] }, 400, origin);
  }
  if (!isValidEmail(to)) {
    return jsonResponse({ error: "invalid_email" }, 400, origin);
  }

  const config = getProjectConfig(project);
  const fromAddr = config.fromEmail || env.FROM_EMAIL;
  const v = vars || {};

  let subject, emailBody;

  switch (template) {
    case "subscribe_welcome":
      subject = `${config.subjectPrefix}お申し込みを受け付けました`;
      emailBody = buildCarepassWelcomeEmail({ ...v, config });
      break;

    case "magic_link":
      subject = `${config.subjectPrefix}ログイン用リンクをお送りします`;
      emailBody = buildCarepassMagicLinkEmail({ ...v, config });
      break;

    case "cancel_confirmation":
      subject = `${config.subjectPrefix}退会手続きが完了しました`;
      emailBody = buildCarepassCancelEmail({ ...v, config });
      break;

    default:
      return jsonResponse({ error: "unknown_template", template }, 400, origin);
  }

  try {
    await sendSES(env, { to, from: fromAddr, subject, body: emailBody });
  } catch (e) {
    console.error("transactional send failed:", e.message);
    return jsonResponse({ error: "send_failed", message: e.message }, 502, origin);
  }

  return jsonResponse({ success: true, project, template, to }, 200, origin);
}
__name(handleTransactional, "handleTransactional");

async function handleAdminList(request, env, origin) {
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }
  const url = new URL(request.url);
  const project = url.searchParams.get("project") || "tamjump";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const { results } = await env.DB.prepare(
    `SELECT * FROM contacts WHERE project = ? ORDER BY created_at DESC LIMIT ?`
  ).bind(project, limit).all();
  return jsonResponse({ contacts: results, count: results.length }, 200, origin);
}
__name(handleAdminList, "handleAdminList");

async function sendSES(env, { to, from, subject, body }) {
  const region = env.AWS_REGION || "ap-northeast-1";
  const endpoint = `https://email.${region}.amazonaws.com`;
  const now = new Date();
  const params = new URLSearchParams({
    Action: "SendEmail",
    "Destination.ToAddresses.member.1": to,
    "Message.Subject.Data": subject,
    "Message.Subject.Charset": "UTF-8",
    "Message.Body.Text.Data": body,
    "Message.Body.Text.Charset": "UTF-8",
    Source: from,
    Version: "2010-12-01"
  });
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const credentialScope = `${dateStamp}/${region}/ses/aws4_request`;
  const canonical = [
    "POST",
    "/",
    "",
    `content-type:application/x-www-form-urlencoded`,
    `host:email.${region}.amazonaws.com`,
    `x-amz-date:${amzDate}`,
    "",
    "content-type;host;x-amz-date",
    await sha256Hex(params.toString())
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonical)
  ].join("\n");
  const sigKey = await getSignatureKey(env.AWS_SECRET_ACCESS_KEY, dateStamp, region, "ses");
  const signature = await hmacHex(sigKey, stringToSign);
  const authHeader = `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Amz-Date": amzDate,
      Authorization: authHeader
    },
    body: params.toString()
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("SES error:", res.status, errText);
    throw new Error(`SES送信失敗: ${res.status}`);
  }
}
__name(sendSES, "sendSES");

async function verifyTurnstile(token, secret, request) {
  if (!token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret,
      response: token,
      remoteip: request.headers.get("CF-Connecting-IP")
    })
  });
  const data = await res.json();
  return data.success === true;
}
__name(verifyTurnstile, "verifyTurnstile");

// ══════════════════════════════════════
// メールテンプレート（tamjump/scsgo 用・既存）
// ══════════════════════════════════════
function buildAdminEmail({ name, email, phone, category, message, project, ticketNumber, config }) {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━
  新しいお問い合わせが届きました
━━━━━━━━━━━━━━━━━━━━━━━━━━━

受付番号:${ticketNumber}
サイト:${config.companyName}(${project})
日時:${(new Date()).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}

──────────────────────────

お名前:${name}
メール:${email}
電話番号:${phone || "未入力"}
お問合せ種別:${category || "未選択"}

──────────────────────────

【お問合せ内容】

${message}

──────────────────────────
※ このメールはシステムから自動送信されています。
`.trim();
}
__name(buildAdminEmail, "buildAdminEmail");

function buildAutoReplyEmail({ name, category, ticketNumber, config }) {
  return `
${name} 様

この度はお問い合わせいただき、誠にありがとうございます。
以下の内容でお問い合わせを受け付けいたしました。

――――――――――
受付番号:${ticketNumber}
お問い合わせ種別:${category || "一般"}
――――――――――

内容を確認のうえ、順次ご連絡いたします。

※通常は【2営業日以内】を目安にご返信しております。

──────────
${config.companyName}
${config.siteUrl}
メール:${config.contactEmail}
──────────

※本メールは自動送信です。返信いただいてもご案内できません。
`.trim();
}
__name(buildAutoReplyEmail, "buildAutoReplyEmail");

// ══════════════════════════════════════
// KINGMAKER 用メールテンプレート（既存）
// ══════════════════════════════════════
function buildKingmakerAdminEmail({ payment_email, receipt_id, mission_name, country, mission_summary, sns, ticketNumber, config }) {
  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━
  KINGMAKER 23:23 — Mission Entry 受信
━━━━━━━━━━━━━━━━━━━━━━━━━━━

受付番号:${ticketNumber}
サイト:${config.companyName}
日時:${(new Date()).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}

──────────────────────────

Payment Email:${payment_email}
Square Receipt ID / 決済日時:${receipt_id || "未入力"}
Mission Name:${mission_name}
Country / 所在国:${country}

──────────────────────────

【Mission Summary】

${mission_summary}

${sns ? `\n[Website/SNS] ${sns}\n` : ""}
──────────────────────────

⚠️ Square 決済記録(取引時刻・メアド・¥100決済)と Receipt ID
を照合してから処理してください。Mismatch のものは除外。

Bell Entry は参加記録です。Grant 支給は本人確認・Mission 確認・
AML審査・法令適合性審査・Grant Fund 残高確認の完了後に運営者
判断で行います。自動支給はしません。

──────────────────────────
※ このメールは KINGMAKER 23:23 entry form から自動送信されています。
`.trim();
}
__name(buildKingmakerAdminEmail, "buildKingmakerAdminEmail");

function buildKingmakerAutoReplyEmail({ mission_name, country, ticketNumber, config }) {
  return `
KINGMAKER 23:23 — Founding Bell

Mission Entry をお受け付けしました。
Your Mission Entry has been received.

――――――――――
Receipt / 受付番号:${ticketNumber}
Mission Name:${mission_name}
Country:${country}
――――――――――

【次のステップ / Next steps】

1. 運営側で Square 決済記録と Mission Entry を照合します。
   We will verify your Square payment record against this Entry.

2. 照合 OK の Entry は Founding Bell サイクル(2026-05-15 23:23 JST〜)
   の検証対象となります。
   Verified entries are eligible for the Founding Bell cycle.

3. 選出は公開された方法で行いますが、選出だけでは Grant の権利は
   発生しません。Grant 支給には本人確認 (KYC)・Mission 確認・
   AML 審査・法令適合性審査・Grant Fund 残高確認を経た場合に限り、
   運営者の判断により行われます。
   Selection alone does not entitle a participant to a Grant.
   Grant disbursement requires KYC, Mission verification, AML review,
   legal compliance review, and Grant Fund availability.

【Bell Entry について / About Bell Entry】
Bell Entry は参加記録です。通貨・暗号資産・前払式支払手段・有価証券・
投資商品ではなく、換金・譲渡・売買はできません。
Bell Entry is a participation record. Not currency, not crypto,
not stored value, not investment product, not exchangeable for cash.

──────────────
KINGMAKER 23:23
${config.siteUrl}
Rules:https://king2323.tamjump.com/rules.html
Important Notices:https://king2323.tamjump.com/risk.html
Operator(運営):${config.companyName}
Contact:${config.contactEmail}
──────────────

※本メールは自動送信です。返信いただいてもご案内できません。
※This is an automated email; replies are not monitored.
`.trim();
}
__name(buildKingmakerAutoReplyEmail, "buildKingmakerAutoReplyEmail");

// ══════════════════════════════════════
// 【新規】Care Support Pass 用テンプレート
// ══════════════════════════════════════
function buildCarepassWelcomeEmail({ displayName, subscriptionId, facilityName, mypageUrl, magicLinkUrl, initialAmountJpy, initialPaidAt, firstBillingDate, config }) {
  const greeting = displayName ? `${displayName} 様` : "お申し込みいただいた皆さま";
  const amount = initialAmountJpy ? `¥${Number(initialAmountJpy).toLocaleString('ja-JP')}` : "¥100";
  const paidAt = initialPaidAt || "本日";
  // firstBillingDate "2026-06-30" → "2026年6月30日"
  const fbd = firstBillingDate
    ? (() => {
        const [y, m, d] = firstBillingDate.split('-').map((x) => parseInt(x, 10));
        return `${y}年${m}月${d}日`;
      })()
    : "翌月末";
  return `
${greeting}

Care Support Pass にお申し込みいただきありがとうございます。
毎月100円のご支援で、地域の介護を支える仕組みにご参加いただきました。

――――――――――
お申し込み番号:${subscriptionId}
現在の支援先:${facilityName || "—"}
――――――――――

【ご決済とご請求のスケジュール】
・本日(${paidAt}) ${amount} の初回ご決済を承りました。
・次回のご決済は ${fbd}(月末締め) に予定されています。
・以降は毎月末日に ${amount} を自動でお引き落としいたします。

【お支援先の変更・退会について】
・お支援先の変更、退会のいずれもマイページからいつでも可能です。
・お手続きの反映は翌月末のご決済からとなります。
  (お手続きを行った月の月末ご決済までは現在の内容で進みます。)
・お手続きに伴う日割り返金はございませんのでご了承ください。

――――――――――

下のリンクから、いつでもマイページにアクセスできます。
お申し込み番号を覚えていただく必要はありません。
メールアドレスだけでログイン用のリンクをお送りします。

【マイページにログイン】
${magicLinkUrl}

(このログインリンクは7日間有効です)

マイページURL:${mypageUrl}

──────────
${config.companyName}
${config.siteUrl}
お問い合わせ:${config.contactEmail}
──────────

※本メールは自動送信です。返信いただいてもご案内できません。
`.trim();
}
__name(buildCarepassWelcomeEmail, "buildCarepassWelcomeEmail");

function buildCarepassMagicLinkEmail({ displayName, magicLinkUrl, config }) {
  const greeting = displayName ? `${displayName} 様` : "お客さま";
  return `
${greeting}

マイページへのログインリンクをお送りします。
下のリンクを開くと、自動的にマイページにログインします。

【マイページにログイン】
${magicLinkUrl}

（このリンクは15分間有効です）

もし心当たりがない場合は、このメールは破棄してください。

──────────
${config.companyName}
${config.siteUrl}
──────────

※本メールは自動送信です。返信いただいてもご案内できません。
`.trim();
}
__name(buildCarepassMagicLinkEmail, "buildCarepassMagicLinkEmail");

function buildCarepassCancelEmail({ displayName, subscriptionId, canceledDate, config }) {
  const greeting = displayName ? `${displayName} 様` : "お客さま";
  return `
${greeting}

Care Support Pass の退会お手続きを承りました。
これまでのご支援、誠にありがとうございました。

――――――――――
お申し込み番号:${subscriptionId}
最終ご決済予定日(自動課金停止日):${canceledDate || "今月末"}
――――――――――

【退会反映について】
・お手続きを行った月の月末ご決済までは現在の支援先に充てられます。
・翌月末以降の自動課金は停止いたします。
・日割り返金はございませんのでご了承ください。

またのご支援をお待ちしております。

──────────
${config.companyName}
${config.siteUrl}
お問い合わせ:${config.contactEmail}
──────────

※本メールは自動送信です。返信いただいてもご案内できません。
`.trim();
}
__name(buildCarepassCancelEmail, "buildCarepassCancelEmail");

// ══════════════════════════════════════
// 共通ユーティリティ（既存）
// ══════════════════════════════════════
async function generateTicketNumber(env, prefix) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1e3);
  const dateStr = jst.toISOString().slice(0, 10).replace(/-/g, "");
  const todayStart = `${jst.toISOString().slice(0, 10)} 00:00:00`;
  const { results } = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM contacts WHERE created_at >= ?`
  ).bind(todayStart).all();
  const seq = (results[0]?.cnt || 0) + 1;
  const seqStr = String(seq).padStart(4, "0");
  return `${prefix}-${dateStr}-${seqStr}`;
}
__name(generateTicketNumber, "generateTicketNumber");

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
__name(isValidEmail, "isValidEmail");
function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin)
    }
  });
}
__name(jsonResponse, "jsonResponse");
async function sha256(data) {
  const encoded = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return await crypto.subtle.digest("SHA-256", encoded);
}
__name(sha256, "sha256");
async function sha256Hex(data) {
  const buf = await sha256(data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}
__name(hmac, "hmac");
async function hmacHex(key, data) {
  const buf = await hmac(key, data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hmacHex, "hmacHex");
async function getSignatureKey(key, dateStamp, region, service) {
  let k = await hmac("AWS4" + key, dateStamp);
  k = await hmac(k, region);
  k = await hmac(k, service);
  k = await hmac(k, "aws4_request");
  return k;
}
__name(getSignatureKey, "getSignatureKey");
export {
  index_default as default
};
