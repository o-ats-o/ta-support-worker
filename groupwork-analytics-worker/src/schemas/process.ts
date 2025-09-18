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

const baseSegment = z
  .object({
    text: z.string(),
    speaker: z.union([z.number().int(), z.string()]).optional().nullable(),
  })
  .passthrough();

const segmentsSchema = z
  .object({
    segments: z.array(baseSegment),
  })
  .passthrough();

const textSchema = z.object({ text: z.string().min(1) });

const diarizationSchema = z
  .object({
    diarization: z.object({
      segments: z.array(
        baseSegment.extend({ start: z.number().optional(), end: z.number().optional() })
      ),
    }),
  })
  .passthrough();

export const runpodOutputSchema = z
  .object({
    output: z.union([segmentsSchema, textSchema, diarizationSchema]),
  })
  .passthrough();


