/**
 * TXT / Markdown 解析与编码处理。
 */
import { normalizeText } from '../chapters.js';

function replacementRatio(text) {
  const total = [...text].length;
  if (total === 0) return 0;
  const bad = (text.match(/\uFFFD/gu) ?? []).length;
  return bad / total;
}

export function decodeTextBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.slice(3)).replace(/\r\n?/gu, '\n'), encoding: 'utf-8' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.slice(2)).replace(/\r\n?/gu, '\n'), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.slice(2)).replace(/\r\n?/gu, '\n'), encoding: 'utf-16be' };
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes).replace(/\r\n?/gu, '\n');
  if (replacementRatio(utf8) > 0.002) {
    try {
      const gb = new TextDecoder('gb18030').decode(bytes).replace(/\r\n?/gu, '\n');
      if (replacementRatio(gb) < replacementRatio(utf8)) return { text: gb, encoding: 'gb18030' };
    } catch {
      /* keep utf8 */
    }
  }
  return { text: utf8, encoding: 'utf-8' };
}

export function parsePlainText(buffer, format = 'txt') {
  const decoded = decodeTextBuffer(buffer);
  const text = normalizeText(decoded.text);
  if (text === '') throw new Error('文件里没有文字');
  const firstLine = text.split('\n', 1)[0]?.replace(/^#{1,6}\s*/u, '').trim() ?? '';
  const title = firstLine.length > 0 && firstLine.length <= 80 ? firstLine : '';
  const warnings = [];
  if (decoded.encoding !== 'utf-8') warnings.push(`按 ${decoded.encoding} 解码`);
  return {
    format,
    title,
    author: '',
    language: 'zh',
    text,
    headings: [],
    encoding: decoded.encoding,
    warnings,
  };
}

export function guessTextTitle(text, filename = '') {
  const first = String(text ?? '').split('\n', 1)[0]?.replace(/^#{1,6}\s*/u, '').trim() ?? '';
  if (first !== '' && first.length <= 80) return first;
  return String(filename ?? '').replace(/\.[^.]+$/u, '').trim();
}
