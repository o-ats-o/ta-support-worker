import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { sessionsQuerySchema } from '../schemas/sessions';
import type { AppBindings } from '../config';

export const sessionsRoutes = new Hono<{ Bindings: AppBindings }>();

// 集約エンドポイント: セッションごとに概要と発話をまとめて返す
sessionsRoutes.get('/sessions', zValidator('query', sessionsQuerySchema), async (c) => {
  const { group_id, start_time, end_time, limit, offset } = c.req.valid('query');
  // セッション概要を取得（session_summary）
  let q = 'SELECT session_id, group_id, utterance_count, sentiment_score, last_updated_at FROM session_summary';
  const cond: string[] = [];
  const bind: (string | number)[] = [];
  if (group_id) { cond.push('group_id = ?'); bind.push(group_id); }
  if (start_time) { cond.push('last_updated_at >= ?'); bind.push(start_time); }
  if (end_time) { cond.push('last_updated_at <= ?'); bind.push(end_time); }
  if (cond.length) q += ' WHERE ' + cond.join(' AND ');
  q += ' ORDER BY last_updated_at DESC LIMIT ? OFFSET ?';
  bind.push(limit, offset);

  const { results: summaries } = await c.env.DB.prepare(q).bind(...bind).all<{ session_id: string; group_id: string; utterance_count: number; sentiment_score: number; last_updated_at: string }>();
  if (!summaries || summaries.length === 0) return c.json([]);

  // 対象セッションIDで発話をまとめて取得
  const sessionIds = Array.from(new Set(summaries.map(s => s.session_id)));
  const placeholders = sessionIds.map(() => '?').join(',');
  let uq = `SELECT session_id, group_id, utterance_text, created_at FROM utterances WHERE session_id IN (${placeholders})`;
  const ubind: (string)[] = [...sessionIds];
  if (group_id) { uq += ' AND group_id = ?'; ubind.push(group_id); }
  uq += ' ORDER BY created_at ASC';
  const { results: utterances } = await c.env.DB.prepare(uq).bind(...ubind).all<{ session_id: string; group_id: string; utterance_text: string; created_at: string }>();

  const map = new Map<string, { session_id: string; group_id: string; datetime: string; transcript: string; utterance_count: number; sentiment_value: number }>();
  for (const s of summaries) {
    map.set(`${s.session_id}:${s.group_id}`, {
      session_id: s.session_id,
      group_id: s.group_id,
      datetime: s.last_updated_at,
      transcript: '',
      utterance_count: s.utterance_count,
      sentiment_value: s.sentiment_score,
    });
  }
  for (const u of utterances ?? []) {
    const key = `${u.session_id}:${u.group_id}`;
    const agg = map.get(key);
    if (agg) {
      agg.transcript += (agg.transcript ? '\n' : '') + u.utterance_text;
    }
  }
  return c.json(Array.from(map.values()));
});


