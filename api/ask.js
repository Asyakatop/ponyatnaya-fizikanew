// Vercel serverless function — adapted from netlify/functions/ask.js and
// functions/.netlify/functions/ask.js (Cloudflare). Runs on Vercel's own
// infrastructure (outside Russia), so Gemini always sees a non-Russian
// caller IP regardless of where the site visitor actually is, and keeps
// the API key on the server instead of exposed in the browser.
//
// The front-end (hosted separately on GitHub Pages) calls this as a
// cross-origin request, so CORS headers are required here.

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

  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }],
  }));

  const requestBody = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  try {
    const geminiResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (geminiResp.status === 429) {
      res.status(429).json({ error: 'Сейчас слишком много запросов к нейросети. Подождите немного и попробуйте снова.' });
      return;
    }

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      res.status(502).json({ error: 'Нейросеть недоступна, попробуйте позже.', detail: errText.slice(0, 300) });
      return;
    }

    const data = await geminiResp.json();
    const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!text) {
      res.status(502).json({ error: 'Нейросеть вернула пустой ответ' });
      return;
    }

    let safeText = text;
    try {
      const parsedAnswer = JSON.parse(text);
      if (typeof parsedAnswer.animation_svg === 'string') {
        parsedAnswer.animation_svg = parsedAnswer.animation_svg
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
          .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
          .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
          .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, '$1');
      }
      safeText = JSON.stringify(parsedAnswer);
    } catch (e) {
      // If it isn't valid JSON, pass it through as-is; the front-end handles that case too.
    }

    res.status(200).json({ content: [{ type: 'text', text: safeText }] });
  } catch (err) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};
