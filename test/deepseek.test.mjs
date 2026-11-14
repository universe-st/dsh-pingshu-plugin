import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectRecord, writeChapters, savePerformance } from '../lib/store.js';
import {
  audioFile,
  buildChunks,
  getTtsConfig,
  getTtsJob,
  parseScriptBlocks,
  saveTtsConfig,
  setCredentialResolver,
  startTtsJob,
  testDeepseek,
} from '../lib/tts.js';

function makeWav(seconds = 0.2, sampleRate = 24000) {
  const samples = Math.max(1, Math.floor(seconds * sampleRate));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const SCRIPT = [
  '# 第一回 测试',
  '',
  '## 开场',
  '【说书人】各位听众，今天咱们讲一个 DeepSeek 语音的测试故事。故事不长，可是人物不少，咱们慢慢说。',
  '',
  '## 正文',
  '【说书人】头一个来的是张三。张三脾气急，遇事先拍桌子。可他心里不坏，就是嘴上不饶人。',
  '【角色：张三】你先说，这事儿到底怎么办？别光站着不说话。',
  '【说书人】李四在旁边听着，半天没吭声。等张三说完了，他才慢慢开口。',
  '【角色：李四】急什么？人还没到齐呢。咱们先把事情说明白，再动手也不迟。',
  '【说书人】张三听完，把桌子一拍，说这事儿不能拖。李四却摇摇头，说拖不拖，得看人齐不齐。',
  '【角色：张三】你就是想得太多。再等下去，黄花菜都凉了。',
  '【角色：李四】凉了就凉了，总比办错了强。',
  '',
  '## 扣子',
  '【说书人】欲知后事如何，且听下回分解。',
].join('\n');

test('DeepSeek TTS: config masking, /v1/tools/tts body, per-speaker voices, WAV cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingshu-deepseek-'));
  process.env.PINGSHU_DATA_DIR = dir;
  process.env.DEEPSEEK_API_KEY = 'env-deepseek-key';
  const wav = makeWav(0.4, 24000);
  const requests = [];
  let calls = 0;

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/tools/tts') {
      response.statusCode = 404;
      response.end();
      return;
    }
    const raw = await readBody(request);
    let body = null;
    try { body = JSON.parse(raw.toString('utf8')); } catch { /* ignore */ }
    calls += 1;
    requests.push({ headers: request.headers, body });
    response.writeHead(200, { 'content-type': 'audio/wav' });
    response.end(wav);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/v1/tools/tts`;

  try {
    const saved = await saveTtsConfig({
      provider: 'deepseek',
      deepseek: {
        endpoint,
        apiKey: '',
        voiceId: 'stella',
        splitCharacters: true,
        chunkChars: 300,
      },
    });
    assert.equal(saved.provider, 'deepseek');
    assert.equal(saved.deepseek.apiKeySet, true);
    assert.equal(saved.deepseek.apiKeySource, 'env');
    assert.equal('apiKey' in saved.deepseek, false);
    assert.equal(saved.deepseek.voiceId, 'stella');
    assert.equal(saved.deepseek.splitCharacters, true);

    const config = await getTtsConfig();
    assert.equal(config.deepseek.apiKeySet, true);
    assert.equal(config.deepseek.apiKeySource, 'env');
    assert.equal(config.deepseek.apiKey, undefined);
    assert.match(config.deepseek.apiKeyMasked, /…/u);

    const blocks = parseScriptBlocks(SCRIPT);
    const { chunks } = buildChunks(blocks, { chunkChars: 300, bySpeaker: true });
    assert.ok(chunks.length >= 4, 'each speaker turn should flush a chunk');
    assert.ok(chunks.some((chunk) => chunk.speakerTag !== 'S1'));
    assert.ok(chunks.every((chunk) => chunk.speakerTag));

    const project = await createProjectRecord({ title: 'DeepSeek 测试书', filename: 'x.epub' });
    await writeChapters(project.id, [{ index: 1, id: 'ch-000001', title: '第一回', text: '正文。', chars: 2 }], '正文。');
    await savePerformance(project.id, 'ch-000001', SCRIPT, { style: '传统评书' });

    const started = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'deepseek' });
    assert.equal(started.provider, 'deepseek');
    assert.equal(started.format, 'wav');
    assert.ok(started.total >= 4);
    for (let i = 0; i < 60 && requests.length < started.total; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(requests.length, started.total);

    const narrator = requests.find((item) => item.body.text.includes('各位听众'));
    assert.ok(narrator, 'the narrator chunk should be requested');
    assert.equal(narrator.headers.authorization, 'Bearer env-deepseek-key');
    assert.equal(narrator.body.voice_id, 'stella');
    assert.equal(narrator.body.format, 'wav');
    assert.equal(narrator.body.filter_markdown, true);
    assert.ok(requests.every((item) => !item.body.text.includes('【')), 'text must not contain pingshu labels');
    assert.ok(requests.some((item) => item.body.voice_id === 'tide'), 'character lines should use the other voice');
    assert.ok(requests.every((item) => ['stella', 'tide'].includes(item.body.voice_id)));

    let job = await getTtsJob(started.jobId);
    for (let i = 0; i < 80 && job.status !== 'ready' && job.status !== 'error'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await getTtsJob(started.jobId);
    }
    assert.equal(job.status, 'ready', job.error ?? '');
    assert.equal(job.format, 'wav');
    assert.equal(job.chunks.length, started.total);
    assert.ok(job.chunks.every((chunk) => chunk.mime === 'audio/wav'));
    assert.ok(job.chunks.every((chunk) => chunk.url.endsWith('.wav')));
    assert.ok(job.chunks.every((chunk) => chunk.duration > 0), 'wav duration should be parsed');

    const file = await audioFile(started.jobId, '0.wav');
    assert.ok(file);
    assert.equal(file.mime, 'audio/wav');
    assert.ok((await stat(file.path)).size > 0);

    const callsBefore = calls;
    const cached = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'deepseek' });
    assert.equal(cached.status, 'ready');
    assert.equal(cached.cached, true);
    assert.equal(calls, callsBefore, 'cache should avoid a second synthesis');

    const testResult = await testDeepseek({ endpoint, voiceId: 'tide' });
    assert.equal(testResult.ok, true, testResult.error ?? '');
    assert.ok(testResult.bytes > 0);
    assert.equal(requests.at(-1).headers.authorization, 'Bearer env-deepseek-key');
    assert.equal(requests.at(-1).body.voice_id, 'tide');
    assert.ok(requests.at(-1).body.text.includes('连接测试'));

    const overridden = await saveTtsConfig({ deepseek: { apiKey: 'config-deepseek-key' } });
    assert.equal(overridden.deepseek.apiKeySource, 'config');
    const testOverride = await testDeepseek({ endpoint });
    assert.equal(testOverride.ok, true, testOverride.error ?? '');
    assert.equal(requests.at(-1).headers.authorization, 'Bearer config-deepseek-key');

    // DSH 凭据库（ctx.credentials）：用户只清掉本机配置时，应回退到 DSH 凭据。
    setCredentialResolver(async (name) => (name === 'DEEPSEEK_API_KEY'
      ? { value: 'sk-dsh-credential-key', source: 'file', masked: 'sk-…-key' }
      : null));
    const cleared = await saveTtsConfig({ deepseek: { clearApiKey: true } });
    assert.equal(cleared.deepseek.apiKeySet, true);
    assert.equal(cleared.deepseek.apiKeySource, 'dsh');
    assert.equal(JSON.stringify(cleared).includes('dsh-credential'), false, 'the raw key must never leave the host');

    const testDsh = await testDeepseek({ endpoint });
    assert.equal(testDsh.ok, true, testDsh.error ?? '');
    assert.equal(requests.at(-1).headers.authorization, 'Bearer sk-dsh-credential-key');

    // 本机配置的 Key 优先于 DSH 凭据库。
    const configFirst = await saveTtsConfig({ deepseek: { apiKey: 'config-deepseek-key' } });
    assert.equal(configFirst.deepseek.apiKeySource, 'config');
    const testConfigFirst = await testDeepseek({ endpoint });
    assert.equal(testConfigFirst.ok, true, testConfigFirst.error ?? '');
    assert.equal(requests.at(-1).headers.authorization, 'Bearer config-deepseek-key');

    // 没有 DSH 凭据服务时，回退到环境变量。
    setCredentialResolver(null);
    await saveTtsConfig({ deepseek: { clearApiKey: true } });
    const testEnv = await testDeepseek({ endpoint });
    assert.equal(testEnv.ok, true, testEnv.error ?? '');
    assert.equal(requests.at(-1).headers.authorization, 'Bearer env-deepseek-key');
  } finally {
    setCredentialResolver(null);
    await new Promise((resolve) => server.close(resolve));
    delete process.env.DEEPSEEK_API_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});

test('DeepSeek TTS: a cut-off WAV stream is reported as an error, not cached', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingshu-deepseek-cut-'));
  process.env.PINGSHU_DATA_DIR = dir;
  process.env.DEEPSEEK_API_KEY = 'env-deepseek-key';
  const full = makeWav(1, 24000);
  const cut = full.subarray(0, 44 + 100);
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/tools/tts') {
      response.statusCode = 404;
      response.end();
      return;
    }
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'audio/wav' });
      response.end(cut);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/v1/tools/tts`;

  try {
    await saveTtsConfig({
      provider: 'deepseek',
      deepseek: { endpoint, voiceId: 'stella', splitCharacters: false, chunkChars: 300 },
    });
    const project = await createProjectRecord({ title: 'DeepSeek 断流测试书', filename: 'x.epub' });
    await writeChapters(project.id, [{ index: 1, id: 'ch-000001', title: '第一回', text: '正文。', chars: 2 }], '正文。');
    await savePerformance(project.id, 'ch-000001', SCRIPT, { style: '传统评书' });

    const started = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'deepseek' });
    let job = await getTtsJob(started.jobId);
    for (let i = 0; i < 80 && job.status !== 'ready' && job.status !== 'error'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await getTtsJob(started.jobId);
    }
    assert.equal(job.status, 'error');
    assert.match(job.error, /断流|不完整|中断/u);
    const cached = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'deepseek' });
    assert.notEqual(cached.cached, true, 'a failed synthesis must not be served from cache');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.DEEPSEEK_API_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});

test('DeepSeek TTS: chunks synthesize concurrently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingshu-deepseek-concurrency-'));
  process.env.PINGSHU_DATA_DIR = dir;
  process.env.DEEPSEEK_API_KEY = 'env-deepseek-key';
  const wav = makeWav(0.2, 24000);
  let active = 0;
  let maxActive = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/tools/tts') {
      response.statusCode = 404;
      response.end();
      return;
    }
    await readBody(request);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 80));
    response.writeHead(200, { 'content-type': 'audio/wav' });
    response.end(wav);
    active -= 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/v1/tools/tts`;
  try {
    await saveTtsConfig({
      provider: 'deepseek',
      deepseek: { endpoint, voiceId: 'stella', splitCharacters: true, chunkChars: 300, concurrency: 3 },
    });
    const project = await createProjectRecord({ title: 'DeepSeek 并发测试书', filename: 'x.epub' });
    await writeChapters(project.id, [{ index: 1, id: 'ch-000001', title: '第一回', text: '正文。', chars: 2 }], '正文。');
    await savePerformance(project.id, 'ch-000001', SCRIPT, { style: '传统评书' });

    const started = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'deepseek' });
    assert.ok(started.total >= 3);
    let job = await getTtsJob(started.jobId);
    for (let i = 0; i < 80 && job.status !== 'ready' && job.status !== 'error'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = await getTtsJob(started.jobId);
    }
    assert.equal(job.status, 'ready', job.error ?? '');
    assert.ok(maxActive >= 2, `expected parallel requests, saw max ${maxActive}`);
    assert.ok(maxActive <= 3, `concurrency should stay within the configured limit, saw ${maxActive}`);
    assert.equal(job.chunks.length, started.total);
    assert.ok(job.chunks.every(Boolean));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.DEEPSEEK_API_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});
