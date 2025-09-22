import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../config';
import { recommendQuerySchema } from '../schemas/recommend';

type Metrics = { utterances: number; miro: number; sentiment: number };

function minMaxNormalize(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!isFinite(min) || !isFinite(max) || max === min) return () => 0.5;
  return (v: number) => (v - min) / (max - min);
}

export const recommendRoutes = new Hono<{ Bindings: AppBindings }>();

recommendRoutes.get('/groups/recommendations', zValidator('query', recommendQuerySchema), async (c) => {
  const { start, end: endRaw, limit } = c.req.valid('query');
  const startMs = new Date(start).getTime();
  const endMs = endRaw ? new Date(endRaw).getTime() : new Date(new Date(start).getTime() + 5 * 60 * 1000).getTime();
  if (isNaN(startMs) || isNaN(endMs)) return c.json({ error: 'Invalid datetime' }, 400);
  const diff = endMs - startMs;
  if (diff !== 5 * 60 * 1000) return c.json({ error: 'Window must be exactly 5 minutes' }, 400);

  // ベースとなるグループ集合（miro_board_map + utterances + session_summary から抽出）
  const baseGroups = new Set<string>();
  const { results: mapRows } = await c.env.DB.prepare('SELECT group_id FROM miro_board_map').all<{ group_id: string }>();
  for (const r of mapRows ?? []) baseGroups.add(r.group_id);
  const { results: uGroups } = await c.env.DB
    .prepare('SELECT DISTINCT group_id FROM utterances WHERE created_at > ? AND created_at <= ?')
    .bind(new Date(startMs).toISOString(), new Date(endMs).toISOString())
    .all<{ group_id: string }>();
  for (const r of uGroups ?? []) baseGroups.add(r.group_id);
  const { results: sGroups } = await c.env.DB
    .prepare('SELECT DISTINCT group_id FROM session_summary WHERE last_updated_at > ? AND last_updated_at <= ?')
    .bind(new Date(startMs).toISOString(), new Date(endMs).toISOString())
    .all<{ group_id: string }>();
  for (const r of sGroups ?? []) baseGroups.add(r.group_id);

  const groupIds = Array.from(baseGroups);
  if (groupIds.length === 0) return c.json([]);

  // 発話件数
  const utterMap = new Map<string, number>();
  const { results: uRows } = await c.env.DB
    .prepare('SELECT group_id, COUNT(*) as cnt FROM utterances WHERE created_at > ? AND created_at <= ? GROUP BY group_id')
    .bind(new Date(startMs).toISOString(), new Date(endMs).toISOString())
    .all<{ group_id: string; cnt: number }>();
  for (const r of uRows ?? []) utterMap.set(r.group_id, Number(r.cnt) || 0);

  // Miro作業量（JSON長の合計）
  const boardToGroup = new Map<string, string>();
  const { results: mapAll } = await c.env.DB.prepare('SELECT group_id, board_id FROM miro_board_map').all<{ group_id: string; board_id: string }>();
  for (const r of mapAll ?? []) boardToGroup.set(r.board_id, r.group_id);
  const miroMap = new Map<string, number>();
  const { results: dRows } = await c.env.DB
    .prepare('SELECT board_id, added, updated, deleted FROM miro_diffs WHERE diff_at > ? AND diff_at <= ?')
    .bind(new Date(startMs).toISOString(), new Date(endMs).toISOString())
    .all<{ board_id: string; added: string; updated: string; deleted: string }>();
  for (const r of dRows ?? []) {
    const g = boardToGroup.get(r.board_id);
    if (!g) continue;
    const add = safeLen(r.added);
    const upd = safeLen(r.updated);
    const del = safeLen(r.deleted);
    miroMap.set(g, (miroMap.get(g) || 0) + add + upd + del);
  }

  // 感情
  const sentiMap = new Map<string, number>();
  const { results: sRows } = await c.env.DB
    .prepare('SELECT group_id, AVG(sentiment_score) as avg_s FROM session_summary WHERE last_updated_at > ? AND last_updated_at <= ? GROUP BY group_id')
    .bind(new Date(startMs).toISOString(), new Date(endMs).toISOString())
    .all<{ group_id: string; avg_s: number }>();
  for (const r of sRows ?? []) sentiMap.set(r.group_id, Number(r.avg_s) || 0);

  // 統合とスコアリング
  const metrics: Record<string, Metrics> = {};
  for (const g of groupIds) {
    metrics[g] = {
      utterances: utterMap.get(g) || 0,
      miro: miroMap.get(g) || 0,
      sentiment: sentiMap.get(g) ?? 0, // なければ0
    };
  }
  const uVals = groupIds.map((g) => metrics[g].utterances);
  const mVals = groupIds.map((g) => metrics[g].miro);
  const sVals = groupIds.map((g) => metrics[g].sentiment);
  const uN = minMaxNormalize(uVals);
  const mN = minMaxNormalize(mVals);
  const sN = minMaxNormalize(sVals);

  const scored = groupIds.map((g) => {
    const m = metrics[g];
    // すべて「低いほど優先」の向きに統一し、重みは1:1:1（平均）
    const u = uN(m.utterances);
    const mi = mN(m.miro);
    const s = sN(m.sentiment);
    const score = (u + mi + s) / 3;
    return { group_id: g, score, metrics: { utterances: m.utterances, miro: m.miro, sentiment_avg: m.sentiment } };
  });
  scored.sort((a, b) => a.score - b.score);
  if (limit && limit > 0) return c.json(scored.slice(0, limit));
  return c.json(scored);
});

function safeLen(jsonText: string): number {
  try {
    const arr = JSON.parse(jsonText);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}
