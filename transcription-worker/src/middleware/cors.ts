import { cors } from 'hono/cors';

export function buildCors(origin: string | string[]) {
  return cors({
    origin,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });
}


