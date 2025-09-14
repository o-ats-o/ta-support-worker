import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { listQuerySchema } from '../schemas/utterances';
import { listUtterances } from '../db/utterances';
import type { AppBindings } from '../config';

export const utterancesRoutes = new Hono<{ Bindings: AppBindings }>();

utterancesRoutes.get('/utterances', zValidator('query', listQuerySchema), async (c) => {
  const { group_id, start_time, end_time, limit, offset } = c.req.valid('query');
  try {
    const results = await listUtterances(c.env.DB, {
      groupId: group_id,
      start: start_time,
      end: end_time,
      limit,
      offset,
    });
    return c.json(results);
  } catch (e: any) {
    console.error('Database query failed:', e.message);
    return c.json({ error: 'Failed to fetch utterances.' }, 500);
  }
});


