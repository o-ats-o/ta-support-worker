export async function generateScenario(prompt: string, apiKey: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-5-nano', messages: [{ role: 'user', content: prompt }] }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
  }
  const completion = await response.json() as any;
  const scenario = completion.choices?.[0]?.message?.content as string | undefined;
  if (!scenario) throw new Error('Invalid response structure from OpenAI API.');
  return scenario;
}


