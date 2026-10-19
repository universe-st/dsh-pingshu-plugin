/**
 * PDF 解析：pdfjs-dist 取文本 → 聚行 → 去页眉页脚 → 书签/字号找标题 → 段落化。
 *
 * pdfjs 在 Node 22 下用 legacy ESM 构建即可，不需要 canvas；这里动态 import，
 * 只有真的导入 PDF 时才加载它，避免拖慢插件启动。
 */
import { countChars } from '../store.js';
import { normalizeText } from '../chapters.js';

const MAX_PAGES = 5000;
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f]/u;

function isCjk(char) {
  return CJK_RE.test(char ?? '');
}

function needsSpace(previous, next, gap, size) {
  if (previous === '' || next === '') return false;
  const left = previous[previous.length - 1];
  const right = next[0];
  if (/\s/u.test(left) || /\s/u.test(right)) return false;
  if (isCjk(left) || isCjk(right)) return false;
  if (/[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right)) return true;
  return Number.isFinite(gap) && gap > size * 0.3;
}

function joinItems(items) {
  let text = '';
  let previousEnd = null;
  for (const item of items) {
    const str = String(item.str ?? '');
    if (str === '') continue;
    if (text !== '' && needsSpace(text, str, item.x - (previousEnd ?? item.x), item.size)) text += ' ';
    text += str;
    previousEnd = item.x + (Number(item.width) || 0);
  }
  return normalizeInline(text);
}

function normalizeInline(text) {
  return String(text ?? '')
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

function groupLines(items, pageWidth) {
  const sorted = items
    .filter((item) => typeof item.str === 'string' && item.str !== '')
    .map((item) => ({
      str: item.str,
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      width: Number(item.width) || 0,
      size: Math.max(1, Number(item.size) || 12),
      hasEOL: item.hasEOL === true,
    }))
    .sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));

  const raw = [];
  let current = null;
  for (const item of sorted) {
    if (current === null || Math.abs(item.y - current.y) > Math.max(2.5, item.size * 0.35) || current.forcedBreak) {
      current = { y: item.y, items: [item], forcedBreak: false };
      raw.push(current);
    } else {
      current.items.push(item);
    }
    if (item.hasEOL) current.forcedBreak = true;
  }

  const lines = [];
  let columnSplits = 0;
  for (const line of raw) {
    const sortedItems = line.items.slice().sort((a, b) => a.x - b.x);
    const segments = [];
    let segment = [];
    let previousEnd = null;
    for (const item of sortedItems) {
      if (segment.length > 0 && previousEnd !== null && item.x - previousEnd > pageWidth * 0.15) {
        segments.push(segment);
        segment = [];
      }
      segment.push(item);
      previousEnd = item.x + item.width;
    }
    if (segment.length > 0) segments.push(segment);
    if (segments.length > 1) columnSplits += 1;
    for (const part of segments) {
      const text = joinItems(part);
      if (text === '') continue;
      const size = part.reduce((sum, item) => sum + item.size * Math.max(1, item.str.length), 0)
        / Math.max(1, part.reduce((sum, item) => sum + Math.max(1, item.str.length), 0));
      lines.push({
        text,
        size: Math.round(size * 2) / 2,
        x: Math.min(...part.map((item) => item.x)),
        y: line.y,
      });
    }
  }
  return { lines, columnSplits };
}

function pageItems(textContent) {
  const items = [];
  for (const item of textContent.items ?? []) {
    if (!item || typeof item.str !== 'string' || item.str === '') continue;
    const transform = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
    const size = Number(item.height) || Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0) || 12;
    items.push({
      str: item.str,
      x: Number(transform[4]) || 0,
      y: Number(transform[5]) || 0,
      width: Number(item.width) || 0,
      size,
      hasEOL: item.hasEOL === true,
    });
  }
  return items;
}

function collectHeaderFooter(pages) {
  const counts = new Map();
  for (const page of pages) {
    const candidates = [
      ...page.lines.slice(0, 2),
      ...page.lines.slice(-2),
    ];
    for (const line of candidates) {
      const key = normalizeInline(line.text);
      if (key === '' || key.length > 80) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.35));
  const repeated = new Set();
  for (const [key, count] of counts) if (count >= threshold) repeated.add(key);
  for (const page of pages) {
    page.lines = page.lines.filter((line) => {
      const key = normalizeInline(line.text);
      if (repeated.has(key)) return false;
      if (/^[\s\-—–_]*\d{1,5}[\s\-—–_]*$/u.test(key)) return false;
      return true;
    });
  }
}

function bodyFontSize(pages) {
  const histogram = new Map();
  for (const page of pages) {
    for (const line of page.lines) {
      const key = line.size;
      histogram.set(key, (histogram.get(key) ?? 0) + countChars(line.text));
    }
  }
  let best = 12;
  let bestCount = -1;
  for (const [size, count] of histogram) {
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  }
  return best;
}

function flattenOutline(items, output = []) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const title = normalizeInline(item.title);
    if (title !== '') output.push({ title, dest: item.dest });
    if (Array.isArray(item.items)) flattenOutline(item.items, output);
  }
  return output;
}

async function outlinePageIndex(doc, dest) {
  try {
    let resolved = dest;
    if (typeof dest === 'string') resolved = await doc.getDestination(dest);
    if (!Array.isArray(resolved) || resolved.length === 0) return null;
    const ref = resolved[0];
    if (ref && typeof ref === 'object') return await doc.getPageIndex(ref);
    if (typeof ref === 'number') return ref;
    return null;
  } catch {
    return null;
  }
}

function findLineOnPage(page, title) {
  const normalized = normalizeInline(title);
  if (normalized === '') return -1;
  const exact = page.lines.findIndex((line) => normalizeInline(line.text) === normalized);
  if (exact >= 0) return exact;
  return page.lines.findIndex((line) => {
    const text = normalizeInline(line.text);
    return text.startsWith(normalized) || normalized.startsWith(text);
  });
}

function paragraphStart(page, line, previous, margin) {
  if (previous === null) return true;
  if (line.x - margin > line.size * 0.85) return true;
  if (previous.y - line.y > Math.max(previous.size, line.size) * 1.8) return true;
  if (line.text.startsWith('　　')) return true;
  return false;
}

function joinParagraph(previous, next) {
  if (previous === '') return next;
  const left = previous[previous.length - 1];
  const right = next[0];
  if (/\s/u.test(left) || /\s/u.test(right)) return `${previous}${next}`;
  if (isCjk(left) || isCjk(right)) return `${previous}${next}`;
  return `${previous} ${next}`;
}

function buildPageParas(page, bodySize) {
  if (page.lines.length === 0) return [];
  const longLines = page.lines.filter((line) => line.text.length >= 12);
  const margin = longLines.length > 0
    ? Math.min(...longLines.map((line) => line.x))
    : Math.min(...page.lines.map((line) => line.x));
  const paragraphs = [];
  let buffer = '';
  let previous = null;
  for (const line of page.lines) {
    const isHeadingLine = line.size >= bodySize * 1.18
      || /^(第[零一二三四五六七八九十百千万两0-9０-９]+[回章节卷部篇集]|序|序言|自序|前言|楔子|引子|后记|尾声|附录|Chap(?:ter)?\s+[0-9IVXLCivxlc]+)/u.test(line.text);
    if (isHeadingLine) {
      if (buffer.trim() !== '') paragraphs.push(buffer.trim());
      buffer = '';
      paragraphs.push(line.text.trim());
      previous = line;
      continue;
    }
    if (paragraphStart(page, line, previous, margin)) {
      if (buffer.trim() !== '') paragraphs.push(buffer.trim());
      buffer = line.text;
    } else {
      buffer = joinParagraph(buffer, line.text);
    }
    previous = line;
  }
  if (buffer.trim() !== '') paragraphs.push(buffer.trim());
  return paragraphs;
}

export async function parsePdf(buffer) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (error) {
    throw new Error(`PDF 解析组件加载失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data,
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
      useWorkerFetch: false,
    }).promise;
  } catch (error) {
    if (error?.name === 'PasswordException') throw new Error('这个 PDF 有密码保护，插件无法解析');
    throw new Error(`PDF 打开失败：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    if (doc.numPages > MAX_PAGES) throw new Error(`PDF 页数太多（${doc.numPages} 页，上限 ${MAX_PAGES} 页）`);
    let info = {};
    try {
      const metadata = await doc.getMetadata();
      info = metadata?.info ?? {};
    } catch {
      info = {};
    }
    const title = String(info.Title ?? '').trim();
    const author = String(info.Author ?? '').trim();

    const pages = [];
    const warnings = [];
    let columnSplits = 0;
    let totalChars = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      let page;
      try {
        page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
        const { lines, columnSplits: splits } = groupLines(pageItems(textContent), viewport.width);
        columnSplits += splits;
        totalChars += lines.reduce((sum, line) => sum + countChars(line.text), 0);
        pages.push({ pageNumber, lines });
      } catch (error) {
        warnings.push(`第 ${pageNumber} 页提取失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        try { page?.cleanup(); } catch { /* ignore */ }
      }
    }
    if (totalChars < Math.max(100, doc.numPages * 10)) {
      throw new Error('这个 PDF 几乎没有可提取的文字，可能是扫描版；请先用 OCR 转成文字版 PDF/EPUB/TXT');
    }
    collectHeaderFooter(pages);
    const bodySize = bodyFontSize(pages);

    // 书签优先。
    let outline = [];
    try {
      outline = flattenOutline(await doc.getOutline());
    } catch {
      outline = [];
    }
    const outlineHeadings = [];
    if (outline.length >= 2) {
      const seenPages = new Set();
      for (const item of outline) {
        const pageIndex = await outlinePageIndex(doc, item.dest);
        if (pageIndex === null || pageIndex < 0 || pageIndex >= pages.length) continue;
        const page = pages[pageIndex];
        const lineIndex = findLineOnPage(page, item.title);
        const line = lineIndex >= 0 ? page.lines[lineIndex] : null;
        outlineHeadings.push({
          title: line?.text ?? item.title,
          pageIndex,
          lineIndex: lineIndex >= 0 ? lineIndex : 0,
          source: `p${pageIndex + 1}`,
        });
        seenPages.add(pageIndex);
      }
      if (seenPages.size < 2) outlineHeadings.length = 0;
    }

    // 字号/正则标题。
    const fontHeadings = [];
    if (outlineHeadings.length === 0) {
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
        const page = pages[pageIndex];
        for (let lineIndex = 0; lineIndex < page.lines.length; lineIndex += 1) {
          const line = page.lines[lineIndex];
          const text = normalizeInline(line.text);
          if (text === '' || text.length > 80) continue;
          const isChapter = /^(第[零一二三四五六七八九十百千万两0-9０-９]+[回章节卷部篇集]|序|序言|自序|前言|楔子|引子|后记|尾声|附录|Chap(?:ter)?\s+[0-9IVXLCivxlc]+)/u.test(text);
          const isBig = line.size >= bodySize * 1.18;
          if (!isChapter && !isBig) continue;
          if (line.size < bodySize * 1.01 && !isChapter) continue;
          fontHeadings.push({ title: text, pageIndex, lineIndex, source: `p${pageIndex + 1}` });
        }
      }
    }

    // 组装全文（保留分页注释，供重新分章定位）。
    const chunks = [];
    const usedHeadings = outlineHeadings.length > 0 ? outlineHeadings : fontHeadings;
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      chunks.push(`<!-- pingshu:page ${page.pageNumber} -->`);
      const paras = buildPageParas(page, bodySize);
      for (const text of paras) chunks.push(text);
      chunks.push('');
    }
    let fullText = normalizeText(chunks.join('\n'));

    // 把标题与全文偏移对上：按顺序搜索标题行，避免同名标题串位。
    const headings = [];
    let cursor = 0;
    for (const entry of usedHeadings) {
      const title = normalizeInline(entry.title);
      if (title === '') continue;
      let start = fullText.indexOf(title, cursor);
      if (start < 0) start = fullText.indexOf(title);
      if (start < 0) continue;
      headings.push({
        title,
        start,
        contentStart: start + title.length,
        source: entry.source,
      });
      cursor = start + title.length;
    }
    headings.sort((a, b) => a.start - b.start);

    if (outlineHeadings.length === 0) warnings.push('PDF 没有可用书签，已按字号/标题行切分');
    if (headings.length < 2) warnings.push('没有识别到足够的回目标题，已按段落长度切分');
    if (columnSplits > Math.max(3, pages.length * 0.2)) warnings.push('检测到疑似多栏排版，文字顺序可能交错');

    return {
      format: 'pdf',
      title,
      author,
      language: '',
      text: fullText,
      headings,
      pages: pages.length,
      warnings,
    };
  } finally {
    try {
      await doc.destroy();
    } catch {
      /* ignore */
    }
  }
}
