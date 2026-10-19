/**
 * 按格式分派解析，并统一成 {chapters, fullText, warnings}。
 */
import { extname } from 'node:path';
import { chapterId, normalizeText, splitChapters } from './chapters.js';
import { countChars } from './store.js';
import { parseEpub } from './parse/epub.js';
import { parsePdf } from './parse/pdf.js';
import { parsePlainText } from './parse/text.js';

export function detectFormatFromBuffer(buffer, filename = '') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'epub';
  const ext = extname(String(filename ?? '')).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.epub') return 'epub';
  if (ext === '.txt') return 'txt';
  if (ext === '.md' || ext === '.markdown') return 'md';
  return 'unknown';
}

function titleFromFilename(filename) {
  const base = String(filename ?? '').split(/[\\/]/u).pop() ?? '';
  return base.replace(/\.[^.]+$/u, '').trim();
}

function normalizeChapterList(chapters) {
  const output = [];
  for (const chapter of chapters) {
    let text = normalizeText(chapter.text);
    if (text === '') continue;
    const index = output.length + 1;
    const title = String(chapter.title ?? '').trim().slice(0, 160) || `第 ${index} 节`;
    const firstLine = text.split('\n', 1)[0]?.replace(/^#\s+/u, '').trim() ?? '';
    if (firstLine !== '' && (firstLine === title || firstLine === title.replace(/^#\s+/u, ''))) {
      text = text.slice(text.indexOf('\n') + 1).replace(/^\n+/u, '').trim();
    }
    output.push({
      index,
      id: chapterId(index),
      title,
      text,
      chars: countChars(text),
      source: chapter.source ?? null,
    });
  }
  return output;
}

export async function parseBook(buffer, filename = '') {
  const format = detectFormatFromBuffer(buffer, filename);
  if (format === 'unknown') {
    throw new Error('不支持的文件格式；请上传 EPUB、PDF、TXT 或 Markdown');
  }
  if (format === 'epub') {
    const parsed = await parseEpub(buffer);
    const chapters = normalizeChapterList(parsed.chapters);
    if (chapters.length === 0) throw new Error('EPUB 里没有解析到正文');
    return {
      format,
      title: parsed.title || titleFromFilename(filename),
      author: parsed.author || '',
      language: parsed.language || 'zh',
      chapters,
      fullText: chapters.map((chapter) => chapter.text).join('\n\n'),
      warnings: parsed.warnings ?? [],
    };
  }
  if (format === 'pdf') {
    const parsed = await parsePdf(buffer);
    const chapters = normalizeChapterList(splitChapters({ text: parsed.text, headings: parsed.headings }));
    if (chapters.length === 0) throw new Error('PDF 里没有切出可用回目');
    return {
      format,
      title: parsed.title || titleFromFilename(filename),
      author: parsed.author || '',
      language: parsed.language || 'zh',
      chapters,
      fullText: normalizeText(parsed.text),
      warnings: parsed.warnings ?? [],
    };
  }
  const parsed = parsePlainText(buffer, format);
  const chapters = normalizeChapterList(splitChapters({ text: parsed.text }));
  if (chapters.length === 0) throw new Error('文件里没有切出可用回目');
  return {
    format,
    title: parsed.title || titleFromFilename(filename),
    author: parsed.author || '',
    language: parsed.language || 'zh',
    chapters,
    fullText: normalizeText(parsed.text),
    warnings: parsed.warnings ?? [],
  };
}
