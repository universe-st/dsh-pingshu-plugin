import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBook, detectFormatFromBuffer } from '../lib/parse.js';
import { splitChapters, resplitByMarkers } from '../lib/chapters.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

test('EPUB with nav: chapters come from the table of contents', async () => {
  const buffer = new Uint8Array(await readFile(join(root, 'sample.epub')));
  assert.equal(detectFormatFromBuffer(buffer, 'sample.epub'), 'epub');
  const parsed = await parseBook(buffer, 'sample.epub');
  assert.equal(parsed.chapters.length, 3);
  assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ['第一回 桃园', '第二回 风波', '第三回 夜雨']);
  assert.ok(parsed.chapters[0].text.includes('桃园'));
  assert.ok(!parsed.chapters[0].text.startsWith('第一回'));
  assert.deepEqual(parsed.warnings, []);
});

test('EPUB without nav falls back to spine and warns', async () => {
  const buffer = new Uint8Array(await readFile(join(root, 'sample-no-toc.epub')));
  const parsed = await parseBook(buffer, 'sample-no-toc.epub');
  assert.equal(parsed.chapters.length, 3);
  assert.ok(parsed.warnings.some((warning) => warning.includes('目录')));
});

test('PDF uses font-size headings when there is no outline', async () => {
  const buffer = new Uint8Array(await readFile(join(root, 'sample.pdf')));
  assert.equal(detectFormatFromBuffer(buffer, 'sample.pdf'), 'pdf');
  const parsed = await parseBook(buffer, 'sample.pdf');
  assert.equal(parsed.chapters.length, 3);
  assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ['Chapter 1', 'Chapter 2', 'Chapter 3']);
  assert.ok(parsed.chapters[0].text.includes('body of chapter 1'));
});

test('TXT / MD split on Chinese headings', async () => {
  for (const name of ['sample.txt', 'sample.md']) {
    const buffer = new Uint8Array(await readFile(join(root, name)));
    const parsed = await parseBook(buffer, name);
    assert.equal(parsed.chapters.length, 3, name);
    assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ['第一回 桃园', '第二回 风波', '第三回 夜雨'], name);
  }
});

test('splitChapters falls back to paragraph chunks', () => {
  const text = Array.from({ length: 120 }, (_, index) => `第${index + 1}段，这是一段没有标题的正文。`).join('\n\n');
  const chapters = splitChapters({ text, targetChars: 400 });
  assert.ok(chapters.length >= 2);
  assert.ok(chapters.every((chapter) => chapter.chars > 0));
  assert.ok(chapters[0].title.startsWith('第 '));
});

test('resplitByMarkers accepts unique ordered markers and rejects duplicates', () => {
  const text = '第一回 甲\n\n甲的内容。\n\n第二回 乙\n\n乙的内容。\n\n第三回 丙\n\n丙的内容。';
  const ok = resplitByMarkers(text, [
    { title: '第一回 甲', start: '第一回 甲' },
    { title: '第二回 乙', start: '第二回 乙' },
    { title: '第三回 丙', start: '第三回 丙' },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.chapters.length, 3);
  const bad = resplitByMarkers('重复\n\n重复', [
    { title: '一', start: '重复' },
    { title: '二', start: '重复' },
  ]);
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('不唯一'));
});
