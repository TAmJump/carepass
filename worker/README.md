# carepass-api (Cloudflare Workers)

Care Support Pass バックエンド — Square Subscriptions 統合。

## デプロイ手順

### 1. 初回セットアップ
```bash
cd worker
npm install
npx wrangler login
```

### 2. Square 側で取得しておくもの
- Square Developer Dashboard で **TAMJ.Corp** のアプリ作成
- **Application ID**(`sq0idp-...`)
- **Access Token** (Sandbox / Production それぞれ)
- **Location ID** (`L...`)
- **Webhook Signature Key** (Webhook 登録後に発行される)

### 3. プラン作成 (scripts/create-plans.js)
```bash
cd ../scripts
SQUARE_ENV=sandbox SQUARE_ACCESS_TOKEN=xxx node create-plans.js > plans.json
# plans.json に12個のplan_variation_idが入る
```

### 4. シークレット投入
```bash
cd ../worker
npx wrangler secret put SQUARE_ACCESS_TOKEN
npx wrangler secret put SQUARE_LOCATION_ID
npx wrangler secret put SQUARE_APPLICATION_ID
npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY
npx wrangler secret put PLAN_VARIATION_IDS_JSON     # plans.json の中身を貼る
npx wrangler secret put ALLOWED_ORIGIN              # https://carepass.115en.com
npx wrangler secret put WEBHOOK_NOTIFICATION_URL    # 後述のWebhook URLと一致
```

### 5. デプロイ
```bash
npx wrangler deploy
```

### 6. カスタムドメイン (Cloudflare Dashboard)
- Workers & Pages → carepass-api → Settings → Triggers
- Routes: `carepass-api.115en.com/*` (Zone: 115en.com)
- DNS で `carepass-api.115en.com` を Workers に自動マッピング

### 7. Webhook 登録 (Square Dashboard)
- URL: `https://carepass-api.115en.com/api/webhook`
- イベント: `subscription.*`, `invoice.*`, `card.automatically_updated`
- 発行された Signature Key を `SQUARE_WEBHOOK_SIGNATURE_KEY` に登録

### 8. 本番切替
- `wrangler.toml` の `SQUARE_ENV = "production"` に変更
- 本番 access_token, location_id, application_id を secret 更新
- 本番プランを再度 `create-plans.js` で作成し、PLAN_VARIATION_IDS_JSON を更新
- `npx wrangler deploy`

## エンドポイント

| Method | Path | 用途 |
|---|---|---|
| GET  | /api/health   | 死活 |
| GET  | /api/config   | フロント用Application ID取得 |
| POST | /api/subscribe| 申込フォーム受信→サブスク作成 |
| POST | /api/cancel   | 退会 |
| POST | /api/webhook  | Square イベント受信 |

## ローカル開発
```bash
npx wrangler dev
# http://localhost:8787
```
`.dev.vars` ファイルにシークレットを書く（gitignore 推奨）。
