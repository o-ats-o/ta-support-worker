type StartJobResponse = { id: string };

export async function startRunpodJob(params: {
  endpointId: string;
  apiKey: string;
  objectKey: string;
  webhookUrl: string;
}): Promise<StartJobResponse> {
  const { endpointId, apiKey, objectKey, webhookUrl } = params;
  const runpodEndpoint = `https://api.runpod.ai/v2/${endpointId}/run`;
  const runpodPayload = { input: { object_key: objectKey }, webhook: webhookUrl };
  const response = await fetch(runpodEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(runpodPayload),
  });
  if (!response.ok) {
    throw new Error(`RunPod API error: ${response.status} ${await response.text()}`);
  }
  return response.json<StartJobResponse>();
}


