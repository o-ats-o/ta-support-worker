export async function analyzeSentiment(text: string, apiKey: string): Promise<number> {
  const url = `https://language.googleapis.com/v1/documents:analyzeSentiment?key=${apiKey}`;
  const body = { document: { content: text, type: 'PLAIN_TEXT', language: 'JA' }, encodingType: 'UTF8' };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Google NLP API error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json() as any;
  return data.documentSentiment?.score ?? 0.0;
}


