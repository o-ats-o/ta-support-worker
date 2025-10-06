import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { webhookQuerySchema, runpodOutputSchema } from '../schemas/process';
import { analyzeSentiment } from '../services/nlp';
import { insertUtterances } from '../db/utterances';
import { upsertSessionSummary } from '../db/sessionSummary';
import { insertSessionSentimentSnapshot } from '../db/sessionSentimentSnapshots';
import type { AppBindings } from '../config';

export const webhookRoutes = new Hono<{ Bindings: AppBindings }>();

webhookRoutes.post('/session/process', zValidator('query', webhookQuerySchema), async (c) => {
  const { sessionId, groupId, secret } = c.req.valid('query');
  if (secret !== c.env.WEBHOOK_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json();
  const validation = runpodOutputSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid webhook payload' }, 400);
  }

  // RunPod 側の出力フォーマット差異を吸収
  const output: any = validation.data.output as any;
  let normalizedSegments: Array<{ text: string; speaker?: number | null }> = [];
  if (Array.isArray(output?.segments)) {
    normalizedSegments = output.segments
      .map((s: any) => ({
        text: String(s.text ?? ''),
        speaker: typeof s.speaker === 'number'
          ? s.speaker
          : (typeof s.speaker === 'string' && /SPEAKER_(\d+)/i.test(s.speaker)
              ? Number((s.speaker as string).match(/SPEAKER_(\d+)/i)![1])
              : null),
      }))
      .filter((s: any) => s.text);
  } else if (typeof output?.text === 'string' && output.text) {
    normalizedSegments = [{ text: output.text }];
  } else if (Array.isArray(output?.diarization?.segments)) {
    normalizedSegments = output.diarization.segments
      .map((s: any) => ({
        text: String(s.text ?? ''),
        speaker: typeof s.speaker === 'number'
          ? s.speaker
          : (typeof s.speaker === 'string' && /SPEAKER_(\d+)/i.test(s.speaker)
              ? Number((s.speaker as string).match(/SPEAKER_(\d+)/i)![1])
              : null),
      }))
      .filter((s: any) => s.text);
  }

  const utteranceCount = normalizedSegments.length;
  if (utteranceCount === 0) {
    return c.json({ success: true, message: 'No utterances to process.' }, 200);
  }

  const fullTranscript = normalizedSegments.map((s) => s.text).join('\n');
  let sentimentScore = 0.0;
  try {
    sentimentScore = await analyzeSentiment(fullTranscript, c.env.GOOGLE_API_KEY);
  } catch (e: any) {
    console.error('Google NLP API call failed:', e.message);
  }

  const now = new Date().toISOString();
  try {
    await insertUtterances(c.env.DB, {
      sessionId,
      groupId,
      texts: normalizedSegments.map((s) => s.text),
      speakers: normalizedSegments.map((s) => (typeof s.speaker === 'number' ? s.speaker : null)),
      createdAtIso: now,
    });
    await upsertSessionSummary(c.env.DB, { sessionId, groupId, utteranceCount, sentimentScore, updatedAtIso: now });
    await insertSessionSentimentSnapshot(c.env.DB, {
      sessionId,
      groupId,
      capturedAtIso: now,
      utteranceCount,
      sentimentScore,
    });
    // SSE へ通知
    try {
      const bc = new BroadcastChannel('ta-support-events');
      bc.postMessage({ type: 'session_processed', sessionId, groupId, at: now });
      bc.close();
    } catch (e) {
      console.warn('BroadcastChannel failed:', (e as any)?.message || e);
    }
    return c.json({ success: true, message: `Processed ${utteranceCount} utterances.` });
  } catch (e: any) {
    console.error('Database transaction failed:', e.message);
    return c.json({ error: 'Failed to process session results.' }, 500);
  }
});


