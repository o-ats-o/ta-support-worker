export async function upsertSessionSummary(db: D1Database, params: {
  sessionId: string;
  groupId: string;
  utteranceCount: number;
  sentimentScore: number;
  updatedAtIso: string;
}) {
  const { sessionId, groupId, utteranceCount, sentimentScore, updatedAtIso } = params;
  const stmt = db.prepare(
    `INSERT INTO session_summary (session_id, group_id, utterance_count, sentiment_score, last_updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(session_id, group_id) DO UPDATE SET
       utterance_count = utterance_count + excluded.utterance_count,
       sentiment_score = excluded.sentiment_score,
       last_updated_at = excluded.last_updated_at`
  ).bind(sessionId, groupId, utteranceCount, sentimentScore, updatedAtIso);
  await stmt.run();
}


