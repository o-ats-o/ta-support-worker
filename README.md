# TA Support Worker

Cloudflare Workers 上で動作する音声アップロード・文字起こし・集計 API。R2 に音声を保存し、RunPod の文字起こしワーカーを呼び出し、Webhook で結果を受けて D1 に保存・集計します。Swagger UI（/docs）で検証可能です。

## 概要

- 音声アップロード用の署名付き URL を発行（R2）
- RunPod に文字起こしジョブを依頼（Webhook URL を付与）
- Webhook 受信で発話を保存し、Google NLP で感情スコアを計算して集計（D1）
- OpenAI API で指導シナリオ生成
- OpenAPI（Zod）→ Swagger UI で /docs 提供
- Miro 連携（1 グループ=1 ボード運用想定。ただしクライアント POST でマッピング）：同期・差分保存・差分参照 API

## 技術スタック

- ランタイム: Cloudflare Workers（Hono）
- ストレージ: Cloudflare R2（S3 互換）
- DB: Cloudflare D1（SQLite）
- バックエンド: TypeScript + Hono + Zod
- OpenAPI: @hono/zod-openapi + @hono/swagger-ui
- その他: RunPod API, Google Cloud Natural Language API, OpenAI API

## ディレクトリ構成（主な）

```
/Users/~/ta-support-worker
└── groupwork-analytics-worker/
    ├── src/
    │   ├── index.ts            # エントリ（ルータ束ね）
    │   ├── docs.ts             # OpenAPI + Swagger UI (/docs, /openapi.json)
    │   ├── routes/             # ルート（API）
    │   │   ├── upload.ts       # /generate-upload-url
    │   │   ├── process.ts      # /process-request
    │   │   ├── webhook.ts      # /session/process
    │   │   ├── utterances.ts   # /utterances
    │   │   └── scenario.ts     # /generate-scenario
    │   ├── services/           # 外部API呼び出し（RunPod/Google/OpenAI/R2）
    │   ├── db/                 # D1 アクセス
    │   ├── schemas/            # Zod スキーマ
    │   └── middleware/         # CORS 等
    ├── schema.sql              # D1 スキーマ
    ├── wrangler.toml           # Wrangler 設定
    └── .dev.vars               # ローカル用 env（Git 管理外）
```

## 前提

- Node.js 20+（22 推奨）
- Cloudflare アカウントと Wrangler v4
- RunPod エンドポイント
- Google Cloud Natural Language API / OpenAI API の利用権限

## セットアップ

1. 依存関係のインストール

```bash
cd /Users/~/ta-support-worker/groupwork-analytics-worker
npm install
```

2. D1 スキーマを適用（ローカル）

```bash
npx wrangler d1 execute transcription-db --local \
  --file=./schema.sql --config ./wrangler.toml
```

3. ローカル環境変数（.dev.vars）

```dotenv
# /Users/~/ta-support-worker/groupwork-analytics-worker/.dev.vars
ALLOWED_ORIGIN="http://localhost:3000"
RUNPOD_ENDPOINT_ID="<your_runpod_endpoint_id>"
# 以下は必要に応じて追加
# RUNPOD_API_KEY="..."
# R2_ACCESS_KEY_ID="..."
# R2_SECRET_ACCESS_KEY="..."
# GOOGLE_API_KEY="..."
# OPENAI_API_KEY="..."
# WEBHOOK_SECRET="..."
# MIRO_TOKEN="..."
```

4. 開発サーバ起動

```bash
npx wrangler dev --config ./wrangler.toml
# http://localhost:8787/api/docs （Swagger UI）
```

## デプロイ（本番）

1. シークレット登録（値は閲覧不可、必要なら上書き）

```bash
cd /Users/~/ta-support-worker/groupwork-analytics-worker
printf '<VALUE>' | npx wrangler secret put RUNPOD_API_KEY --config ./wrangler.toml
printf '<VALUE>' | npx wrangler secret put R2_ACCESS_KEY_ID --config ./wrangler.toml
printf '<VALUE>' | npx wrangler secret put R2_SECRET_ACCESS_KEY --config ./wrangler.toml
printf '<VALUE>' | npx wrangler secret put GOOGLE_API_KEY --config ./wrangler.toml
printf '<VALUE>' | npx wrangler secret put OPENAI_API_KEY --config ./wrangler.toml
printf '<VALUE>' | npx wrangler secret put WEBHOOK_SECRET --config ./wrangler.toml
```

2. D1 スキーマを適用（リモート）

```bash
npx wrangler d1 execute transcription-db --remote \
  --file=./schema.sql --config ./wrangler.toml
```

3. デプロイ

```bash
npx wrangler deploy --config ./wrangler.toml
# https://<worker-subdomain>.workers.dev
```

## /docs（Swagger UI）での検証方法

1. 署名付き URL の取得

- POST `/api/generate-upload-url`
- リクエスト（任意）: `{ "contentType": "audio/wav" | "audio/flac" }`
- レスポンス: `{ uploadUrl, objectKey }`

2. 音声ファイルを R2 にアップロード（curl 等）

```bash
# wav 例
curl -X PUT "<uploadUrl>" -H "Content-Type: audio/wav" --data-binary @/path/to/audio.wav
# flac 例
curl -X PUT "<uploadUrl>" -H "Content-Type: audio/flac" --data-binary @/path/to/audio.flac
```

- 注意: 署名発行時の `contentType` と PUT 時の `Content-Type` を一致させる

3. RunPod に文字起こし依頼

- POST `/api/process-request`
- リクエスト: `{ "objectKey":"<上記のobjectKey>", "sessionId":"s1", "groupId":"g1" }`
- 期待: 202 Accepted（`jobId` 返却）

4. Webhook（RunPod→Worker）受信の確認（手動テスト）

- POST `/api/session/process?sessionId=s1&groupId=g1&secret=<WEBHOOK_SECRET>`
- ボディ例:

```json
{ "output": { "segments": [{ "text": "こんにちは" }, { "text": "よろしく" }] } }
```

- 期待: D1 の `utterances` へ挿入、`session_summary` 更新、Google NLP で感情スコア反映

5. 保存データの取得

- GET `/api/utterances?group_id=g1&limit=50&offset=0`

6. シナリオ生成

- POST `/api/generate-scenario`
- リクエスト: `{ "transcript": "..." }`

7. セッション要約＋全文（新規）

- GET `/api/sessions?group_id=<g>&start_time=<ISO>&end_time=<ISO>&limit=50&offset=0`
- 返却（配列、1 要素=1 セッション）:
  - `session_id`, `group_id`, `datetime`（最終更新）, `utterance_count`, `sentiment_value`, `transcript`（そのセッションの全文）
  - 例:

```json
[
  {
    "session_id": "S1",
    "group_id": "a",
    "datetime": "2025-09-17T16:59:08.277Z",
    "utterance_count": 20,
    "sentiment_value": 0.3,
    "transcript": "こっちは\nさっき持ってきた資料例は何でもある\n..."
  }
]
```

8. Miro 同期・差分・最新（新規・マッピング運用）

- 前提: フロント（GET 側）は group_id のみを使用。クライアント（POST 側）は group_id と board_id を送信してマッピング登録。
- 同期（差分作成・マッピング登録/更新）

```bash
curl -X POST http://localhost:8787/api/miro/sync \
  -H 'Content-Type: application/json' \
  -d '{"group_id":"G1","board_id":"b-xxxx","types":["sticky_note","line"]}'
```

- 差分取得

```bash
curl 'http://localhost:8787/api/miro/diffs?group_id=G1&since=2025-09-18T00:00:00Z&limit=50'
```

- 最新アイテム

```bash
curl 'http://localhost:8787/api/miro/items?group_id=G1&include_deleted=false&limit=100'
```

備考: `types`は必要時のみ指定。未指定なら全アイテム対象。

## トラブルシューティング

- CORS 500（`includes` エラー）: `ALLOWED_ORIGIN` 未設定。`.dev.vars` か `wrangler.toml [vars]` で設定
- D1 エラー（テーブルなし）: `schema.sql` をローカル/リモートに適用
- 署名 URL で PUT が失敗: `Content-Type` が不一致。発行時と同じ MIME を指定
- RunPod Webhook が届かない: 本番 URL でデプロイする（dev は公開 URL でない）
- シークレットを確認したい: 値の閲覧不可。`npx wrangler secret list` で存在確認のみ

## セキュリティ/公開可否

- `wrangler.toml` の `[vars]`（R2_BUCKET_NAME, R2_ACCOUNT_ID, ALLOWED_ORIGIN, RUNPOD_ENDPOINT_ID）は公開可
- API キー・シークレット類は `.dev.vars`（ローカル）・`wrangler secret put`（本番）で管理し、Git に含めない

---

メンテナ

- Node: v20+（22 推奨）
- Wrangler: v4 系
- Lint/型: `npm run dev` 起動時に型チェック（TS strict）
