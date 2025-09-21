import { z } from '@hono/zod-openapi';

export const recommendQuerySchema = z
  .object({
    start: z.string().datetime(), // 例: 2025-09-19T09:00:00Z
    end: z.string().datetime().optional(), // 未指定なら start+5分
    // limit=0 または未指定: 全件返す
    limit: z
      .string()
      .optional()
      .default('0')
      .transform((v) => Math.min(Math.max(Number(v) || 0, 0), 100)),
    w_u: z.string().optional().default('0.5').transform((v) => Number(v) || 0.5),
    w_m: z.string().optional().default('0.4').transform((v) => Number(v) || 0.4),
    w_s: z.string().optional().default('0.1').transform((v) => Number(v) || 0.1),
  })
  .strict();


