import { z } from '@hono/zod-openapi';

export const sessionsQuerySchema = z.object({
  group_id: z.string().optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  limit: z.string().optional().default('50').transform((v) => Math.min(Math.max(Number(v) || 0, 1), 200)),
  offset: z.string().optional().default('0').transform((v) => Math.max(Number(v) || 0, 0)),
});


