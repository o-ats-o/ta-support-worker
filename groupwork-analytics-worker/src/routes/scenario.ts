import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { scenarioSchema } from '../schemas/scenario';
import { generateScenario } from '../services/openai';
import type { AppBindings } from '../config';

export const scenarioRoutes = new Hono<{ Bindings: AppBindings }>();

scenarioRoutes.post('/generate-scenario', zValidator('json', scenarioSchema), async (c) => {
  const { transcript } = c.req.valid('json');
  const prompt = `#命令文:\nあなたは優秀な教員です。以降に示すグループワークの内容を見て、このグループに対してどのように声を掛け指導を開始しますか？指導の際の声掛けシナリオを箇条書きで複数提示してください。その際、グループの議論を活性化させることに焦点を置いてください。\n#グループワークの内容:\n${transcript}`;
  try {
    const scenario = await generateScenario(prompt, c.env.OPENAI_API_KEY);
    return c.json({ scenario });
  } catch (e: any) {
    console.error('Error generating scenario:', e.message);
    return c.json({ error: 'Failed to generate scenario.' }, 500);
  }
});


