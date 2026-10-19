/**
 * XHTML / HTML → 纯文本。
 *
 * EPUB 的正文是 XHTML；这里既要把标签去掉，也要保留段落与标题，
 * 让分章和阅读器都能用。优先用 XMLParser（EPUB 规范要求良构 XML），
 * 遇到坏文件再退回正则清洗。
 */
import { XMLParser } from 'fast-xml-parser';

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre',
  'figure', 'figcaption', 'dd', 'dt', 'table', 'ul', 'ol', 'br', 'hr',
]);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'rt', 'rp', 'noscript', 'template']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3']);

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', middot: '·', bull: '•', copy: '©',
  reg: '®', trade: '™', times: '×', divide: '÷', deg: '°',
};

function decodeEntities(input) {
  return String(input ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const value = ENTITIES[body.toLowerCase()];
    return value === undefined ? whole : value;
  });
}

function walk(nodes, state) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@') continue;
      if (key === '#text') {
        state.text += String(value ?? '');
        continue;
      }
      const tag = key.includes(':') ? key.split(':').pop() : key;
      if (SKIP_TAGS.has(tag)) continue;
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) state.text += '\n';
      if (HEADING_TAGS.has(tag)) {
        const headingStart = state.text.length;
        walk(value, state);
        const headingText = state.text.slice(headingStart).replace(/\s+/gu, ' ').trim();
        if (headingText !== '') {
          state.headings.push({ level: Number(tag.slice(1)) || 1, title: headingText, start: headingStart });
        }
      } else {
        walk(value, state);
      }
      if (isBlock) state.text += '\n';
    }
  }
}

function normalizeText(input) {
  return String(input ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** 正则兜底：处理少量不合规的 EPUB XHTML。 */
function fallbackHtmlToText(html) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const cleaned = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style|head|rt|rp|noscript|template)[^>]*>[\s\S]*?<\/\1>/giu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|dd|dt)>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/giu, ' ');
  return {
    text: normalizeText(decodeEntities(cleaned)),
    title: titleMatch ? normalizeText(decodeEntities(titleMatch[1])) : '',
    headings: [],
  };
}

/**
 * @returns {{ text: string, title: string, headings: Array<{level:number,title:string,start:number}> }}
 */
export function xhtmlToText(html) {
  const source = String(html ?? '').replace(/^\uFEFF/u, '');
  try {
    const parser = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      processEntities: true,
      htmlEntities: true,
      allowBooleanAttributes: true,
      trimValues: false,
    });
    const tree = parser.parse(source);
    const state = { text: '', headings: [] };
    walk(tree, state);
    const text = normalizeText(state.text);
    let title = '';
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(source);
    if (titleMatch) title = normalizeText(decodeEntities(titleMatch[1]));
    return {
      text,
      title,
      headings: state.headings
        .map((entry) => ({ ...entry, title: normalizeText(entry.title) }))
        .filter((entry) => entry.title !== ''),
    };
  } catch {
    return fallbackHtmlToText(source);
  }
}

export function htmlToText(html) {
  return xhtmlToText(html).text;
}

export function extractTags(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'giu');
  const values = [];
  for (const match of String(html ?? '').matchAll(re)) {
    values.push(normalizeText(decodeEntities(match[1].replace(/<[^>]+>/gu, ''))));
  }
  return values;
}
