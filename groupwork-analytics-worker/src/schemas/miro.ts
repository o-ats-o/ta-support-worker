import { z } from '@hono/zod-openapi';

export const miroSyncBodySchema = z
  .object({
    group_id: z.string().min(1),
    board_id: z.string().min(1),
    types: z.array(z.string()).optional(),
  })
  .strict();

export const miroDiffsQuerySchema = z
  .object({
    group_id: z.string().min(1),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    limit: z
      .string()
      .optional()
      .default('50')
      .transform((v) => Math.min(Math.max(Number(v) || 0, 1), 200)),
    offset: z.string().optional().default('0').transform((v) => Math.max(Number(v) || 0, 0)),
  })
  .strict();

export const miroItemsQuerySchema = z
  .object({
    group_id: z.string().min(1),
    include_deleted: z
      .union([z.string(), z.boolean()])
      .optional()
      .transform((v) => {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') return v === 'true';
        return false;
      })
      .optional()
      .default(false),
    limit: z
      .string()
      .optional()
      .default('200')
      .transform((v) => Math.min(Math.max(Number(v) || 0, 1), 1000)),
    offset: z.string().optional().default('0').transform((v) => Math.max(Number(v) || 0, 0)),
  })
  .strict();


