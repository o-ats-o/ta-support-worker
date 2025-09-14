import { Hono } from 'hono';
import { buildCors } from './middleware/cors';
import { uploadRoutes } from './routes/upload';
import { processRoutes } from './routes/process';
import { webhookRoutes } from './routes/webhook';
import { utterancesRoutes } from './routes/utterances';
import { scenarioRoutes } from './routes/scenario';
import { getConfig, type AppBindings } from './config';
import { docsApp } from './docs';

const app = new Hono<{ Bindings: AppBindings }>();

// CORS
app.use('*', async (c, next) => {
  const { allowedOrigin } = getConfig(c.env);
  const corsMiddleware = buildCors(allowedOrigin);
  return corsMiddleware(c, next);
});

app.route('/', uploadRoutes);
app.route('/', processRoutes);
app.route('/', webhookRoutes);
app.route('/', utterancesRoutes);
app.route('/', scenarioRoutes);
app.route('/', docsApp);

export default app;
