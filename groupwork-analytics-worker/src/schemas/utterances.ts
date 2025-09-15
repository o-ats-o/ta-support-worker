import { z } from '@hono/zod-openapi';

export const listQuerySchema = z.object({
  group_id: z.string().optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  limit: z.string().optional().default('100').transform((v) => Math.min(Math.max(Number(v) || 0, 1), 500)),
  offset: z.string().optional().default('0').transform((v) => Math.max(Number(v) || 0, 0)),
});


