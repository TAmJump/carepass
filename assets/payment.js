/*
 * Care Support Pass — 決済フロントエンド
 * 各申込フォームに <div id="card-container"></div> と #pay-submit を置けば動く。
 *
 * フォーム例:
 *   <form id="csp-form" data-type="individual">
 *     <input name="given_name" required>
 *     <input name="family_name" required>
 *     <input name="email_address" type="email" required>
 *     <input name="phone_number">
 *     <input name="postal_code" required>  ← SDKフォームの郵便番号と一致必須
 *     <select name="plan_key" required>
 *       <option value="care100">¥100</option> ...
 *     </select>
 *     <div id="card-container"></div>
 *     <button id="pay-submit" type="button" disabled>申し込む</button>
 *     <div id="pay-status"></div>
 *   </form>
 *
 * 必要なグローバル設定:
 *   window.CSP_API_BASE = "https://api.carepass.tamjump.com"
 *   (本番デプロイ前のテスト時は wrangler dev の URL に切り替え)
 */
(function () {
  'use strict';

  const API_BASE = window.CSP_API_BASE || 'https://api.carepass.tamjump.com';

  // 初期化が必要なフォームがなければ何もしない
  const form = document.getElementById('csp-form');
  if (!form) return;

  const cardContainer = document.getElementById('card-container');
  const submitBtn = document.getElementById('pay-submit');
  const statusEl = document.getElementById('pay-status');
  const type = form.dataset.type; // "individual" | "partner" | "facility"

  let card;
  let payments;

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'pay-status ' + (kind || '');
  }

  function disableSubmit(d) {
    if (submitBtn) submitBtn.disabled = !!d;
  }

  async function fetchConfig() {
    const r = await fetch(API_BASE + '/api/config');
    if (!r.ok) throw new Error('config_fetch_failed');
    return r.json();
  }

  async function initSquare() {
    if (!window.Square) {
      throw new Error('Square SDK not loaded');
    }
    const cfg = await fetchConfig();
    payments = window.Square.payments(cfg.application_id, cfg.location_id);
    card = await payments.card();
    await card.attach(cardContainer);
    disableSubmit(false);
  }

  async function tokenize() {
    // SCA verification details
    const givenName = form.elements['given_name']?.value || '';
    const familyName = form.elements['family_name']?.value || '';
    const email = form.elements['email_address']?.value || '';
    const phone = form.elements['phone_number']?.value || '';
    const postalCode = form.elements['postal_code']?.value || '';

    const verificationDetails = {
      intent: 'STORE',         // カードを保存する用途
      customerInitiated: true,
      sellerKeyedIn: false,
      billingContact: {
        givenName,
        familyName,
        email,
        phone,
        country: 'JP',
        postalCode,
      },
    };

    const result = await card.tokenize(verificationDetails);
    if (result.status !== 'OK') {
      const msg = result.errors?.map((e) => e.message).join('; ') || 'カード情報の確認でエラーが発生しました';
      throw new Error(msg);
    }
    return {
      sourceId: result.token,
      verificationToken: result.verificationDetailsToken,
    };
  }

  async function subscribe() {
    setStatus('カード情報を確認中…', 'loading');
    disableSubmit(true);

    let tokenResult;
    try {
      tokenResult = await tokenize();
    } catch (e) {
      setStatus(e.message || 'カードの確認に失敗しました', 'error');
      disableSubmit(false);
      return;
    }

    setStatus('お申し込みを処理中…', 'loading');

    const fd = new FormData(form);
    const buyer = {
      given_name: fd.get('given_name') || '',
      family_name: fd.get('family_name') || '',
      email_address: fd.get('email_address') || '',
      phone_number: fd.get('phone_number') || '',
      company_name: fd.get('company_name') || undefined,
      address: {
        postal_code: fd.get('postal_code') || '',
        country: 'JP',
        address_line_1: fd.get('address_line_1') || undefined,
        address_line_2: fd.get('address_line_2') || undefined,
      },
      metadata: collectMetadata(fd),
    };

    const planKey = fd.get('plan_key');

    try {
      const r = await fetch(API_BASE + '/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          plan_key: planKey,
          source_id: tokenResult.sourceId,
          verification_token: tokenResult.verificationToken,
          buyer,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        throw new Error(data?.error || data?.message || 'subscribe_failed');
      }
      // 成功 → thanks.html へ
      const params = new URLSearchParams({
        type,
        sid: data.subscription_id,
      });
      window.location.href = '/thanks.html?' + params.toString();
    } catch (e) {
      console.error(e);
      setStatus('お申し込みに失敗しました。もう一度お試しください。(' + e.message + ')', 'error');
      disableSubmit(false);
    }
  }

  function collectMetadata(fd) {
    // 標準フィールド以外の入力をすべてmetadataに格納（運営側参照用）
    const skip = new Set([
      'given_name', 'family_name', 'email_address', 'phone_number',
      'company_name', 'postal_code', 'address_line_1', 'address_line_2',
      'plan_key',
    ]);
    const meta = {};
    for (const [k, v] of fd.entries()) {
      if (!skip.has(k) && v) meta[k] = v;
    }
    return meta;
  }

  // 初期化
  document.addEventListener('DOMContentLoaded', () => {
    initSquare().catch((e) => {
      console.error('Square init failed:', e);
      setStatus('決済システムの読み込みに失敗しました。ページを再読み込みしてください。', 'error');
    });

    if (submitBtn) {
      submitBtn.addEventListener('click', (e) => {
        e.preventDefault();
        // HTML5バリデーション
        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }
        subscribe();
      });
    }
  });
})();
