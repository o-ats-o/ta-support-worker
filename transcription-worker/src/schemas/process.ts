import { z } from '@hono/zod-openapi';

export const processRequestSchema = z.object({
  objectKey: z.string().min(1),
  sessionId: z.string().min(1),
  groupId: z.string().min(1),
});

export const webhookQuerySchema = z.object({
  sessionId: z.string().min(1),
  groupId: z.string().min(1),
  secret: z.string().min(1),
});

export const runpodOutputSchema = z.object({
  output: z.object({ segments: z.array(z.object({ text: z.string() })) }),
});


