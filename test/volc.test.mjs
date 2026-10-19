import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectRecord, writeChapters, savePerformance } from '../lib/store.js';
import {
  audioFile,
  getTtsConfig,
  getTtsJob,
  parseScriptBlocks,
  saveTtsConfig,
  startTtsJob,
  testVolcengine,
} from '../lib/tts.js';

function fakeMp3(seed, size = 96) {
  const buffer = Buffer.alloc(size, seed);
  buffer.write('ID3', 0, 'ascii');
  return buffer;
}

function parseBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
  });
}

test('Volcengine unidirectional streaming TTS: headers, NDJSON audio, cache, config masking', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingshu-volc-'));
  process.env.PINGSHU_DATA_DIR = dir;
  const audioA = fakeMp3(1, 64);
  const audioB = fakeMp3(2, 80);
  let synthCalls = 0;
  let testCalls = 0;
  let lastRequest = null;
  const requests = [];

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/v3/tts/unidirectional') {
      response.statusCode = 404;
      response.end();
      return;
    }
    const body = await parseBody(request);
    lastRequest = {
      headers: request.headers,
      body,
    };
    requests.push(lastRequest);
    const isTest = String(body?.req_params?.text ?? '').includes('连接测试');
    if (isTest) testCalls += 1;
    else synthCalls += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(`${JSON.stringify({ code: 0, data: audioA.toString('base64') })}\n`);
    response.write(`${JSON.stringify({ code: 0, data: audioB.toString('base64') })}\n`);
    response.write(`${JSON.stringify({ code: 20000000, message: 'OK' })}\n`);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/api/v3/tts/unidirectional`;

  try {
    const saved = await saveTtsConfig({
      provider: 'volcengine',
      volcengine: {
        endpoint,
        apiKey: 'volc-test-key',
        resourceId: 'seed-tts-2.0',
        speaker: 'zh_female_vv_uranus_bigtts',
        sampleRate: 24000,
        chunkChars: 300,
      },
    });
    assert.equal(saved.provider, 'volcengine');
    assert.equal(saved.volcengine.apiKeySet, true);
    assert.ok(saved.volcengine.apiKeyMasked.includes('…'));
    assert.equal('apiKey' in saved.volcengine, false);

    const config = await getTtsConfig();
    assert.equal(config.volcengine.apiKeySet, true);
    assert.equal(config.volcengine.apiKey, undefined);
    assert.equal(config.volcengine.resourceId, 'seed-tts-2.0');

    const kept = await saveTtsConfig({ provider: 'volcengine', volcengine: { apiKey: '', speaker: config.volcengine.speaker } });
    assert.equal(kept.volcengine.apiKeySet, true, 'blank key should keep the saved one');

    const project = await createProjectRecord({ title: '火山测试书', filename: 'x.epub' });
    await writeChapters(project.id, [{ index: 1, id: 'ch-000001', title: '第一回', text: '正文。', chars: 2 }], '正文。');
    const script = [
      '# 第一回 测试',
      '',
      '## 开场',
      '【说书人】各位听众，今天咱们讲一个火山豆包的测试故事。这个故事不长，可是人物不少，咱们慢慢说。',
      '',
      '## 正文',
      '【说书人】头一个来的是张三。张三脾气急，遇事先拍桌子。可他心里不坏，就是嘴上不饶人。',
      '【角色：张三】你先说，这事儿到底怎么办？别光站着不说话。',
      '【说书人】李四在旁边听着，半天没吭声。等张三说完了，他才慢慢开口。',
      '【角色：李四】急什么？人还没到齐呢。咱们先把事情说明白，再动手也不迟。',
      '【说书人】张三听完，把桌子一拍，说这事儿不能拖。李四却摇摇头，说拖不拖，得看人齐不齐。',
      '【角色：张三】你就是想得太多。再等下去，黄花菜都凉了。',
      '【角色：李四】凉了就凉了，总比办错了强。',
      '【说书人】这话一出口，屋里就静了。张三看着李四，李四看着窗外，谁也不再说话。',
      '【说书人】张三把茶碗一端，李四把袖子一挽，屋里的空气又紧了几分。',
      '【角色：李四】咱们别吵，先把人找齐。',
      '【说书人】张三哼了一声，没再说话。窗外的风把门吹得吱呀一响。',
      '',
      '## 扣子',
      '【说书人】三个人在屋里你看看我，我看看你，谁也不肯先露底。欲知后事如何，且听下回分解。',
    ].join('\n');
    await savePerformance(project.id, 'ch-000001', script, { style: '传统评书' });

    const blocks = parseScriptBlocks(script);
    assert.ok(blocks.length >= 4);

    const started = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'volcengine' });
    assert.equal(started.provider, 'volcengine');
    assert.ok(started.total >= 2, 'chunkChars 300 should split the script');
    for (let i = 0; i < 60 && requests.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(requests.length > 0, 'the host should call the streaming endpoint');
    const first = requests[0];
    assert.equal(first.headers['x-api-key'], 'volc-test-key');
    assert.equal(first.headers['x-api-resource-id'], 'seed-tts-2.0');
    assert.match(first.headers['x-api-request-id'], /^[0-9a-f-]{36}$/i);
    assert.equal(first.body.req_params.speaker, 'zh_female_vv_uranus_bigtts');
    assert.equal(first.body.req_params.audio_params.format, 'mp3');
    assert.equal(first.body.req_params.audio_params.sample_rate, 24000);
    assert.ok(requests.every((item) => !item.body.req_params.text.includes('【')), 'spoken text must not contain speaker labels');
    assert.ok(requests.some((item) => item.body.req_params.text.includes('各位听众')));
    assert.ok(requests.every((item) => item.body.req_params.text.length > 0));

    let job = await getTtsJob(started.jobId);
    for (let i = 0; i < 80 && job.status !== 'ready' && job.status !== 'error'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await getTtsJob(started.jobId);
    }
    assert.equal(job.status, 'ready', job.error ?? '');
    assert.equal(job.format, 'mp3');
    assert.ok(job.chunks.length >= 2);
    assert.ok(job.chunks.every((chunk) => chunk.url.endsWith('.mp3')));
    assert.ok(job.chunks.every((chunk) => chunk.mime === 'audio/mpeg'));
    assert.equal(job.chunks[0].bytes, audioA.length + audioB.length);

    const file = await audioFile(started.jobId, '0.mp3');
    assert.ok(file);
    assert.equal(file.mime, 'audio/mpeg');
    const info = await stat(file.path);
    assert.ok(info.size > 0);

    const callsBefore = synthCalls;
    const cached = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'volcengine' });
    assert.equal(cached.status, 'ready');
    assert.equal(cached.cached, true);
    assert.equal(synthCalls, callsBefore, 'cache should avoid a second synthesis');

    const testResult = await testVolcengine({ endpoint, apiKey: '', speaker: 'zh_female_vv_uranus_bigtts' });
    assert.equal(testResult.ok, true, testResult.error ?? '');
    assert.ok(testResult.bytes > 0);
    assert.equal(testCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
