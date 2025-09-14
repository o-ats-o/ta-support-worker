import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { createR2Client, createUploadUrl } from '../services/r2';
import type { AppBindings } from '../config';
import { zValidator } from '@hono/zod-validator';
import { z } from '@hono/zod-openapi';

export const uploadRoutes = new Hono<{ Bindings: AppBindings }>();

const generateUploadUrlSchema = z.object({
  contentType: z.enum(['audio/wav', 'audio/flac']).optional().default('audio/wav'),
});

uploadRoutes.post('/generate-upload-url', zValidator('json', generateUploadUrlSchema.optional()), async (c) => {
  const s3 = createR2Client({
    accountId: c.env.R2_ACCOUNT_ID,
    accessKeyId: c.env.R2_ACCESS_KEY_ID,
    secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
  });
  try {
    const body = await c.req.json().catch(() => ({}));
    const contentType = body?.contentType ?? 'audio/wav';
    const ext = contentType === 'audio/flac' ? 'flac' : 'wav';
    const objectKey = `${uuidv4()}.${ext}`;
    const uploadUrl = await createUploadUrl({ s3, bucket: c.env.R2_BUCKET_NAME, objectKey, contentType });
    return c.json({ uploadUrl, objectKey });
  } catch (error) {
    console.error('Error generating signed URL:', error);
    return c.json({ error: 'Failed to generate upload URL' }, 500);
  }
});


