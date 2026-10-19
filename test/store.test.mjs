import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBook } from '../lib/parse.js';
import {
  createProjectRecord,
  writeChapters,
  savePerformance,
  listPerformances,
  getPerformance,
  deletePerformance,
  readProject,
  deleteProjectRecord,
} from '../lib/store.js';
import {
  getProjectView,
  saveChapterSummary,
  saveDossier,
  analysisStatus,
  getDossier,
  getAnalysis,
  repairProject,
  resolveQuery,
} from '../lib/dossier.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

test('project → chapters → analysis → performance lifecycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingshu-test-'));
  process.env.PINGSHU_DATA_DIR = dir;
  try {
    const buffer = new Uint8Array(await readFile(join(root, 'sample.epub')));
    const parsed = await parseBook(buffer, 'sample.epub');
    const project = await createProjectRecord({ title: '生命周期测试', author: '作者', filename: 'sample.epub' });
    await writeChapters(project.id, parsed.chapters, parsed.fullText, parsed.warnings);
    let view = await getProjectView(project.id, { scan: true });
    assert.equal(view.status, 'ready');
    assert.equal(view.chapters.length, 3);
    assert.equal(view.chapterCount, 3);

    const chapter = view.chapters[0];
    const summary = '这一回讲的是桃园相会，三个人各有心思。'.repeat(12);
    const saved = await saveChapterSummary(project.id, chapter.id, summary, {
      characters: ['张三', '李四'],
      terms: ['桃园'],
      events: [{ when: '早年', event: '三人相会' }],
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.progress.done, 1);

    const status = await analysisStatus(project.id);
    assert.equal(status.chapterSummaries.done, 1);
    assert.equal(status.chapterSummaries.missingCount, 2);
    assert.ok(status.dossier.missing.includes('bookSummary'));

    const dossierSaved = await saveDossier(project.id, {
      bookSummary: '全书概要。'.repeat(40),
      characters: [{ name: '张三', aliases: ['张老三'], role: '主角', profile: '张三的小传。' }],
      timeline: [{ when: '第一年', event: '相会', chapter: '第一回' }],
      glossary: [{ term: '桃园', category: '地点', explanation: '桃树园子', analogy: '像村口的大槐树' }],
      context: '这是测试背景。',
    });
    assert.equal(dossierSaved.ok, true);
    assert.equal(dossierSaved.counts.characters, 1);
    assert.equal(dossierSaved.counts.glossary, 1);

    const dossier = await getDossier(project.id, chapter.id);
    assert.equal(dossier.characters[0].name, '张三');
    assert.equal(dossier.glossary[0].term, '桃园');
    assert.ok(dossier.bookSummary.text.includes('全书概要'));

    const analysis = await getAnalysis(project.id, { kind: 'book' });
    assert.ok(analysis.content.includes('全书概要'));
    const character = await getAnalysis(project.id, { kind: 'character', name: '张老三' });
    assert.ok(character.content.includes('张三'));

    const script = `# ${chapter.title}\n\n## 开场\n【说书人】各位听众，今天讲一个测试故事。\n\n## 正文\n【角色：张三】咱们走吧。\n\n## 扣子\n【说书人】欲知后事如何，且听下回分解。`.repeat(8);
    const performance = await savePerformance(project.id, chapter.id, script, { style: '传统评书', durationMinutes: 25 });
    assert.equal(performance.versionId, 'v1');
    assert.ok(performance.chars > 200);
    const second = await savePerformance(project.id, chapter.id, script, { style: '轻松幽默' });
    assert.equal(second.versionId, 'v2');
    assert.equal((await listPerformances(project.id)).items.length, 2);
    assert.equal((await getPerformance(project.id, chapter.id)).meta.versionId, 'v2');
    assert.equal((await getPerformance(project.id, chapter.id, 'v1')).meta.versionId, 'v1');

    const repaired = await repairProject(project.id);
    assert.equal(repaired.chapters[0].summary, true);
    assert.equal(repaired.chapters[0].performances, 2);

    const resolved = await resolveQuery('桃子', { limit: 5 });
    assert.ok(Array.isArray(resolved.chapters));

    await deletePerformance(project.id, chapter.id, 'v1');
    assert.equal((await listPerformances(project.id, chapter.id)).items.length, 1);
    const current = await readProject(project.id);
    assert.equal(current.performanceCount, 1);

    await deleteProjectRecord(project.id);
    await assert.rejects(() => readProject(project.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
