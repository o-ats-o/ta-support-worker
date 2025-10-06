# TA Support Worker

Cloudflare Workers 上で動作する音声アップロード・文字起こし・集計 API。R2 に音声を保存し、RunPod の文字起こしワーカーを呼び出し、Webhook で結果を受けて D1 に保存・集計します。Swagger UI（/docs）で検証可能です。

## 概要

- 音声アップロード用の署名付き URL を発行（R2）
- RunPod に文字起こしジョブを依頼（Webhook URL を付与）
- Webhook 受信で発話を保存し、Google NLP で感情スコアを計算してサマリ（`session_summary`）とスナップショット履歴（`session_sentiment_snapshots`）を更新（D1）
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
    │   │   ├── scenario.ts     # /generate-scenario
    │   │   ├── sessions.ts     # /sessions （グループ一覧メトリクス）
    │   │   └── timeseries.ts   # /groups/timeseries （5バケット時系列）
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

> **NOTE:** `schema.sql` は `DROP TABLE` を含むため既存データを初期化します。既存環境で新しい `session_sentiment_snapshots` テーブルだけ追加したい場合は、以下のコマンドを個別に実行してください。

```bash
npx wrangler d1 execute transcription-db --local --config ./wrangler.toml --command '
  CREATE TABLE IF NOT EXISTS session_sentiment_snapshots (
    session_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    utterance_count INTEGER NOT NULL DEFAULT 0,
    sentiment_score REAL NOT NULL DEFAULT 0.0,
    PRIMARY KEY (session_id, group_id, captured_at)
  );
'
npx wrangler d1 execute transcription-db --local --config ./wrangler.toml --command '
  CREATE INDEX IF NOT EXISTS idx_session_sentiment_snapshots_group_time ON session_sentiment_snapshots (group_id, captured_at);
'
npx wrangler d1 execute transcription-db --local --config ./wrangler.toml --command '
  CREATE INDEX IF NOT EXISTS idx_session_sentiment_snapshots_time ON session_sentiment_snapshots (captured_at);
'
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

- 期待: D1 の `utterances` へ挿入、`session_summary` と `session_sentiment_snapshots` 更新、Google NLP で感情スコア反映

5. 保存データの取得

- GET `/api/utterances?group_id=g1&limit=50&offset=0`

6. シナリオ生成

- POST `/api/generate-scenario`
- リクエスト: `{ "transcript": "..." }`

7. グループ一覧

- GET `/api/sessions?start_time=<ISO>&end_time=<ISO>`
- 役割: 左カラムのグループ一覧用メトリクスを返す（指定窓と直前窓の比較）。発話は `utterances`、感情は `session_sentiment_snapshots`（指定窓内の平均）から算出。
- 返却（配列、1 要素=1 グループ）:
  - `group_id`
  - `metrics` { `utterances`, `miro`, `sentiment_avg` }
  - `prev_metrics` { 同上 }
  - `deltas` { 同上（現 − 前） }

例:

```json
[
  {
    "group_id": "Group A",
    "metrics": { "utterances": 3, "miro": 18, "sentiment_avg": -0.2 },
    "prev_metrics": { "utterances": 1, "miro": 15, "sentiment_avg": 0.1 },
    "deltas": { "utterances": 2, "miro": 3, "sentiment_avg": -0.3 }
  }
]
```

8. グループ推薦（固定 5 分ウィンドウ）

- 役割: 指定した 5 分区間で各グループの発話件数・Miro 作業量・平均感情（`session_sentiment_snapshots`）を集計し、Z-score 標準化した 3 指標の平均（低いほど優先）で返す
- エンドポイント: `GET /api/groups/recommendations`
- クエリ:
  - `start` 必須（ISO）例: `2025-09-19T09:00:00Z`
  - `end` 任意（未指定は start+5 分）。`(end - start) === 5分` 以外は 400
  - `limit` 任意（未指定または 0 で全件）
- 例:

```bash
# 全件（limit 省略）
curl 'http://localhost:8787/api/groups/recommendations?start=2025-09-19T09:00:00Z&end=2025-09-19T09:05:00Z'

# 上位N件のみ（例: 2件）
curl 'http://localhost:8787/api/groups/recommendations?start=2025-09-19T09:00:00Z&end=2025-09-19T09:05:00Z&limit=2'
```

- レスポンス（score 小=要観察度高い）

```json
[
  {
    "group_id": "G7",
    "score": 0.18,
    "metrics": { "utterances": 2, "miro": 3, "sentiment_avg": -0.05 }
  },
  {
    "group_id": "G3",
    "score": 0.25,
    "metrics": { "utterances": 3, "miro": 4, "sentiment_avg": 0.0 }
  }
]
```

9. 時間推移（5 バケット）

- 役割: 選択した 5 分窓と、その直前 4 窓の合計 5 バケット（古 → 新）を返す。各バケットの感情は `session_sentiment_snapshots` の平均。
- エンドポイント: `GET /api/groups/timeseries?group_ids=G1,G2&start=<ISO>&end=<ISO>`（`end` 省略時は `start+5分`）
- 返却:

```json
{
  "window_ms": 300000,
  "buckets": [
    {
      "start": "2025-09-19T08:40:00.000Z",
      "end":   "2025-09-19T08:45:00.000Z",
      "items": [
        { "group_id": "Group A", "utterances": 1, "miro": 0, "sentiment_avg": -0.1 },
        { "group_id": "Group B", "utterances": 0, "miro": 2, "sentiment_avg": 0.0 }
      ]
    },
    {
      "start": "2025-09-19T08:45:00.000Z",
      "end":   "2025-09-19T08:50:00.000Z",
      "items": [
        { "group_id": "Group A", "utterances": 2, "miro": 1, "sentiment_avg": 0.05 },
        { "group_id": "Group B", "utterances": 1, "miro": 0, "sentiment_avg": -0.02 }
      ]
    }
     // ... 計5バケット（最後が選択窓）
}
```

10. 感情スナップショット履歴の取得

- エンドポイント: `GET /api/sessions/sentiment-history`
- クエリ: `group_id`（必須）, `session_id`, `start`, `end`, `limit` (1-500), `offset`
- 役割: Webhook 処理ごとに蓄積される `session_sentiment_snapshots` を直接参照し、時間逆順で履歴を返す（ダッシュボードの履歴/推移タブなどで利用）。

例:

```bash
curl 'http://localhost:8787/api/sessions/sentiment-history?group_id=GroupA&limit=20'
```

レスポンス例:

```json
{
  "items": [
    {
      "session_id": "s1",
      "group_id": "GroupA",
      "captured_at": "2025-10-06T03:01:10.715Z",
      "utterance_count": 24,
      "sentiment_score": -0.12
    }
  ]
}
```

11. Miro 同期・差分・最新（新規・マッピング運用）

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
