// Cloudflare Pages Function — same contract and logic as netlify/functions/ask.js,
// just adapted to Cloudflare's request/response API instead of Netlify's.
// Placed at this nested path so it answers the SAME URL
// (/.netlify/functions/ask) that index.html already calls — the front-end
// needs no changes to work on either Netlify or Cloudflare Pages.

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

const NO_CACHE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'Pragma': 'no-cache',
};

function json(status, bodyObj, extraHeaders) {
  return new Response(JSON.stringify(bodyObj), {
    status,
    headers: Object.assign({}, NO_CACHE_HEADERS, extraHeaders),
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
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

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Сервер не настроен: не задан GEMINI_API_KEY в переменных окружения Cloudflare' });
  }

  const model = env.GEMINI_MODEL || 'gemini-3.6-flash';
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
}
