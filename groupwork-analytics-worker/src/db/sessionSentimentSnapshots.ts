export async function insertSessionSentimentSnapshot(db: D1Database, params: {
  sessionId: string;
  groupId: string;
  capturedAtIso: string;
  utteranceCount: number;
  sentimentScore: number;
}) {
  const { sessionId, groupId, capturedAtIso, utteranceCount, sentimentScore } = params;
  const stmt = db
    .prepare(
      `INSERT INTO session_sentiment_snapshots (session_id, group_id, captured_at, utterance_count, sentiment_score)
       VALUES (?,?,?,?,?)`
    )
    .bind(sessionId, groupId, capturedAtIso, utteranceCount, sentimentScore);
  await stmt.run();
}
