import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitChapters,
  adjustChapters,
  inspectChapterSplit,
} from '../lib/chapters.js';
import { stripSiteBoilerplate } from '../lib/parse/text.js';

function filler(label, paragraphs = 90) {
  return Array.from({ length: paragraphs }, (_, index) => `${label}正文第${index + 1}段，这一段用来把正文撑到目录残片不可能有的长度。`).join('\n\n');
}

function tocBook() {
  return [
    '书评：这是一本用来测试分章的书。',
    '',
    '小＿说txt天堂',
    '',
    '宇宙目录',
    '',
    '序 怀念作者',
    '',
    '引　言',
    '',
    '第一章 起点',
    '',
    '第一章提要，只有一小段。',
    '',
    '第二章 继续',
    '',
    '第二章提要，只有一小段。',
    '',
    '附录1 附录甲',
    '',
    '附录2 附录乙',
    '',
    'www.xiaoshuotxt.com',
    '',
    '序 怀念作者',
    '',
    filler('序'),
    '',
    '引　言',
    '',
    filler('引言'),
    '',
    '第一章　起点',
    '',
    filler('第一章'),
    '',
    '第二章 继续',
    '',
    filler('第二章前半'),
    '',
    '第二章 继续-1',
    '',
    filler('第二章中段'),
    '',
    '第二章 继续-2',
    '',
    filler('第二章后半'),
    '',
    '附录1 附录甲',
    '',
    filler('附录甲'),
    '',
    '附录2 附录乙',
    '',
    filler('附录乙'),
  ].join('\n');
}

test('TXT 目录块被丢掉，正文里的重复标题保留', () => {
  const chapters = splitChapters({ text: tocBook() });
  assert.deepEqual(chapters.map((chapter) => chapter.title), [
    '序 怀念作者',
    '引言',
    '第一章 起点',
    '第二章 继续',
    '附录1 附录甲',
    '附录2 附录乙',
  ]);
  assert.ok(chapters[0].chars > 1000);
  assert.ok(chapters[3].text.includes('第二章中段'));
  assert.ok(!chapters[3].text.includes('第二章 继续-1'));
  assert.ok(!chapters[3].text.includes('第二章 继续-2'));
});

test('adjustChapters 支持 drop / merge / split', () => {
  const raw = '第一章 甲\n\n甲的前半段。\n\n第二部分 后半段\n\n后半段内容。\n\n第二章 乙\n\n乙正文。';
  const chapters = splitChapters({ text: raw });
  assert.equal(chapters.length, 2);
  const split = adjustChapters({
    fullText: raw,
    chapters,
    ops: [{ kind: 'split', chapterId: chapters[0].id, marker: '第二部分 后半段', title: '第二部分 后半段' }],
  });
  assert.equal(split.ok, true);
  assert.deepEqual(split.chapters.map((chapter) => chapter.title), ['第一章 甲', '第二部分 后半段', '第二章 乙']);
  assert.ok(!split.chapters[1].text.startsWith('第二部分'));

  const merged = adjustChapters({
    fullText: raw,
    chapters,
    ops: [{ kind: 'merge', chapterId: chapters[0].id, toChapterId: chapters[1].id, title: '第一章 合并' }],
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.chapters.length, 1);
  assert.equal(merged.chapters[0].title, '第一章 合并');
  assert.ok(merged.chapters[0].text.includes('乙正文'));

  const dropped = adjustChapters({
    fullText: raw,
    chapters,
    ops: [{ kind: 'drop', chapterId: chapters[0].id }],
  });
  assert.equal(dropped.ok, true);
  assert.equal(dropped.chapters.length, 1);
  assert.equal(dropped.chapters[0].title, '第二章 乙');
});

test('adjustChapters 能对同一回连续 split 多次', () => {
  const raw = '第一章 甲\n\n开头。\n\n第一部分 一\n\n一的内容。\n\n第二部分 二\n\n二的内容。\n\n第二章 乙\n\n乙正文。';
  const chapters = splitChapters({ text: raw });
  assert.equal(chapters.length, 2);
  const result = adjustChapters({
    fullText: raw,
    chapters,
    ops: [
      { kind: 'split', chapterId: chapters[0].id, marker: '第一部分 一', title: '第一部分 一' },
      { kind: 'split', chapterId: chapters[0].id, marker: '第二部分 二', title: '第二部分 二' },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.chapters.map((chapter) => chapter.title), ['第一章 甲', '第一部分 一', '第二部分 二', '第二章 乙']);
});

test('inspectChapterSplit 能指出目录残片、拆回和未切开的附录', () => {
  const report = inspectChapterSplit([
    { id: 'ch-000001', index: 1, title: '第一章 起点', text: '第一章提要。', chars: 6 },
    { id: 'ch-000002', index: 2, title: '第一章 起点', text: filler('正文'), chars: 5000 },
    { id: 'ch-000003', index: 3, title: '第二章 继续-1', text: filler('前半'), chars: 3000 },
    { id: 'ch-000004', index: 4, title: '第二章 继续-2', text: filler('后半'), chars: 3000 },
    {
      id: 'ch-000005',
      index: 5,
      title: '第三章 收尾',
      text: `收尾正文。\n\n附录1 附录甲\n\n${filler('附录')}`,
      chars: 5000,
    },
  ]);
  const kinds = report.issues.map((issue) => issue.kind);
  assert.ok(kinds.includes('toc-fragment'));
  assert.ok(kinds.includes('split-continuation'));
  assert.ok(kinds.includes('unsplit-appendix'));
  const opKinds = report.suggestedOps.map((op) => op.kind);
  assert.ok(opKinds.includes('drop'));
  assert.ok(opKinds.includes('merge'));
  assert.ok(opKinds.includes('split'));
});

test('stripSiteBoilerplate 只删站点横幅，不删正文', () => {
  const cleaned = stripSiteBoilerplate('正文第一段。\n小＿说txt天堂\nwww.xiaoshuotＸt，coＭ\n正文第二段。');
  assert.equal(cleaned, '正文第一段。\n正文第二段。');
});

test('inspectChapterSplit 能发现混在序里的引言标题', () => {
  const report = inspectChapterSplit([
    { id: 'ch-000001', index: 1, title: '序 怀念作者', text: `${filler('序')}\n\n引　言\n\n${filler('引言')}`, chars: 9000 },
  ]);
  const issue = report.issues.find((entry) => entry.kind === 'unsplit-heading');
  assert.ok(issue);
  assert.equal(issue.marker, '引　言');
  assert.deepEqual(report.suggestedOps[0], { kind: 'split', chapterId: 'ch-000001', marker: '引　言', title: '引言' });
});
