// Resend API による メール送信ラッパー
// https://resend.com/docs/api-reference/emails/send-email
//
// RESEND_API_KEY が未設定の場合は console.log だけして success を返す（開発用 no-op）

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

async function sendViaResend(env, { from, to, subject, html, text, reply_to }) {
  if (!env.RESEND_API_KEY) {
    console.warn('[mail] RESEND_API_KEY not set, skipping actual send. To:', to, 'Subject:', subject);
    return { ok: true, skipped: true };
  }
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: from || env.MAIL_FROM || 'Care Support Pass <no-reply@carepass.tamjump.com>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      reply_to: reply_to || env.MAIL_ADMIN || undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[mail] Resend error:', res.status, JSON.stringify(data));
    return { ok: false, status: res.status, error: data };
  }
  return { ok: true, id: data.id };
}

// =====================================================================
// テンプレ
// =====================================================================

function baseLayout({ heading, bodyHtml, footerNote }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:#f6f6f6;font-family:-apple-system,'Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif;color:#1c1c1c;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f6f6;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;border-radius:14px;padding:36px 32px;box-shadow:0 2px 8px rgba(0,0,0,.05);max-width:100%">
      <tr><td style="padding:0 0 18px;border-bottom:1px solid #eee">
        <div style="font-size:20px;font-weight:700;color:#1c1c1c;letter-spacing:.01em">
          <span style="color:#e94436">●</span> Care Support Pass
        </div>
      </td></tr>
      <tr><td style="padding:24px 0 8px">
        <h1 style="margin:0 0 16px;font-size:18px;font-weight:700;color:#1c1c1c;line-height:1.5">${heading}</h1>
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:18px 0 0;border-top:1px solid #eee;font-size:11px;color:#888;line-height:1.7">
        ${footerNote || ''}
        <div style="margin-top:12px">
          このメールに心当たりがない場合は破棄してください。<br>
          © Care Support Pass / TAMJ.Corp
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// 申込完了メール
export async function sendSubscribeWelcome(env, { to, displayName, subscriptionId, facilityName, mypageUrl, magicLinkUrl }) {
  const subject = `【Care Support Pass】お申し込みを受け付けました`;
  const greeting = displayName ? `${displayName} 様` : 'お申し込みいただいた皆さま';
  const bodyHtml = `
    <p style="margin:0 0 14px;font-size:14px;line-height:1.85">${greeting}</p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.85">
      Care Support Pass にお申し込みいただきありがとうございます。<br>
      毎月100円のご支援で、地域の介護を支える仕組みにご参加いただきました。
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;font-size:13px;color:#444">
      <tr><td style="padding:6px 12px 6px 0;color:#888">お申し込み番号</td><td style="font-family:Menlo,Consolas,monospace;font-size:11px">${subscriptionId}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#888">ご登録メール</td><td>${to}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#888">現在の支援先</td><td>${facilityName || '—'}</td></tr>
    </table>
    <p style="margin:0 0 12px;font-size:14px;line-height:1.85">
      下のボタンから、いつでもマイページにアクセスできます。
      お申し込み番号を覚えていただく必要はありません。メールアドレスだけでログイン用のリンクをお送りします。
    </p>
    <p style="margin:24px 0 12px;text-align:center">
      <a href="${magicLinkUrl}" style="display:inline-block;background:#e94436;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:14px;font-weight:600">
        マイページにログイン
      </a>
    </p>
    <p style="margin:18px 0 0;font-size:12px;color:#888;line-height:1.75">
      このログインリンクは15分間有効です。期限切れの場合は、マイページから再度ログインリンクをご請求ください。<br>
      マイページURL: <a href="${mypageUrl}" style="color:#e94436">${mypageUrl}</a>
    </p>
  `;
  const html = baseLayout({ heading: 'お申し込み完了のお知らせ', bodyHtml, footerNote: '本メールは Care Support Pass のお申し込み完了に伴い自動送信されています。' });
  const text = `${greeting}

Care Support Pass にお申し込みいただきありがとうございます。

お申し込み番号: ${subscriptionId}
ご登録メール: ${to}
現在の支援先: ${facilityName || '—'}

マイページへのログインは下記URLから。リンクは15分有効です。
${magicLinkUrl}

マイページ: ${mypageUrl}

— Care Support Pass / TAMJ.Corp`;
  return await sendViaResend(env, { to, subject, html, text });
}

// マジックリンクのみ
export async function sendMagicLink(env, { to, magicLinkUrl, displayName }) {
  const subject = `【Care Support Pass】ログイン用リンクをお送りします`;
  const greeting = displayName ? `${displayName} 様` : 'お客さま';
  const bodyHtml = `
    <p style="margin:0 0 14px;font-size:14px;line-height:1.85">${greeting}</p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.85">
      マイページへのログインリンクをお送りします。下のボタンを押すと、自動的にマイページにログインします。
    </p>
    <p style="margin:24px 0 12px;text-align:center">
      <a href="${magicLinkUrl}" style="display:inline-block;background:#e94436;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:14px;font-weight:600">
        マイページにログイン
      </a>
    </p>
    <p style="margin:18px 0 0;font-size:12px;color:#888;line-height:1.75">
      このリンクは15分間有効です。期限が切れた場合は、もう一度マイページからログインリンクをご請求ください。<br>
      もし心当たりがない場合は、このメールは破棄してください。
    </p>
  `;
  const html = baseLayout({ heading: 'ログインリンクのお知らせ', bodyHtml });
  const text = `${greeting}

マイページにログインするためのリンクをお送りします。
下のURLを開くと自動的にログインします。15分間有効です。

${magicLinkUrl}

— Care Support Pass`;
  return await sendViaResend(env, { to, subject, html, text });
}

// 解約完了メール
export async function sendCancelConfirmation(env, { to, displayName, subscriptionId, canceledDate }) {
  const subject = `【Care Support Pass】退会手続きが完了しました`;
  const greeting = displayName ? `${displayName} 様` : 'お客さま';
  const bodyHtml = `
    <p style="margin:0 0 14px;font-size:14px;line-height:1.85">${greeting}</p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.85">
      Care Support Pass の退会手続きが完了しました。これまでのご支援、誠にありがとうございました。
    </p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;font-size:13px;color:#444">
      <tr><td style="padding:6px 12px 6px 0;color:#888">お申し込み番号</td><td style="font-family:Menlo,Consolas,monospace;font-size:11px">${subscriptionId}</td></tr>
      <tr><td style="padding:6px 12px 6px 0;color:#888">解約予定日</td><td>${canceledDate || '本日'}</td></tr>
    </table>
    <p style="margin:0 0 14px;font-size:13px;line-height:1.85;color:#666">
      解約予定日以降の自動課金は停止します。日割り返金はありませんのでご了承ください。<br>
      またのご支援をお待ちしております。
    </p>
  `;
  const html = baseLayout({ heading: '退会手続き完了のお知らせ', bodyHtml });
  const text = `${greeting}

Care Support Pass の退会手続きが完了しました。

お申し込み番号: ${subscriptionId}
解約予定日: ${canceledDate || '本日'}

これまでのご支援、誠にありがとうございました。

— Care Support Pass / TAMJ.Corp`;
  return await sendViaResend(env, { to, subject, html, text });
}
