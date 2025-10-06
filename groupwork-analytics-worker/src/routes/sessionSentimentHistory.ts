import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../config';
import { sentimentHistoryQuerySchema } from '../schemas/sentimentSnapshots';

export const sessionSentimentHistoryRoutes = new Hono<{ Bindings: AppBindings }>();

sessionSentimentHistoryRoutes.get('/sessions/sentiment-history', zValidator('query', sentimentHistoryQuerySchema), async (c) => {
  const { group_id, session_id, start, end, limit, offset } = c.req.valid('query');

  const conditions: string[] = ['group_id = ?'];
  const bindings: (string | number)[] = [group_id];
  if (session_id) {
    conditions.push('session_id = ?');
    bindings.push(session_id);
  }
  if (start) {
    conditions.push('captured_at >= ?');
    bindings.push(start);
  }
  if (end) {
    conditions.push('captured_at <= ?');
    bindings.push(end);
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const query = `SELECT session_id, group_id, captured_at, utterance_count, sentiment_score
    FROM session_sentiment_snapshots
    ${whereClause}
    ORDER BY captured_at DESC
    LIMIT ? OFFSET ?`;

  bindings.push(limit, offset);

  const stmt = c.env.DB.prepare(query).bind(...bindings);
  const { results } = await stmt.all<{
    session_id: string;
    group_id: string;
    captured_at: string;
    utterance_count: number;
    sentiment_score: number;
  }>();

  return c.json({
    items: (results ?? []).map((row) => ({
      session_id: row.session_id,
      group_id: row.group_id,
      captured_at: row.captured_at,
      utterance_count: Number(row.utterance_count) || 0,
      sentiment_score: typeof row.sentiment_score === 'number' ? row.sentiment_score : Number(row.sentiment_score) || 0,
    })),
  });
});
