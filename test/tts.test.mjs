import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectRecord, writeChapters, savePerformance } from '../lib/store.js';
import {
  buildChunks,
  buildSpeakerMap,
  getTtsConfig,
  getTtsJob,
  parseScriptBlocks,
  saveTtsConfig,
  startTtsJob,
  testTts,
  uploadTtsReference,
  ttsCacheRoot,
  audioFile,
} from '../lib/tts.js';

function makeWav(seconds = 0.2, sampleRate = 16000) {
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

test('MOSS-TTSD host flow: config, reference upload, chunked synthesis, cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingshu-tts-'));
  process.env.PINGSHU_DATA_DIR = dir;
  const wav = makeWav();
  let generateCalls = 0;
  let lastPayload = null;
  const payloads = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.statusCode = 200;
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/generate') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        generateCalls += 1;
        lastPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        payloads.push(lastPayload);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ text: wav.toString('base64') }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/generate`;
  try {
    const ref = await uploadTtsReference({ kind: 'narrator', name: 'ref.wav', data: wav.toString('base64') });
    assert.equal(ref.format, 'wav');
    assert.ok(ref.file.startsWith('refs/'));

    const config = await saveTtsConfig({
      provider: 'moss',
      moss: {
        endpoint,
        narrator: { file: ref.file, text: '这是叙述者的参考音频。' },
        character: { file: '', text: '' },
        maxNewTokens: 2048,
        chunkChars: 300,
      },
    });
    assert.equal(config.provider, 'moss');
    assert.equal(config.moss.endpoint, endpoint);

    const project = await createProjectRecord({ title: 'TTS 测试书', filename: 'x.epub' });
    await writeChapters(project.id, [{ index: 1, id: 'ch-000001', title: '第一回', text: '正文。', chars: 2 }], '正文。');
    const script = [
      '# 第一回 测试',
      '',
      '## 开场',
      '【说书人】各位听众，今天咱们讲一个测试故事。这个故事不长，可是人物不少，咱们慢慢说。',
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
      '【角色：张三】行，那就再等等。可我把丑话说在前头，出了事，你别后悔。',
      '【说书人】李四没接话，只是把茶碗往桌上一放，发出轻轻的一声响。',
      '',
      '## 扣子',
      '【说书人】三个人在屋里你看看我，我看看你，谁也不肯先露底。欲知后事如何，且听下回分解。',
    ].join('\n');
    await savePerformance(project.id, 'ch-000001', script, { style: '传统评书' });

    const blocks = parseScriptBlocks(script);
    const { chunks, tags } = buildChunks(blocks, { chunkChars: 300 });
    assert.ok(blocks.length >= 4);
    assert.ok(chunks.length >= 2);
    assert.ok(tags.includes('S2'), 'character should map to S2');
    const speakerMap = buildSpeakerMap(blocks);
    assert.equal(speakerMap.map.get('角色：张三'), 'S2');
    assert.equal(speakerMap.map.get('说书人'), 'S1');

    const health = await testTts(endpoint);
    assert.equal(health.ok, true);

    const started = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'moss' });
    assert.equal(started.provider, 'moss');
    assert.ok(started.total >= 2);
    let job = await getTtsJob(started.jobId);
    for (let i = 0; i < 80 && job.status !== 'ready' && job.status !== 'error'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = await getTtsJob(started.jobId);
    }
    assert.equal(job.status, 'ready', job.error ?? '');
    assert.equal(job.chunks.length, started.total);
    assert.ok(job.chunks.every((chunk) => chunk.url.startsWith('/dsh-pingshu/audio/')));
    assert.ok(generateCalls >= 2);
    assert.ok(lastPayload.text.includes('[S1]'));
    assert.ok(payloads.some((payload) => payload.text.includes('[S2]')), 'at least one chunk should include the character tag');
    assert.ok(Array.isArray(lastPayload.audio_data));
    assert.ok(lastPayload.audio_data[0].startsWith('data:audio/'));

    const file = await audioFile(started.jobId, '0.wav');
    assert.ok(file);
    const info = await stat(file.path);
    assert.ok(info.size > 44);

    const callsBefore = generateCalls;
    const cached = await startTtsJob({ projectId: project.id, chapterId: 'ch-000001', provider: 'moss' });
    assert.equal(cached.status, 'ready');
    assert.equal(cached.cached, true);
    assert.equal(generateCalls, callsBefore, 'cache should avoid a second synthesis');
    assert.equal((await getTtsConfig()).provider, 'moss');
    assert.ok(ttsCacheRoot().includes('cache'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
