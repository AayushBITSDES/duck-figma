import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

let failOpenAiOnce = true;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          OPENAI_API_KEY: 'test-key',
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.hostname === 'api.openai.com') {
            const body = await request.text();
            if (body.includes('SLOW_OPENAI')) await new Promise((resolve) => setTimeout(resolve, 500));
            if (body.includes('FAIL_OPENAI') && failOpenAiOnce) {
              failOpenAiOnce = false;
              return Response.json({ error: { message: 'rate limited' } }, { status: 429 });
            }
            if (body.includes('ECHO_ROUND')) {
              return Response.json({
                id: 'chatcmpl-echo',
                choices: [
                  {
                    message: { role: 'assistant', content: body },
                    finish_reason: 'stop',
                  },
                ],
              });
            }
            return Response.json({
              id: 'chatcmpl-test',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'What is the real constraint on this board?',
                  },
                  finish_reason: 'stop',
                },
              ],
            });
          }
          return new Response('blocked', { status: 599 });
        },
      },
    }),
  ],
  test: {
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
