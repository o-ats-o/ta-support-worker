import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { sessionsQuerySchema } from '../schemas/sessions';
import type { AppBindings } from '../config';

export const sessionsRoutes = new Hono<{ Bindings: AppBindings }>();

// 集約エンドポイント: セッションごとに概要と発話をまとめて返す
sessionsRoutes.get('/sessions', zValidator('query', sessionsQuerySchema), async (c) => {
  const { group_id, start_time, end_time, limit, offset, with_groups } = c.req.valid('query');

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
  if (!utterances || utterances.length === 0) {
    // groups だけ要求された場合でも、セッションが無ければ空配列
    if (with_groups) {
      const groups = await buildGroupMetrics(c.env.DB, { start: start_time, end: end_time });
      return c.json({ sessions: [], groups });
    }
    return c.json([]);
  }

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

  if (with_groups) {
    const groups = await buildGroupMetrics(c.env.DB, { start: start_time, end: end_time });
    return c.json({ sessions: paged, groups });
  }
  return c.json(paged);
});



// 画面左側「グループ一覧」向けメトリクスを算出
async function buildGroupMetrics(db: D1Database, params: { start?: string; end?: string }) {
  const { start, end } = params;
  // ウィンドウ未指定時は「直近5分」を採用
  const endMs = end ? new Date(end).getTime() : Date.now();
  const startMs = start ? new Date(start).getTime() : endMs - 5 * 60 * 1000;
  const windowStartIso = new Date(startMs).toISOString();
  const windowEndIso = new Date(endMs).toISOString();
  const prevStartIso = new Date(startMs - (endMs - startMs)).toISOString();
  const prevEndIso = new Date(startMs).toISOString();

  // ベースとなるグループ集合
  const baseGroups = new Set<string>();
  const { results: mapRows } = await db.prepare('SELECT group_id FROM miro_board_map').all<{ group_id: string }>();
  for (const r of mapRows ?? []) baseGroups.add(r.group_id);
  const { results: uGroups } = await db
    .prepare('SELECT DISTINCT group_id FROM utterances WHERE created_at > ? AND created_at <= ?')
    .bind(windowStartIso, windowEndIso)
    .all<{ group_id: string }>();
  for (const r of uGroups ?? []) baseGroups.add(r.group_id);
  const { results: sGroups } = await db
    .prepare('SELECT DISTINCT group_id FROM session_summary WHERE last_updated_at > ? AND last_updated_at <= ?')
    .bind(windowStartIso, windowEndIso)
    .all<{ group_id: string }>();
  for (const r of sGroups ?? []) baseGroups.add(r.group_id);
  const groupIds = Array.from(baseGroups);
  if (groupIds.length === 0) return [] as any[];

  // 発話件数（現窓/前窓）
  const utterMap = new Map<string, number>();
  const { results: uRows } = await db
    .prepare('SELECT group_id, COUNT(*) as cnt FROM utterances WHERE created_at > ? AND created_at <= ? GROUP BY group_id')
    .bind(windowStartIso, windowEndIso)
    .all<{ group_id: string; cnt: number }>();
  for (const r of uRows ?? []) utterMap.set(r.group_id, Number(r.cnt) || 0);

  const prevUtterMap = new Map<string, number>();
  const { results: puRows } = await db
    .prepare('SELECT group_id, COUNT(*) as cnt FROM utterances WHERE created_at > ? AND created_at <= ? GROUP BY group_id')
    .bind(prevStartIso, prevEndIso)
    .all<{ group_id: string; cnt: number }>();
  for (const r of puRows ?? []) prevUtterMap.set(r.group_id, Number(r.cnt) || 0);

  // Miro作業量（JSON配列長の合計）
  const boardToGroup = new Map<string, string>();
  const { results: mapAll } = await db.prepare('SELECT group_id, board_id FROM miro_board_map').all<{ group_id: string; board_id: string }>();
  for (const r of mapAll ?? []) boardToGroup.set(r.board_id, r.group_id);
  const miroMap = new Map<string, number>();
  const { results: dRows } = await db
    .prepare('SELECT board_id, added, updated, deleted FROM miro_diffs WHERE diff_at > ? AND diff_at <= ?')
    .bind(windowStartIso, windowEndIso)
    .all<{ board_id: string; added: string; updated: string; deleted: string }>();
  for (const r of dRows ?? []) {
    const g = boardToGroup.get(r.board_id);
    if (!g) continue;
    const add = safeLen(r.added);
    const upd = safeLen(r.updated);
    const del = safeLen(r.deleted);
    miroMap.set(g, (miroMap.get(g) || 0) + add + upd + del);
  }
  const prevMiroMap = new Map<string, number>();
  const { results: pdRows } = await db
    .prepare('SELECT board_id, added, updated, deleted FROM miro_diffs WHERE diff_at > ? AND diff_at <= ?')
    .bind(prevStartIso, prevEndIso)
    .all<{ board_id: string; added: string; updated: string; deleted: string }>();
  for (const r of pdRows ?? []) {
    const g = boardToGroup.get(r.board_id);
    if (!g) continue;
    const add = safeLen(r.added);
    const upd = safeLen(r.updated);
    const del = safeLen(r.deleted);
    prevMiroMap.set(g, (prevMiroMap.get(g) || 0) + add + upd + del);
  }

  // 感情（平均）
  const sentiMap = new Map<string, number>();
  const { results: sRows } = await db
    .prepare('SELECT group_id, AVG(sentiment_score) as avg_s FROM session_summary WHERE last_updated_at > ? AND last_updated_at <= ? GROUP BY group_id')
    .bind(windowStartIso, windowEndIso)
    .all<{ group_id: string; avg_s: number }>();
  for (const r of sRows ?? []) sentiMap.set(r.group_id, Number(r.avg_s) || 0);

  const prevSentiMap = new Map<string, number>();
  const { results: psRows } = await db
    .prepare('SELECT group_id, AVG(sentiment_score) as avg_s FROM session_summary WHERE last_updated_at > ? AND last_updated_at <= ? GROUP BY group_id')
    .bind(prevStartIso, prevEndIso)
    .all<{ group_id: string; avg_s: number }>();
  for (const r of psRows ?? []) prevSentiMap.set(r.group_id, Number(r.avg_s) || 0);

  // 形に整形
  const list = groupIds.map((g) => {
    const metrics = {
      utterances: utterMap.get(g) || 0,
      miro: miroMap.get(g) || 0,
      sentiment_avg: sentiMap.get(g) ?? 0,
    };
    const prev = {
      utterances: prevUtterMap.get(g) || 0,
      miro: prevMiroMap.get(g) || 0,
      sentiment_avg: prevSentiMap.get(g) ?? 0,
    };
    const deltas = {
      utterances: metrics.utterances - prev.utterances,
      miro: metrics.miro - prev.miro,
      sentiment_avg: metrics.sentiment_avg - prev.sentiment_avg,
    };
    return { group_id: g, metrics, prev_metrics: prev, deltas };
  });
  return list;
}

function safeLen(jsonText: string): number {
  try {
    const arr = JSON.parse(jsonText);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}
