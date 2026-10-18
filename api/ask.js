// Vercel serverless function. Runs outside Russia, so Gemini always sees a
// non-Russian caller IP, and keeps the API key on the server. The front-end
// (GitHub Pages) calls it cross-origin, hence the CORS headers.

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

function setCommonHeaders(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.has(origin) ? origin : 'https://fizika-rulit.ru');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

// Per-instance, in-memory limit: not a hard global cap (instances are
// recycled and scaled), but stops one script hammering a single instance.
// Kept generous because a whole class can share one school IP.
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
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-flash-latest,gemini-flash-lite-latest')
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
      return obj && typeof obj.reply === 'string' && obj.reply ? obj : null;
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

module.exports = async function handler(req, res) {
  setCommonHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Слишком много запросов подряд. Подождите немного и попробуйте снова.' });
    return;
  }

  const { system, messages } = req.body || {};
  if (!system || typeof system !== 'string' || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Отсутствует system или messages' });
    return;
  }

  const lastUserText = messages[messages.length - 1] && messages[messages.length - 1].content;
  if (typeof lastUserText !== 'string' || lastUserText.length > 500) {
    res.status(400).json({ error: 'Некорректный вопрос' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Сервер не настроен: не задан GEMINI_API_KEY в переменных окружения Vercel' });
    return;
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
      res.setHeader('X-Model-Used', model);
      res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(answer) }] });
      return;
    }

    console.error(`Model ${model} failed: ${result.status} ${result.detail}`);
    last = result;
    if (result.status === 429) sawRateLimit = true;
    if (result.status >= 500) await sleep(700);
  }

  if (sawRateLimit) {
    res.status(429).json({ error: 'Сейчас слишком много запросов к нейросети. Подождите немного и попробуйте снова.' });
    return;
  }
  res.status(502).json({ error: 'Нейросеть недоступна, попробуйте позже.', detail: last.detail });
};
