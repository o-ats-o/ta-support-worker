import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { scenarioSchema } from '../schemas/scenario';
import { generateScenario } from '../services/openai';
import type { AppBindings } from '../config';

export const scenarioRoutes = new Hono<{ Bindings: AppBindings }>();

scenarioRoutes.post('/generate-scenario', zValidator('json', scenarioSchema), async (c) => {
  const { transcript } = c.req.valid('json');
  const prompt = `#命令文:\nあなたは優秀な教員です。以降に示すグループワークの会話内容を読み、議論の停滞、あるいは論点のズレといった、介入のきっかけとなりうる潜在的な問題点を探してください。その上で、グループの議論をより活性化させ、思考を深めるための支援的な介入を開始するために使える、オープンエンドな質問を箇条書きで3つ、異なる切り口で生成してください。\n#グループワークの内容:\n${transcript}`;
  try {
    const scenario = await generateScenario(prompt, c.env.OPENAI_API_KEY);
    return c.json({ scenario });
  } catch (e: any) {
    console.error('Error generating scenario:', e.message);
    return c.json({ error: 'Failed to generate scenario.' }, 500);
  }
});


