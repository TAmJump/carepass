# Square 決済統合 — 設計書

> Care Support Pass (carepass.tamjump.com) の月額課金実装。
> Cloudflare Workers をバックエンドにし、Square Web Payments SDK + Subscriptions API を統合。

---

## 🎯 構成図

```
┌─────────────────────────────────────────────────────────────────┐
│  carepass.tamjump.com  (GitHub Pages・静的)                     │
│                                                                  │
│  index.html / partners.html / facilities.html                   │
│   └ <div id="card-container"> ← Web Payments SDK が描画         │
│        ↓ card.tokenize() で payment token 取得                  │
│        ↓ fetch POST                                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓ HTTPS
┌─────────────────────────────────────────────────────────────────┐
│  api.carepass.tamjump.com  (Cloudflare Workers)                 │
│                                                                  │
│  POST /api/subscribe       ← フォーム送信受信                    │
│   1. CreateCustomer  (Customers API)                             │
│   2. CreateCard      (Cards API・トークンを永続カード化)         │
│   3. CreateSubscription (Subscriptions API・該当プラン)          │
│   → 顧客に応じてplan_variation_id選択                            │
│                                                                  │
│  POST /api/webhook         ← Square→Worker (HMAC検証)            │
│   - invoice.payment_made / subscription.updated 等               │
│                                                                  │
│  POST /api/cancel          ← 退会                                │
│   - CancelSubscription                                           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Square API  (connect.squareup.com)                              │
│   - Sandbox: connect.squareupsandbox.com                        │
│   - Square-Version: 2026-01-22                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📦 サブスクリプション計画（12プラン）

Subscription Plan は3つ作成し、それぞれに Plan Variation を作る：

### Plan: Individual Membership (個人会員)
| Variation | 月額 | ordinal | cadence |
|---|---|---|---|
| Care 100 | ¥100 | 0 | MONTHLY |
| Care 300 | ¥300 | 0 | MONTHLY |
| Care 500 | ¥500 | 0 | MONTHLY |
| Care 1000 | ¥1,000 | 0 | MONTHLY |

### Plan: Partner Membership (加盟店)
| Variation | 月額 | 備考 |
|---|---|---|
| Local Partner | ¥3,000 | |
| Care Partner | ¥10,000 | |
| Sponsor Partner | ¥30,000 | |
※ Free Partner はSquare計画作成不要（決済なし、フォーム送信のみ）

### Plan: Facility Membership (介護施設)
| Variation | 月額 | 規模 |
|---|---|---|
| Facility S | ¥5,000 | 9–29室 |
| Facility M | ¥10,000 | 30–44室 |
| Facility L | ¥15,000 | 45–59室 |
| Facility XL | ¥20,000 | 60–79室 |
| Facility XXL | ¥30,000 | 80室以上 |

合計 = 個人4 + 加盟店3 + 施設5 = **12 plan variations**

すべて `scripts/create-plans.js` で一括作成（後述）。

---

## 🔐 環境変数 (wrangler secret put で設定)

```
SQUARE_ACCESS_TOKEN          # API access token (本番/Sandbox切替)
SQUARE_LOCATION_ID           # 加盟店ID
SQUARE_WEBHOOK_SIGNATURE_KEY # Webhook署名検証用
SQUARE_ENV                   # "sandbox" | "production"
PLAN_VARIATION_IDS_JSON      # プラン作成後にIDをJSONで保存
                             # {"care100":"XXX","care300":"YYY",...}
ALLOWED_ORIGIN               # CORS用 → https://carepass.tamjump.com
```

---

## 🛣️ Worker エンドポイント仕様

### `POST /api/subscribe`

**リクエスト Body**:
```json
{
  "type": "individual" | "partner" | "facility",
  "plan_key": "care100" | "care300" | ... | "facility_s" | ...,
  "source_id": "cnon:...",            // Web Payments SDK の payment token
  "verification_token": "...",         // SCA verification (optional)
  "buyer": {
    "given_name": "...",
    "family_name": "...",
    "email_address": "...",            // 必須・Squareが請求書をここに送る
    "phone_number": "...",
    "address": { ... },                // 郵便番号は SDKフォームと一致必須
    "company_name": "...",             // partner/facility のみ
    "metadata": { ... }                // 申込フォームの追加情報
  }
}
```

**処理フロー**:
```
1. CORS / Origin check
2. body 検証
3. Square Customer 検索 or 新規作成 (SearchCustomers / CreateCustomer)
4. CreateCard で source_id を永続カードに変換 → card_id
5. CreateSubscription
   - customer_id, location_id, plan_variation_id, card_id
   - start_date は未指定 = 即時開始
6. 200 OK with { subscription_id, status, customer_id }
```

**レスポンス**:
```json
{
  "ok": true,
  "subscription_id": "...",
  "customer_id": "...",
  "status": "PENDING"  // 課金後 ACTIVE に変わる
}
```

### `POST /api/webhook`

Square から呼ばれる。署名検証必須。

**処理対象イベント**:
- `subscription.created` — 加入完了通知
- `subscription.updated` — ステータス変更
- `invoice.payment_made` — 課金成功
- `invoice.scheduled_charge_failed` — 課金失敗
- `subscription.canceled` — 退会
- `card.automatically_updated` — カード自動更新（情報のみ）

**処理**:
- HMAC-SHA256 で `x-square-hmacsha256-signature` を検証
- 失敗 → 403
- 成功 → 200 OK を5秒以内に返す（処理は内部キューでも可）
- 当面は console.log のみ（後で D1 や R2 に保存）

### `POST /api/cancel`

**リクエスト Body**:
```json
{
  "subscription_id": "...",
  "customer_email": "..."   // 本人確認用
}
```

**処理**:
1. Square から Subscription を Retrieve
2. customer_id から Customer を取得し、email 照合
3. 一致したら CancelSubscription を呼ぶ（次の課金日まで継続）
4. 200 OK

---

## 🎨 フロントエンド統合（フォーム1画面完結）

### 各HTMLの申込フォームに以下を埋め込む：

```html
<!-- Square SDK 読み込み（head か body末尾） -->
<script src="https://web.squarecdn.com/v1/square.js"></script>

<!-- フォーム内 (既存の <form> セクション) -->
<div id="card-container"></div>
<button id="submit-pay" type="button" disabled>申し込む</button>
<div id="payment-status"></div>

<script src="/assets/payment.js" defer></script>
```

### `/assets/payment.js` の役割：
1. `Square.payments(applicationId, locationId)` で初期化
2. `payments.card()` でカードフォーム生成 → `#card-container` にアタッチ
3. 送信ボタンクリック → `card.tokenize({ intent: 'STORE', ... })` で payment token 生成
4. `/api/subscribe` に POST
5. 成功 → `/thanks.html?type={type}&sid={subscription_id}`
6. 失敗 → エラー表示

### 重要：3Dセキュア (SCA) 対応
`tokenize()` の verificationDetails で `intent: "STORE"` を指定すると SCAフロー自動。

---

## 🔁 退会フロー (FAQで「いつでも退会できる」と謳ってる)

### 退会ページ案：`/cancel.html`
```
入力:
  - 登録メールアドレス
  - サブスクリプションID（thanks.htmlで案内されたもの）or
    メアドからの本人確認リンク

→ /api/cancel に POST
→ 次の課金日まで継続、その後停止
```

**ファーストパス**: thanks.html に「退会はメール案内のリンクから」と書き、運営側手動対応も可（最初はそれで十分）。

---

## 📋 実装ファイル一覧（最終）

```
/home/claude/care-support-pass/
├ worker/
│  ├ src/
│  │  ├ index.js              ← メインWorker (ルーティング)
│  │  ├ square.js             ← Square API ラッパー
│  │  ├ webhook.js            ← Webhook検証ハンドラ
│  │  ├ plans.js              ← plan_key → variation_id マップ
│  │  └ cors.js               ← CORS共通
│  ├ wrangler.toml            ← Worker設定
│  ├ package.json
│  └ README.md
│
├ scripts/
│  └ create-plans.js          ← 初期セットアップ：12プランを一括作成
│
├ assets/
│  └ payment.js               ← フロントエンドWeb Payments SDK統合
│
├ index.html                  ← フォームを Square SDK 対応に書き換え
├ partners.html               ← 同上
├ facilities.html             ← 同上
├ thanks.html                 ← 決済完了表示・サブスクID表示
└ cancel.html                 ← (新規) 退会ページ
```

---

## 🚧 デプロイ手順（順番厳守）

### Phase 1: Square準備
1. Square Developer Dashboard で **TAMJ.Corp** アプリ作成
2. **Sandbox**環境の access token 取得
3. **Sandbox**の Location ID 取得
4. Application ID（フロント用）取得

### Phase 2: プラン作成 (Sandboxでまず)
```bash
cd scripts
SQUARE_ENV=sandbox SQUARE_ACCESS_TOKEN=xxx node create-plans.js
# → 12個の plan_variation_id がJSON出力される
# → これを PLAN_VARIATION_IDS_JSON にコピー
```

### Phase 3: Worker デプロイ
```bash
cd worker
npm install
wrangler login
wrangler secret put SQUARE_ACCESS_TOKEN
wrangler secret put SQUARE_LOCATION_ID
wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY
wrangler secret put PLAN_VARIATION_IDS_JSON
wrangler secret put ALLOWED_ORIGIN
wrangler deploy
# → https://carepass-api.<account>.workers.dev で稼働
```

### Phase 4: カスタムドメイン
- Cloudflareダッシュボード で `api.carepass.tamjump.com` を Workers にバインド

### Phase 5: Webhook 登録
- Square Developer Dashboard → Webhooks
- URL: `https://api.carepass.tamjump.com/api/webhook`
- イベント: subscription.* / invoice.* / card.*
- 取得した Signature Key を Worker secret に登録

### Phase 6: フロントエンド更新
- payment.js を assets/ に追加
- index.html / partners.html / facilities.html に SDK と payment.js を組み込む
- 申込フォームの送信ボタンを実装

### Phase 7: Sandboxテスト
- Square提供のテストカード (4111 1111 1111 1111) で動作確認
- Webhookが正しく届くか確認 (webhook.site で中継できる)

### Phase 8: 本番切替
- access_token を本番のものに変更
- create-plans.js を本番環境で再実行
- 本番カードで小額テスト
- 本番公開

---

## ⚠️ 注意事項

### Square 仕様
- `Square-Version: 2026-01-22` を全リクエストヘッダーに付ける
- Subscription は最初 PENDING → 課金成功で ACTIVE
- 個人会員 ¥100/月は手数料との兼ね合いで赤字になる可能性 → 確認必須
- ACH（口座振替）はSubscriptions APIでは未対応 → カードのみ
- Cash App PayとAfterpay はサブスク非対応

### NG ワード厳守 (HANDOVER.md A-4 参照)
- 寄附ではない「月額会員サービス」と表記
- 「決済」「課金」は内部用語、ユーザー向けは「会費」「お支払い」

### セキュリティ
- access_token は絶対にフロントエンドに出さない（Worker側のみ）
- Webhook 署名検証なしの POST は全部 403
- CORS は `https://carepass.tamjump.com` のみ許可

---

**END OF DESIGN DOC**
