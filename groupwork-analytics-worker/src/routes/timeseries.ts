import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../config';
import { timeseriesQuerySchema } from '../schemas/timeseries';
import { DATA_DELAY_MS } from '../utils/dataDelay';

export const timeseriesRoutes = new Hono<{ Bindings: AppBindings }>();

timeseriesRoutes.get('/groups/timeseries', zValidator('query', timeseriesQuerySchema), async (c) => {
  const { group_ids, start, end } = c.req.valid('query');

  const endMs = end ? new Date(end).getTime() : new Date(new Date(start).getTime() + 5 * 60 * 1000).getTime();
  const startMs = new Date(start).getTime();
  const window = endMs - startMs; // 5分想定
  const anchorMs = Date.now() - DATA_DELAY_MS;

  // 選択窓とその直前4窓の合計5バケットを返す（古→新の順）
  const baseStart = startMs - 4 * window;
  const buckets: { start: string; end: string; items: { group_id: string; utterances: number; miro: number; sentiment_avg: number }[] }[] = [];
  for (let i = 0; i < 5; i++) {
    const bStart = baseStart + i * window;
    const bEnd = bStart + window;
    const fromIso = new Date(bStart).toISOString();
    const toIso = new Date(bEnd).toISOString();
    let u: Map<string, number>;
    let m: Map<string, number>;
    let s: Map<string, number>;
    if (anchorMs >= bEnd) {
      u = await countUtterances(c.env.DB, group_ids, fromIso, toIso);
      m = await sumMiroDiffs(c.env.DB, group_ids, fromIso, toIso);
      s = await avgSentiment(c.env.DB, group_ids, fromIso, toIso);
    } else {
      u = new Map();
      m = new Map();
      s = new Map();
    }
    const items = group_ids.map((g) => ({
      group_id: g,
      utterances: u.get(g) || 0,
      miro: m.get(g) || 0,
      sentiment_avg: s.get(g) ?? 0,
    }));
    buckets.push({ start: fromIso, end: toIso, items });
  }

  return c.json({ window_ms: window, buckets });
});

async function countUtterances(db: D1Database, groupIds: string[], from: string, to: string) {
  const map = new Map<string, number>();
  const { results } = await db
    .prepare(`SELECT group_id, COUNT(*) as cnt FROM utterances WHERE created_at > ? AND created_at <= ? AND group_id IN (${groupIds.map(() => '?').join(',')}) GROUP BY group_id`)
    .bind(from, to, ...groupIds)
    .all<{ group_id: string; cnt: number }>();
  for (const r of results ?? []) map.set(r.group_id, Number(r.cnt) || 0);
  return map;
}

async function sumMiroDiffs(db: D1Database, groupIds: string[], from: string, to: string) {
  const boardToGroup = new Map<string, string>();
  const { results: mapAll } = await db
    .prepare('SELECT group_id, board_id FROM miro_board_map WHERE group_id IN (' + groupIds.map(() => '?').join(',') + ')')
    .bind(...groupIds)
    .all<{ group_id: string; board_id: string }>();
  for (const r of mapAll ?? []) boardToGroup.set(r.board_id, r.group_id);
  const map = new Map<string, number>();
  const { results } = await db
    .prepare('SELECT board_id, added, updated, deleted FROM miro_diffs WHERE diff_at > ? AND diff_at <= ?')
    .bind(from, to)
    .all<{ board_id: string; added: string; updated: string; deleted: string }>();
  for (const r of results ?? []) {
    const g = boardToGroup.get(r.board_id);
    if (!g || !groupIds.includes(g)) continue;
    const add = safeLen(r.added);
    const upd = safeLen(r.updated);
    const del = safeLen(r.deleted);
    map.set(g, (map.get(g) || 0) + add + upd + del);
  }
  return map;
}

async function avgSentiment(db: D1Database, groupIds: string[], from: string, to: string) {
  const map = new Map<string, number>();
  const { results } = await db
    .prepare(`SELECT group_id, AVG(sentiment_score) as avg_s FROM session_summary WHERE last_updated_at > ? AND last_updated_at <= ? AND group_id IN (${groupIds.map(() => '?').join(',')}) GROUP BY group_id`)
    .bind(from, to, ...groupIds)
    .all<{ group_id: string; avg_s: number }>();
  for (const r of results ?? []) map.set(r.group_id, Number(r.avg_s) || 0);
  return map;
}

function safeLen(jsonText: string): number {
  try {
    const arr = JSON.parse(jsonText);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}


