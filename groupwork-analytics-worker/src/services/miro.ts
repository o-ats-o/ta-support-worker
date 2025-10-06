import type { AppBindings } from '../config';

type JsonValue = any;

export type MiroItem = {
  id: string;
  type: string;
  [key: string]: JsonValue;
};

export type MiroUpdatedDiff = {
  id: string;
  type: string;
  before: MiroItem | null;
  after: MiroItem | null;
  beforeText?: string;
  afterText?: string;
  changedPaths: string[];
};

export type MiroDiff = {
  boardId: string;
  diffAt: string; // ISO8601
  added: MiroItem[];
  updated: MiroUpdatedDiff[];
  deleted: { id: string; type?: string }[];
};

const MIRO_API_BASE = 'https://api.miro.com/v2';
type PreparedStatement = ReturnType<AppBindings['DB']['prepare']>;

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
  const { token, boardId } = params;
  const types = (params.types ?? [])
    .map((t) => String(t || '').trim())
    .filter((t) => t.length > 0);
  const items: MiroItem[] = [];
  let url = new URL(`${MIRO_API_BASE}/boards/${encodeURIComponent(boardId)}/items`);
  // Miro API: maximum items page size is 50
  url.searchParams.set('limit', '50');
  if (types.length > 0) {
    // Miro v2 は type フィルタをクエリに受け付ける。複数はカンマ区切り
    url.searchParams.set('type', types.join(','));
  }
  let cursor: string | undefined;
  while (true) {
    const fetchUrl = new URL(url.toString());
    if (cursor) fetchUrl.searchParams.set('cursor', cursor);
    const res = await fetch(fetchUrl.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Miro API error ${res.status}: ${body}`);
    }
    const json: any = await res.json();
    const data: any[] = json?.data ?? json?.items ?? [];
    for (const it of data) items.push(it as MiroItem);
    // Miroのレスポンスは cursor が文字列の場合と、オブジェクト（after/next プロパティ）で返る場合がある
    const newCursor: string | undefined =
      typeof json?.cursor === 'string'
        ? json.cursor
        : json?.cursor?.after ?? json?.cursor?.next ?? undefined;
    if (!newCursor) break;
    cursor = newCursor;
  }
  return items;
}

// マッピング: group_id -> board_id を保存・解決
export async function upsertBoardMap(env: AppBindings, groupId: string, boardId: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO miro_board_map (group_id, board_id, created_at, updated_at) VALUES (?, ?, ?, ?)\nON CONFLICT(group_id) DO UPDATE SET board_id = excluded.board_id, updated_at = excluded.updated_at'
  )
    .bind(groupId, boardId, now, now)
    .run();
}

export async function resolveBoardId(env: AppBindings, groupId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT board_id FROM miro_board_map WHERE group_id = ?')
    .bind(groupId)
    .first<{ board_id: string }>();
  if (!row?.board_id) throw new Error(`No board mapped for group_id=${groupId}`);
  return row.board_id;
}

export async function syncBoardAndDiff(env: AppBindings, boardId: string, opts?: { types?: string[] }) {
  const types = opts?.types;
  const now = new Date().toISOString();
  const token = env.MIRO_TOKEN;
  const items = await fetchBoardItems({ token, boardId, types });
  const processedItems = await serializeAndHashItems(items);

  // 直近の状態を取得
  const prevRows = await env.DB.prepare(
    'SELECT item_id, type, hash, data, deleted_at, first_seen_at FROM miro_items WHERE board_id = ?'
  )
    .bind(boardId)
    .all<{
      item_id: string;
      type: string;
      hash: string;
      data: string;
      deleted_at: string | null;
      first_seen_at: string;
    }>();

  const prevMap = new Map<
    string,
    { type: string; hash: string; data: string; deleted_at: string | null; first_seen_at: string }
  >();
  for (const r of prevRows.results ?? [])
    prevMap.set(r.item_id, {
      type: r.type,
      hash: r.hash,
      data: r.data,
      deleted_at: r.deleted_at,
      first_seen_at: r.first_seen_at,
    });

  const seenIds = new Set<string>();
  const added: MiroItem[] = [];
  const updated: MiroUpdatedDiff[] = [];
  const insertStatements: PreparedStatement[] = [];
  const updateStatements: PreparedStatement[] = [];

  for (const { item, serialized, hash } of processedItems) {
    const itemId = item.id;
    if (!itemId) continue;
    seenIds.add(itemId);
    const prev = prevMap.get(itemId);
    if (!prev) {
      added.push(item);
      insertStatements.push(
        env.DB
          .prepare(
            'INSERT INTO miro_items (board_id, item_id, type, hash, data, first_seen_at, last_seen_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
          )
          .bind(boardId, itemId, String(item.type ?? ''), hash, serialized, now, now)
      );
      continue;
    }
    const wasDeleted = prev.deleted_at !== null;
    const isChanged = prev.hash !== hash || wasDeleted;
    if (isChanged) {
      const prevItem = safeJsonParse<MiroItem | null>(prev.data, null);
      updated.push({
        id: itemId,
        type: String(item.type ?? ''),
        before: prevItem,
        after: item,
        beforeText: extractMiroItemText(prevItem),
        afterText: extractMiroItemText(item),
        changedPaths: computeChangedPaths(prevItem, item),
      });
    }
    updateStatements.push(
      env.DB
        .prepare('UPDATE miro_items SET type = ?, hash = ?, data = ?, last_seen_at = ?, deleted_at = NULL WHERE board_id = ? AND item_id = ?')
        .bind(String(item.type ?? ''), hash, serialized, now, boardId, itemId)
    );
  }

  if (insertStatements.length > 0) {
    await executeBatchStatements(env.DB, insertStatements);
  }
  if (updateStatements.length > 0) {
    await executeBatchStatements(env.DB, updateStatements);
  }

  // 削除検出（今回見つからなかったアイテム）
  const deleted: { id: string; type?: string }[] = [];
  const deleteStatements: PreparedStatement[] = [];
  for (const [prevId, prev] of prevMap.entries()) {
    if (!seenIds.has(prevId) && prev.deleted_at === null) {
      deleted.push({ id: prevId, type: prev.type });
      deleteStatements.push(
        env.DB
          .prepare('UPDATE miro_items SET deleted_at = ?, last_seen_at = ? WHERE board_id = ? AND item_id = ?')
          .bind(now, now, boardId, prevId)
      );
    }
  }

  if (deleteStatements.length > 0) {
    await executeBatchStatements(env.DB, deleteStatements);
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
    updated: normalizeUpdatedEntries(safeJsonParse(r.updated, [])),
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

function normalizeUpdatedEntries(entries: any[]): MiroUpdatedDiff[] {
  if (!Array.isArray(entries)) return [];
  const normalized: MiroUpdatedDiff[] = [];
  for (const entry of entries) {
    const value = normalizeUpdatedEntry(entry);
    if (value) normalized.push(value);
  }
  return normalized;
}

function normalizeUpdatedEntry(entry: any): MiroUpdatedDiff | null {
  if (!entry || typeof entry !== 'object') return null;
  const candidateBefore = 'before' in entry ? (entry.before as MiroItem | null) : null;
  const candidateAfter = 'after' in entry ? (entry.after as MiroItem | null) : null;
  const hasRichShape = candidateBefore !== null || candidateAfter !== null || 'beforeText' in entry || 'afterText' in entry;
  if (hasRichShape) {
    const before = candidateBefore && typeof candidateBefore === 'object' ? candidateBefore : null;
    const after = candidateAfter && typeof candidateAfter === 'object' ? candidateAfter : null;
    const id = String(entry.id ?? after?.id ?? before?.id ?? '');
    const type = String(entry.type ?? after?.type ?? before?.type ?? '');
    if (!id) return null;
    return {
      id,
      type,
      before,
      after,
      beforeText:
        typeof entry.beforeText === 'string' && entry.beforeText.trim().length > 0
          ? entry.beforeText
          : extractMiroItemText(before),
      afterText:
        typeof entry.afterText === 'string' && entry.afterText.trim().length > 0
          ? entry.afterText
          : extractMiroItemText(after),
      changedPaths: Array.isArray(entry.changedPaths)
        ? entry.changedPaths.map((p: any) => String(p)).filter((p: string) => p.length > 0)
        : computeChangedPaths(before, after),
    };
  }

  const after = entry as MiroItem;
  const id = String((after as any)?.id ?? '');
  if (!id) return null;
  return {
    id,
    type: String((after as any)?.type ?? ''),
    before: null,
    after,
    beforeText: undefined,
    afterText: extractMiroItemText(after),
    changedPaths: [],
  };
}

function computeChangedPaths(before: MiroItem | null, after: MiroItem | null): string[] {
  const trackedPaths: string[][] = [
    ['data', 'plainText'],
    ['data', 'text'],
    ['data', 'content'],
    ['data', 'title'],
    ['plainText'],
    ['text'],
    ['title'],
    ['name'],
  ];
  const changed = new Set<string>();
  for (const path of trackedPaths) {
    const beforeVal = getNestedValue(before, path);
    const afterVal = getNestedValue(after, path);
    if (!valuesEqual(beforeVal, afterVal)) changed.add(path.join('.'));
  }
  return Array.from(changed);
}

function getNestedValue(source: any, path: string[]): any {
  if (!source || typeof source !== 'object') return undefined;
  let current: any = source;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function valuesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  const normalizedA = normalizeComparableValue(a);
  const normalizedB = normalizeComparableValue(b);
  return normalizedA === normalizedB;
}

function normalizeComparableValue(value: any): string {
  if (value === undefined) return '__undefined__';
  if (value === null) return '__null__';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function extractMiroItemText(item: MiroItem | null | undefined): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const candidates: string[] = [];
  const pushCandidate = (value: unknown) => {
    if (typeof value === 'string') candidates.push(value);
  };
  pushCandidate((item as any).plainText);
  pushCandidate((item as any).text);
  pushCandidate((item as any).title);
  pushCandidate((item as any).name);
  const data = (item as any).data;
  if (data && typeof data === 'object') {
    pushCandidate((data as any).plainText);
    pushCandidate((data as any).text);
    pushCandidate((data as any).title);
    pushCandidate((data as any).content);
  }
  for (const raw of candidates) {
    const decoded = decodeHtmlEntities(raw);
    const stripped = stripHtml(decoded).trim();
    if (stripped.length > 0) return stripped;
  }
  return undefined;
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>(\r?\n)?/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code);
      return Number.isFinite(num) ? String.fromCharCode(num) : _;
    });
}

async function serializeAndHashItems(items: MiroItem[]) {
  const chunkSize = 32;
  const results: { item: MiroItem; serialized: string; hash: string }[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const hashedChunk = await Promise.all(
      chunk.map(async (item) => {
        const serialized = JSON.stringify(item);
        const hash = await sha256(serialized);
        return { item, serialized, hash };
      })
    );
    results.push(...hashedChunk);
  }
  return results;
}

async function executeBatchStatements(db: AppBindings['DB'], statements: PreparedStatement[], chunkSize = 40) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    await db.batch(chunk);
  }
}


