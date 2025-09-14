import { z } from '@hono/zod-openapi';

export const scenarioSchema = z.object({
  transcript: z.string().min(1, { message: 'Transcript is required.' }),
});


