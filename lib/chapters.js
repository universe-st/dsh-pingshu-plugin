/**
 * 回目切分。
 *
 * 原则：先用书自带的目录/标题（EPUB TOC、PDF 书签、TXT 标题行）做确定性切分；
 * 找不到就按段落边界切成固定长度的「第 N 节」，保证后续一定能读、能讲。
 *
 * 网络 TXT 常见的三类坑在这里统一处理：
 * 1. 正文前先列一遍「目录/提要」，同一批标题在正文里又出现一次 —— 前面的目录行必须丢掉；
 * 2. 同一回被网站拆成「第七章 xxx-1」「第七章 xxx-2」—— 要合并回一回；
 * 3. 附录、引言这类标题不在「第 X 章」的格式里 —— 也要认出边界。
 *
 * 自动规则拿不准时，对话里的 AI 可以用 inspectChapterSplit / adjustChapters
 * 做「先体检、再按操作调整」，不用整本重来。
 */
import { countChars } from './store.js';

export const DEFAULT_CHUNK_CHARS = 8000;
/** 目录/提要残片一般很短；超过这个长度就不当目录行处理。 */
const TOC_BODY_MAX = 700;
/** 连续多少条「短且后面重复」的标题，才判定为目录块。 */
const TOC_RUN_MIN = 3;

const CHAPTER_RE = /^\s*(第[零一二三四五六七八九十百千万两0-9０-９]+[回章节卷部篇集])(?:[\s、.．:：\-—]+.*)?$/u;
const SPECIAL_RE = /^\s*(?:序|序言|自序|代序|译序|译者序|推荐序|前言|引言|引子|楔子|序章|导言|导读|后记|译后记|尾声|结束语|跋|致谢|参考文献|凡例|附录\s*[0-9０-９一二三四五六七八九十甲乙丙丁戊己庚辛壬癸]*)(?:[\s、.．:：\-—]+.*)?$/u;
const EN_RE = /^\s*(Chapter|CHAPTER|Part|PART)\s+[0-9IVXLCivxlc]+(?:[\s.:：\-—]+.*)?$/u;
const NUM_RE = /^\s*[0-9０-９]{1,4}[.、．]\s*\S.{0,60}$/u;
const MD_RE = /^\s{0,3}(#{1,2})\s+(.+?)\s*#*\s*$/u;
const TOC_LINE_RE = /^\s*(?:.{0,12}目\s*录|目\s*录|contents?|table\s+of\s+contents)\s*$/iu;
const PAGE_SPLIT_SUFFIX_RE = /[-－—–_]\s*\d+\s*$/u;
const PAGE_SPLIT_LINE_RE = /^\s*第[零一二三四五六七八九十百千万两0-9０-９]+[回章节卷部篇集].*[-－—–_]\s*\d+\s*$/u;

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

/**
 * 网络 TXT 常在章节之间塞一句「小＿说txt天堂 / www.xiaoshuotxt.com」。
 * 只删「短、且明显是站点横幅」的整行，不碰正文段落。
 */
const SITE_BANNER_RE = /xiaoshuo|小[＿_`\s]*说.{0,16}天.{0,3}堂|txt\s*小说\s*天堂/iu;

export function stripSiteBoilerplate(text) {
  const kept = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    const compact = trimmed.normalize('NFKC').replace(/\s+/gu, '');
    if (compact !== '' && trimmed.length <= 160 && SITE_BANNER_RE.test(compact)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function normalizeTitle(raw) {
  let title = String(raw ?? '')
    .replace(/^#{1,6}\s*/u, '')
    .replace(/[\t \u3000]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160);
  const compact = title.replace(/[\s\u3000]+/gu, '');
  // 「引　言」「目 录」这类词中间夹了全角空格，标题里去掉空格更好读。
  if (compact.length <= 12 && SPECIAL_RE.test(compact)) title = compact;
  return title;
}

/** 用于判断两个标题是不是同一回（忽略空白、全半角、网站分页后缀）。 */
export function chapterTitleKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^#{1,6}\s*/u, '')
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[-－—–_]\d+$/u, '')
    .replace(/[，,。.、；;：:！!？?]+$/u, '');
}

function isPageSplitTitle(title) {
  return PAGE_SPLIT_SUFFIX_RE.test(String(title ?? '').trim());
}

function stripPageSplitSuffix(title) {
  return normalizeTitle(String(title ?? '').replace(PAGE_SPLIT_SUFFIX_RE, ''));
}

function looksLikeHeading(line) {
  const text = String(line ?? '').trim();
  if (text === '' || text.length > 80) return false;
  const compact = text.replace(/[\s\u3000]+/gu, '');
  // 「目录」本身是目录标记，不是正文回目。
  if (/^(?:目录|contents|tableofcontents)$/iu.test(compact)) return false;
  if (CHAPTER_RE.test(text) || SPECIAL_RE.test(text) || EN_RE.test(text)) return true;
  if (compact !== text && compact.length <= 12 && SPECIAL_RE.test(compact)) return true;
  if (NUM_RE.test(text) && text.length <= 40) return true;
  return false;
}

function bodyLengthOf(text, headings, index) {
  const current = headings[index];
  const end = index + 1 < headings.length ? headings[index + 1].start : text.length;
  const start = Number.isFinite(current.contentStart) ? current.contentStart : current.start;
  return countChars(text.slice(Math.min(start, end), Math.max(start, end)));
}

/**
 * 丢掉正文前那份「目录/提要」。判断依据不是关键词，而是：
 * 同一标题在更后面又出现一次，且前面这一次的「正文」短得可疑。
 * 连续 3 条以上这种标题 → 整段都是目录；只有 2 条时要求附近有「目录」字样或位置很靠前。
 */
function suppressTableOfContents(text, headings) {
  if (headings.length < TOC_RUN_MIN) return headings;
  const entries = headings.map((heading, index) => ({
    heading,
    index,
    key: chapterTitleKey(heading.title),
    bodyChars: bodyLengthOf(text, headings, index),
  }));
  const lastIndexByKey = new Map();
  for (const entry of entries) lastIndexByKey.set(entry.key, entry.index);
  const duplicate = entries.map((entry) => {
    const last = lastIndexByKey.get(entry.key);
    if (last === undefined || last <= entry.index) return false;
    if (entry.bodyChars >= TOC_BODY_MAX) return false;
    const laterChars = bodyLengthOf(text, headings, last);
    return laterChars > Math.max(TOC_BODY_MAX, entry.bodyChars * 2);
  });
  const tocMarker = findTocMarkerOffset(text.slice(0, headings[0].start));
  const drop = new Set();
  let run = [];
  const flush = () => {
    if (run.length === 0) return;
    const first = entries[run[0]];
    const nearMarker = tocMarker >= 0 && first.heading.start >= tocMarker && first.heading.start - tocMarker < 20000;
    const veryEarly = first.heading.start < text.length * 0.15;
    if (run.length >= TOC_RUN_MIN || (run.length === 2 && (nearMarker || veryEarly))) {
      for (const index of run) drop.add(index);
    }
    run = [];
  };
  for (const entry of entries) {
    if (duplicate[entry.index]) run.push(entry.index);
    else flush();
  }
  flush();
  return headings.filter((_heading, index) => !drop.has(index));
}

/**
 * 同一回被网站拆成「-1」「-2」时合并回一条。
 * 只处理带数字后缀的相邻标题，避免把上下篇里同名的真回目误合。
 */
function mergeContinuationHeadings(headings) {
  const merged = [];
  for (const heading of headings) {
    const previous = merged[merged.length - 1];
    if (previous && (isPageSplitTitle(previous.title) || isPageSplitTitle(heading.title)) &&
      chapterTitleKey(previous.title) === chapterTitleKey(heading.title)) {
      merged[merged.length - 1] = {
        ...previous,
        title: stripPageSplitSuffix(previous.title),
        mergedCount: (previous.mergedCount ?? 1) + 1,
      };
      continue;
    }
    merged.push({ ...heading });
  }
  return merged;
}

/** 找正文前最后一个「目录」标记行的偏移；找不到返回 -1。 */
function findTocMarkerOffset(text) {
  let offset = 0;
  let found = -1;
  for (const line of String(text ?? '').split('\n')) {
    if (TOC_LINE_RE.test(line)) found = offset;
    offset += line.length + 1;
  }
  return found;
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
  const sorted = headings.sort((a, b) => a.start - b.start);
  return mergeContinuationHeadings(suppressTableOfContents(text, sorted));
}

function cleanBody(text, title) {
  let body = stripSiteBoilerplate(String(text ?? ''))
    .replace(/<!--\s*pingshu:[\s\S]*?-->/gu, '')
    .replace(/\u0000/gu, '')
    .trim();
  const firstLine = body.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine !== '' && (firstLine === title || normalizeTitle(firstLine) === title)) {
    body = body.slice(firstLine.length).replace(/^\n+/u, '');
  }
  // 被合并的「-1/-2」章节，第二段的标题行会留在正文中间，去掉。
  body = body.split('\n').filter((line) => !PAGE_SPLIT_LINE_RE.test(line)).join('\n');
  body = body.replace(/\n{3,}/gu, '\n\n');
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
  let preambleEnd = first.start;
  // 正文前若有「目录」块，卷首只保留目录之前的导读/书评，不把目录列表当正文。
  const tocMarker = findTocMarkerOffset(text.slice(0, preambleEnd));
  if (tocMarker >= 0) preambleEnd = tocMarker;
  const preamble = text.slice(0, preambleEnd).trim();
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

// ── AI 可调的分章调整 ─────────────────────────────────────────────────────

function locateChapterSegments(fullText, chapters) {
  const text = String(fullText ?? '');
  const segments = [];
  let cursor = 0;
  for (const chapter of chapters) {
    const body = String(chapter.text ?? '');
    let start = -1;
    const probes = [
      [...body].slice(0, 120).join('').trim(),
      [...body].slice(0, 48).join('').trim(),
      [...body].slice(0, 16).join('').trim(),
    ].filter((probe) => probe.length >= 6);
    for (const probe of probes) {
      const found = text.indexOf(probe, cursor);
      if (found >= 0) {
        start = found;
        break;
      }
    }
    if (start < 0 && chapter.title) {
      const title = String(chapter.title).trim();
      const found = text.indexOf(title, cursor);
      if (found >= 0) {
        start = found + title.length;
        // 标题行和正文之间通常隔着空行；跳过空白再定位正文开头。
        while (start < text.length && /\s/u.test(text[start])) start += 1;
      }
    }
    if (start < 0) {
      return { ok: false, error: `无法在全文里定位回目「${chapter.title ?? chapter.id}」，请改用 pingshu_resplit_chapters 重建` };
    }
    let end = Math.min(text.length, start + body.length);
    // 章节正文可能被清理过（例如合并 -1/-2 时删掉了中间那行标题），
    // 不能只靠 start + 字数定位结尾；用正文最后一段原文回锚更稳。
    const suffix = [...body].slice(-80).join('').trim();
    if (suffix.length >= 4) {
      const found = text.indexOf(suffix, start);
      if (found >= 0) end = Math.max(end, found + suffix.length);
    }
    end = Math.min(text.length, end);
    segments.push({ chapterId: chapter.id, title: chapter.title, start, end });
    cursor = Math.max(cursor, end, start + 1);
  }
  return { ok: true, segments };
}

/**
 * 在现有回目上做增量调整，不重传、不改原文。
 * ops 支持：
 * - { kind:'rename', chapterId, title }
 * - { kind:'drop', chapterId }
 * - { kind:'merge', chapterId, toChapterId, title? }
 * - { kind:'split', chapterId, marker, title, firstTitle? }
 */
export function adjustChapters({ fullText, chapters, ops = [] }) {
  const located = locateChapterSegments(fullText, chapters);
  if (!located.ok) return located;
  let items = located.segments.map((segment, index) => ({
    ...segment,
    rootId: segment.chapterId ?? `root-${index + 1}`,
    segmentId: segment.chapterId ?? `seg-${index + 1}`,
    aliases: [segment.chapterId ?? `seg-${index + 1}`],
  }));
  let created = 0;
  const indexOf = (id) => items.findIndex((item) => item.segmentId === id || item.chapterId === id || item.aliases?.includes(id));
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] ?? {};
    const kind = String(op.kind ?? '');
    const at = indexOf(String(op.chapterId ?? ''));
    if (at < 0) return { ok: false, error: `第 ${i + 1} 个操作找不到回目：${op.chapterId ?? ''}` };
    if (kind === 'rename') {
      items[at] = { ...items[at], title: normalizeTitle(op.title) || items[at].title };
      continue;
    }
    if (kind === 'drop') {
      items.splice(at, 1);
      continue;
    }
    if (kind === 'merge') {
      const to = indexOf(String(op.toChapterId ?? ''));
      if (to < 0) return { ok: false, error: `第 ${i + 1} 个操作找不到合并终点：${op.toChapterId ?? ''}` };
      if (to <= at) return { ok: false, error: `第 ${i + 1} 个操作只能向后合并（toChapterId 必须在 chapterId 之后）` };
      const first = items[at];
      const last = items[to];
      items.splice(at, to - at + 1, {
        ...first,
        title: normalizeTitle(op.title) || first.title,
        end: last.end,
        aliases: [...new Set([...(first.aliases ?? []), ...(last.aliases ?? [])])],
      });
      continue;
    }
    if (kind === 'split') {
      const marker = String(op.marker ?? '').trim();
      if (marker.length < 2) return { ok: false, error: `第 ${i + 1} 个 split 操作需要至少 2 个字的 marker` };
      const item = items[at];
      // 同一回可能被连续 split 成多段；在「同一原始回目」的全部分段里找 marker。
      const family = items.filter((entry) => entry.rootId === item.rootId).sort((a, b) => a.start - b.start);
      const familyStart = family[0].start;
      const familyEnd = family[family.length - 1].end;
      const slice = fullText.slice(familyStart, familyEnd);
      const first = slice.indexOf(marker);
      if (first < 0) return { ok: false, error: `第 ${i + 1} 个 split 操作在这一回里找不到 marker：${marker.slice(0, 40)}` };
      if (slice.indexOf(marker, first + 1) >= 0) {
        return { ok: false, error: `第 ${i + 1} 个 split 操作的 marker 在这一回里不唯一，请换更长的一段` };
      }
      const absolute = familyStart + first;
      const target = family.find((entry) => absolute >= entry.start && absolute < entry.end);
      if (!target) return { ok: false, error: `第 ${i + 1} 个 split 操作的 marker 落点不在这一回里` };
      if (absolute <= target.start) return { ok: false, error: `第 ${i + 1} 个 split 操作的 marker 已经在回目开头，不能切` };
      const targetAt = items.indexOf(target);
      created += 1;
      items.splice(targetAt, 1, {
        ...target,
        title: normalizeTitle(op.firstTitle) || target.title,
        end: absolute,
      }, {
        chapterId: null,
        rootId: target.rootId,
        segmentId: `new-${created}`,
        aliases: [],
        title: normalizeTitle(op.title) || `第 ${items.length + 1} 节`,
        start: absolute,
        end: target.end,
      });
      continue;
    }
    return { ok: false, error: `第 ${i + 1} 个操作类型不支持：${kind}` };
  }
  if (items.length === 0) return { ok: false, error: '调整后一回不剩；请检查 drop 操作' };
  const output = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const body = fullText.slice(item.start, item.end);
    if (countChars(body) === 0) continue;
    output.push(buildChapter(output.length + 1, item.title || `第 ${output.length + 1} 节`, body));
  }
  if (output.length === 0) return { ok: false, error: '调整后没有可用的正文' };
  return {
    ok: true,
    chapters: output,
    summary: {
      before: chapters.length,
      after: output.length,
      dropped: Math.max(0, chapters.length - output.length),
      operations: ops.length,
    },
  };
}

/** 找一找当前回目里明显的分章问题，返回建议操作（只读、不改数据）。 */
export function inspectChapterSplit(chapters) {
  const list = (Array.isArray(chapters) ? chapters : []).map((chapter, index) => ({
    id: chapter.id ?? chapter.chapterId ?? `ch-${String(index + 1).padStart(6, '0')}`,
    index: chapter.index ?? index + 1,
    title: String(chapter.title ?? '').trim(),
    text: String(chapter.text ?? ''),
    chars: Number.isFinite(chapter.chars) ? chapter.chars : countChars(chapter.text),
  }));
  const keys = list.map((chapter) => chapterTitleKey(chapter.title));
  const lastIndexByKey = new Map();
  for (let i = 0; i < list.length; i += 1) lastIndexByKey.set(keys[i], i);
  const issues = [];
  const suggestedOps = [];
  const pushOp = (op) => {
    const signature = JSON.stringify(op);
    if (!suggestedOps.some((entry) => JSON.stringify(entry) === signature)) suggestedOps.push(op);
  };
  // 先认出目录/提要残片：这些回之后会被整个丢掉，不要再对它们建议 merge / split。
  const fragments = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const chapter = list[i];
    const later = lastIndexByKey.get(keys[i]);
    if (later === undefined || later <= i || chapter.chars >= TOC_BODY_MAX) continue;
    const laterChapter = list[later];
    if (laterChapter.chars > Math.max(TOC_BODY_MAX, chapter.chars * 2)) fragments.add(chapter.id);
  }
  for (let i = 0; i < list.length; i += 1) {
    const chapter = list[i];
    const later = lastIndexByKey.get(keys[i]);
    if (fragments.has(chapter.id) && later !== undefined) {
      const laterChapter = list[later];
      issues.push({
        kind: 'toc-fragment',
        chapterId: chapter.id,
        title: chapter.title,
        chars: chapter.chars,
        sameAs: laterChapter.id,
        message: `「${chapter.title}」只有 ${chapter.chars} 字，和后面的「${laterChapter.title}」（${laterChapter.chars} 字）重复，像目录/提要残片`,
      });
      pushOp({ kind: 'drop', chapterId: chapter.id });
      continue;
    }
    const next = list[i + 1];
    if (next && !fragments.has(next.id) && keys[i] === keys[i + 1] &&
      (isPageSplitTitle(chapter.title) || isPageSplitTitle(next.title)) && chapter.id !== next.id) {
      issues.push({
        kind: 'split-continuation',
        chapterId: chapter.id,
        withChapterId: next.id,
        title: chapter.title,
        message: `「${chapter.title}」和「${next.title}」是同一回被拆开的，应合并`,
      });
      pushOp({ kind: 'merge', chapterId: chapter.id, toChapterId: next.id, title: stripPageSplitSuffix(chapter.title) });
    }
    const lines = chapter.text.split('\n');
    let offset = 0;
    for (const line of lines) {
      const text = line.trim();
      const compact = text.replace(/[\s\u3000]+/gu, '');
      if (offset > 0 && compact.length <= 80 && /^附录\s*[0-9０-９一二三四五六七八九十甲乙丙丁戊己庚辛壬癸]+/u.test(compact)) {
        issues.push({
          kind: 'unsplit-appendix',
          chapterId: chapter.id,
          title: chapter.title,
          marker: text,
          message: `「${text}」是附录标题，却还留在「${chapter.title}」正文里`,
        });
        pushOp({ kind: 'split', chapterId: chapter.id, marker: text, title: text });
      } else if (offset > 0 && /^(?:引言|引子|前言|后记|译后记|尾声|致谢)$/u.test(compact)) {
        issues.push({
          kind: 'unsplit-heading',
          chapterId: chapter.id,
          title: chapter.title,
          marker: text,
          message: `「${text}」是独立回目的标题，却还留在「${chapter.title}」正文里`,
        });
        pushOp({ kind: 'split', chapterId: chapter.id, marker: text, title: compact });
      }
      offset += line.length + 1;
    }
  }
  return {
    ok: true,
    chapterCount: list.length,
    issues,
    suggestedOps,
  };
}
