import type { AppBindings } from '../config';

type JsonValue = any;

export type MiroItem = {
  id: string;
  type: string;
  [key: string]: JsonValue;
};

export type MiroDiff = {
  boardId: string;
  diffAt: string; // ISO8601
  added: MiroItem[];
  updated: MiroItem[];
  deleted: { id: string; type?: string }[];
};

const MIRO_API_BASE = 'https://api.miro.com/v2';

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchBoardItems(params: {
  token: string;
  boardId: string;
  types?: string[];
}): Promise<MiroItem[]> {
  const { token, boardId, types } = params;
  const items: MiroItem[] = [];
  let url = new URL(`${MIRO_API_BASE}/boards/${encodeURIComponent(boardId)}/items`);
  url.searchParams.set('limit', '100');
  if (types && types.length > 0) {
    // Miro v2 は type フィルタをクエリに受け付ける。複数はカンマ区切り
    url.searchParams.set('type', types.join(','));
  }
  let cursor: string | undefined;
  while (true) {
    const fetchUrl = new URL(url.toString());
    if (cursor) fetchUrl.searchParams.set('cursor', cursor);
    const res = await fetch(fetchUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Miro API error ${res.status}: ${body}`);
    }
    const json: any = await res.json();
    const data: any[] = json?.data ?? json?.items ?? [];
    for (const it of data) items.push(it as MiroItem);
    const newCursor = json?.cursor?.after;
    if (!newCursor) break;
    cursor = newCursor;
  }
  return items;
}

// group_id = board_id 運用のため、解決・マッピング処理は不要

export async function syncBoardAndDiff(env: AppBindings, boardId: string, opts?: { types?: string[] }) {
  const types = opts?.types;
  const now = new Date().toISOString();
  const token = env.MIRO_TOKEN;
  const items = await fetchBoardItems({ token, boardId, types });

  // 直近の状態を取得
  const prevRows = await env.DB.prepare(
    'SELECT item_id, type, hash, deleted_at, first_seen_at FROM miro_items WHERE board_id = ?'
  )
    .bind(boardId)
    .all<{ item_id: string; type: string; hash: string; deleted_at: string | null; first_seen_at: string }>();

  const prevMap = new Map<string, { type: string; hash: string; deleted_at: string | null; first_seen_at: string }>();
  for (const r of prevRows.results ?? []) prevMap.set(r.item_id, { type: r.type, hash: r.hash, deleted_at: r.deleted_at, first_seen_at: r.first_seen_at });

  const seenIds = new Set<string>();
  const added: MiroItem[] = [];
  const updated: MiroItem[] = [];

  for (const it of items) {
    const itemId = it.id;
    if (!itemId) continue;
    seenIds.add(itemId);
    const serialized = JSON.stringify(it);
    const hash = await sha256(serialized);
    const prev = prevMap.get(itemId);
    if (!prev) {
      // 新規
      added.push(it);
      await env.DB.prepare(
        'INSERT INTO miro_items (board_id, item_id, type, hash, data, first_seen_at, last_seen_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
      )
        .bind(boardId, itemId, String(it.type ?? ''), hash, serialized, now, now)
        .run();
    } else {
      // 既存
      const isChanged = prev.hash !== hash || prev.deleted_at !== null;
      if (isChanged) updated.push(it);
      await env.DB.prepare(
        'UPDATE miro_items SET type = ?, hash = ?, data = ?, last_seen_at = ?, deleted_at = NULL WHERE board_id = ? AND item_id = ?'
      )
        .bind(String(it.type ?? ''), hash, serialized, now, boardId, itemId)
        .run();
    }
  }

  // 削除検出（今回見つからなかったアイテム）
  const deleted: { id: string; type?: string }[] = [];
  for (const [prevId, prev] of prevMap.entries()) {
    if (!seenIds.has(prevId) && prev.deleted_at === null) {
      deleted.push({ id: prevId, type: prev.type });
      await env.DB.prepare(
        'UPDATE miro_items SET deleted_at = ?, last_seen_at = ? WHERE board_id = ? AND item_id = ?'
      )
        .bind(now, now, boardId, prevId)
        .run();
    }
  }

  // 差分を記録
  const diffAt = now;
  await env.DB.prepare(
    'INSERT OR REPLACE INTO miro_diffs (board_id, diff_at, added, updated, deleted) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(boardId, diffAt, JSON.stringify(added), JSON.stringify(updated), JSON.stringify(deleted))
    .run();

  const result = { boardId, diffAt, added, updated, deleted } satisfies MiroDiff;
  return result;
}

export async function listDiffs(env: AppBindings, params: {
  boardId: string;
  since?: string;
  until?: string;
  limit: number;
  offset: number;
}) {
  const { boardId, since, until, limit, offset } = params;
  const conds: string[] = ['board_id = ?'];
  const binds: (string | number)[] = [boardId];
  if (since) {
    conds.push('diff_at >= ?');
    binds.push(since);
  }
  if (until) {
    conds.push('diff_at <= ?');
    binds.push(until);
  }
  const sql = `SELECT board_id, diff_at, added, updated, deleted FROM miro_diffs WHERE ${conds.join(' AND ')} ORDER BY diff_at DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);
  const { results } = await env.DB.prepare(sql).bind(...binds).all<{
    board_id: string;
    diff_at: string;
    added: string;
    updated: string;
    deleted: string;
  }>();
  return (results ?? []).map((r) => ({
    boardId: r.board_id,
    diffAt: r.diff_at,
    added: safeJsonParse(r.added, []),
    updated: safeJsonParse(r.updated, []),
    deleted: safeJsonParse(r.deleted, []),
  }));
}

export async function listItems(env: AppBindings, params: {
  boardId: string;
  includeDeleted: boolean;
  limit: number;
  offset: number;
}) {
  const { boardId, includeDeleted, limit, offset } = params;
  const conds: string[] = ['board_id = ?'];
  const binds: (string | number | null)[] = [boardId];
  if (!includeDeleted) {
    conds.push('deleted_at IS NULL');
  }
  const sql = `SELECT item_id, type, data, first_seen_at, last_seen_at, deleted_at FROM miro_items WHERE ${conds.join(' AND ')} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);
  const { results } = await env.DB.prepare(sql).bind(...binds).all<{
    item_id: string;
    type: string;
    data: string;
    first_seen_at: string;
    last_seen_at: string;
    deleted_at: string | null;
  }>();
  return (results ?? []).map((r) => ({
    id: r.item_id,
    type: r.type,
    data: safeJsonParse(r.data, {}),
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    deletedAt: r.deleted_at,
  }));
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}


