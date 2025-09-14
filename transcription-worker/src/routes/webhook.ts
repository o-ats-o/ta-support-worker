import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { webhookQuerySchema, runpodOutputSchema } from '../schemas/process';
import { analyzeSentiment } from '../services/nlp';
import { insertUtterances } from '../db/utterances';
import { upsertSessionSummary } from '../db/sessionSummary';
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

  const { segments } = validation.data.output;
  const utteranceCount = segments.length;
  if (utteranceCount === 0) {
    return c.json({ success: true, message: 'No utterances to process.' }, 200);
  }

  const fullTranscript = segments.map((s) => s.text).join('\n');
  let sentimentScore = 0.0;
  try {
    sentimentScore = await analyzeSentiment(fullTranscript, c.env.GOOGLE_API_KEY);
  } catch (e: any) {
    console.error('Google NLP API call failed:', e.message);
  }

  const now = new Date().toISOString();
  try {
    await insertUtterances(c.env.DB, { sessionId, groupId, texts: segments.map((s) => s.text), createdAtIso: now });
    await upsertSessionSummary(c.env.DB, { sessionId, groupId, utteranceCount, sentimentScore, updatedAtIso: now });
    return c.json({ success: true, message: `Processed ${utteranceCount} utterances.` });
  } catch (e: any) {
    console.error('Database transaction failed:', e.message);
    return c.json({ error: 'Failed to process session results.' }, 500);
  }
});


