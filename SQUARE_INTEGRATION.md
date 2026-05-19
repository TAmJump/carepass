# Square 決済統合 — 設計書 v2

> Care Support Pass (carepass.tamjump.com) の月額課金実装。
> **個人会員の月100円・1プランのみ**。加盟店・介護施設は申込受付（課金なし）。
> 支援者は施設指名制で、どの施設を支援するかを選択する。

---

## 🎯 構成図

```
┌─────────────────────────────────────────────────────────────────┐
│  carepass.tamjump.com  (GitHub Pages・静的)                     │
│                                                                  │
│  index.html  個人会員フォーム                                    │
│   └ 施設選択(select) + Square card-container                    │
│        ↓ /api/config で施設リスト取得                            │
│        ↓ card.tokenize() で payment token                       │
│        ↓ /api/subscribe POST                                    │
│                                                                  │
│  partners.html / facilities.html  申込受付フォーム               │
│   └ Square SDK 不要                                              │
│        ↓ /api/apply POST                                        │
└─────────────────────────────────────────────────────────────────┘
                              ↓ HTTPS
┌─────────────────────────────────────────────────────────────────┐
│  api.carepass.tamjump.com  (Cloudflare Workers)                 │
│                                                                  │
│  GET  /api/config        application_id + location_id + 施設一覧 │
│  POST /api/subscribe     個人会員(Square Subscription作成)        │
│  POST /api/apply         加盟店・施設申込(Customer登録のみ)        │
│  POST /api/cancel        退会                                    │
│  POST /api/webhook       Square Webhook (HMAC-SHA256)            │
│                                                                  │
│  処理フロー (subscribe):                                         │
│   1. CreateCustomer  (Customers API・施設IDをメタデータに保存)   │
│   2. CreateCard      (Cards API・トークンを永続カード化)         │
│   3. CreateSubscription (Subscriptions API・¥100/月プラン)       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Square API  (connect.squareup.com)                              │
│   - Sandbox: connect.squareupsandbox.com                        │
│   - Square-Version: 2026-01-22                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📦 サブスクリプション計画（1つだけ）

### Plan: Care Support Pass — Monthly Membership

| Variation key | 月額 | 用途 |
|---|---|---|
| `care100` | ¥100 | 個人会員（唯一の課金プラン） |

**加盟店プランも介護施設プランも Square には作りません**。
- 加盟店：参加形態は4種類（Free / Local / Care / Sponsor）あるが、課金は別途運営側で個別調整
- 介護施設：会費ゼロ。Care Support Pass は集まる仕組みを提供する立場で、支援者は施設が自分で集める

---

## 🏢 施設リスト管理

Cloudflare Workers の **環境変数 `FACILITIES_JSON`** で管理。

例：
```json
[
  {
    "id": "facility_a",
    "name": "施設A",
    "location": "東京都足立区",
    "scale": "30-44",
    "accepting": true
  },
  {
    "id": "facility_b",
    "name": "施設B",
    "location": "神奈川県横浜市",
    "scale": "45-59",
    "accepting": true
  }
]
```

施設追加・変更 = `wrangler secret put FACILITIES_JSON` を再実行するだけ。
GitHub Pagesのデプロイ不要。

---

## 🔐 環境変数 (wrangler secret put で設定)

```
SQUARE_ACCESS_TOKEN          # API access token (本番/Sandbox)
SQUARE_LOCATION_ID           # 加盟店ID
SQUARE_APPLICATION_ID        # アプリID (フロントから/api/config経由で取得)
SQUARE_WEBHOOK_SIGNATURE_KEY # Webhook署名検証用
WEBHOOK_NOTIFICATION_URL     # Square Dashboardに登録したURLと同じ文字列
PLAN_VARIATION_IDS_JSON      # {"care100":"XXX"}
FACILITIES_JSON              # 施設リスト（上記参照）
ALLOWED_ORIGIN               # "https://carepass.tamjump.com"
```

`wrangler.toml` の `vars`:
- `SQUARE_ENV = "sandbox"` (本番切替時 "production")

---

## 🛣️ Worker エンドポイント仕様

### `GET /api/config`

**用途**: フロントから Square Application ID と施設リストを取得

**レスポンス**:
```json
{
  "application_id": "sandbox-sq0idb-...",
  "location_id": "L...",
  "env": "sandbox",
  "facilities": [{"id":"facility_a","name":"施設A","location":"東京都","accepting":true}]
}
```

### `POST /api/subscribe`  ← 個人会員専用

**リクエスト Body**:
```json
{
  "source_id": "cnon:...",
  "verification_token": "...",
  "facility_id": "facility_a",
  "buyer": {
    "given_name": "...", "family_name": "...",
    "email_address": "...",
    "phone_number": "...",
    "address": { "postal_code": "...", "country": "JP" },
    "metadata": { "support_theme": "...", "coupon_genre": "..." }
  }
}
```

**処理**:
1. `facility_id` 検証（FACILITIES_JSON 内の有効なIDか）
2. CreateCustomer or 既存検索（emailで）
3. CreateCard で payment token → 永続 card_id
4. CreateSubscription（plan_variation_id=care100, card_id, facility_idはsubscriptionのsource.urlに記録）

**レスポンス**:
```json
{
  "ok": true,
  "subscription_id": "...",
  "customer_id": "...",
  "status": "PENDING",
  "facility_id": "facility_a"
}
```

### `POST /api/apply`  ← 加盟店・介護施設の申込受付

**リクエスト Body**:
```json
{
  "type": "partner" | "facility",
  "applicant": {
    "given_name": "...", "family_name": "...",
    "email_address": "...",
    "company_name": "...",
    "details": { "industry": "...", "facility_scale": "30-44", "ownership": "non_owned", "apps_intent": "both_ready", ... }
  }
}
```

**処理**:
- Square の Customer Directory に登録（Square Dashboard から運営が後で確認可能）
- type で分類できるよう `note` フィールドに `{"kind":"partner|facility","details":{...}}` を保存
- TODO: 運営者メール通知（Cloudflare Email Workers / 外部 SMTP）

### `POST /api/cancel`

```json
{ "subscription_id": "...", "customer_email": "..." }
```
- email 照合 → CancelSubscription（次の課金日で停止）

### `POST /api/webhook`

Square Webhook の HMAC-SHA-256 検証 → イベントログ。
処理対象: `subscription.*`, `invoice.*`, `card.automatically_updated`

---

## 🎨 フロントエンド統合

### 共通: `assets/payment.js`

`<form id="csp-form" data-type="...">` の `data-type` で動作切り替え：

| data-type | Square SDK | 送信先 | フィールド |
|---|---|---|---|
| `individual` | 必要 | `/api/subscribe` | facility_id, source_id, buyer |
| `partner` | 不要 | `/api/apply` | applicant.* + details |
| `facility` | 不要 | `/api/apply` | applicant.* + details |

### 個人会員フォーム (index.html)
- 施設選択(select) `name="facility_id"` を必須
- ¥100/月の固定表示（変更不可）
- Square card-container
- `<script src="https://web.squarecdn.com/v1/square.js">` を読み込み

### 加盟店フォーム (partners.html)
- Square SDK 読み込み**しない**
- 業種・参加形態の希望・クーポン内容など
- 送信 → /api/apply で運営側に通知

### 施設フォーム (facilities.html)
- Square SDK 読み込み**しない**
- 規模・所有形態・**tやるゼ/mやるゼ導入意向**を必須
- 送信 → /api/apply で運営側に通知

---

## 🚧 デプロイ手順

### Phase 1: Square Developer Dashboard
- ✅ アプリ「Care Support Pass」作成済
- ✅ Sandbox Application ID: `sandbox-sq0idb-EnZefMydm3SEPqs5cKNIog`
- ✅ Sandbox Location ID: `LYFS542ADA78W`
- Sandbox Access Token: ユーザーが保管中
- Production: 本番切替時に取得

### Phase 2: プラン作成 (Sandboxでまず)
```bash
cd scripts
set SQUARE_ENV=sandbox
set SQUARE_ACCESS_TOKEN=xxx
node create-plans.js > plans.json
# → plans.json に {"care100":"XXX"} が出力される
```

### Phase 3: Worker デプロイ
```bash
cd worker
npm install
npx wrangler login

# secrets投入
npx wrangler secret put SQUARE_ACCESS_TOKEN
npx wrangler secret put SQUARE_LOCATION_ID
npx wrangler secret put SQUARE_APPLICATION_ID
npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY   # Webhook登録後
npx wrangler secret put WEBHOOK_NOTIFICATION_URL
npx wrangler secret put PLAN_VARIATION_IDS_JSON       # plans.jsonの中身
npx wrangler secret put FACILITIES_JSON               # 施設リスト
npx wrangler secret put ALLOWED_ORIGIN                # "https://carepass.tamjump.com"

npx wrangler deploy
```

### Phase 4: カスタムドメイン
- Cloudflare Dashboard → Workers → Settings → Triggers
- Route: `api.carepass.tamjump.com/*` (Zone: tamjump.com)

### Phase 5: Webhook 登録 (Square Dashboard)
- URL: `https://api.carepass.tamjump.com/api/webhook`
- イベント: `subscription.*`, `invoice.*`, `card.automatically_updated`
- 発行された Signature Key を `SQUARE_WEBHOOK_SIGNATURE_KEY` に登録

### Phase 6: Sandboxテスト
- テストカード: `4111 1111 1111 1111` / 任意未来日 / CVV `111` / 郵便番号 `10003`
- 個人会員フォーム送信 → Subscription PENDING → 課金で ACTIVE
- `npx wrangler tail` で Webhook 受信確認

### Phase 7: 本番切替
- `wrangler.toml` の `SQUARE_ENV = "production"`
- 本番 access_token / location_id / application_id を secret 更新
- 本番プラン作成 (`SQUARE_ENV=production node create-plans.js`)
- 本番 webhook 登録 → signature key 更新
- `npx wrangler deploy`

---

## ⚠️ 注意事項

### Square 仕様
- `Square-Version: 2026-01-22`
- Subscription は最初 PENDING → 課金成功で ACTIVE
- 月100円は手数料との兼ね合いで運営側ほぼ赤字 → 加盟店スポンサー収入が主収益源
- ACH（口座振替）は Subscriptions API 未対応 → カードのみ
- Cash App Pay / Afterpay はサブスク非対応

### 設計思想（厳守）
- 月100円は**一律・一律・一律**。プラン分岐なし
- 加盟店・施設に Square 課金はない
- 支援者は施設を選んで支援する（自動配分ではない）
- 施設は自分で支援者を集める（Care Support Pass は集まる仕組みを提供する立場）

### セキュリティ
- access_token は絶対にフロントエンドに出さない（Worker側のみ）
- Webhook 署名検証なしの POST は全部 403
- CORS は `https://carepass.tamjump.com` のみ許可

---

**END OF DESIGN DOC v2**
