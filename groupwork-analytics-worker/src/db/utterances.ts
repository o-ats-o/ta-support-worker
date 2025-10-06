import { DATA_DELAY_MS } from '../utils/dataDelay';

export async function insertUtterances(db: D1Database, params: {
  sessionId: string;
  groupId: string;
  texts: string[];
  createdAtIso: string;
  speakers?: (number | null)[];
}) {
  const { sessionId, groupId, texts, createdAtIso, speakers } = params;
  const statements = texts.map((t, idx) => db
    .prepare('INSERT INTO utterances (session_id, group_id, utterance_text, created_at, speaker) VALUES (?,?,?,?,?)')
    .bind(sessionId, groupId, t, createdAtIso, speakers ? speakers[idx] ?? null : null));
  // チャンク分割（D1のバッチ上限対策）
  const chunkSize = 100;
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    await db.batch(chunk);
  }
}

type ListUtterancesParams = {
  groupId?: string;
  start?: string;
  end?: string;
  limit: number;
  offset: number;
};

function toMs(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toIso(ms?: number): string | undefined {
  if (ms === undefined) return undefined;
  return new Date(ms).toISOString();
}

export async function listUtterances(db: D1Database, params: ListUtterancesParams) {
  const { groupId, start, end, limit, offset } = params;

  const anchorMs = Date.now() - DATA_DELAY_MS;
  const startMs = toMs(start);
  const requestedEndMs = toMs(end);
  const effectiveEndMs = requestedEndMs !== undefined ? Math.min(requestedEndMs, anchorMs) : anchorMs;

  if (startMs !== undefined && effectiveEndMs !== undefined && startMs >= effectiveEndMs) {
    return [];
  }

  const normalizedStartIso = toIso(startMs);
  const normalizedEndIso = toIso(effectiveEndMs);

  let query = 'SELECT * FROM utterances';
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];
  if (groupId) {
    conditions.push('group_id = ?');
    bindings.push(groupId);
  }
  if (normalizedStartIso) {
    conditions.push('created_at >= ?');
    bindings.push(normalizedStartIso);
  }
  if (normalizedEndIso) {
    conditions.push('created_at < ?');
    bindings.push(normalizedEndIso);
  }
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  bindings.push(limit, offset);

  const stmt = db.prepare(query).bind(...bindings);
  const { results } = await stmt.all<any>();
  if (!results) return [];

  const filtered = results.filter((row: any) => {
    const createdMs = toMs(row.created_at);
    if (createdMs === undefined) return false;
    if (startMs !== undefined && createdMs < startMs) return false;
    if (effectiveEndMs !== undefined && createdMs >= effectiveEndMs) return false;
    return true;
  });

  return filtered;
}


