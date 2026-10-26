#!/usr/bin/env node
// Phase 1 デプロイ後の動作確認スクリプト
// 使い方: node scripts/smoke-test-phase1.js [your-email@example.com]
//
// 1. /api/health に env / db / mail のフラグが立つかチェック
// 2. メアドを引数に渡せば /api/auth/request-magic-link を叩いて結果を表示
//    (実際のメール送信は RESEND_API_KEY が設定されていれば届く)

const API = 'https://carepass-api.115en.com';

async function main() {
  const email = process.argv[2];

  console.log('--- /api/health ---');
  const h = await fetch(`${API}/api/health`);
  const hj = await h.json();
  console.log(JSON.stringify(hj, null, 2));
  if (!hj.db) console.warn('⚠️  db: false → D1 binding がまだ有効化されていません');
  if (!hj.mail) console.warn('⚠️  mail: false → RESEND_API_KEY 未設定（メール送信は no-op）');

  if (email) {
    console.log(`\n--- /api/auth/request-magic-link (email=${email}) ---`);
    const r = await fetch(`${API}/api/auth/request-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://carepass.115en.com' },
      body: JSON.stringify({ email }),
    });
    const rj = await r.json().catch(() => ({}));
    console.log('status:', r.status);
    console.log(JSON.stringify(rj, null, 2));
  }

  console.log('\n--- /api/auth/me (no cookie) ---');
  const me = await fetch(`${API}/api/auth/me`);
  console.log('status:', me.status);
  console.log(await me.text());
}

main().catch((e) => { console.error(e); process.exit(1); });
