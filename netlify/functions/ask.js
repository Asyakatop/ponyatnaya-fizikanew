// Netlify serverless function: proxies the site's chat to the Google Gemini API
// (free tier) so the front-end can get real AI answers without exposing an API key
// in the browser. No npm dependencies — uses the global fetch available in
// Netlify's Node 18+ runtime.
//
// Contract with index.html (see callClaude()):
//   request  body:  { system: string, messages: [{ role: 'user'|'assistant', content: string }] }
//   response body:  { content: [{ type: 'text', text: string }] }  — mimics the
//                   shape the front-end already expects from a Messages-API-style call.

const ANIMATION_TYPES = [
  'speed', 'force', 'gravity', 'pendulum', 'wave', 'refraction', 'scattering',
  'friction', 'pressure', 'heat', 'conduction', 'electricity', 'buoyancy',
  'magnetism', 'elasticity', 'inertia', 'condensation', 'convection',
  'evaporation', 'melting', 'freezing', 'static', 'signal', 'reflection',
  'dispersion', 'lens', 'induction', 'equilibrium', 'comparison', 'traction',
  'echo', 'headphones', 'seismograph', 'rolling', 'sea', 'remote', 'boat',
  'submarine', 'ventHood', 'trampoline', 'dynamometer', 'comb', 'doorSpark',
  'grounding', 'humidity', 'kettle', 'lid', 'mirror', 'seasons', 'saucer',
  'seatbelt', 'clasp', 'generic',
];

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    animationType: { type: 'STRING', enum: ANIMATION_TYPES },
    caption: { type: 'STRING' },
    formula: { type: 'STRING' },
  },
  required: ['reply', 'animationType', 'caption', 'formula'],
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Метод не поддерживается' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Некорректный запрос' }) };
  }

  const { system, messages } = payload;
  if (!system || typeof system !== 'string' || !Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Отсутствует system или messages' }) };
  }

  const lastUserText = messages[messages.length - 1] && messages[messages.length - 1].content;
  if (typeof lastUserText !== 'string' || lastUserText.length > 500) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Некорректный вопрос' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Сервер не настроен: не задан GEMINI_API_KEY в переменных окружения Netlify' }),
    };
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
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  try {
    const geminiResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (geminiResp.status === 429) {
      return {
        statusCode: 429,
        body: JSON.stringify({ error: 'Сейчас слишком много запросов к нейросети. Подождите немного и попробуйте снова.' }),
      };
    }

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Нейросеть недоступна, попробуйте позже.', detail: errText.slice(0, 300) }),
      };
    }

    const data = await geminiResp.json();
    const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!text) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Нейросеть вернула пустой ответ' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text }] }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Внутренняя ошибка сервера' }) };
  }
};
