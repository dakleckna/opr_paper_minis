'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.OPR_PORT) || 4173;
const ROOT = __dirname;
const AI_KEYS_PATH = path.join(ROOT, 'ai-keys.json');
const PROVIDER_COOLDOWNS = new Map();
const PROVIDER_PROMPT_MAX_CHARS = 2048;
const PROVIDER_PRIORITY = ['gemini', 'huggingface'];
const HF_ROUTER_URL = 'https://router.huggingface.co';
const HF_HUB_URL = 'https://huggingface.co';
const HF_QUEUE_POLL_INTERVAL_MS = 750;
const HF_QUEUE_TIMEOUT_MS = 180000;
const DEFAULT_NEGATIVE_PROMPT = 'multiple characters, squad, group, duplicate, cropped body, missing feet, missing wheels, real tabletop miniature, painted plastic or resin model, 3D render, product photo, display stand, circular base, floor line, scenery, background, smoke, cast shadow, text, logo, watermark, frame, grey studio gradient, black background, monochrome grey armor';
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/AI_ARTWORK_PROMPT.md', 'AI_ARTWORK_PROMPT.md'],
]);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
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
      // Keep the original array index internally so duplicate providers (for
      // example two separate Gemini keys) receive independent cooldowns.
      .map(item => ({ ...item.provider, __configIndex: item.index }));
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

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function boundedDimension(value, minimum, maximum, fallback) {
  const dimension = boundedInteger(value, minimum, maximum, fallback);
  return Math.max(8, Math.round(dimension / 8) * 8);
}

function providerKey(provider) {
  return `${provider.type}:${provider.model || ''}:${provider.__configIndex ?? ''}`;
}

function providerSafePrompt(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (text.length <= PROVIDER_PROMPT_MAX_CHARS) return text;
  const separator = ' … [constraints continue] … ';
  const available = Math.max(0, PROVIDER_PROMPT_MAX_CHARS - separator.length);
  const headLength = Math.min(1240, Math.ceil(available * .62));
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${separator}${text.slice(-tailLength)}`;
}

function formatProviderError(provider, status, rawBody) {
  const rawText = String(rawBody || '');
  const normalizedRawText = rawText.toLocaleLowerCase();
  let detail = rawBody;
  try {
    const payload = JSON.parse(rawBody);
    detail = payload.error?.message || payload.errors?.[0]?.message || payload.message || payload.error || rawBody;
  } catch {
    // Some providers return plain-text errors. Keep the original message in that case.
  }
  // Native Gemini image generation currently has no API allocation on the
  // standard Free tier. Google reports this as a generic 429 quota error with
  // a zero free-tier limit, which is otherwise easy to confuse with exhausted
  // text-token quota. Keep the diagnostic actionable for this project.
  if (provider.type === 'gemini' && status === 429
      && /free[\s_-]?tier/.test(normalizedRawText)
      && /limit\s*[:=]\s*0/.test(normalizedRawText)
      && /(?:flash[-_ ]?image|image)/.test(normalizedRawText)) {
    detail = 'Gemini-Bildgenerierung ist für dieses Projekt im Free-Tier nicht freigeschaltet (Kontingent 0); kostenlose Text-Tokens sind davon unabhängig.';
  }
  detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 180);
  return `${provider.type}: HTTP ${status}${detail ? ` (${detail})` : ''}`;
}

async function responseError(provider, response) {
  throw new Error(formatProviderError(provider, response.status, await response.text()));
}

function geminiRequest(provider, prompt, aspectRatio) {
  const model = provider.model || 'gemini-2.5-flash-image';
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent`;
  const generationConfig = { responseModalities: ['IMAGE'] };
  if (aspectRatio) {
    generationConfig.responseFormat = { image: { aspectRatio } };
  }
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'x-goog-api-key': provider.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });
}

async function generateWithGemini(provider, prompt) {
  // The REST API documents portrait ratios differently across model/API
  // revisions. Use the protobuf enum first, then retry without the optional
  // field when an account rejects the aspect-ratio value. The prompt still
  // requests the portrait composition, and this avoids a hard 400 failure.
  let upstream = await geminiRequest(provider, prompt, 'ASPECT_RATIO_TWO_BY_THREE');
  if (!upstream.ok && upstream.status === 400) {
    const rawBody = await upstream.text();
    if (/aspect[\s_-]?ratio/i.test(rawBody)) {
      upstream = await geminiRequest(provider, prompt, null);
    } else {
      throw new Error(formatProviderError(provider, upstream.status, rawBody));
    }
  }
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
  const steps = boundedInteger(provider.steps, 1, 8, 8);
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, steps }),
  });
  if (!upstream.ok) await responseError(provider, upstream);
  const payload = await upstream.json();
  const image = payload.result?.image;
  if (!payload.success || !image) throw new Error(`cloudflare: ${payload.errors?.[0]?.message || 'Die Antwort enthielt kein Bild.'}`);
  return { provider: 'Cloudflare Workers AI', mimeType: 'image/jpeg', data: Buffer.from(image, 'base64') };
}

function encodePath(value) {
  return String(value || '').split('/').map(part => encodeURIComponent(part)).join('/');
}

function huggingFaceInferenceProvider(provider) {
  const configured = provider.inferenceProvider || provider.routeProvider || provider.providerName
    || (typeof provider.provider === 'string' && provider.provider !== 'huggingface' ? provider.provider : '');
  return String(configured || 'fal-ai').trim().toLowerCase();
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function readJsonResponse(response, providerLabel) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${providerLabel}: Die Antwort enthielt kein gültiges JSON.`);
  }
}

async function loadHuggingFaceProviderMapping(model, providerName, apiToken) {
  const endpoint = `${HF_HUB_URL}/api/models/${encodePath(model)}?expand%5B%5D=inferenceProviderMapping`;
  const response = await fetch(endpoint, {
    headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
  });
  if (!response.ok) await responseError({ type: 'huggingface' }, response);
  const payload = await readJsonResponse(response, 'huggingface');
  const mappings = payload?.inferenceProviderMapping;
  if (!mappings || typeof mappings !== 'object') {
    throw new Error(`huggingface: Für ${model} wurde keine aktuelle Provider-Zuordnung gefunden.`);
  }
  return mappings;
}

function selectHuggingFaceMapping(mappings, configuredProvider) {
  const supported = new Set(['fal-ai', 'nscale', 'together']);
  const entries = Object.entries(mappings)
    .filter(([name, mapping]) => mapping && mapping.status === 'live' && typeof mapping.providerId === 'string')
    .map(([name, mapping]) => ({ name, ...mapping }));
  if (configuredProvider === 'auto') {
    return entries.find(entry => supported.has(entry.name)) || null;
  }
  return entries.find(entry => entry.name === configuredProvider) || null;
}

function imageResultFromBase64(base64, providerName, mimeType = 'image/png') {
  if (!base64 || typeof base64 !== 'string') return null;
  return { provider: providerName, mimeType, data: Buffer.from(base64, 'base64') };
}

async function downloadHuggingFaceImage(url, providerName) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`${providerName}: Die Provider-Antwort enthielt keine gültige Bild-URL.`);
  }
  const response = await fetch(url);
  if (!response.ok) await responseError({ type: 'huggingface' }, response);
  const mimeType = (response.headers.get('content-type') || 'image/png').split(';')[0];
  return { provider: providerName, mimeType, data: Buffer.from(await response.arrayBuffer()) };
}

function routedFalQueueUrl(queueUrl, providerName = 'fal-ai') {
  const parsed = new URL(queueUrl);
  if (parsed.origin === HF_ROUTER_URL && parsed.pathname.startsWith(`/${providerName}/`)) {
    parsed.searchParams.set('_subdomain', 'queue');
    return parsed.toString();
  }
  // HF's Fal queue requires the router query flag for both status and result
  // requests. Without it, the router rejects a perfectly valid request with
  // "Not allowed to GET .../status for provider fal-ai".
  const routed = new URL(`${HF_ROUTER_URL}/${providerName}${parsed.pathname}`);
  for (const [key, value] of parsed.searchParams) routed.searchParams.set(key, value);
  routed.searchParams.set('_subdomain', 'queue');
  return routed.toString();
}

async function generateWithHuggingFaceFal(provider, prompt, parameters, providerId) {
  const endpoint = `${HF_ROUTER_URL}/fal-ai/${encodePath(providerId)}?_subdomain=queue`;
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt, ...parameters }),
  });
  if (!upstream.ok) await responseError(provider, upstream);
  let job = await readJsonResponse(upstream, 'huggingface/fal-ai');

  if (Array.isArray(job?.images) && typeof job.images[0]?.url === 'string') {
    return downloadHuggingFaceImage(job.images[0].url, 'Hugging Face (Fal AI)');
  }
  if (!job?.request_id) {
    throw new Error('huggingface/fal-ai: Die Queue-Antwort enthielt keine request_id.');
  }
  const statusUrl = job.status_url
    ? routedFalQueueUrl(job.status_url)
    : `${HF_ROUTER_URL}/fal-ai/${encodePath(providerId)}/requests/${encodeURIComponent(job.request_id)}/status?_subdomain=queue`;
  const responseUrl = job.response_url
    ? routedFalQueueUrl(job.response_url)
    : `${HF_ROUTER_URL}/fal-ai/${encodePath(providerId)}/requests/${encodeURIComponent(job.request_id)}/response?_subdomain=queue`;
  const startedAt = Date.now();
  let status = String(job.status || 'IN_QUEUE').toUpperCase();
  while (status !== 'COMPLETED') {
    if (status === 'FAILED' || status === 'ERROR' || job.error) {
      throw new Error(`huggingface/fal-ai: ${job.error || 'Die Bildgenerierung ist in der Queue fehlgeschlagen.'}`);
    }
    if (Date.now() - startedAt > HF_QUEUE_TIMEOUT_MS) {
      throw new Error('huggingface/fal-ai: Zeitüberschreitung beim Warten auf das Bild.');
    }
    await sleep(HF_QUEUE_POLL_INTERVAL_MS);
    const statusResponse = await fetch(statusUrl, {
      headers: { Authorization: `Bearer ${provider.apiToken}`, Accept: 'application/json' },
    });
    if (!statusResponse.ok) await responseError(provider, statusResponse);
    job = await readJsonResponse(statusResponse, 'huggingface/fal-ai');
    status = String(job.status || '').toUpperCase();
  }
  const resultResponse = await fetch(responseUrl, {
    headers: { Authorization: `Bearer ${provider.apiToken}`, Accept: 'application/json' },
  });
  if (!resultResponse.ok) await responseError(provider, resultResponse);
  const result = await readJsonResponse(resultResponse, 'huggingface/fal-ai');
  if (result?.error) throw new Error(`huggingface/fal-ai: ${result.error}`);
  return downloadHuggingFaceImage(result?.images?.[0]?.url, 'Hugging Face (Fal AI)');
}

async function generateWithHuggingFaceOpenAiImage(provider, prompt, parameters, providerName, providerId) {
  const endpoint = `${HF_ROUTER_URL}/${providerName}/v1/images/generations`;
  const payload = {
    model: providerId,
    prompt,
    ...parameters,
    response_format: providerName === 'nscale' ? 'b64_json' : 'base64',
  };
  if (providerName === 'together' && payload.num_inference_steps !== undefined) {
    payload.steps = payload.num_inference_steps;
    delete payload.num_inference_steps;
  }
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!upstream.ok) await responseError(provider, upstream);
  const result = await readJsonResponse(upstream, `huggingface/${providerName}`);
  const first = Array.isArray(result?.data) ? result.data[0] : null;
  if (first?.b64_json) return imageResultFromBase64(first.b64_json, `Hugging Face (${providerName})`, 'image/jpeg');
  if (typeof first?.url === 'string') return downloadHuggingFaceImage(first.url, `Hugging Face (${providerName})`);
  throw new Error(`huggingface/${providerName}: Die Antwort enthielt kein Bild.`);
}

async function generateWithHuggingFaceLegacy(provider, prompt, model) {
  const endpoint = provider.endpoint || `${HF_ROUTER_URL}/hf-inference/models/${encodePath(model)}`;
  const schnell = /schnell/i.test(model);
  const steps = boundedInteger(provider.steps, 1, 50, schnell ? 4 : 28);
  const width = boundedDimension(provider.width, 256, 1536, 768);
  const height = boundedDimension(provider.height, 256, 1536, 1152);
  const guidanceScale = Number.isFinite(Number(provider.guidanceScale))
    ? Number(provider.guidanceScale)
    : (schnell ? 0 : 3.5);
  const negativePrompt = String(provider.negativePrompt || DEFAULT_NEGATIVE_PROMPT).trim();
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiToken}`, 'Content-Type': 'application/json', Accept: 'image/png' },
    body: JSON.stringify({
      inputs: prompt,
      parameters: {
        width,
        height,
        num_inference_steps: steps,
        guidance_scale: guidanceScale,
        negative_prompt: negativePrompt,
      },
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

async function generateWithHuggingFace(provider, prompt) {
  const model = provider.model || 'black-forest-labs/FLUX.1-schnell';
  const configuredProvider = huggingFaceInferenceProvider(provider);
  const schnell = /schnell/i.test(model);
  const steps = boundedInteger(provider.steps, 1, 50, schnell ? 4 : 28);
  const width = boundedDimension(provider.width, 256, 1536, 768);
  const height = boundedDimension(provider.height, 256, 1536, 1152);
  const guidanceScale = Number.isFinite(Number(provider.guidanceScale))
    ? Number(provider.guidanceScale)
    : (schnell ? 0 : 3.5);
  const negativePrompt = String(provider.negativePrompt || DEFAULT_NEGATIVE_PROMPT).trim();
  const parameters = {
    width,
    height,
    num_inference_steps: steps,
    guidance_scale: guidanceScale,
    negative_prompt: negativePrompt,
  };
  if (provider.endpoint || configuredProvider === 'hf-inference') {
    return generateWithHuggingFaceLegacy(provider, prompt, model);
  }
  const mappings = await loadHuggingFaceProviderMapping(model, configuredProvider, provider.apiToken);
  const selected = selectHuggingFaceMapping(mappings, configuredProvider);
  if (!selected) {
    const available = Object.entries(mappings)
      .filter(([, mapping]) => mapping?.status === 'live')
      .map(([name]) => name)
      .join(', ');
    throw new Error(`huggingface: Kein kompatibler Provider für ${model} gefunden${available ? ` (verfügbar: ${available})` : ''}.`);
  }
  if (selected.name === 'fal-ai') return generateWithHuggingFaceFal(provider, prompt, parameters, selected.providerId);
  if (selected.name === 'nscale' || selected.name === 'together') {
    return generateWithHuggingFaceOpenAiImage(provider, prompt, parameters, selected.name, selected.providerId);
  }
  throw new Error(`huggingface: Provider ${selected.name} ist für Text-to-Image noch nicht integriert. Setze inferenceProvider auf fal-ai oder nscale.`);
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
      // 402 is Hugging Face's explicit "monthly included credits depleted"
      // response. Cool it down just like auth/quota failures so every unit in
      // the same import does not repeat a request that cannot succeed.
      if (/HTTP (?:401|402|403|429)\b/.test(message)) {
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
    // A new JSON + AI run must always start at the top of the configured
    // provider list. Quota cooldowns still apply between artworks in the same
    // run, but must not make a later user-triggered run skip Gemini forever.
    if (requestUrl.searchParams.get('newRun') === '1') PROVIDER_COOLDOWNS.clear();
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
