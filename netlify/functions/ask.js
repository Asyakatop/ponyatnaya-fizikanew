// Netlify serverless function: proxies the site's chat to the Google Gemini API
// (free tier) so the front-end can get real AI answers without exposing an API key
// in the browser. No npm dependencies — uses the global fetch available in
// Netlify's Node 18+ runtime.
//
// Contract with index.html (see callClaude()):
//   request  body:  { system: string, messages: [{ role: 'user'|'assistant', content: string }] }
//   response body:  { content: [{ type: 'text', text: string }] }  — mimics the
//                   shape the front-end already expects from a Messages-API-style call.

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

// Every reply carries these — some ISP/carrier proxies cache POST responses
// by URL alone (ignoring the request body) and would otherwise replay a
// stale answer for every question that follows.
const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

function json(statusCode, bodyObj, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign({}, NO_CACHE_HEADERS, extraHeaders),
    body: JSON.stringify(bodyObj),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Метод не поддерживается' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Некорректный запрос' });
  }

  const { system, messages } = payload;
  if (!system || typeof system !== 'string' || !Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: 'Отсутствует system или messages' });
  }

  const lastUserText = messages[messages.length - 1] && messages[messages.length - 1].content;
  if (typeof lastUserText !== 'string' || lastUserText.length > 500) {
    return json(400, { error: 'Некорректный вопрос' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Сервер не настроен: не задан GEMINI_API_KEY в переменных окружения Netlify' });
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
      return json(429, { error: 'Сейчас слишком много запросов к нейросети. Подождите немного и попробуйте снова.' });
    }

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      return json(502, { error: 'Нейросеть недоступна, попробуйте позже.', detail: errText.slice(0, 300) });
    }

    const data = await geminiResp.json();
    const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!text) {
      return json(502, { error: 'Нейросеть вернула пустой ответ' });
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

    return json(200, { content: [{ type: 'text', text: safeText }] });
  } catch (err) {
    return json(500, { error: 'Внутренняя ошибка сервера' });
  }
};
