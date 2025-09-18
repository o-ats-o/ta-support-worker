import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { sessionsQuerySchema } from '../schemas/sessions';
import type { AppBindings } from '../config';

export const sessionsRoutes = new Hono<{ Bindings: AppBindings }>();

// 集約エンドポイント: セッションごとに概要と発話をまとめて返す
sessionsRoutes.get('/sessions', zValidator('query', sessionsQuerySchema), async (c) => {
  const { group_id, start_time, end_time, limit, offset } = c.req.valid('query');

  // utterances を直接フィルタして取得（/api/utterances と同じ条件）
  let utterSql = 'SELECT session_id, group_id, utterance_text, created_at, speaker FROM utterances';
  const conds: string[] = [];
  const binds: (string | number)[] = [];
  if (group_id) { conds.push('group_id = ?'); binds.push(group_id); }
  if (start_time) { conds.push('created_at >= ?'); binds.push(start_time); }
  if (end_time) { conds.push('created_at <= ?'); binds.push(end_time); }
  if (conds.length) utterSql += ' WHERE ' + conds.join(' AND ');
  utterSql += ' ORDER BY created_at ASC';
  const { results: utterances } = await c.env.DB
    .prepare(utterSql)
    .bind(...binds)
    .all<{ session_id: string; group_id: string; utterance_text: string; created_at: string; speaker: number | null }>();
  if (!utterances || utterances.length === 0) return c.json([]);

  // セッション単位に集約
  const map = new Map<string, { session_id: string; group_id: string; datetime: string; transcript: string; transcript_diarize: string | null; utterance_count: number; sentiment_value: number }>();
  for (const u of utterances) {
    const key = `${u.session_id}:${u.group_id}`;
    let agg = map.get(key);
    if (!agg) {
      agg = { session_id: u.session_id, group_id: u.group_id, datetime: u.created_at, transcript: '', transcript_diarize: null, utterance_count: 0, sentiment_value: 0 };
      map.set(key, agg);
    }
    agg.transcript += (agg.transcript ? '\n' : '') + u.utterance_text;
    // diarize: 連続する同一話者はまとめずに1行ずつ出力
    if (u.speaker !== null && u.speaker !== undefined) {
      const line = `Speaker ${u.speaker}: ${u.utterance_text}`;
      agg.transcript_diarize = (agg.transcript_diarize ? agg.transcript_diarize + '\n\n' : '') + line;
    }
    agg.utterance_count += 1;
    if (u.created_at > agg.datetime) agg.datetime = u.created_at;
  }

  // sentiment は任意参照
  const sessionIds = Array.from(new Set(Array.from(map.values()).map(v => v.session_id)));
  if (sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(',');
    let sumSql = `SELECT session_id, group_id, sentiment_score FROM session_summary WHERE session_id IN (${placeholders})`;
    const sumBind: string[] = [...sessionIds];
    if (group_id) { sumSql += ' AND group_id = ?'; sumBind.push(group_id); }
    const { results: summaryRows } = await c.env.DB
      .prepare(sumSql)
      .bind(...sumBind)
      .all<{ session_id: string; group_id: string; sentiment_score: number }>();
    for (const s of summaryRows ?? []) {
      const k = `${s.session_id}:${s.group_id}`;
      const agg = map.get(k);
      if (agg) agg.sentiment_value = s.sentiment_score;
    }
  }

  // 並べ替え・ページング（datetime 降順）
  const all = Array.from(map.values()).map(v => ({ ...v, transcript_diarize: v.transcript_diarize ?? null })).sort((a, b) => (a.datetime < b.datetime ? 1 : -1));
  const paged = all.slice(offset, offset + limit);
  return c.json(paged);
});


