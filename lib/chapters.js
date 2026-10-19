/**
 * 回目切分。
 *
 * 原则：先用书自带的目录/标题（EPUB TOC、PDF 书签、TXT 标题行）做确定性切分；
 * 找不到就按段落边界切成固定长度的「第 N 节」，保证后续一定能读、能讲。
 * AI 只在切分明显错误时通过 resplitByMarkers 介入。
 */
import { countChars } from './store.js';

export const DEFAULT_CHUNK_CHARS = 8000;

const CHAPTER_RE = /^\s*(第[零一二三四五六七八九十百千万两0-9０-９]+[回章节卷部篇集])(?:[\s、.．:：\-—]+.*)?$/u;
const SPECIAL_RE = /^\s*(序|序言|自序|前言|楔子|引子|后记|尾声|附录|目录|凡例)(?:[\s、.．:：\-—]+.*)?$/u;
const EN_RE = /^\s*(Chapter|CHAPTER|Part|PART)\s+[0-9IVXLCivxlc]+(?:[\s.:：\-—]+.*)?$/u;
const NUM_RE = /^\s*[0-9０-９]{1,4}[.、．]\s*\S.{0,60}$/u;
const MD_RE = /^\s{0,3}(#{1,2})\s+(.+?)\s*#*\s*$/u;

export function chapterId(index) {
  return `ch-${String(index).padStart(6, '0')}`;
}

/** 统一换行、去掉控制字符、压掉超过两个的连续空行，但保留段落。 */
export function normalizeText(input) {
  return String(input ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u0000/gu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function normalizeTitle(raw) {
  return String(raw ?? '')
    .replace(/^#{1,6}\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160);
}

function looksLikeHeading(line) {
  const text = String(line ?? '').trim();
  if (text === '' || text.length > 80) return false;
  if (CHAPTER_RE.test(text) || SPECIAL_RE.test(text) || EN_RE.test(text)) return true;
  if (NUM_RE.test(text) && text.length <= 40) return true;
  return false;
}

/**
 * 从整段文本里找标题行，返回偏移与标题。
 * `fontHeadings` 来自 PDF 解析器（字号/书签），优先于正则。
 */
export function detectHeadings(text, fontHeadings = []) {
  if (Array.isArray(fontHeadings) && fontHeadings.length >= 2) {
    return fontHeadings
      .filter((entry) => Number.isFinite(entry.start) && entry.start >= 0 && entry.start < text.length)
      .map((entry) => ({
        title: normalizeTitle(entry.title),
        start: entry.start,
        contentStart: Number.isFinite(entry.contentStart) ? entry.contentStart : entry.start,
        source: entry.source,
      }))
      .filter((entry) => entry.title !== '')
      .sort((a, b) => a.start - b.start);
  }

  const headings = [];
  let offset = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    const md = MD_RE.exec(line);
    if (md) {
      headings.push({ title: normalizeTitle(md[2]), start: lineStart, contentStart: offset, source: 'md' });
      continue;
    }
    if (!looksLikeHeading(line)) continue;
    let title = normalizeTitle(line);
    let contentStart = offset;
    // 「第一回」单独一行、下一行是回目名：合并。
    if (/^第[零一二三四五六七八九十百千万两0-9０-９]+[回章节卷部篇集]$/u.test(title) && i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      if (next !== '' && next.length <= 48 && !looksLikeHeading(next) && !/[。！？；]$/u.test(next)) {
        title = `${title} ${next}`;
        contentStart = offset + lines[i + 1].length + 1;
      }
    }
    headings.push({ title, start: lineStart, contentStart, source: 'heading' });
  }
  return headings.sort((a, b) => a.start - b.start);
}

function cleanBody(text, title) {
  let body = String(text ?? '')
    .replace(/<!--\s*pingshu:[\s\S]*?-->/gu, '')
    .replace(/\u0000/gu, '')
    .trim();
  const firstLine = body.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine !== '' && (firstLine === title || normalizeTitle(firstLine) === title)) {
    body = body.slice(firstLine.length).replace(/^\n+/u, '');
  }
  return body.trim();
}

function buildChapter(index, title, body, source) {
  const text = cleanBody(body, title);
  const chars = countChars(text);
  return {
    index,
    id: chapterId(index),
    title: normalizeTitle(title) || `第 ${index} 节`,
    text,
    chars,
    source: source ?? null,
  };
}

/** 按标题偏移切片；标题之前的短前言并进第一章，长前言单独成「卷首」。 */
export function chaptersFromHeadings(text, headings, { includePreamble = true } = {}) {
  const usable = headings.filter((entry) => entry.title !== '' && entry.start < text.length);
  if (usable.length === 0) return [];
  const chapters = [];
  const first = usable[0];
  const preamble = text.slice(0, first.start).trim();
  let index = 1;
  if (includePreamble && countChars(preamble) >= 200) {
    chapters.push(buildChapter(index, '卷首', preamble, first.source));
    index += 1;
  }
  for (let i = 0; i < usable.length; i += 1) {
    const current = usable[i];
    const end = i + 1 < usable.length ? usable[i + 1].start : text.length;
    const start = Math.min(current.contentStart ?? current.start, end);
    const body = text.slice(start, end);
    if (countChars(body) < 2 && i + 1 < usable.length) continue;
    chapters.push(buildChapter(index, current.title, body, current.source));
    index += 1;
  }
  return chapters.filter((chapter) => chapter.chars > 0 || chapter.text.trim() !== '');
}

function splitLongParagraph(paragraph, targetChars) {
  if (countChars(paragraph) <= targetChars * 1.4) return [paragraph];
  const sentences = paragraph.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? [paragraph];
  const parts = [];
  let buffer = '';
  for (const sentence of sentences) {
    if (countChars(buffer + sentence) > targetChars && buffer !== '') {
      parts.push(buffer.trim());
      buffer = sentence;
    } else {
      buffer += sentence;
    }
  }
  if (buffer.trim() !== '') parts.push(buffer.trim());
  return parts.length > 0 ? parts : [paragraph];
}

/** 无标题时的兜底：按段落累计到目标字数，尽量不切断段落。 */
export function chunkByParagraphs(text, targetChars = DEFAULT_CHUNK_CHARS) {
  const paragraphs = String(text ?? '')
    .split(/\n{2,}/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const chunks = [];
  let buffer = [];
  let size = 0;
  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push(buffer.join('\n\n'));
    buffer = [];
    size = 0;
  };
  for (const paragraph of paragraphs) {
    const pieces = splitLongParagraph(paragraph, targetChars);
    for (const piece of pieces) {
      const pieceChars = countChars(piece);
      if (size > 0 && size + pieceChars > targetChars) flush();
      buffer.push(piece);
      size += pieceChars;
    }
  }
  flush();
  if (chunks.length === 0) chunks.push(String(text ?? ''));
  return chunks.map((chunk, index) => buildChapter(index + 1, `第 ${index + 1} 节`, chunk));
}

export function splitChapters({ text, headings = [], targetChars = DEFAULT_CHUNK_CHARS, includePreamble = true } = {}) {
  const normalized = normalizeText(text);
  if (normalized === '') return [];
  const usable = Array.isArray(headings) ? headings : [];
  const detected = detectHeadings(normalized, usable);
  if (detected.length >= 2) {
    return chaptersFromHeadings(normalized, detected, { includePreamble });
  }
  return chunkByParagraphs(normalized, targetChars);
}

/**
 * 用 markers 重新分章。markers 是每回正文开头的一段原文，必须在全文里唯一且按顺序出现。
 * 返回 { ok:true, chapters } 或 { ok:false, error, marker?, occurrences? }。
 */
export function resplitByMarkers(text, markers) {
  const normalized = normalizeText(text);
  if (!Array.isArray(markers) || markers.length < 2) {
    return { ok: false, error: '至少需要两个 markers（每回一个）才能重新分章' };
  }
  const positions = [];
  for (let i = 0; i < markers.length; i += 1) {
    const raw = markers[i] ?? {};
    const marker = String(raw.start ?? raw.marker ?? '').trim();
    const title = normalizeTitle(raw.title ?? '');
    if (marker === '') return { ok: false, error: `第 ${i + 1} 个 marker 为空` };
    if (title === '') return { ok: false, error: `第 ${i + 1} 个 marker 缺少 title` };
    let first = normalized.indexOf(marker);
    if (first < 0) return { ok: false, error: `找不到 marker：${marker.slice(0, 60)}`, marker };
    if (normalized.indexOf(marker, first + 1) >= 0) {
      let count = 0;
      let cursor = 0;
      while (cursor < normalized.length) {
        const found = normalized.indexOf(marker, cursor);
        if (found < 0) break;
        count += 1;
        cursor = found + marker.length;
      }
      return { ok: false, error: `marker 不唯一（出现 ${count} 次），请换更长的一段：${marker.slice(0, 60)}`, marker, occurrences: count };
    }
    positions.push({ start: first, title, marker, source: raw.source });
  }
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i].start <= positions[i - 1].start) {
      return { ok: false, error: `markers 顺序不对：第 ${i + 1} 个在第 ${i} 个之前` };
    }
  }
  const chapters = [];
  let index = 1;
  const preamble = normalized.slice(0, positions[0].start).trim();
  if (countChars(preamble) >= 200) {
    chapters.push(buildChapter(index, '卷首', preamble));
    index += 1;
  }
  for (let i = 0; i < positions.length; i += 1) {
    const current = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : normalized.length;
    const body = normalized.slice(current.start, end);
    chapters.push(buildChapter(index, current.title, body, current.source));
    index += 1;
  }
  return { ok: true, chapters };
}

/** 从章节正文生成用于重新分章的候选 marker（第一行/第一段前 80 字）。 */
export function markerOf(chapterText) {
  const first = String(chapterText ?? '').trim().split('\n', 1)[0]?.trim() ?? '';
  return [...first].slice(0, 80).join('');
}
