/**
 * EPUB 解析：container.xml → OPF → spine/nav/ncx → 每章 XHTML → 纯文本。
 *
 * 目录优先，目录缺失就按 spine；同一文件多个目录项时按 h1/h2 再切。
 */
import { posix } from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { xhtmlToText } from './html.js';
import { chapterId, normalizeText } from '../chapters.js';
import { countChars } from '../store.js';

const MAX_ENTRIES = 5000;
const MAX_UNCOMPRESSED = 300 * 1024 * 1024;

function decodeBytes(bytes, declared) {
  try {
    return new TextDecoder(declared || 'utf-8').decode(bytes).replace(/^\uFEFF/u, '');
  } catch {
    /* fall through */
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/u, '');
  const bad = (utf8.match(/\uFFFD/gu) ?? []).length;
  if (bad > 3 && bad / Math.max(1, utf8.length) > 0.002) {
    try {
      return new TextDecoder('gb18030').decode(bytes).replace(/^\uFEFF/u, '');
    } catch {
      /* keep utf8 */
    }
  }
  return utf8;
}

function xmlParser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    processEntities: true,
    htmlEntities: true,
    trimValues: true,
  });
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    if (typeof value['#text'] === 'string') return value['#text'];
    const first = Object.values(value).find((entry) => typeof entry === 'string');
    if (typeof first === 'string') return first;
  }
  return '';
}

function findKey(object, localName) {
  if (!object || typeof object !== 'object') return undefined;
  if (localName in object) return object[localName];
  for (const key of Object.keys(object)) {
    const plain = key.startsWith('@_') ? key.slice(2) : key;
    if (plain.split(':').pop() === localName) return object[key];
  }
  return undefined;
}

function entryPath(path) {
  return posix.normalize(String(path ?? '').replace(/^\.\//u, '').replace(/^\/+/u, ''));
}

function resolveHref(opfPath, href) {
  let clean = String(href ?? '').split('#')[0].trim();
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* keep */
  }
  if (clean === '') return '';
  const resolved = posix.normalize(posix.join(posix.dirname(opfPath), clean));
  return resolved.replace(/^\/+/u, '');
}

function titleFromNav(source) {
  const entries = [];
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of String(source ?? '').matchAll(re)) {
    const href = match[1] ?? match[2] ?? '';
    const text = normalizeText(match[3].replace(/<[^>]+>/gu, ''));
    if (text !== '' && href !== '') entries.push({ href, title: text });
  }
  return entries;
}

function walkNavPoints(navPoints, output) {
  for (const point of asArray(navPoints)) {
    if (!point || typeof point !== 'object') continue;
    const label = point.navLabel ?? point['ncx:navLabel'];
    const content = point.content ?? point['ncx:content'];
    const title = normalizeText(textOf(findKey(label ?? {}, 'text')));
    const src = String(findKey(content ?? {}, 'src') ?? '');
    if (title !== '' && src !== '') output.push({ href: src, title });
    const children = point.navPoint ?? point['ncx:navPoint'];
    if (children !== undefined) walkNavPoints(children, output);
  }
}

function titleFromNcx(source) {
  const parsed = xmlParser().parse(source);
  const ncx = parsed.ncx ?? parsed['ncx:ncx'] ?? parsed;
  const navMap = ncx.navMap ?? ncx['ncx:navMap'];
  const output = [];
  walkNavPoints(navMap?.navPoint ?? navMap?.['ncx:navPoint'], output);
  return output;
}

export async function parseEpub(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let total = 0;
  let count = 0;
  let entries;
  try {
    entries = unzipSync(bytes, {
      filter(file) {
        count += 1;
        total += Number(file.originalSize) || 0;
        return count <= MAX_ENTRIES && total <= MAX_UNCOMPRESSED;
      },
    });
  } catch (error) {
    throw new Error(`EPUB 解压失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const map = new Map();
  for (const [key, value] of Object.entries(entries)) map.set(entryPath(key).toLowerCase(), { key: entryPath(key), value });
  const read = (path) => {
    const normalized = entryPath(path);
    return map.get(normalized.toLowerCase())?.value;
  };
  const readText = (path) => {
    const bytesValue = read(path);
    if (!bytesValue) return undefined;
    return decodeBytes(bytesValue);
  };

  const mimetype = readText('mimetype')?.trim();
  if (mimetype && !mimetype.startsWith('application/epub+zip')) {
    throw new Error('这不是标准的 EPUB 文件（mimetype 不匹配）');
  }
  if (read('META-INF/encryption.xml')) {
    throw new Error('这本书带有 DRM 加密，插件无法解析');
  }

  const containerText = readText('META-INF/container.xml');
  if (!containerText) throw new Error('EPUB 缺少 META-INF/container.xml');
  const container = xmlParser().parse(containerText);
  const rootfiles = findKey(findKey(container, 'container') ?? {}, 'rootfiles');
  const rootfile = asArray(findKey(rootfiles ?? {}, 'rootfile'))[0];
  const opfPath = entryPath(String(rootfile?.['@_full-path'] ?? ''));
  if (opfPath === '') throw new Error('EPUB 的 container.xml 没有指向 OPF 文件');
  const opfText = readText(opfPath);
  if (!opfText) throw new Error('EPUB 缺少 OPF 文件');

  const opf = xmlParser().parse(opfText);
  const pkg = findKey(opf, 'package') ?? opf;
  const metadata = findKey(pkg, 'metadata') ?? {};
  const title = normalizeText(textOf(findKey(metadata, 'title'))) || '';
  const author = normalizeText(textOf(findKey(metadata, 'creator'))) || '';
  const language = normalizeText(textOf(findKey(metadata, 'language'))) || '';

  const manifest = new Map();
  for (const item of asArray(findKey(findKey(pkg, 'manifest') ?? {}, 'item'))) {
    const id = String(item?.['@_id'] ?? '');
    const href = String(item?.['@_href'] ?? '');
    if (id === '' || href === '') continue;
    manifest.set(id, {
      id,
      href,
      path: resolveHref(opfPath, href),
      mediaType: String(item?.['@_media-type'] ?? ''),
      properties: String(item?.['@_properties'] ?? ''),
    });
  }
  const spine = [];
  for (const itemref of asArray(findKey(findKey(pkg, 'spine') ?? {}, 'itemref'))) {
    const idref = String(itemref?.['@_idref'] ?? '');
    const item = manifest.get(idref);
    if (!item) continue;
    if (String(itemref?.['@_linear'] ?? '') === 'no') continue;
    spine.push(item);
  }
  if (spine.length === 0) throw new Error('EPUB 的 spine 为空，找不到正文');

  // 目录：nav.xhtml 优先，否则 toc.ncx。
  let toc = [];
  const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/u).includes('nav'));
  if (navItem) {
    const navText = readText(navItem.path);
    if (navText) toc = titleFromNav(navText);
  }
  if (toc.length === 0) {
    const ncxItem = [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml')
      ?? [...manifest.values()].find((item) => item.path.endsWith('.ncx'));
    if (ncxItem) {
      const ncxText = readText(ncxItem.path);
      if (ncxText) {
        try {
          toc = titleFromNcx(ncxText);
        } catch {
          toc = [];
        }
      }
    }
  }

  const tocByPath = new Map();
  for (const entry of toc) {
    const path = resolveHref(opfPath, entry.href);
    if (path === '') continue;
    const list = tocByPath.get(path) ?? [];
    const titleText = normalizeText(entry.title);
    if (titleText !== '' && !list.some((existing) => existing === titleText)) list.push(titleText);
    tocByPath.set(path, list);
  }

  const warnings = [];
  if (toc.length === 0) warnings.push('没有找到目录，已按 spine 顺序切分');
  const chapters = [];
  const fullParts = [];
  let index = 1;
  for (const item of spine) {
    const source = readText(item.path);
    if (source === undefined) continue;
    const parsed = xhtmlToText(source);
    let text = parsed.text;
    if (text.trim() === '') continue;
    const titles = tocByPath.get(item.path) ?? [];
    if (titles.length > 1 && parsed.headings.length > 1) {
      // 同一文件多个目录项：按标题在规范化文本中的位置切。
      // （XML 走查得到的偏移是规范化之前的，不能直接用。）
      const parts = [];
      let cursor = 0;
      const headings = [];
      for (const heading of parsed.headings) {
        const title = normalizeText(heading.title);
        if (title === '') continue;
        let start = text.indexOf(title, cursor);
        if (start < 0) start = text.indexOf(title);
        if (start < 0) continue;
        headings.push({ ...heading, title, start });
        cursor = start + title.length;
      }
      for (let i = 0; i < headings.length; i += 1) {
        const start = headings[i].start;
        const end = i + 1 < headings.length ? headings[i + 1].start : text.length;
        const body = text.slice(start, end).trim();
        if (body !== '') parts.push({ title: headings[i].title, text: body });
      }
      if (parts.length >= 2) {
        for (const part of parts) {
          const chapterText = normalizeText(part.text);
          if (countChars(chapterText) < 5) continue;
          chapters.push({
            index,
            id: chapterId(index),
            title: part.title || titles[0],
            text: chapterText,
            chars: countChars(chapterText),
            source: item.path,
          });
          fullParts.push(chapterText);
          index += 1;
        }
        continue;
      }
    }
    const fallbackTitle = titles[0] || parsed.headings[0]?.title || parsed.title || `第 ${index} 章`;
    text = normalizeText(text);
    if (countChars(text) < 5) continue;
    chapters.push({
      index,
      id: chapterId(index),
      title: normalizeText(fallbackTitle).slice(0, 160) || `第 ${index} 章`,
      text,
      chars: countChars(text),
      source: item.path,
    });
    fullParts.push(text);
    index += 1;
  }
  if (chapters.length === 0) throw new Error('EPUB 里没有解析到正文文字');
  return {
    format: 'epub',
    title,
    author,
    language,
    chapters,
    fullText: fullParts.join('\n\n'),
    warnings,
  };
}
