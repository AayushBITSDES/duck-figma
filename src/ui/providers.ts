export type ProviderId = 'openrouter' | 'openai' | 'anthropic' | 'google';

export const MAX_REPLY_TOKENS = 220;

export type Provider = {
  label: string;
  model: string;
  hint: string;
  url: string;
  headers: (key: string) => Record<string, string>;
  body: (system: string, msgs: { role: string; content: string }[]) => any;
  reply: (data: any) => string | undefined;
};

// Every one of these was checked against a live preflight: all four answer CORS
// for a null origin, which is the origin a Figma plugin iframe sends.
export const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter: {
    label: 'OpenRouter',
    model: 'thinkingmachines/inkling:free',
    hint: 'sk-or-v1-...',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: (key) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }),
    body: (system, msgs) => openAiBody(PROVIDERS.openrouter.model, system, msgs),
    reply: (d) => d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content,
  },
  openai: {
    label: 'OpenAI',
    model: 'gpt-5.6-luna',
    hint: 'sk-...',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: (key) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }),
    body: (system, msgs) => openAiBody(PROVIDERS.openai.model, system, msgs),
    reply: (d) => d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content,
  },
  anthropic: {
    label: 'Anthropic',
    model: 'claude-haiku-4-5',
    hint: 'sk-ant-...',
    url: 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: (system, msgs) => ({
      model: PROVIDERS.anthropic.model,
      max_tokens: MAX_REPLY_TOKENS,
      system,
      messages: msgs,
    }),
    reply: (d) => d && d.content && d.content[0] && d.content[0].text,
  },
  google: {
    label: 'Google AI Studio',
    model: 'gemini-3.8-flash',
    hint: 'AIza...',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    headers: (key) => ({ 'Content-Type': 'application/json', 'x-goog-api-key': key }),
    body: (system, msgs) => ({
      systemInstruction: { parts: [{ text: system }] },
      contents: msgs.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: MAX_REPLY_TOKENS },
    }),
    reply: (d) =>
      d && d.candidates && d.candidates[0] && d.candidates[0].content &&
      d.candidates[0].content.parts && d.candidates[0].content.parts[0] &&
      d.candidates[0].content.parts[0].text,
  },
};

export function openAiBody(model: string, system: string, msgs: { role: string; content: string }[]) {
  return {
    model,
    max_completion_tokens: MAX_REPLY_TOKENS,
    messages: [{ role: 'system', content: system }].concat(msgs),
  };
}

export const PROVIDER_IDS: ProviderId[] = ['openrouter', 'openai', 'anthropic', 'google'];
