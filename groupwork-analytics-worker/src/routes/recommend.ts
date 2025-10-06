import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../config';
import { recommendQuerySchema } from '../schemas/recommend';
import { DATA_DELAY_MS } from '../utils/dataDelay';

type Metrics = { utterances: number; miro: number; sentiment: number };

function zScoreNormalize(values: number[]): (v: number) => number {
  const n = values.length;
  if (!n) return () => 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(variance);
  if (!isFinite(std) || std === 0) return () => 0; // 全員同値 → 中立
  return (v: number) => (v - mean) / std;
}

export const recommendRoutes = new Hono<{ Bindings: AppBindings }>();

recommendRoutes.get('/groups/recommendations', zValidator('query', recommendQuerySchema), async (c) => {
  const { start, end: endRaw, limit } = c.req.valid('query');
  const startMs = new Date(start).getTime();
  const endMs = endRaw ? new Date(endRaw).getTime() : new Date(new Date(start).getTime() + 5 * 60 * 1000).getTime();
  if (isNaN(startMs) || isNaN(endMs)) return c.json({ error: 'Invalid datetime' }, 400);
  const diff = endMs - startMs;
  if (diff !== 5 * 60 * 1000) return c.json({ error: 'Window must be exactly 5 minutes' }, 400);
  const anchorMs = Date.now() - DATA_DELAY_MS;
  const windowReady = anchorMs >= endMs;
  const prevWindowReady = anchorMs >= startMs;
  const windowStartIso = new Date(startMs).toISOString();
  const windowEndIso = new Date(endMs).toISOString();

  // ベースとなるグループ集合（miro_board_map + utterances + session_sentiment_snapshots から抽出）
  const baseGroups = new Set<string>();
  const { results: mapRows } = await c.env.DB.prepare('SELECT group_id FROM miro_board_map').all<{ group_id: string }>();
  for (const r of mapRows ?? []) baseGroups.add(r.group_id);
  if (windowReady) {
    const { results: uGroups } = await c.env.DB
      .prepare('SELECT DISTINCT group_id FROM utterances WHERE created_at > ? AND created_at <= ?')
      .bind(windowStartIso, windowEndIso)
      .all<{ group_id: string }>();
    for (const r of uGroups ?? []) baseGroups.add(r.group_id);
    const { results: sGroups } = await c.env.DB
      .prepare('SELECT DISTINCT group_id FROM session_sentiment_snapshots WHERE captured_at > ? AND captured_at <= ?')
      .bind(windowStartIso, windowEndIso)
      .all<{ group_id: string }>();
    for (const r of sGroups ?? []) baseGroups.add(r.group_id);
  }

  const groupIds = Array.from(baseGroups);
  if (groupIds.length === 0) return c.json([]);

  // 発話件数
  const utterMap = new Map<string, number>();
  if (windowReady) {
    const { results: uRows } = await c.env.DB
      .prepare('SELECT group_id, COUNT(*) as cnt FROM utterances WHERE created_at > ? AND created_at <= ? GROUP BY group_id')
      .bind(windowStartIso, windowEndIso)
      .all<{ group_id: string; cnt: number }>();
    for (const r of uRows ?? []) utterMap.set(r.group_id, Number(r.cnt) || 0);
  }

  // Miro作業量（JSON長の合計）
  const boardToGroup = new Map<string, string>();
  const { results: mapAll } = await c.env.DB.prepare('SELECT group_id, board_id FROM miro_board_map').all<{ group_id: string; board_id: string }>();
  for (const r of mapAll ?? []) boardToGroup.set(r.board_id, r.group_id);
  const miroMap = new Map<string, number>();
  if (windowReady) {
    const { results: dRows } = await c.env.DB
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
  }

  // 感情
  const sentiMap = new Map<string, number>();
  if (windowReady) {
    const { results: sRows } = await c.env.DB
      .prepare('SELECT group_id, AVG(sentiment_score) as avg_s FROM session_sentiment_snapshots WHERE captured_at > ? AND captured_at <= ? GROUP BY group_id')
      .bind(windowStartIso, windowEndIso)
      .all<{ group_id: string; avg_s: number }>();
    for (const r of sRows ?? []) sentiMap.set(r.group_id, Number(r.avg_s) || 0);
  }

  // 直前5分（前窓）の集計
  const prevStartIso = new Date(startMs - 5 * 60 * 1000).toISOString();
  const prevEndIso = new Date(startMs).toISOString();
  const prevUtterMap = new Map<string, number>();
  if (prevWindowReady) {
    const { results: puRows } = await c.env.DB
      .prepare('SELECT group_id, COUNT(*) as cnt FROM utterances WHERE created_at > ? AND created_at <= ? GROUP BY group_id')
      .bind(prevStartIso, prevEndIso)
      .all<{ group_id: string; cnt: number }>();
    for (const r of puRows ?? []) prevUtterMap.set(r.group_id, Number(r.cnt) || 0);
  }

  const prevMiroMap = new Map<string, number>();
  if (prevWindowReady) {
    const { results: pdRows } = await c.env.DB
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
  }

  const prevSentiMap = new Map<string, number>();
  if (prevWindowReady) {
    const { results: psRows } = await c.env.DB
      .prepare('SELECT group_id, AVG(sentiment_score) as avg_s FROM session_sentiment_snapshots WHERE captured_at > ? AND captured_at <= ? GROUP BY group_id')
      .bind(prevStartIso, prevEndIso)
      .all<{ group_id: string; avg_s: number }>();
    for (const r of psRows ?? []) prevSentiMap.set(r.group_id, Number(r.avg_s) || 0);
  }

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
  const uN = zScoreNormalize(uVals);
  const mN = zScoreNormalize(mVals);
  const sN = zScoreNormalize(sVals);

  let scored = groupIds.map((g) => {
    const m = metrics[g];
    // すべて「低いほど優先」の向きに統一し、Z-score の 1:1:1 平均
    const u = uN(m.utterances);
    const mi = mN(m.miro);
    const s = sN(m.sentiment);
    const score = (u + mi + s) / 3;
    const prev = {
      utterances: prevUtterMap.get(g) || 0,
      miro: prevMiroMap.get(g) || 0,
      sentiment_avg: prevSentiMap.get(g) ?? 0,
    };
    const deltas = {
      utterances: m.utterances - prev.utterances,
      miro: m.miro - prev.miro,
      sentiment_avg: m.sentiment - prev.sentiment_avg,
    };
    const reasons: string[] = [];
    if (u <= -0.5) reasons.push('発話回数が少ない');
    if (s <= -0.5 || m.sentiment < 0) reasons.push('感情がネガティブ');
    if (mi <= -0.5) reasons.push('Miroの作業量が少ない');
    return {
      group_id: g,
      score,
      metrics: { utterances: m.utterances, miro: m.miro, sentiment_avg: m.sentiment },
      prev_metrics: prev,
      deltas,
      subscores_z: { utterances_z: u, miro_z: mi, sentiment_z: s },
      reasons,
    };
  });
  // スコアが同値のときは発話→Miro→感情の順でタイブレーク
  scored.sort((a, b) =>
    a.score !== b.score
      ? a.score - b.score
      : a.metrics.utterances !== b.metrics.utterances
      ? a.metrics.utterances - b.metrics.utterances
      : a.metrics.miro !== b.metrics.miro
      ? a.metrics.miro - b.metrics.miro
      : a.metrics.sentiment_avg - b.metrics.sentiment_avg
  );
  // ランク番号を付与（フロント側で先頭2件を優先観察として利用）
  scored = scored.map((item, idx) => ({ ...item, rank: idx + 1 }));
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
