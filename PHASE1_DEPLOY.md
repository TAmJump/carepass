# Phase 1 デプロイ手順

## 全体像

Phase 1 で追加されたもの:
1. D1 マイグレーション (`worker/migrations/0001_init.sql`)
2. Worker に `/api/auth/*` `/api/me/*` 追加（マジックリンク + セッション）
3. メール送信は **既存の `tamjump-contact-api` (AWS SES) を共通基盤として利用**
4. `mypage.html` をメアドマジックリンクプライマリ + 申込番号フォールバック
5. 全 HTML のナビに「マイページ」ボタン

## ユーザーPC作業手順

### 0. (緊急 §6-1) 本番テスト Subscription 2件の解約

```cmd
curl -X POST "https://connect.squareup.com/v2/subscriptions/798c1c46-c53a-432f-96be-f64a554539ec/cancel" -H "Authorization: Bearer REDACTED_SQUARE_TOKEN" -H "Content-Type: application/json" -H "Square-Version: 2026-01-22"

curl -X POST "https://connect.squareup.com/v2/subscriptions/bb21c3cd-4b0b-4ad1-bdf6-546fc27ea57f/cancel" -H "Authorization: Bearer REDACTED_SQUARE_TOKEN" -H "Content-Type: application/json" -H "Square-Version: 2026-01-22"
```

✅ 完了済

### 1. D1 作成 + マイグレーション

```cmd
cd C:\carepass-work\carepass
git pull
cd worker
npx wrangler d1 create carepass-db
:: 表示された database_id を wrangler.toml に貼る (Claude 側で対応済ならスキップ)
npx wrangler d1 migrations apply carepass-db --remote
```

✅ 完了済（`5f4e840e-28e2-4c8a-9c8d-1b70bee44d89`）

### 2. tamjump-contact-api を新バージョンに置き換え

このセッションで Claude が生成した `worker.js`（次節）を、Cloudflare ダッシュボードの:

   Workers & Pages → `tamjump-contact-api` → **Edit code** → 全選択削除 → 貼り付け → **Save and deploy**

差分:
- ALLOWED_ORIGINS に `https://carepass.tamjump.com` を追加
- PROJECT_CONFIG に `carepass` を追加
- `/transactional` エンドポイント新設（service-to-service用）
- carepass 用メールテンプレ 3種追加（subscribe_welcome / magic_link / cancel_confirmation）

### 3. INTERNAL_TOKEN の生成・両 Worker に投入

#### a. トークン生成（ユーザーPCで）

```cmd
:: PowerShell
[Convert]::ToBase64String((1..32 | %{Get-Random -Maximum 256}))
```

または cmd で:

```cmd
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

64文字のランダム文字列が出る → これが INTERNAL_TOKEN。

#### b. tamjump-contact-api 側に投入

Workers & Pages → `tamjump-contact-api` → **Settings** → **Variables and Secrets** → **+ Add**
- Type: Secret
- Name: `INTERNAL_TOKEN`
- Value: (上記で生成したトークン)
- Save

#### c. carepass-api 側に投入（コマンドプロンプトで）

```cmd
cd C:\carepass-work\carepass\worker
npx wrangler secret put MAIL_API_TOKEN
:: プロンプトに同じトークンを貼る
```

### 4. carepass-api を deploy

```cmd
npx wrangler deploy
```

`Deployed carepass-api triggers` が出れば成功。

### 5. 動作確認

#### a. ヘルスチェック

```cmd
curl https://carepass-api.tamjump.com/api/health
```

期待値: `{"ok":true,"env":"production","db":true,"mail":true}`

- `db: false` → wrangler.toml の database_id 確認
- `mail: false` → MAIL_API_TOKEN 未投入

#### b. マジックリンクテスト

```cmd
curl -X POST https://carepass-api.tamjump.com/api/auth/request-magic-link -H "Content-Type: application/json" -H "Origin: https://carepass.tamjump.com" -d "{\"email\":\"your-test@example.com\"}"
```

期待値: `{"ok":true,...}`

ただしテストメアドが accounts テーブルに無ければメールは送られない（仕様）。
本番テスト時は新規 Subscribe → 申込完了メール（subscribe_welcome テンプレ）が届くフローで確認するのが楽。

#### c. ブラウザ確認

1. https://carepass.tamjump.com/mypage.html
2. メアド入力 → ログインリンク送信
3. 届いたメールの URL → 自動ログイン

### 6. テスト購入フローでの最終確認

1. https://carepass.tamjump.com/#apply
2. 自分のメアドで申込
3. 申込完了メール（CSP-プレフィックス、送信元 `noreply@tamjump.com`）が届く
4. マイページのログインリンクが動作

## トラブルシュート

### "Unauthorized" が tamjump-contact-api から返る

INTERNAL_TOKEN と MAIL_API_TOKEN の値が一致していない。両方とも再投入。

### メールが届かない

- `tamjump-contact-api` の Logs (Cloudflare ダッシュボード → Observability) で SES エラーがないか確認
- SES の Sender Identity に `noreply@tamjump.com` が verify 済みか
- 受信者がスパムフォルダに行っていないか

### CSP / CORS エラー

- mypage.html の CSP `connect-src` に `https://carepass-api.tamjump.com` が含まれているか確認 (含まれている)
- carepass-api 側の `ALLOWED_ORIGIN` secret が `https://carepass.tamjump.com` であること

### "db_not_configured"

wrangler.toml の database_id が PLACEHOLDER のまま → 実 ID に差し替えて再 deploy
