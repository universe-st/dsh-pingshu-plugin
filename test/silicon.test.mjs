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
  saveTtsConfig,
  startTtsJob,
  testSiliconFlow,
} from '../lib/tts.js';

function fakeMp3(seed, size = 96) {
  const buffer = Buffer.alloc(size, seed);
  buffer.write('ID3', 0, 'ascii');
  return buffer;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

test('SiliconFlow MOSS-TTSD-v0.5: env key, /v1/audio/speech body, MP3 cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingshu-silicon-'));
  process.env.PINGSHU_DATA_DIR = dir;
  process.env.SILICON_FLOW_API_KEY = 'env-silicon-key';
  const audio = fakeMp3(7, 128);
  const requests = [];
  let calls = 0;

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/audio/speech') {
      response.statusCode = 404;
      response.end();
      return;
    }
    const raw = await readBody(request);
    let body = null;
    try { body = JSON.parse(raw.toString('utf8')); } catch { /* ignore */ }
    calls += 1;
    requests.push({ headers: request.headers, body });
    response.writeHead(200, { 'content-type': 'audio/mpeg' });
    response.end(audio);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/v1/audio/speech`;

  try {
    const saved = await saveTtsConfig({
      provider: 'siliconflow',
      siliconflow: {
        endpoint,
        apiKey: '',
        model: 'fnlp/MOSS-TTSD-v0.5',
        voice: 'fnlp/MOSS-TTSD-v0.5:alex',
        sampleRate: 44100,
        speed: 1,
        gain: 0,
        chunkChars: 300,
      },
    });
    assert.equal(saved.provider, 'siliconflow');
    assert.equal(saved.siliconflow.apiKeySet, true);
    assert.equal(saved.siliconflow.apiKeySource, 'env');
    assert.equal('apiKey' in saved.siliconflow, false);

    const config = await getTtsConfig();
    assert.equal(config.siliconflow.apiKeySet, true);
    assert.equal(config.siliconflow.apiKeySource, 'env');

    const project = await createProjectRecord({ title: '硅基流动测试书', filename: 'x.epub' });
    await writeChapters(project.id, [{ index: 1, id: 'ch-000001', title: '第一回', text: '正文。', chars: 2 }], '正文。');
    const script = [
      '# 第一回 测试',
      '',
      '## 开场',
      '【说书人】各位听众，今天咱们讲一个硅基流动的测试故事。这个故事不长，可是人物不少，咱们慢慢说。',
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
      '',
      '## 扣子',
      '【说书人】欲知后事如何，且听下回分解。',
    ].join('\n');
    await savePerformance(project.id, 'ch-000001', script, { style: '传统评书' });

    const started = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'siliconflow' });
    assert.equal(started.provider, 'siliconflow');
    assert.ok(started.total >= 2);
    for (let i = 0; i < 60 && requests.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(requests.length > 0);
    const first = requests[0];
    assert.equal(first.headers.authorization, 'Bearer env-silicon-key');
    assert.equal(first.body.model, 'fnlp/MOSS-TTSD-v0.5');
    assert.equal(first.body.voice, 'fnlp/MOSS-TTSD-v0.5:alex');
    assert.equal(first.body.response_format, 'mp3');
    assert.equal(first.body.sample_rate, 44100);
    assert.equal(first.body.stream, false);
    assert.equal(first.body.speed, 1);
    assert.equal(first.body.gain, 0);
    assert.ok(first.body.input.includes('[S1]'));
    assert.ok(requests.some((item) => item.body.input.includes('[S2]')), 'characters should map to S2');
    assert.ok(requests.every((item) => !item.body.input.includes('【')), 'input should not contain pingshu labels');

    let job = await getTtsJob(started.jobId);
    for (let i = 0; i < 80 && job.status !== 'ready' && job.status !== 'error'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await getTtsJob(started.jobId);
    }
    assert.equal(job.status, 'ready', job.error ?? '');
    assert.equal(job.format, 'mp3');
    assert.ok(job.chunks.every((chunk) => chunk.mime === 'audio/mpeg'));
    assert.ok(job.chunks.every((chunk) => chunk.url.endsWith('.mp3')));
    const file = await audioFile(started.jobId, '0.mp3');
    assert.ok(file);
    assert.equal(file.mime, 'audio/mpeg');
    assert.ok((await stat(file.path)).size > 0);

    const callsBefore = calls;
    const cached = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'siliconflow' });
    assert.equal(cached.status, 'ready');
    assert.equal(cached.cached, true);
    assert.equal(calls, callsBefore);

    const testResult = await testSiliconFlow({ endpoint, model: 'fnlp/MOSS-TTSD-v0.5', voice: 'fnlp/MOSS-TTSD-v0.5:alex' });
    assert.equal(testResult.ok, true, testResult.error ?? '');
    assert.ok(testResult.bytes > 0);
    assert.equal(requests.at(-1).headers.authorization, 'Bearer env-silicon-key');

    const overridden = await saveTtsConfig({ siliconflow: { apiKey: 'config-silicon-key' } });
    assert.equal(overridden.siliconflow.apiKeySource, 'config');
    const testOverride = await testSiliconFlow({ endpoint });
    assert.equal(testOverride.ok, true, testOverride.error ?? '');
    assert.equal(requests.at(-1).headers.authorization, 'Bearer config-silicon-key');

    await saveTtsConfig({
      siliconflow: {
        model: 'FunAudioLLM/CosyVoice2-0.5B',
        voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
      },
    });
    const cosy = await testSiliconFlow({ endpoint });
    assert.equal(cosy.ok, true, cosy.error ?? '');
    const cosyRequest = requests.at(-1);
    assert.equal(cosyRequest.body.model, 'FunAudioLLM/CosyVoice2-0.5B');
    assert.equal(cosyRequest.body.voice, 'FunAudioLLM/CosyVoice2-0.5B:alex');
    assert.ok(!cosyRequest.body.input.includes('[S1]'), 'CosyVoice2 should get plain text');
    assert.ok(!cosyRequest.body.input.includes('[S2]'), 'CosyVoice2 should get plain text');
    assert.ok(cosyRequest.body.input.includes('连接测试'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.SILICON_FLOW_API_KEY;
    await rm(dir, { recursive: true, force: true });
  }
});
