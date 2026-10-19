import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuide, buildAnalysisPrompt, buildPerformancePrompt, normalizePerformanceOptions } from '../lib/prompts.js';

const project = {
  id: 'b000000000001',
  title: '测试书',
  author: '作者',
  charCount: 1000,
  chapters: [{ id: 'ch-000001', index: 1, title: '第一回', chars: 500 }],
};
const chapter = project.chapters[0];

test('guides contain the pingshu method keywords', async () => {
  const performance = await loadGuide('performance');
  for (const keyword of ['定场诗', '扣子', '开脸儿', '摆砌末', '倒插笔', '花开两朵', '且听下回分解', '翻译腔', '现代类比', '名词解释']) {
    assert.ok(performance.markdown.includes(keyword), `performance guide missing ${keyword}`);
  }
  const analysis = await loadGuide('analysis');
  for (const keyword of ['章节摘要', '全书概要', '人物', '时间线', '背景', '术语']) {
    assert.ok(analysis.markdown.includes(keyword), `analysis guide missing ${keyword}`);
  }
  const all = await loadGuide('all');
  assert.ok(all.markdown.length > performance.markdown.length);
});

test('performance prompt includes ids, options and save instructions', () => {
  const prompt = buildPerformancePrompt(project, chapter, { style: '少儿版', explanation: '详细', notes: '多讲官职' });
  assert.ok(prompt.includes(project.id));
  assert.ok(prompt.includes(chapter.id));
  assert.ok(prompt.includes('pingshu_get_guide'));
  assert.ok(prompt.includes('pingshu_get_dossier'));
  assert.ok(prompt.includes('pingshu_save_performance'));
  assert.ok(prompt.includes('不设字数'));
  assert.ok(prompt.includes('完整讲完'));
  assert.ok(prompt.includes('格言'));
  assert.ok(prompt.includes('少儿版'));
  assert.ok(prompt.includes('多讲官职'));
});

test('analysis prompt asks for batches and saving as you go', () => {
  const prompt = buildAnalysisPrompt(project, {});
  assert.ok(prompt.includes('pingshu_analysis_status'));
  assert.ok(prompt.includes('pingshu_analysis_batches'));
  assert.ok(prompt.includes('subagent'));
  assert.ok(prompt.includes('一次做完'));
  assert.ok(prompt.includes('pingshu_save_chapter_summary'));
  assert.ok(prompt.includes('pingshu_save_dossier'));
  assert.ok(prompt.includes('等用户说“继续”') === false);
  const focus = buildAnalysisPrompt(project, { focus: 'characters', instruction: '重点写曹操' });
  assert.ok(focus.includes('全书层面'));
  assert.ok(focus.includes('重点写曹操'));
});

test('performance options normalize unknown values', () => {
  assert.deepEqual(normalizePerformanceOptions({ durationMinutes: 99, style: '乱写', explanation: '很多' }), {
    style: '传统评书',
    explanation: '适中',
    notes: '',
  });
});
