// Deno Deploy version of api/ask.js. Deno Deploy's network is reachable from
// Russia while Vercel's often is not, and its servers sit outside Russia, so
// Gemini still sees a non-Russian caller IP. Same logic as api/ask.js.

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    caption: { type: 'STRING' },
    formula: { type: 'STRING' },
    animation_svg: { type: 'STRING' },
  },
  required: ['reply', 'caption', 'formula', 'animation_svg'],
};

const ALLOWED_ORIGINS = new Set([
  'https://fizika-rulit.ru',
  'https://www.fizika-rulit.ru',
  'https://asyakatop.github.io',
]);

function baseHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://fizika-rulit.ru',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

function jsonResponse(status, body, origin, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, baseHeaders(origin), extraHeaders),
  });
}

// Per-instance, in-memory limit (not a hard global cap). Generous because a
// whole class can share one school IP. Skipped when the caller IP is unknown,
// so that unrelated users are never lumped into one bucket.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const requestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

// Gemini regularly answers 503 "high demand" for a single model, so each
// request walks a chain of models until one gives a usable answer.
const PRIMARY_MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-3.6-flash';
const FALLBACK_MODELS = (Deno.env.get('GEMINI_FALLBACK_MODELS') || 'gemini-flash-latest,gemini-flash-lite-latest')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MODEL_CHAIN = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];

const ATTEMPT_TIMEOUT_MS = 20000;
const TOTAL_BUDGET_MS = 50000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The model sometimes emits LaTeX backslashes (\frac, \rho, ...) undoubled
// inside JSON: some break JSON.parse, others silently turn into control
// characters (\t, \f, \r). Prefer the repaired parse when the direct one
// looks corrupted.
function parseModelJson(raw) {
  const cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const tryParse = (text) => {
    try {
      const obj = JSON.parse(text);
      // Reject placeholder answers such as "...": the model occasionally returns those.
      return obj && typeof obj.reply === 'string' && /[A-Za-zА-Яа-яЁё]{3,}/.test(obj.reply) ? obj : null;
    } catch (e) {
      return null;
    }
  };
  const direct = tryParse(cleaned);
  const fixed = tryParse(cleaned.replace(/(?<!\\)\\(?=[a-zA-Z]{2,})/g, '\\\\'));
  const looksCorrupted = (obj) => obj && /[\x00-\x1F]/.test((obj.formula || '') + (obj.reply || ''));
  if (fixed && (!direct || looksCorrupted(direct))) return fixed;
  return direct || fixed;
}

async function askOneModel(model, apiKey, requestBody) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      return { ok: false, status: resp.status, detail };
    }
    const data = await resp.json();
    const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;
    if (!text) return { ok: false, status: 502, detail: 'empty response' };
    // A cut-off answer comes back as HTTP 200 with truncated JSON.
    const parsed = parseModelJson(text);
    if (!parsed) return { ok: false, status: 502, detail: 'truncated or invalid JSON' };
    return { ok: true, parsed };
  } catch (err) {
    return { ok: false, status: 504, detail: String((err && err.name) || err) };
  }
}

function sanitizeSvg(svg) {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, '$1');
}

async function handler(req) {
  const origin = req.headers.get('origin');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: baseHeaders(origin) });
  }

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, origin);
  }

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (ip && isRateLimited(ip)) {
    return jsonResponse(429, { error: 'Слишком много запросов подряд. Подождите немного и попробуйте снова.' }, origin);
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return jsonResponse(400, { error: 'Некорректный запрос' }, origin);
  }

  const { system, messages } = payload || {};
  if (!system || typeof system !== 'string' || !Array.isArray(messages) || messages.length === 0) {
    return jsonResponse(400, { error: 'Отсутствует system или messages' }, origin);
  }

  const lastUserText = messages[messages.length - 1] && messages[messages.length - 1].content;
  if (typeof lastUserText !== 'string' || lastUserText.length > 500) {
    return jsonResponse(400, { error: 'Некорректный вопрос' }, origin);
  }

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return jsonResponse(500, { error: 'Сервер не настроен: не задан GEMINI_API_KEY в переменных окружения Deno Deploy' }, origin);
  }

  const requestBody = {
    system_instruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    })),
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const started = Date.now();
  let last = { status: 502, detail: '' };
  let sawRateLimit = false;

  for (const model of MODEL_CHAIN) {
    if (Date.now() - started > TOTAL_BUDGET_MS) break;

    const result = await askOneModel(model, apiKey, requestBody);
    if (result.ok) {
      const answer = result.parsed;
      if (typeof answer.animation_svg === 'string') answer.animation_svg = sanitizeSvg(answer.animation_svg);
      return jsonResponse(200, { content: [{ type: 'text', text: JSON.stringify(answer) }] }, origin, { 'X-Model-Used': model });
    }

    console.error(`Model ${model} failed: ${result.status} ${result.detail}`);
    last = result;
    if (result.status === 429) sawRateLimit = true;
    if (result.status >= 500) await sleep(700);
  }

  if (sawRateLimit) {
    return jsonResponse(429, { error: 'Сейчас слишком много запросов к нейросети. Подождите немного и попробуйте снова.' }, origin);
  }
  return jsonResponse(502, { error: 'Нейросеть недоступна, попробуйте позже.', detail: last.detail }, origin);
}

Deno.serve(handler);
