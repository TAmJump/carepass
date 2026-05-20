# Phase 1 デプロイ手順

## 全体像

このセッションで push したもの:
1. D1 マイグレーション (`worker/migrations/0001_init.sql`)
2. Worker に `/api/auth/*` と `/api/me/*` を追加（マジックリンク認証 + セッション）
3. `/api/subscribe` に申込完了メール送信
4. `mypage.html` をメアドマジックリンクプライマリ + 申込番号フォールバック
5. 全 HTML のナビに「マイページ」ボタン

## ユーザーPCで実行する手順

### 0. (緊急) 本番テスト Subscription 2件の解約

```cmd
curl -X POST "https://connect.squareup.com/v2/subscriptions/798c1c46-c53a-432f-96be-f64a554539ec/cancel" -H "Authorization: Bearer REDACTED_SQUARE_TOKEN" -H "Content-Type: application/json" -H "Square-Version: 2026-01-22"

curl -X POST "https://connect.squareup.com/v2/subscriptions/bb21c3cd-4b0b-4ad1-bdf6-546fc27ea57f/cancel" -H "Authorization: Bearer REDACTED_SQUARE_TOKEN" -H "Content-Type: application/json" -H "Square-Version: 2026-01-22"
```

成功なら `"status":"DEACTIVATED"` or `"canceled_date":"..."` が返る。

### 1. 最新コードを pull

```cmd
cd C:\carepass-work\carepass
git pull
```

### 2. D1 データベース作成

```cmd
cd worker
npx wrangler d1 create carepass-db
```

→ 出力に `database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"` が含まれる。
この **database_id** を `worker/wrangler.toml` の `PLACEHOLDER_REPLACE_WITH_REAL_ID` と差し替える。

### 3. マイグレーション適用

```cmd
npx wrangler d1 migrations apply carepass-db --remote
```

`✅ Applied 1 migration` が出れば OK。

### 4. シークレット投入

#### a. Resend API キー（メール送信用）

[https://resend.com](https://resend.com) で無料アカウント作成 → Domain `carepass.tamjump.com` を verify → API Key 発行

または、最初はテストで Resend が提供する `onboarding@resend.dev` から送る方式でも可。
その場合は `wrangler.toml` の `MAIL_FROM` を一時的に `Care Support Pass <onboarding@resend.dev>` に変える。

```cmd
npx wrangler secret put RESEND_API_KEY
（プロンプトに re_xxxxxxxxxxxx を貼る）
```

#### b. 既存シークレット（v6.5から残置・確認のみ）

下記が既に投入済みであることを `npx wrangler secret list` で確認:
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_LOCATION_ID`
- `SQUARE_WEBHOOK_SIGNATURE_KEY`
- `SQUARE_APPLICATION_ID`
- `PLAN_VARIATION_IDS_JSON`
- `FACILITIES_JSON`
- `ALLOWED_ORIGIN`
- `WEBHOOK_NOTIFICATION_URL`

### 5. Worker デプロイ

```cmd
npx wrangler deploy
```

`Deployed carepass-api triggers` が出れば成功。

### 6. 動作確認

#### a. ヘルスチェック

```cmd
curl https://carepass-api.tamjump.com/api/health
```

期待値: `{"ok":true,"env":"production","db":true,"mail":true}`

`db: false` ならマイグレーション or wrangler.toml の binding 設定漏れ。
`mail: false` なら RESEND_API_KEY 未投入。

#### b. マジックリンク送信テスト

```cmd
node scripts\smoke-test-phase1.js your-test-email@example.com
```

メールが届くか、Resend ダッシュボードで送信ログを確認。

#### c. ブラウザ確認

1. https://carepass.tamjump.com/mypage.html を開く
2. メールでログインフォームに自分のメアドを入力
3. メールに届くリンクをクリック
4. マイページに自動ログインされ、契約情報が表示される

### 7. (任意) 既存ユーザーをアカウントにバックフィル

v6.5 までに本番テスト決済をした顧客は、まだ accounts テーブルに行がない。
解約済みであれば無視可能。継続する場合は別途バックフィルスクリプトを作る（Phase 2 以降）。

## トラブルシュート

### マジックリンクをクリックしても "login_error=token_expired"

トークンの有効期限は15分。再度マイページからログインリンクを請求する。

### "db_not_configured" エラー

wrangler.toml の `database_id` が PLACEHOLDER のままになっている。実IDに差し替えて再 deploy。

### メールが届かない

1. `/api/health` の `mail: true` を確認
2. Resend ダッシュボードで送信ログを確認（拒否されていないか）
3. 受信側スパムフォルダ確認
4. Resend で `carepass.tamjump.com` ドメインが verify 済みか確認（未 verify なら DNS の SPF/DKIM レコード追加が必要）

### CORS エラー（クッキーが送られない）

ブラウザの DevTools → Network で OPTIONS リクエストのレスポンスを確認:
- `Access-Control-Allow-Origin: https://carepass.tamjump.com` (正確に一致)
- `Access-Control-Allow-Credentials: true`

セッションクッキーは `SameSite=None; Secure` で、本番では HTTPS 必須。
