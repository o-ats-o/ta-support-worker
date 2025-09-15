export type AppBindings = {
  DB: D1Database;
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  ALLOWED_ORIGIN?: string;
  GOOGLE_API_KEY: string;
  OPENAI_API_KEY: string;
  RUNPOD_API_KEY: string;
  RUNPOD_ENDPOINT_ID?: string;
  WEBHOOK_SECRET: string;
};

export function getConfig(env: AppBindings) {
  const allowedOrigin = env.ALLOWED_ORIGIN ?? '*';
  const runpodEndpointId = env.RUNPOD_ENDPOINT_ID;
  return {
    allowedOrigin,
    runpodEndpointId,
  };
}


