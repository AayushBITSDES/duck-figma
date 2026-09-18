const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: CORS_HEADERS,
  });
}

const ALLOWED_ORIGINS = new Set([
  'null',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  'https://localhost:8787',
  'https://127.0.0.1:8787',
]);

export function originAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (origin === null || origin === '') return false;
  return ALLOWED_ORIGINS.has(origin);
}
