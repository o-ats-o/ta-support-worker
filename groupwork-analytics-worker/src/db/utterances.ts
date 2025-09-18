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

export async function listUtterances(db: D1Database, params: {
  groupId?: string;
  start?: string;
  end?: string;
  limit: number;
  offset: number;
}) {
  const { groupId, start, end, limit, offset } = params;
  let query = 'SELECT * FROM utterances';
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];
  if (groupId) { conditions.push('group_id =?'); bindings.push(groupId); }
  if (start) { conditions.push('created_at >=?'); bindings.push(start); }
  if (end) { conditions.push('created_at <=?'); bindings.push(end); }
  if (conditions.length > 0) { query += ' WHERE ' + conditions.join(' AND '); }
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  bindings.push(limit, offset);
  const stmt = db.prepare(query).bind(...bindings);
  const { results } = await stmt.all();
  return results ?? [];
}


