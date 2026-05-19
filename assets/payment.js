/*
 * Care Support Pass — フロントエンド処理
 *
 * 2つのフォームモード:
 *  1) <form id="csp-form" data-type="individual">  個人会員（Square決済あり）
 *  2) <form id="csp-form" data-type="partner|facility">  加盟店/施設申込（決済なし）
 *
 * 必要なグローバル設定:
 *   window.CSP_API_BASE = "https://carepass-api.tamjump.com"
 */
(function () {
  'use strict';

  const API_BASE = window.CSP_API_BASE || 'https://carepass-api.tamjump.com';

  const form = document.getElementById('csp-form');
  if (!form) return;

  const type = form.dataset.type; // "individual" | "partner" | "facility"
  const cardContainer = document.getElementById('card-container');
  const submitBtn = document.getElementById('pay-submit');
  const statusEl = document.getElementById('pay-status');
  const facilitySelect = document.getElementById('facility-select');

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

  function loadSquareSDK(env) {
    // env が "sandbox" なら sandbox.web.squarecdn.com、それ以外は本番 CDN を読む。
    return new Promise((resolve, reject) => {
      if (window.Square) return resolve();
      const src = env === 'sandbox'
        ? 'https://sandbox.web.squarecdn.com/v1/square.js'
        : 'https://web.squarecdn.com/v1/square.js';
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('square_sdk_load_failed'));
      document.head.appendChild(s);
    });
  }

  async function populateFacilities(facilities) {
    if (!facilitySelect) return;
    // 既存のオプションを空にして、APIから取得した施設リストを埋める
    facilitySelect.innerHTML = '<option value="">支援したい施設を選択してください</option>';
    for (const f of facilities) {
      if (f.accepting === false) continue;
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name + (f.location ? `（${f.location}）` : '');
      facilitySelect.appendChild(opt);
    }
  }

  async function initIndividual() {
    const cfg = await fetchConfig();
    await loadSquareSDK(cfg.env);
    if (!window.Square) throw new Error('Square SDK not loaded');
    await populateFacilities(cfg.facilities || []);
    payments = window.Square.payments(cfg.application_id, cfg.location_id);
    card = await payments.card();
    await card.attach(cardContainer);
    disableSubmit(false);
  }

  async function initApply() {
    // 申込モード（partner/facility）: Square SDK 不要
    // 施設フォームの場合、施設選択は不要（自分が施設だから）
    disableSubmit(false);
  }

  async function tokenize() {
    const givenName = form.elements['given_name']?.value || '';
    const familyName = form.elements['family_name']?.value || '';
    const email = form.elements['email_address']?.value || '';
    const phone = form.elements['phone_number']?.value || '';
    const postalCode = form.elements['postal_code']?.value || '';

    const verificationDetails = {
      intent: 'STORE',
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

  function collectBuyer(fd) {
    return {
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
    };
  }

  function collectMetadata(fd, exclude) {
    const skip = new Set(exclude);
    const meta = {};
    for (const [k, v] of fd.entries()) {
      if (!skip.has(k) && v) meta[k] = v;
    }
    return meta;
  }

  async function submitIndividual() {
    const fd = new FormData(form);
    const facilityId = fd.get('facility_id');
    if (!facilityId) {
      setStatus('支援したい施設を選択してください', 'error');
      return;
    }

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

    const buyer = collectBuyer(fd);
    buyer.metadata = collectMetadata(fd, [
      'given_name', 'family_name', 'email_address', 'phone_number',
      'company_name', 'postal_code', 'address_line_1', 'address_line_2',
      'facility_id', 'consent',
    ]);

    try {
      const r = await fetch(API_BASE + '/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_id: tokenResult.sourceId,
          verification_token: tokenResult.verificationToken,
          facility_id: facilityId,
          buyer,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        throw new Error(data?.error || data?.message || 'subscribe_failed');
      }
      const params = new URLSearchParams({
        type: 'individual',
        sid: data.subscription_id,
        facility: facilityId,
      });
      window.location.href = '/thanks.html?' + params.toString();
    } catch (e) {
      console.error(e);
      setStatus('お申し込みに失敗しました。もう一度お試しください。(' + e.message + ')', 'error');
      disableSubmit(false);
    }
  }

  async function submitApply() {
    setStatus('お申し込みを送信中…', 'loading');
    disableSubmit(true);

    const fd = new FormData(form);
    const applicant = {
      ...collectBuyer(fd),
      details: collectMetadata(fd, [
        'given_name', 'family_name', 'email_address', 'phone_number',
        'company_name', 'postal_code', 'address_line_1', 'address_line_2',
        'consent',
      ]),
    };

    try {
      const r = await fetch(API_BASE + '/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, applicant }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        throw new Error(data?.error || data?.message || 'apply_failed');
      }
      window.location.href = '/thanks.html?type=' + type;
    } catch (e) {
      console.error(e);
      setStatus('お申し込みに失敗しました。もう一度お試しください。(' + e.message + ')', 'error');
      disableSubmit(false);
    }
  }

  // 初期化
  document.addEventListener('DOMContentLoaded', () => {
    const initFn = type === 'individual' ? initIndividual : initApply;
    initFn().catch((e) => {
      console.error('Init failed:', e);
      setStatus('決済システムの読み込みに失敗しました。ページを再読み込みしてください。', 'error');
    });

    if (submitBtn) {
      submitBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }
        if (type === 'individual') submitIndividual();
        else submitApply();
      });
    }
  });
})();
