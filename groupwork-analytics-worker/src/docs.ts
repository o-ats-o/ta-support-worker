import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { scenarioSchema } from './schemas/scenario';
import { processRequestSchema, webhookQuerySchema, runpodOutputSchema } from './schemas/process';
import { listQuerySchema } from './schemas/utterances';
import { sessionsQuerySchema } from './schemas/sessions';
import { recommendQuerySchema } from './schemas/recommend';
import { miroDiffsQuerySchema, miroItemsQuerySchema, miroSyncBodySchema } from './schemas/miro';

export const docsApp = new OpenAPIHono();

docsApp.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Transcription Worker API', version: '1.0.0' },
  // Try it out 時のベースURLを /api に固定
  servers: [{ url: '/api' }],
});

// POST /generate-upload-url アップロードURLを生成する
docsApp.openapi(
  createRoute({
    method: 'post',
    path: '/generate-upload-url',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              contentType: z.enum(['audio/wav', 'audio/flac']).optional().openapi({
                example: 'audio/wav',
                description: 'アップロードするMIMEタイプ（未指定は audio/wav）',
              }),
            }).openapi('GenerateUploadUrlRequest'),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Signed URL generated',
        content: {
          'application/json': {
            schema: z.object({ uploadUrl: z.string().url(), objectKey: z.string() }).openapi('GenerateUploadUrlResponse'),
          },
        },
      },
    },
  }),
  (c) => c.json({ uploadUrl: '', objectKey: '' })
);

// POST /generate-scenario
docsApp.openapi(
  createRoute({
    method: 'post',
    path: '/generate-scenario',
    request: {
      body: {
        content: {
          'application/json': {
            schema: scenarioSchema.openapi('GenerateScenarioRequest'),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'Generated scenario',
        content: {
          'application/json': {
            schema: z.object({ scenario: z.string() }).openapi('GenerateScenarioResponse'),
          },
        },
      },
    },
  }),
  // ダミーのハンドラ（実実装は既存ルート）。docs 目的のみ
  (c) => c.json({ scenario: '' })
);

// POST /process-request 処理リクエストを送信する
docsApp.openapi(
  createRoute({
    method: 'post',
    path: '/process-request',
    request: {
      body: {
        content: {
          'application/json': {
            schema: processRequestSchema.openapi('ProcessRequest'),
          },
        },
        required: true,
      },
    },
    responses: {
      202: {
        description: 'Accepted',
        content: { 'application/json': { schema: z.object({ success: z.boolean(), message: z.string(), jobId: z.string().optional() }) } },
      },
    },
  }),
  (c) => c.json({ success: true, message: 'Accepted' }, 202)
);

// POST /session/process (webhook) RunPodのジョブが完了したときに呼ばれる
docsApp.openapi(
  createRoute({
    method: 'post',
    path: '/session/process',
    request: {
      query: webhookQuerySchema.openapi('WebhookQuery'),
      body: { content: { 'application/json': { schema: runpodOutputSchema.openapi('RunpodWebhookBody') } }, required: true },
    },
    responses: { 200: { description: 'OK' } },
  }),
  (c) => c.json({})
);

// GET /utterances 発話を取得する
docsApp.openapi(
  createRoute({
    method: 'get',
    path: '/utterances',
    request: { query: listQuerySchema.openapi('ListUtterancesQuery') },
    responses: { 200: { description: 'OK' } },
  }),
  (c) => c.json({})
);

// --- Miro ---
// POST /miro/sync（マッピング登録/更新 + 同期・差分作成）
docsApp.openapi(
  createRoute({
    method: 'post',
    path: '/miro/sync',
    request: {
      body: {
        content: {
          'application/json': {
            schema: miroSyncBodySchema.openapi('MiroSyncRequest'),
          },
        },
        required: true,
      },
    },
    responses: {
      200: { description: 'Mapping upserted, synced and diff created' },
    },
  }),
  (c) => c.json({})
);

// GET /miro/diffs（group_id を board_id に解決して履歴を返す）
docsApp.openapi(
  createRoute({
    method: 'get',
    path: '/miro/diffs',
    request: { query: miroDiffsQuerySchema.openapi('MiroDiffsQuery') },
    responses: {
      200: { description: 'Diff history' },
    },
  }),
  (c) => c.json([])
);

// GET /miro/items（group_id を board_id に解決して最新状態を返す）
docsApp.openapi(
  createRoute({
    method: 'get',
    path: '/miro/items',
    request: { query: miroItemsQuerySchema.openapi('MiroItemsQuery') },
    responses: {
      200: { description: 'Latest items' },
    },
  }),
  (c) => c.json([])
);

// GET /sessions（セッション単位の要約＋全文）
docsApp.openapi(
  createRoute({
    method: 'get',
    path: '/sessions',
    request: { query: sessionsQuerySchema.openapi('SessionsQuery') },
    responses: {
      200: {
        description: 'Sessions with summary and transcript',
        content: {
          'application/json': {
            schema: z.array(
              z.object({
                session_id: z.string(),
                group_id: z.string(),
                datetime: z.string(),
                utterance_count: z.number(),
                sentiment_value: z.number(),
                transcript: z.string(),
                transcript_diarize: z.string().nullable(),
              })
            ).openapi('SessionsResponse'),
          },
        },
      },
    },
  }),
  (c) => c.json([])
);

// GET /groups/recommendations（固定5分ウィンドウの推薦）
docsApp.openapi(
  createRoute({
    method: 'get',
    path: '/groups/recommendations',
    request: { query: recommendQuerySchema.openapi('RecommendQuery') },
    responses: {
      200: {
        description: 'Group recommendations for the 5-minute window (limit omitted => all). Score is the mean of three Z-score standardized metrics (utterances, miro, sentiment). Lower score = higher priority (lower activity/negative sentiment).',
        content: {
          'application/json': {
            schema: z
              .array(
                z.object({
                  group_id: z.string(),
                  rank: z.number().optional(),
                  score: z.number(),
                  metrics: z.object({
                    utterances: z.number(),
                    miro: z.number(),
                    sentiment_avg: z.number(),
                  }),
                  prev_metrics: z
                    .object({
                      utterances: z.number(),
                      miro: z.number(),
                      sentiment_avg: z.number(),
                    })
                    .optional(),
                  deltas: z
                    .object({
                      utterances: z.number(),
                      miro: z.number(),
                      sentiment_avg: z.number(),
                    })
                    .optional(),
                  subscores_z: z
                    .object({
                      utterances_z: z.number(),
                      miro_z: z.number(),
                      sentiment_z: z.number(),
                    })
                    .optional(),
                  reasons: z.array(z.string()).optional(),
                })
              )
              .openapi('RecommendResponse'),
          },
        },
      },
      400: { description: 'Invalid window (must be exactly 5 minutes) or bad params' },
    },
  }),
  (c) => c.json([])
);

// UI Swagger UIを表示する（相対参照にして /api 配下でも動作）
docsApp.get('/docs', swaggerUI({ url: 'openapi.json' }));