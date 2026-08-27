'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.OPR_PORT) || 4173;
const ROOT = __dirname;
const AI_KEYS_PATH = path.join(ROOT, 'ai-keys.json');
const PROVIDER_COOLDOWNS = new Map();
const PROVIDER_PROMPT_MAX_CHARS = 1800;
const PROVIDER_PRIORITY = ['gemini', 'huggingface'];
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
]);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function send(response, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...extraHeaders });
  response.end(body);
}

function readRequestJson(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    request.setEncoding('utf8');
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new Error('Die Anfrage ist zu groß.'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Ungültige JSON-Anfrage.'));
      }
    });
    request.on('error', reject);
  });
}

function loadAiProviders() {
  try {
    const config = JSON.parse(fs.readFileSync(AI_KEYS_PATH, 'utf8'));
    if (!Array.isArray(config.providers)) return [];
    return config.providers
      .filter(provider => provider && provider.enabled !== false && typeof provider.type === 'string')
      .map((provider, index) => ({ provider, index }))
      .sort((left, right) => {
        const leftRank = PROVIDER_PRIORITY.indexOf(left.provider.type);
        const rightRank = PROVIDER_PRIORITY.indexOf(right.provider.type);
        const normalizedLeft = leftRank < 0 ? PROVIDER_PRIORITY.length : leftRank;
        const normalizedRight = rightRank < 0 ? PROVIDER_PRIORITY.length : rightRank;
        return normalizedLeft - normalizedRight || left.index - right.index;
      })
      .map(item => item.provider);
  } catch {
    return [];
  }
}

function configuredProvider(provider) {
  if (provider.type === 'gemini') return Boolean(provider.apiKey && !provider.apiKey.includes('PASTE_'));
  if (provider.type === 'cloudflare') return Boolean(provider.apiToken && provider.accountId && !provider.apiToken.includes('PASTE_'));
  if (provider.type === 'huggingface') return Boolean(provider.apiToken && !provider.apiToken.includes('PASTE_'));
  return false;
}

function providerKey(provider) {
  return `${provider.type}:${provider.model || ''}`;
}

function providerSafePrompt(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (text.length <= PROVIDER_PROMPT_MAX_CHARS) return text;
  const headLength = 1240;
  const tailLength = PROVIDER_PROMPT_MAX_CHARS - headLength - 24;
  return `${text.slice(0, headLength)} … [constraints continue] … ${text.slice(-tailLength)}`;
}

async function responseError(provider, response) {
  const rawBody = await response.text();
  let detail = rawBody;
  try {
    const payload = JSON.parse(rawBody);
    detail = payload.error?.message || payload.errors?.[0]?.message || payload.message || payload.error || rawBody;
  } catch {
    // Some providers return plain-text errors. Keep the original message in that case.
  }
  detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 180);
  throw new Error(`${provider.type}: HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
}

async function generateWithGemini(provider, prompt) {
  const model = provider.model || 'gemini-2.5-flash-image';
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent`;
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-goog-api-key': provider.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        // Keep Gemini outputs portrait as requested by the artwork prompt;
        // the browser rotates them back into the stable v1 strip orientation.
        responseFormat: { image: { aspectRatio: '2:3' } },
      },
    }),
  });
  if (!upstream.ok) await responseError(provider, upstream);
  const payload = await upstream.json();
  const parts = payload.candidates?.flatMap(candidate => candidate.content?.parts || []) || [];
  const image = parts.find(part => part.inlineData?.data || part.inline_data?.data);
  const inlineData = image?.inlineData || image?.inline_data;
  if (!inlineData?.data) throw new Error('gemini: Die Antwort enthielt kein Bild.');
  return { provider: 'Google Gemini', mimeType: inlineData.mimeType || inlineData.mime_type || 'image/png', data: Buffer.from(inlineData.data, 'base64') };
}

async function generateWithCloudflare(provider, prompt) {
  const model = provider.model || '@cf/black-forest-labs/flux-1-schnell';
  if (!/^@cf\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error('cloudflare: Ungültige Modellkennung. Erwartet wird z. B. @cf/black-forest-labs/flux-1-schnell.');
  }
  // Cloudflare expects the model name as separate path segments. Encoding its slash
  // turns it into a different route and produces "No route for that URI".
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(provider.accountId)}/ai/run/${model}`;
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, steps: 4 }),
  });
  if (!upstream.ok) await responseError(provider, upstream);
  const payload = await upstream.json();
  const image = payload.result?.image;
  if (!payload.success || !image) throw new Error(`cloudflare: ${payload.errors?.[0]?.message || 'Die Antwort enthielt kein Bild.'}`);
  return { provider: 'Cloudflare Workers AI', mimeType: 'image/jpeg', data: Buffer.from(image, 'base64') };
}

async function generateWithHuggingFace(provider, prompt) {
  const model = provider.model || 'black-forest-labs/FLUX.1-schnell';
  const endpoint = provider.endpoint || `https://router.huggingface.co/hf-inference/models/${encodeURIComponent(model)}`;
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiToken}`, 'Content-Type': 'application/json', Accept: 'image/png' },
    body: JSON.stringify({
      inputs: prompt,
      parameters: { width: 512, height: 768, num_inference_steps: 4 },
    }),
  });
  if (!upstream.ok) await responseError(provider, upstream);
  const mimeType = upstream.headers.get('content-type') || 'image/png';
  if (mimeType.includes('application/json')) {
    const payload = await upstream.json();
    throw new Error(`huggingface: ${payload.error || 'Die Antwort enthielt kein Bild.'}`);
  }
  return { provider: 'Hugging Face', mimeType: mimeType.split(';')[0], data: Buffer.from(await upstream.arrayBuffer()) };
}

async function generateArtwork(prompt) {
  const providers = loadAiProviders().filter(configuredProvider);
  if (!providers.length) throw new Error('Keine nutzbare KI-Konfiguration gefunden. Kopiere ai-keys.example.json nach ai-keys.json und trage mindestens einen Schlüssel ein.');
  const errors = [];
  for (const provider of providers) {
    const cooldownUntil = PROVIDER_COOLDOWNS.get(providerKey(provider));
    if (cooldownUntil && cooldownUntil > Date.now()) {
      errors.push(`${provider.type}: wegen vorherigem Quota-/Zugriffsfehler kurz übersprungen`);
      continue;
    }
    PROVIDER_COOLDOWNS.delete(providerKey(provider));
    try {
      if (provider.type === 'gemini') return await generateWithGemini(provider, prompt);
      if (provider.type === 'cloudflare') return await generateWithCloudflare(provider, prompt);
      if (provider.type === 'huggingface') return await generateWithHuggingFace(provider, prompt);
      errors.push(`${provider.type}: unbekannter Provider`);
    } catch (error) {
      const message = String(error.message || `${provider.type}: unbekannter Fehler`);
      if (/HTTP (?:401|403|429)\b/.test(message)) {
        PROVIDER_COOLDOWNS.set(providerKey(provider), Date.now() + 5 * 60 * 1000);
      }
      errors.push(message.slice(0, 220));
    }
  }
  throw new Error(`Alle KI-Provider waren nicht verfügbar. ${errors.join(' | ')}`);
}

async function proxyArmyBook(requestUrl, response) {
  const armyId = requestUrl.searchParams.get('armyId') || '';
  const gameSystem = requestUrl.searchParams.get('gameSystem') || '';
  if (!/^[A-Za-z0-9_-]+$/.test(armyId) || !/^[A-Za-z0-9_-]+$/.test(gameSystem)) {
    send(response, 400, 'Ungültige Army-Forge-Parameter.');
    return;
  }
  try {
    const upstream = new URL(`https://army-forge.onepagerules.com/api/army-books/${encodeURIComponent(armyId)}`);
    upstream.searchParams.set('gameSystem', gameSystem);
    const upstreamResponse = await fetch(upstream);
    if (!upstreamResponse.ok) {
      send(response, upstreamResponse.status, `Army Forge antwortet mit ${upstreamResponse.status}.`);
      return;
    }
    send(response, 200, await upstreamResponse.text(), 'application/json; charset=utf-8');
  } catch {
    send(response, 502, 'Army-Forge-Daten konnten nicht abgerufen werden.');
  }
}

function factionSlug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

async function proxyFactionReference(requestUrl, response) {
  const faction = requestUrl.searchParams.get('faction') || '';
  const slug = factionSlug(faction);
  if (!slug) {
    send(response, 400, 'Ungültige Fraktion.');
    return;
  }
  const sourceUrl = `https://www.onepagerules.com/factions/${slug}`;
  try {
    const upstreamResponse = await fetch(sourceUrl, { signal: AbortSignal.timeout(5000) });
    if (!upstreamResponse.ok) {
      send(response, 200, JSON.stringify({ sourceUrl, summary: '' }), 'application/json; charset=utf-8');
      return;
    }
    const html = await upstreamResponse.text();
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i);
    const fallbackText = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const summary = decodeHtml(metaMatch?.[1] || fallbackText).slice(0, 900);
    send(response, 200, JSON.stringify({ sourceUrl, summary }), 'application/json; charset=utf-8');
  } catch {
    // A visual reference is helpful but must never block image generation when
    // the official site is offline or a custom faction has no page.
    send(response, 200, JSON.stringify({ sourceUrl, summary: '' }), 'application/json; charset=utf-8');
  }
}

async function generateArt(request, response) {
  try {
    const payload = await readRequestJson(request);
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!prompt || prompt.length > 5000) {
      send(response, 400, 'Ungültiger Bild-Prompt.');
      return;
    }
    const image = await generateArtwork(providerSafePrompt(prompt));
    send(response, 200, image.data, image.mimeType, { 'X-OPR-AI-Provider': image.provider });
  } catch (error) {
    send(response, 503, error.message || 'Die Bildgenerierung ist fehlgeschlagen.');
  }
}

http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
  if (request.method === 'GET' && requestUrl.pathname === '/api/army-book') {
    await proxyArmyBook(requestUrl, response);
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/faction-reference') {
    await proxyFactionReference(requestUrl, response);
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/api/ai-status') {
    const providers = loadAiProviders().filter(configuredProvider).map(provider => provider.type);
    send(response, 200, JSON.stringify({ providers }), 'application/json; charset=utf-8');
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/api/generate-art') {
    await generateArt(request, response);
    return;
  }
  const fileName = STATIC_FILES.get(requestUrl.pathname);
  if (request.method !== 'GET' || !fileName) {
    send(response, 404, 'Nicht gefunden.');
    return;
  }
  const filePath = path.join(ROOT, fileName);
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(response, 500, 'Lokale Datei konnte nicht gelesen werden.');
      return;
    }
    send(response, 200, data, MIME_TYPES[path.extname(fileName)] || 'application/octet-stream');
  });
}).listen(PORT, HOST, () => {
  console.log(`OPR Paper Minis läuft unter http://${HOST}:${PORT}/`);
});
