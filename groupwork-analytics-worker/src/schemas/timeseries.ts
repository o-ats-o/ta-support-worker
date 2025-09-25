import { z } from '@hono/zod-openapi';

// クエリ: group_ids はカンマ区切り（例: G1,G2）。
// start は必須、end 未指定時は start+5分を選択窓とする。
export const timeseriesQuerySchema = z
  .object({
    group_ids: z
      .string()
      .min(1)
      .openapi({ example: 'G1,G2', description: '対象グループのカンマ区切りID' })
      .transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean)),
    start: z.string().datetime().openapi({ example: '2025-09-19T09:00:00Z', description: '選択した5分窓の開始（ISO）' }),
    end: z.string().datetime().optional().openapi({ example: '2025-09-19T09:05:00Z', description: '選択した5分窓の終了（ISO: start+5分を推奨）' }),
  })
  .openapi('TimeseriesQuery');


