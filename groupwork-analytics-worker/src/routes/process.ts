import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { processRequestSchema } from '../schemas/process';
import { startRunpodJob } from '../services/runpod';
import { getConfig, type AppBindings } from '../config';

export const processRoutes = new Hono<{ Bindings: AppBindings }>();

processRoutes.post('/process-request', zValidator('json', processRequestSchema), async (c) => {
  const { objectKey, sessionId, groupId } = c.req.valid('json');
  const webhookUrl = new URL(c.req.url);
  webhookUrl.pathname = '/api/session/process';
  webhookUrl.searchParams.set('sessionId', sessionId);
  webhookUrl.searchParams.set('groupId', groupId);
  webhookUrl.searchParams.set('secret', c.env.WEBHOOK_SECRET);

  try {
    const { runpodEndpointId } = getConfig(c.env);
    const endpointId = runpodEndpointId ?? 's1qct4d0xol9s3';
    const job = await startRunpodJob({
      endpointId,
      apiKey: c.env.RUNPOD_API_KEY,
      objectKey,
      webhookUrl: webhookUrl.toString(),
      bucketName: c.env.R2_BUCKET_NAME,
    });
    return c.json({ success: true, message: 'Processing job accepted.', jobId: job.id }, 202);
  } catch (e: any) {
    console.error('Failed to start RunPod job:', e.message);
    return c.json({ error: 'Failed to start transcription job.' }, 500);
  }
});


