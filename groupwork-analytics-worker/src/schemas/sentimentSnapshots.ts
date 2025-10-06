import { z } from '@hono/zod-openapi';

export const sentimentHistoryQuerySchema = z.object({
  group_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  limit: z
    .string()
    .optional()
    .default('50')
    .transform((v) => Math.min(Math.max(Number(v) || 0, 1), 500)),
  offset: z
    .string()
    .optional()
    .default('0')
    .transform((v) => Math.max(Number(v) || 0, 0)),
});
