import { z } from '@hono/zod-openapi';

export const sessionsQuerySchema = z.object({
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  limit: z.string().optional().default('0').transform((v) => Math.max(Number(v) || 0, 0)),
  offset: z.string().optional().default('0').transform((v) => Math.max(Number(v) || 0, 0)),
});


