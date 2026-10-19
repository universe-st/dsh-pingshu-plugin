/**
 * TTS 提供方：
 *   - browser：浏览器 Web Speech API（客户端处理）
 *   - moss：MOSS-TTSD 的 SGLang /generate 服务（本地/局域网）
 *   - volcengine：火山引擎豆包「单向流式语音合成 HTTP」
 *
 * 火山引擎接口：
 *   POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   X-Api-Key / X-Api-Resource-Id / X-Api-Request-Id / Content-Type: application/json
 *   body: { req_params: { text, speaker, audio_params: { format: "mp3", sample_rate } } }
 *   response: HTTP chunked，每行一个 JSON，{ code: 0, data: base64(音频块) }，
 *             最后一行 { code: 20000000 } 表示结束。
 *
 * 插件按评书段落分块请求，把每块的 MP3 音频拼成一个文件，缓存到 cache/tts/<hash>/，
 * 再由 /dsh-pingshu/audio/... 路由交给浏览器播放。
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { dataRoot, getPerformance, readJsonFile, safeName, stripFrontmatter, writeJsonFile } from './store.js';

const DEFAULT_CONFIG = {
  provider: 'browser',
  moss: {
    endpoint: 'http://127.0.0.1:30000/generate',
    narrator: { file: '', text: '' },
    character: { file: '', text: '' },
    maxNewTokens: 8192,
    chunkChars: 1200,
    temperature: 1.1,
    topP: 0.9,
    topK: 50,
  },
  volcengine: {
    endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    apiKey: '',
    resourceId: 'seed-tts-2.0',
    speaker: 'zh_female_vv_uranus_bigtts',
    format: 'mp3',
    sampleRate: 24000,
    speechRate: 0,
    loudnessRate: 0,
    pitch: 0,
    model: '',
    chunkChars: 1000,
  },
  siliconflow: {
    endpoint: 'https://api.siliconflow.cn/v1/audio/speech',
    apiKey: '',
    model: 'fnlp/MOSS-TTSD-v0.5',
    voice: 'fnlp/MOSS-TTSD-v0.5:alex',
    responseFormat: 'mp3',
    sampleRate: 44100,
    speed: 1,
    gain: 0,
    chunkChars: 1000,
  },
};

const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
const SILICON_SAMPLE_RATES = [32000, 44100];
const jobs = new Map();
let queue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

export function ttsRoot() {
  return join(dataRoot(), 'tts');
}

export function ttsRefsRoot() {
  return join(ttsRoot(), 'refs');
}

export function ttsCacheRoot() {
  return join(dataRoot(), 'cache', 'tts');
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function cleanString(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (text === '') return fallback;
  return text.slice(0, maxLength);
}

function validateEndpoint(value, label) {
  const raw = String(value ?? '').trim();
  if (raw === '') throw new Error(`${label}服务地址不能为空`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label}服务地址不是合法 URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label}服务地址必须是 http(s)`);
  if (url.username || url.password) throw new Error(`${label}服务地址不要带用户名/密码`);
  return url.toString();
}

function normalizeConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const moss = value.moss && typeof value.moss === 'object' ? value.moss : {};
  const narrator = moss.narrator && typeof moss.narrator === 'object' ? moss.narrator : {};
  const character = moss.character && typeof moss.character === 'object' ? moss.character : {};
  const volc = value.volcengine && typeof value.volcengine === 'object' ? value.volcengine : {};
  const silicon = value.siliconflow && typeof value.siliconflow === 'object' ? value.siliconflow : {};
  const sampleRate = Number(volc.sampleRate);
  const siliconSampleRate = Number(silicon.sampleRate);
  return {
    provider: ['browser', 'moss', 'volcengine', 'siliconflow'].includes(value.provider) ? value.provider : 'browser',
    moss: {
      endpoint: cleanString(moss.endpoint, DEFAULT_CONFIG.moss.endpoint, 500),
      narrator: {
        file: typeof narrator.file === 'string' ? narrator.file : '',
        text: typeof narrator.text === 'string' ? narrator.text.slice(0, 4000) : '',
      },
      character: {
        file: typeof character.file === 'string' ? character.file : '',
        text: typeof character.text === 'string' ? character.text.slice(0, 4000) : '',
      },
      maxNewTokens: clampNumber(moss.maxNewTokens, DEFAULT_CONFIG.moss.maxNewTokens, 256, 16384),
      chunkChars: clampNumber(moss.chunkChars, DEFAULT_CONFIG.moss.chunkChars, 300, 3000),
      temperature: clampNumber(moss.temperature, DEFAULT_CONFIG.moss.temperature, 0.1, 2),
      topP: clampNumber(moss.topP, DEFAULT_CONFIG.moss.topP, 0.1, 1),
      topK: clampNumber(moss.topK, DEFAULT_CONFIG.moss.topK, 1, 200),
    },
    volcengine: {
      endpoint: cleanString(volc.endpoint, DEFAULT_CONFIG.volcengine.endpoint, 500),
      apiKey: typeof volc.apiKey === 'string' ? volc.apiKey.trim().slice(0, 4096) : '',
      resourceId: cleanString(volc.resourceId, DEFAULT_CONFIG.volcengine.resourceId, 100),
      speaker: cleanString(volc.speaker, DEFAULT_CONFIG.volcengine.speaker, 200),
      format: 'mp3',
      sampleRate: SAMPLE_RATES.includes(sampleRate) ? sampleRate : DEFAULT_CONFIG.volcengine.sampleRate,
      speechRate: clampNumber(volc.speechRate, DEFAULT_CONFIG.volcengine.speechRate, -50, 100),
      loudnessRate: clampNumber(volc.loudnessRate, DEFAULT_CONFIG.volcengine.loudnessRate, -50, 100),
      pitch: clampNumber(volc.pitch, DEFAULT_CONFIG.volcengine.pitch, -12, 12),
      model: typeof volc.model === 'string' ? volc.model.trim().slice(0, 100) : '',
      chunkChars: clampNumber(volc.chunkChars, DEFAULT_CONFIG.volcengine.chunkChars, 300, 3000),
    },
    siliconflow: {
      endpoint: cleanString(silicon.endpoint, DEFAULT_CONFIG.siliconflow.endpoint, 500),
      apiKey: typeof silicon.apiKey === 'string' ? silicon.apiKey.trim().slice(0, 4096) : '',
      model: cleanString(silicon.model, DEFAULT_CONFIG.siliconflow.model, 200),
      voice: cleanString(silicon.voice, DEFAULT_CONFIG.siliconflow.voice, 200),
      responseFormat: 'mp3',
      sampleRate: SILICON_SAMPLE_RATES.includes(siliconSampleRate) ? siliconSampleRate : DEFAULT_CONFIG.siliconflow.sampleRate,
      speed: clampNumber(silicon.speed, DEFAULT_CONFIG.siliconflow.speed, 0.25, 4),
      gain: clampNumber(silicon.gain, DEFAULT_CONFIG.siliconflow.gain, -10, 10),
      chunkChars: clampNumber(silicon.chunkChars, DEFAULT_CONFIG.siliconflow.chunkChars, 300, 3000),
    },
  };
}

function siliconEnvKey() {
  return String(process.env.SILICON_FLOW_API_KEY ?? process.env.SILICONFLOW_API_KEY ?? '').trim();
}

function siliconKey(config) {
  return config.siliconflow.apiKey || siliconEnvKey();
}

function configFile() {
  return join(ttsRoot(), 'tts.json');
}

async function readTtsConfig() {
  const raw = await readJsonFile(configFile());
  return normalizeConfig(raw ?? DEFAULT_CONFIG);
}

function maskKey(key) {
  const value = String(key ?? '');
  if (value === '') return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

function sanitizeConfig(config) {
  const { apiKey, ...volcRest } = config.volcengine;
  const { apiKey: siliconApiKey, ...siliconRest } = config.siliconflow;
  const envKey = siliconEnvKey();
  const siliconEffective = siliconApiKey || envKey;
  return {
    ...config,
    moss: {
      ...config.moss,
      narrator: { ...config.moss.narrator },
      character: { ...config.moss.character },
    },
    volcengine: {
      ...volcRest,
      apiKeySet: apiKey !== '',
      apiKeyMasked: maskKey(apiKey),
    },
    siliconflow: {
      ...siliconRest,
      apiKeySet: siliconEffective !== '',
      apiKeySource: siliconApiKey ? 'config' : envKey ? 'env' : '',
      apiKeyMasked: maskKey(siliconEffective),
    },
  };
}

async function writeTtsConfig(config) {
  await writeJsonFile(configFile(), config);
  try {
    await chmod(configFile(), 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
}

export async function getTtsConfig() {
  return sanitizeConfig(await readTtsConfig());
}

export async function saveTtsConfig(patch = {}) {
  const current = await readTtsConfig();
  const mossPatch = patch.moss && typeof patch.moss === 'object' ? patch.moss : {};
  const volcPatch = patch.volcengine && typeof patch.volcengine === 'object' ? patch.volcengine : {};
  const siliconPatch = patch.siliconflow && typeof patch.siliconflow === 'object' ? patch.siliconflow : {};
  const nextKey = volcPatch.clearApiKey === true
    ? ''
    : (typeof volcPatch.apiKey === 'string' && volcPatch.apiKey.trim() !== ''
        ? volcPatch.apiKey.trim()
        : current.volcengine.apiKey);
  const nextSiliconKey = siliconPatch.clearApiKey === true
    ? ''
    : (typeof siliconPatch.apiKey === 'string' && siliconPatch.apiKey.trim() !== ''
        ? siliconPatch.apiKey.trim()
        : current.siliconflow.apiKey);
  const next = normalizeConfig({
    provider: patch.provider ?? current.provider,
    moss: { ...current.moss, ...mossPatch },
    volcengine: { ...current.volcengine, ...volcPatch, apiKey: nextKey },
    siliconflow: { ...current.siliconflow, ...siliconPatch, apiKey: nextSiliconKey },
  });
  next.moss.endpoint = validateEndpoint(next.moss.endpoint, 'MOSS-TTSD');
  next.volcengine.endpoint = validateEndpoint(next.volcengine.endpoint, '火山引擎豆包');
  next.siliconflow.endpoint = validateEndpoint(next.siliconflow.endpoint, '硅基流动');
  for (const kind of ['narrator', 'character']) {
    const file = next.moss[kind].file;
    if (file === '') continue;
    const resolved = resolve(ttsRoot(), file);
    const root = resolve(ttsRefsRoot()) + sep;
    if (!resolved.startsWith(root)) throw new Error('参考音频路径不合法');
  }
  await writeTtsConfig(next);
  return sanitizeConfig(next);
}

function sniffAudio(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return { format: 'wav', mime: 'audio/wav' };
  if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') return { format: 'mp3', mime: 'audio/mpeg' };
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'fLaC') return { format: 'flac', mime: 'audio/flac' };
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return { format: 'ogg', mime: 'audio/ogg' };
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return { format: 'm4a', mime: 'audio/mp4' };
  return { format: 'wav', mime: 'audio/wav' };
}

export async function uploadTtsReference({ kind, name, data } = {}) {
  const which = kind === 'character' ? 'character' : kind === 'narrator' ? 'narrator' : null;
  if (!which) throw new Error('参考音频类型必须是 narrator 或 character');
  const raw = String(data ?? '').replace(/^data:audio\/[^;]+;base64,/u, '');
  if (raw === '') throw new Error('参考音频为空');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 0) throw new Error('参考音频解码失败');
  if (bytes.length > 20 * 1024 * 1024) throw new Error('参考音频太大（上限 20MB）');
  const sniff = sniffAudio(bytes);
  const filename = `${which}-${Date.now()}-${randomUUID().slice(0, 6)}.${sniff.format}`;
  await mkdir(ttsRefsRoot(), { recursive: true, mode: 0o700 });
  await writeFile(join(ttsRefsRoot(), filename), bytes, { mode: 0o600 });
  const current = await readTtsConfig();
  current.moss[which].file = `refs/${filename}`;
  await writeTtsConfig(current);
  return { kind: which, file: `refs/${filename}`, name: safeName(name ?? filename, filename), bytes: bytes.length, format: sniff.format, mime: sniff.mime };
}

function fetchWithTimeout(url, options, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
  return fetch(url, { ...options, signal: combined });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeNetworkError(error, label, endpoint) {
  let host = String(endpoint ?? '');
  try { host = new URL(String(endpoint)).host; } catch { /* keep raw */ }
  const cause = error && typeof error === 'object' ? error.cause : null;
  const causeText = cause && cause.code
    ? `${cause.code}${cause.message ? `：${cause.message}` : ''}`
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`连不上${label}（${host}）：${message}${causeText ? `（${causeText}）` : ''}`);
}

/**
 * 只对「连接还没建立就被重置/拒绝/域名解析失败」做自动重试。
 * 不重试超时和流中断，避免服务端已经合成、客户端超时后重复请求造成重复计费。
 */
async function fetchWithRetry(url, options, signal, timeoutMs, { label = 'TTS 服务', attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, signal, timeoutMs);
      if ([502, 503, 504].includes(response.status) && attempt < attempts) {
        await delay(500 * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (signal.aborted) throw error;
      const code = error && typeof error === 'object' ? error.cause?.code : null;
      const retryable = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
      if (!retryable || attempt >= attempts) break;
      await delay(600 * attempt);
    }
  }
  throw describeNetworkError(lastError, label, url);
}

export async function testTts(endpoint) {
  let url;
  try {
    url = validateEndpoint(endpoint, 'MOSS-TTSD');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const base = new URL(url);
  const candidates = ['/health', '/v1/models'];
  let lastStatus = 0;
  for (const path of candidates) {
    try {
      const response = await fetchWithTimeout(new URL(path, base).toString(), { method: 'GET' }, new AbortController().signal, 6000);
      lastStatus = response.status;
      if (response.ok) return { ok: true, status: response.status, message: `服务可达（${path}）` };
    } catch (error) {
      return { ok: false, error: `连不上 MOSS-TTSD 服务：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (lastStatus === 404 || lastStatus === 405) {
    return { ok: true, warning: '服务地址可达，但没有健康检查接口；可以直接点「合成并朗读」试试。' };
  }
  return { ok: false, error: `服务返回 HTTP ${lastStatus}；请确认地址是 SGLang 的 /generate` };
}

export async function testVolcengine(payload = {}) {
  const config = await readTtsConfig();
  const volc = config.volcengine;
  const apiKey = String(payload.apiKey ?? '').trim() || volc.apiKey;
  if (apiKey === '') return { ok: false, error: '请先填写火山引擎 API Key' };
  let endpoint;
  try {
    endpoint = validateEndpoint(cleanString(payload.endpoint, volc.endpoint, 500), '火山引擎豆包');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const settings = {
    ...volc,
    apiKey,
    endpoint,
    resourceId: cleanString(payload.resourceId, volc.resourceId, 100),
    speaker: cleanString(payload.speaker, volc.speaker, 200),
    sampleRate: SAMPLE_RATES.includes(Number(payload.sampleRate)) ? Number(payload.sampleRate) : volc.sampleRate,
  };
  if (settings.speaker === '') return { ok: false, error: '请填写 Speaker ID（音色 ID）' };
  try {
    const result = await synthesizeVolcChunk(settings, {
      spokenText: '你好，这是评书插件的连接测试。',
      chars: 19,
    }, new AbortController().signal);
    return {
      ok: true,
      bytes: result.bytes.length,
      message: `连接成功，收到约 ${Math.max(1, Math.round(result.bytes.length / 1024))} KB 音频（测试会按字符计费）`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── 脚本解析 / 分块 ─────────────────────────────────────────────────────

const NARRATOR_NAMES = new Set(['说书人', '旁白', '叙述者', '']);

export function parseScriptBlocks(markdown) {
  const text = stripFrontmatter(markdown);
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const blocks = [];
  let index = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/u.test(line)) { i += 1; continue; }
    if (/^(#{1,6})\s+/u.test(line)) { i += 1; continue; }
    if (/^\s*```/u.test(line)) {
      i += 1;
      while (i < lines.length && !/^\s*```/u.test(lines[i])) i += 1;
      i += 1;
      continue;
    }
    if (/^\s*\|/u.test(line)) {
      while (i < lines.length && /^\s*\|/u.test(lines[i])) i += 1;
      continue;
    }
    const buffer = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== ''
      && !/^(#{1,6})\s+/u.test(lines[i])
      && !/^\s*([-*_])\1{2,}\s*$/u.test(lines[i])
      && !/^\s*\|/u.test(lines[i])
      && !/^\s*```/u.test(lines[i])) {
      buffer.push(lines[i]);
      i += 1;
    }
    const paragraph = buffer.join(' ').replace(/\s+/gu, ' ').trim();
    if (paragraph === '') continue;
    const segments = paragraph.split(/(?=【[^】]{1,24}】)/u).map((entry) => entry.trim()).filter((entry) => entry !== '');
    for (const segment of segments.length > 0 ? segments : [paragraph]) {
      const speakerMatch = /^【([^】]{1,24})】\s*/u.exec(segment);
      const speaker = speakerMatch ? speakerMatch[1] : '';
      const body = speakerMatch ? segment.slice(speakerMatch[0].length).trim() : segment;
      if (body === '') continue;
      blocks.push({ index, speaker, text: body });
      index += 1;
    }
  }
  return blocks;
}

export function buildSpeakerMap(blocks) {
  const map = new Map();
  map.set('', 'S1');
  for (const name of NARRATOR_NAMES) map.set(name, 'S1');
  let next = 2;
  const characters = [];
  for (const block of blocks) {
    const speaker = String(block.speaker ?? '').trim();
    if (NARRATOR_NAMES.has(speaker)) continue;
    if (!map.has(speaker)) {
      const tag = next <= 5 ? `S${next}` : 'S5';
      map.set(speaker, tag);
      characters.push(speaker);
      next += 1;
    }
  }
  const tags = [...new Set(map.values())].sort();
  return { map, characters, tags };
}

function splitLongBlock(block, maxChars) {
  if (block.text.length <= maxChars) return [block];
  const pieces = [];
  let remaining = block.text;
  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('；'), slice.lastIndexOf('\n'));
    const at = cut > maxChars * 0.4 ? cut + 1 : maxChars;
    pieces.push({ ...block, text: remaining.slice(0, at).trim() });
    remaining = remaining.slice(at).trim();
  }
  if (remaining !== '') pieces.push({ ...block, text: remaining });
  return pieces;
}

export function buildChunks(blocks, { chunkChars = 1200 } = {}) {
  const { map, characters, tags } = buildSpeakerMap(blocks);
  const maxChars = clampNumber(chunkChars, 1200, 300, 3000);
  const chunks = [];
  let current = [];
  let currentChars = 0;
  const flush = () => {
    if (current.length === 0) return;
    const mossText = current.map((block) => `[${map.get(String(block.speaker ?? '').trim()) ?? 'S1'}] ${block.text}`).join('\n');
    const spokenText = current.map((block) => block.text).join('\n');
    const siliconText = current.map((block) => {
      const tag = map.get(String(block.speaker ?? '').trim()) ?? 'S1';
      return `[${tag === 'S1' ? 'S1' : 'S2'}] ${block.text}`;
    }).join('\n');
    const plainText = current.map((block) => `${block.speaker ? `【${block.speaker}】` : ''}${block.text}`).join('\n');
    const blockStart = Math.min(...current.map((block) => block.index));
    const blockEnd = Math.max(...current.map((block) => block.index));
    chunks.push({
      index: chunks.length,
      blockStart,
      blockEnd,
      text: plainText,
      spokenText,
      siliconText,
      mossText,
      chars: current.reduce((sum, block) => sum + block.text.length, 0),
    });
    current = [];
    currentChars = 0;
  };
  for (const block of blocks) {
    for (const piece of splitLongBlock(block, maxChars)) {
      if (currentChars > 0 && currentChars + piece.text.length > maxChars) flush();
      current.push(piece);
      currentChars += piece.text.length;
    }
  }
  flush();
  return { chunks, speakerMap: map, characters, tags };
}

// ── MOSS-TTSD ───────────────────────────────────────────────────────────

function refsPath(relative) {
  const root = resolve(ttsRoot()) + sep;
  const path = resolve(ttsRoot(), String(relative ?? ''));
  if (!path.startsWith(root)) throw new Error('参考音频路径不合法');
  return path;
}

function audioMimeFor(file) {
  const ext = extname(file).toLowerCase();
  return ({ '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' })[ext] ?? 'audio/wav';
}

async function readRef(relative) {
  if (!relative) return null;
  const bytes = await readFile(refsPath(relative));
  return { bytes, dataUri: `data:${audioMimeFor(relative)};base64,${bytes.toString('base64')}` };
}

async function resolveSpeakerRefs(config, tags) {
  const narrator = config.moss.narrator;
  const character = config.moss.character;
  if (!narrator.file) throw new Error('还没有上传 MOSS-TTSD 的叙述者参考音频；请先在 TTS 设置里上传。');
  const narratorAudio = await readRef(narrator.file);
  const characterAudio = character.file ? await readRef(character.file) : null;
  const speakers = [];
  for (const tag of tags.length > 0 ? tags : ['S1']) {
    const isNarrator = tag === 'S1';
    const audio = isNarrator ? narratorAudio : (characterAudio ?? narratorAudio);
    const text = isNarrator ? narrator.text : (character.text || narrator.text);
    speakers.push({ tag, audio, text });
  }
  const promptText = speakers
    .filter((speaker) => speaker.text.trim() !== '')
    .map((speaker) => `[${speaker.tag}] ${speaker.text.trim()}`)
    .join(' ');
  return {
    promptText,
    audio: speakers.map((speaker) => speaker.audio.dataUri),
    speakers: speakers.map((speaker) => ({ tag: speaker.tag, text: speaker.text })),
  };
}

function wavDuration(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= buffer.length) byteRate = buffer.readUInt32LE(offset + 16);
    if (id === 'data') { dataSize = size; break; }
    offset += 8 + size + (size % 2);
  }
  if (byteRate <= 0) return 0;
  return Math.round((dataSize / byteRate) * 10) / 10;
}

async function synthesizeMossChunk(config, chunk, refs, signal) {
  const maxNewTokens = Math.min(
    config.moss.maxNewTokens,
    Math.max(1024, Math.ceil(chunk.chars * 4)),
  );
  const text = `${refs.promptText} ${chunk.mossText}`.trim();
  const body = {
    text,
    audio_data: refs.audio,
    sampling_params: {
      max_new_tokens: maxNewTokens,
      temperature: config.moss.temperature,
      top_p: config.moss.topP,
      top_k: config.moss.topK,
    },
  };
  const response = await fetchWithRetry(config.moss.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, signal, 10 * 60 * 1000, { label: 'MOSS-TTSD', attempts: 2 });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`MOSS-TTSD 返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
  }
  const json = await response.json();
  let bytes;
  if (typeof json?.text === 'string') {
    if (/^https?:\/\//u.test(json.text)) {
      const audioResponse = await fetchWithTimeout(json.text, { method: 'GET' }, signal, 60000);
      if (!audioResponse.ok) throw new Error(`下载 MOSS 音频失败（HTTP ${audioResponse.status}）`);
      bytes = Buffer.from(await audioResponse.arrayBuffer());
    } else {
      bytes = Buffer.from(json.text, 'base64');
    }
  } else if (typeof json?.audio === 'string') {
    bytes = Buffer.from(json.audio, 'base64');
  } else if (typeof json?.audio_base64 === 'string') {
    bytes = Buffer.from(json.audio_base64, 'base64');
  } else if (typeof json?.url === 'string') {
    const audioResponse = await fetchWithTimeout(json.url, { method: 'GET' }, signal, 60000);
    if (!audioResponse.ok) throw new Error(`下载 MOSS 音频失败（HTTP ${audioResponse.status}）`);
    bytes = Buffer.from(await audioResponse.arrayBuffer());
  }
  if (!bytes || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('MOSS-TTSD 没有返回有效 WAV 音频');
  }
  return { bytes, duration: wavDuration(bytes) };
}

// ── 火山引擎豆包单向流式 TTS ─────────────────────────────────────────────

async function synthesizeVolcChunk(config, chunk, signal) {
  const text = String(chunk.spokenText ?? chunk.text ?? '').trim();
  if (text === '') throw new Error('这一块没有可合成的文本');
  if (!config.apiKey) throw new Error('还没有填写火山引擎 API Key');
  if (!config.speaker) throw new Error('还没有填写 Speaker ID（音色 ID）');
  const requestId = randomUUID();
  const reqParams = {
    text,
    speaker: config.speaker,
    audio_params: {
      format: 'mp3',
      sample_rate: config.sampleRate,
      speech_rate: config.speechRate,
      loudness_rate: config.loudnessRate,
    },
  };
  if (Number(config.pitch) !== 0) reqParams.post_process = { pitch: config.pitch };
  if (config.model) reqParams.model = config.model;

  const response = await fetchWithRetry(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Api-Key': config.apiKey,
      'X-Api-Resource-Id': config.resourceId,
      'X-Api-Request-Id': requestId,
    },
    body: JSON.stringify({ req_params: reqParams }),
  }, signal, 120000, { label: '火山豆包', attempts: 3 });

  const logid = response.headers.get('x-tt-logid') ?? '';
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`火山豆包返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}${logid ? `（logid ${logid}）` : ''}`);
  }
  if (!response.body) throw new Error('火山豆包没有返回流式响应体');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let buffer = '';
  let ended = false;
  let apiError = null;

  const handleLine = (raw) => {
    let line = String(raw ?? '').trim();
    if (line === '') return;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (line === '' || line === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    const code = Number(json?.code ?? 0);
    if (code === 20000000) {
      ended = true;
      return;
    }
    if (code > 0) {
      apiError = new Error(`火山豆包返回错误 ${code}：${json?.message ?? '未知错误'}${logid ? `（logid ${logid}）` : ''}`);
      return;
    }
    if (typeof json?.data === 'string' && json.data !== '') {
      try {
        parts.push(Buffer.from(json.data, 'base64'));
      } catch {
        apiError = new Error('火山豆包返回的音频 base64 无法解码');
      }
    }
  };

  try {
    while (!ended && !apiError) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while (!ended && !apiError && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    }
    if (!ended && !apiError && buffer.trim() !== '') handleLine(buffer);
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  if (apiError) throw apiError;
  const bytes = Buffer.concat(parts);
  if (bytes.length === 0) throw new Error('火山豆包没有返回音频数据');
  return { bytes, duration: 0 };
}

// ── 硅基流动（SiliconFlow）MOSS-TTSD-v0.5 ──────────────────────────────

async function synthesizeSiliconChunk(config, chunk, signal) {
  const isMoss = /MOSS-TTSD/i.test(config.model);
  const text = String(
    isMoss
      ? (chunk.siliconText ?? chunk.mossText ?? chunk.text ?? '')
      : (chunk.spokenText ?? chunk.text ?? chunk.siliconText ?? ''),
  ).trim();
  if (text === '') throw new Error('这一块没有可合成的文本');
  const apiKey = config.apiKey || siliconEnvKey();
  if (!apiKey) {
    throw new Error('还没有配置硅基流动 API Key；可以在 TTS 设置里填，或设置环境变量 SILICON_FLOW_API_KEY。');
  }
  if (!config.model) throw new Error('还没有填写硅基流动模型 ID（例如 fnlp/MOSS-TTSD-v0.5）');
  if (!config.voice) throw new Error('还没有填写硅基流动 voice（例如 fnlp/MOSS-TTSD-v0.5:alex）');
  const body = {
    model: config.model,
    input: text,
    voice: config.voice,
    response_format: 'mp3',
    sample_rate: config.sampleRate,
    stream: false,
    speed: config.speed,
    gain: config.gain,
  };
  const response = await fetchWithRetry(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }, signal, 180000, { label: '硅基流动', attempts: 3 });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`硅基流动返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('硅基流动没有返回音频数据');
  if (contentType.includes('application/json') || contentType.startsWith('text/')) {
    const detail = bytes.toString('utf8').slice(0, 300);
    throw new Error(`硅基流动返回的不是音频：${detail}`);
  }
  return { bytes, duration: 0 };
}

export async function testSiliconFlow(payload = {}) {
  const config = await readTtsConfig();
  const silicon = config.siliconflow;
  const apiKey = String(payload.apiKey ?? '').trim() || silicon.apiKey || siliconEnvKey();
  if (apiKey === '') {
    return { ok: false, error: '请先在 TTS 设置里填写 SiliconFlow API Key，或设置环境变量 SILICON_FLOW_API_KEY。' };
  }
  let endpoint;
  try {
    endpoint = validateEndpoint(cleanString(payload.endpoint, silicon.endpoint, 500), '硅基流动');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const settings = {
    ...silicon,
    apiKey,
    endpoint,
    model: cleanString(payload.model, silicon.model, 200),
    voice: cleanString(payload.voice, silicon.voice, 200),
    sampleRate: SILICON_SAMPLE_RATES.includes(Number(payload.sampleRate)) ? Number(payload.sampleRate) : silicon.sampleRate,
  };
  try {
    const result = await synthesizeSiliconChunk(settings, {
      siliconText: '[S1] 你好，这是评书插件的连接测试。',
      spokenText: '你好，这是评书插件的连接测试。',
      chars: 19,
    }, new AbortController().signal);
    return {
      ok: true,
      bytes: result.bytes.length,
      message: `连接成功，收到约 ${Math.max(1, Math.round(result.bytes.length / 1024))} KB 音频（测试会按字符计费）`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── 任务 ────────────────────────────────────────────────────────────────

function cacheDir(hash) {
  return join(ttsCacheRoot(), hash);
}

function audioUrl(hash, index, ext) {
  return `/dsh-pingshu/audio/${hash}/${index}.${ext}`;
}

async function readManifest(hash, total) {
  const manifest = await readJsonFile(join(cacheDir(hash), 'manifest.json'));
  if (!manifest || !Array.isArray(manifest.chunks) || manifest.chunks.length !== total) return null;
  for (const chunk of manifest.chunks) {
    const path = join(cacheDir(hash), chunk.file);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0) return null;
    } catch {
      return null;
    }
  }
  return manifest;
}

function jobView(job) {
  return {
    jobId: job.id,
    provider: job.provider ?? 'moss',
    format: job.ext ?? 'wav',
    status: job.status,
    progress: job.progress,
    total: job.total,
    chunks: job.chunks,
    error: job.error ?? null,
    cached: job.cached === true,
  };
}

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function runJob(job, chunks, synthesize) {
  if (job.controller.signal.aborted) {
    job.status = 'canceled';
    return;
  }
  job.status = 'running';
  const dir = cacheDir(job.id);
  const ext = job.ext;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (let index = 0; index < chunks.length; index += 1) {
    if (job.controller.signal.aborted) {
      job.status = 'canceled';
      return;
    }
    const chunk = chunks[index];
    const file = `${index}.${ext}`;
    const path = join(dir, file);
    let bytes;
    let duration;
    try {
      const existing = await readFile(path);
      if (existing.length > 0) {
        bytes = existing;
        duration = ext === 'wav' ? wavDuration(existing) : 0;
      }
    } catch {
      /* generate below */
    }
    if (!bytes) {
      const result = await synthesize(chunk, job.controller.signal);
      bytes = result.bytes;
      duration = result.duration;
      await writeFile(path, bytes, { mode: 0o600 });
    }
    const entry = {
      index,
      text: chunk.text,
      blockStart: chunk.blockStart,
      blockEnd: chunk.blockEnd,
      chars: chunk.chars,
      file,
      url: audioUrl(job.id, index, ext),
      bytes: bytes.length,
      duration,
      mime: job.mime,
    };
    job.chunks[index] = entry;
    job.progress = index + 1;
    await writeJsonFile(join(dir, 'manifest.json'), {
      jobId: job.id,
      provider: job.provider,
      ext,
      mime: job.mime,
      createdAt: nowIso(),
      chunks: job.chunks.filter(Boolean),
    });
  }
  job.status = 'ready';
  job.progress = chunks.length;
  await writeJsonFile(join(dir, 'manifest.json'), {
    jobId: job.id,
    provider: job.provider,
    ext,
    mime: job.mime,
    createdAt: nowIso(),
    chunks: job.chunks,
  });
}

function cachedJob(hash, chunks, manifest) {
  return {
    id: hash,
    provider: manifest.provider ?? 'moss',
    ext: manifest.ext ?? (manifest.chunks[0]?.file?.endsWith('.mp3') ? 'mp3' : 'wav'),
    mime: manifest.mime ?? (manifest.ext === 'mp3' ? 'audio/mpeg' : 'audio/wav'),
    status: 'ready',
    progress: chunks.length,
    total: chunks.length,
    chunks: manifest.chunks,
    error: null,
    cached: true,
  };
}

async function startMossJob({ projectId, performance, blocks, config }) {
  const { chunks, tags } = buildChunks(blocks, { chunkChars: config.moss.chunkChars });
  if (chunks.length === 0) throw new Error('没有可合成的段落');
  const refs = await resolveSpeakerRefs(config, tags);
  const hash = createHash('sha256').update(JSON.stringify({
    provider: 'moss',
    endpoint: config.moss.endpoint,
    narrator: config.moss.narrator,
    character: config.moss.character,
    sampling: { maxNewTokens: config.moss.maxNewTokens, temperature: config.moss.temperature, topP: config.moss.topP, topK: config.moss.topK },
    chunks: chunks.map((chunk) => chunk.mossText),
  })).digest('hex').slice(0, 24);

  const cached = await readManifest(hash, chunks.length);
  if (cached) {
    const job = cachedJob(hash, chunks, cached);
    jobs.set(hash, job);
    return jobView(job);
  }
  const existing = jobs.get(hash);
  if (existing && existing.status !== 'error' && existing.status !== 'canceled') return jobView(existing);

  const job = {
    id: hash,
    provider: 'moss',
    ext: 'wav',
    mime: 'audio/wav',
    status: 'queued',
    progress: 0,
    total: chunks.length,
    chunks: new Array(chunks.length).fill(null),
    error: null,
    cached: false,
    controller: new AbortController(),
    createdAt: nowIso(),
    projectId,
    chapterId: performance.meta.chapterId,
    versionId: performance.meta.versionId,
  };
  jobs.set(hash, job);
  void enqueue(async () => {
    try {
      await runJob(job, chunks, (chunk, signal) => synthesizeMossChunk(config, chunk, refs, signal));
    } catch (error) {
      if (job.controller.signal.aborted) job.status = 'canceled';
      else {
        job.status = 'error';
        job.error = error instanceof Error ? error.message : String(error);
      }
    }
  });
  return jobView(job);
}

async function startVolcJob({ projectId, performance, blocks, config }) {
  const volc = config.volcengine;
  if (!volc.apiKey) throw new Error('还没有填写火山引擎 API Key；请先在 TTS 设置里配置。');
  if (!volc.speaker) throw new Error('还没有填写 Speaker ID（音色 ID）。');
  const { chunks } = buildChunks(blocks, { chunkChars: volc.chunkChars });
  if (chunks.length === 0) throw new Error('没有可合成的段落');
  const keyTag = createHash('sha256').update(volc.apiKey).digest('hex').slice(0, 8);
  const hash = createHash('sha256').update(JSON.stringify({
    provider: 'volcengine',
    endpoint: volc.endpoint,
    keyTag,
    resourceId: volc.resourceId,
    speaker: volc.speaker,
    sampleRate: volc.sampleRate,
    speechRate: volc.speechRate,
    loudnessRate: volc.loudnessRate,
    pitch: volc.pitch,
    model: volc.model,
    chunks: chunks.map((chunk) => chunk.spokenText),
  })).digest('hex').slice(0, 24);

  const cached = await readManifest(hash, chunks.length);
  if (cached) {
    const job = cachedJob(hash, chunks, cached);
    jobs.set(hash, job);
    return jobView(job);
  }
  const existing = jobs.get(hash);
  if (existing && existing.status !== 'error' && existing.status !== 'canceled') return jobView(existing);

  const job = {
    id: hash,
    provider: 'volcengine',
    ext: 'mp3',
    mime: 'audio/mpeg',
    status: 'queued',
    progress: 0,
    total: chunks.length,
    chunks: new Array(chunks.length).fill(null),
    error: null,
    cached: false,
    controller: new AbortController(),
    createdAt: nowIso(),
    projectId,
    chapterId: performance.meta.chapterId,
    versionId: performance.meta.versionId,
  };
  jobs.set(hash, job);
  void enqueue(async () => {
    try {
      await runJob(job, chunks, (chunk, signal) => synthesizeVolcChunk(volc, chunk, signal));
    } catch (error) {
      if (job.controller.signal.aborted) job.status = 'canceled';
      else {
        job.status = 'error';
        job.error = error instanceof Error ? error.message : String(error);
      }
    }
  });
  return jobView(job);
}

async function startSiliconJob({ projectId, performance, blocks, config }) {
  const silicon = config.siliconflow;
  const apiKey = siliconKey(config);
  if (!apiKey) throw new Error('还没有配置硅基流动 API Key；可以在 TTS 设置里填，或设置环境变量 SILICON_FLOW_API_KEY。');
  if (!silicon.model) throw new Error('还没有填写硅基流动模型 ID（例如 fnlp/MOSS-TTSD-v0.5）。');
  if (!silicon.voice) throw new Error('还没有填写硅基流动 voice（例如 fnlp/MOSS-TTSD-v0.5:alex）。');
  const { chunks } = buildChunks(blocks, { chunkChars: silicon.chunkChars });
  if (chunks.length === 0) throw new Error('没有可合成的段落');
  const keyTag = createHash('sha256').update(apiKey).digest('hex').slice(0, 8);
  const hash = createHash('sha256').update(JSON.stringify({
    provider: 'siliconflow',
    endpoint: silicon.endpoint,
    keyTag,
    model: silicon.model,
    voice: silicon.voice,
    sampleRate: silicon.sampleRate,
    speed: silicon.speed,
    gain: silicon.gain,
    chunks: chunks.map((chunk) => chunk.siliconText),
  })).digest('hex').slice(0, 24);

  const cached = await readManifest(hash, chunks.length);
  if (cached) {
    const job = cachedJob(hash, chunks, cached);
    jobs.set(hash, job);
    return jobView(job);
  }
  const existing = jobs.get(hash);
  if (existing && existing.status !== 'error' && existing.status !== 'canceled') return jobView(existing);

  const job = {
    id: hash,
    provider: 'siliconflow',
    ext: 'mp3',
    mime: 'audio/mpeg',
    status: 'queued',
    progress: 0,
    total: chunks.length,
    chunks: new Array(chunks.length).fill(null),
    error: null,
    cached: false,
    controller: new AbortController(),
    createdAt: nowIso(),
    projectId,
    chapterId: performance.meta.chapterId,
    versionId: performance.meta.versionId,
  };
  jobs.set(hash, job);
  void enqueue(async () => {
    try {
      await runJob(job, chunks, (chunk, signal) => synthesizeSiliconChunk({ ...silicon, apiKey }, chunk, signal));
    } catch (error) {
      if (job.controller.signal.aborted) job.status = 'canceled';
      else {
        job.status = 'error';
        job.error = error instanceof Error ? error.message : String(error);
      }
    }
  });
  return jobView(job);
}

export async function startTtsJob({ projectId, chapterId, versionId, provider } = {}) {
  const config = await readTtsConfig();
  const requested = ['browser', 'moss', 'volcengine', 'siliconflow'].includes(provider) ? provider : config.provider;
  if (requested === 'browser') return { provider: 'browser' };
  const performance = await getPerformance(projectId, chapterId, versionId);
  const blocks = parseScriptBlocks(performance.script);
  if (blocks.length === 0) throw new Error('这一版文案没有可朗读的正文');
  if (requested === 'volcengine') return startVolcJob({ projectId, performance, blocks, config });
  if (requested === 'siliconflow') return startSiliconJob({ projectId, performance, blocks, config });
  return startMossJob({ projectId, performance, blocks, config });
}

export async function getTtsJob(jobId) {
  const id = String(jobId ?? '');
  if (id === '') throw new Error('缺少 jobId');
  const job = jobs.get(id);
  if (job) return jobView(job);
  const manifest = await readJsonFile(join(cacheDir(id), 'manifest.json'));
  if (manifest && Array.isArray(manifest.chunks)) {
    return {
      jobId: id,
      provider: manifest.provider ?? 'moss',
      format: manifest.ext ?? (manifest.chunks[0]?.file?.endsWith('.mp3') ? 'mp3' : 'wav'),
      status: 'ready',
      progress: manifest.chunks.length,
      total: manifest.chunks.length,
      chunks: manifest.chunks,
      error: null,
      cached: true,
    };
  }
  throw new Error('找不到这个合成任务');
}

export function cancelTtsJob(jobId) {
  const job = jobs.get(String(jobId ?? ''));
  if (!job) return { ok: false, error: '任务不存在或已结束' };
  if (job.status === 'ready') return { ok: true, status: 'ready' };
  job.controller.abort();
  job.status = 'canceled';
  return { ok: true, status: 'canceled' };
}

export async function listTtsJobs() {
  return { jobs: [...jobs.values()].map(jobView) };
}

export async function audioFile(hash, file) {
  const id = String(hash ?? '');
  if (!/^[a-f0-9]{8,64}$/u.test(id)) return null;
  const match = /^(\d{1,4})\.(wav|mp3)$/u.exec(String(file ?? ''));
  if (!match) return null;
  const dir = cacheDir(id);
  const path = join(dir, String(file));
  if (!path.startsWith(dir + sep)) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0) return null;
    return { path, size: info.size, mime: match[2] === 'mp3' ? 'audio/mpeg' : 'audio/wav' };
  } catch {
    return null;
  }
}

export { DEFAULT_CONFIG as DEFAULT_TTS_CONFIG };
