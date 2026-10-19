/**
 * 评书 —— 浏览器半区。
 *
 * 两个挂载点：
 *   sidebar.panellist + main(key="pingshu")：项目/回目/资料/评书工作台
 *   main 里的阅读器：大字号 Markdown + 浏览器 TTS 朗读
 *
 * 这是经典脚本（不能 import/export），只能 require 外壳提供的 React。
 * 所有 React 元素用 React.createElement 构造，没有 JSX 构建步骤。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pingshu',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PACKAGE = 'dsh-pingshu';
    const SERVICE = 'pingshu';
    const PANEL_ID = 'pingshu';
    const NS = PACKAGE;

    // ── 极简 i18n：中文原文作为 key；英文只覆盖主界面 ─────────────────────
    const EN = {
      '评书': 'Pingshu',
      '新建项目': 'New project',
      '评书工作台': 'Pingshu studio',
      '还没有书': 'No books yet',
      '上传一本 EPUB / PDF / TXT / Markdown，开一场评书。': 'Upload an EPUB / PDF / TXT / Markdown to begin.',
      '回目': 'Chapters',
      '书目资料': 'Book notes',
      '评书文案': 'Performances',
      '开始分析': 'Analyze',
      '继续分析': 'Continue analysis',
      '重新分析': 'Re-analyze',
      '讲这一回': 'Perform this chapter',
      '读原文': 'Read chapter',
      '查看': 'View',
      '让 AI 补充': 'Ask AI to fill in',
      '朗读': 'Read aloud',
      '阅读': 'Read',
      '下载': 'Download',
      '重讲': 'Retell',
      '删除': 'Delete',
      '关闭': 'Close',
      '刷新': 'Refresh',
      '改名': 'Rename',
      '保存': 'Save',
      '取消': 'Cancel',
      '确定': 'Confirm',
      '导入并开始分析': 'Import and analyze',
      '只导入': 'Import only',
      '上传中…': 'Uploading…',
      '识别回目中…': 'Detecting chapters…',
      '全书概要': 'Book summary',
      '章节摘要': 'Chapter summaries',
      '人物': 'Characters',
      '时间线': 'Timeline',
      '背景与术语': 'Context & glossary',
      '还没有整理资料': 'No notes yet',
      '还没有讲过': 'No performances yet',
      '打开最近对话': 'Open latest chat',
      '在对话中查看': 'Open in chat',
    };

    const localeState = { id: 'zh', listeners: new Set() };
    function setLocaleId(id) {
      const next = String(id ?? 'zh');
      if (localeState.id === next) return;
      localeState.id = next;
      for (const listener of localeState.listeners) {
        try { listener(); } catch { /* ignore */ }
      }
    }
    function T(text, params) {
      const source = String(text ?? '');
      const translated = localeState.id.startsWith('en') ? (EN[source] ?? source) : source;
      if (!params) return translated;
      return translated.replace(/\{(\w+)\}/g, (whole, key) => (params[key] === undefined ? whole : String(params[key])));
    }
    function useLocaleTick() {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setTick((value) => value + 1);
        localeState.listeners.add(listener);
        return () => { localeState.listeners.delete(listener); };
      }, []);
    }
    function attachI18n(ctx) {
      const bind = (child) => {
        try {
          const locale = child.get('locale');
          if (!locale) return;
          setLocaleId(locale.getLocale().id);
          locale.subscribe(() => setLocaleId(locale.getLocale().id));
        } catch { /* ignore */ }
      };
      try {
        const locale = ctx.get('locale');
        if (locale) { bind(ctx); return; }
      } catch { /* ignore */ }
      try { ctx.inject(['locale'], bind); } catch { /* ignore */ }
    }

    // ── 远程服务 ───────────────────────────────────────────────────────────
    const codec = (symbol) => ({ mode: 'strict', typeSymbol: symbol, create: () => ({ parse: (value) => value }) });
    // 必须与宿主 lib/wire.js 的 METHODS 一一对应；第二个字段 = 收不收 payload。
    const REMOTE_METHODS = [
      ['listProjects', false],
      ['getProject', true],
      ['repairProject', true],
      ['createProject', true],
      ['reissueUpload', true],
      ['startImport', true],
      ['deleteProject', true],
      ['renameProject', true],
      ['getChapter', true],
      ['getAnalysis', true],
      ['saveChapterSummary', true],
      ['saveDossier', true],
      ['analysisStatus', true],
      ['analysisBatches', true],
      ['getDossier', true],
      ['savePerformance', true],
      ['listPerformances', true],
      ['getPerformance', true],
      ['deletePerformance', true],
      ['resplitChapters', true],
      ['resolve', true],
      ['startConversation', true],
      ['getGuide', true],
      ['getTtsConfig', false],
      ['saveTtsConfig', true],
      ['uploadTtsReference', true],
      ['ttsTest', true],
      ['volcTest', true],
      ['siliconTest', true],
      ['ttsStart', true],
      ['ttsJob', true],
      ['ttsCancel', true],
    ];

    const CONTRIBUTION = {
      package: PACKAGE,
      descriptors: REMOTE_METHODS.map(([method, hasPayload]) => ({
        id: `${PACKAGE}#${SERVICE}/${method}`,
        service: SERVICE,
        namespace: SERVICE,
        method,
        invocation: { kind: 'direct' },
        parameters: hasPayload
          ? [{ name: 'payload', wire: 'payload', source: 'json', codec: codec(`${PACKAGE}#${method}Payload`) }]
          : [],
        result: codec(`${PACKAGE}#${method}Result`),
      })),
    };

    function createApi(ctx, mountPromise) {
      let mounted = null;
      const ensure = async () => {
        if (!mounted) mounted = Promise.resolve(mountPromise).then(() => undefined);
        await mounted;
        const remote = ctx.get(`remote.${SERVICE}`);
        if (!remote) throw new Error('评书远程服务不可用，请确认插件已启用');
        return remote;
      };
      const call = async (method, payload) => {
        const remote = await ensure();
        const result = payload === undefined ? await remote[method]() : await remote[method](payload);
        if (result === null || typeof result !== 'object' || result.ok !== true) {
          const detail = result?.error;
          throw new Error(detail === undefined ? `${method} 调用失败` : `${detail.code ?? 'ERROR'}: ${detail.message ?? ''}`);
        }
        return result.value;
      };
      const api = {};
      for (const [method] of REMOTE_METHODS) {
        api[method] = (payload) => (payload === undefined ? call(method) : call(method, payload));
      }
      return api;
    }

    async function getService(ctx, name, attempts = 20) {
      try {
        const found = ctx.get(name);
        if (found) return found;
      } catch { /* ignore */ }
      for (let i = 0; i < attempts; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          const found = ctx.get(name);
          if (found) return found;
        } catch { /* ignore */ }
      }
      return null;
    }

    // ── 小工具 ─────────────────────────────────────────────────────────────
    function stripFrontmatter(markdown) {
      const text = String(markdown ?? '');
      if (!text.startsWith('---')) return text;
      const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(text);
      return match ? text.slice(match[0].length) : text;
    }
    function stripLeadingHeading(markdown, title) {
      const text = String(markdown ?? '').replace(/^\s+/u, '');
      const match = /^#\s+([^\n]+)\n+/u.exec(text);
      if (!match) return text;
      if (title && match[1].trim() !== String(title).trim()) return text;
      return text.slice(match[0].length);
    }
    function formatChars(value) {
      const number = Number(value) || 0;
      if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)} 万字`;
      return `${number} 字`;
    }
    function formatSize(bytes) {
      const value = Number(bytes) || 0;
      if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
      if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
      return `${value} B`;
    }
    function formatDate(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat(localeState.id.startsWith('en') ? 'en' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
    }
    function percent(done, total) {
      if (!total) return 0;
      return Math.max(0, Math.min(100, Math.round((Number(done) / Number(total)) * 100)));
    }
    function downloadText(filename, text) {
      const blob = new Blob([String(text ?? '')], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(String(text ?? ''));
        return true;
      } catch {
        return false;
      }
    }
    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^;]+;base64,/u, ''));
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
    }

    // ── Markdown 渲染（无 dangerouslySetInnerHTML）────────────────────────
    function inline(text, keyPrefix = 'i') {
      const nodes = [];
      const source = String(text ?? '');
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/gu;
      let last = 0;
      let index = 0;
      for (const match of source.matchAll(pattern)) {
        if (match.index > last) nodes.push(source.slice(last, match.index));
        const token = match[0];
        const key = `${keyPrefix}-${index}`;
        if (token.startsWith('**')) nodes.push(h('strong', { key }, token.slice(2, -2)));
        else if (token.startsWith('`')) nodes.push(h('code', { key, className: 'PS_code' }, token.slice(1, -1)));
        else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
          nodes.push(link ? h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]) : token);
        } else if (token.startsWith('*')) nodes.push(h('em', { key }, token.slice(1, -1)));
        else nodes.push(token);
        last = match.index + token.length;
        index += 1;
      }
      if (last < source.length) nodes.push(source.slice(last));
      return nodes;
    }

    function parseTable(lines, keyPrefix) {
      const cells = (line) => line.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim());
      const header = cells(lines[0]);
      const body = lines.slice(2).map(cells);
      return h('div', { key: keyPrefix, className: 'PS_tableWrap' },
        h('table', { className: 'PS_table' },
          h('thead', null, h('tr', null, header.map((cell, i) => h('th', { key: i }, inline(cell, `${keyPrefix}-h${i}`))))),
          h('tbody', null, body.map((row, r) => h('tr', { key: r }, row.map((cell, c) => h('td', { key: c }, inline(cell, `${keyPrefix}-r${r}c${c}`))))))
        )
      );
    }

    function Markdown({ markdown, title, className }) {
      const text = stripLeadingHeading(stripFrontmatter(markdown), title);
      const lines = text.replace(/\r\n?/gu, '\n').split('\n');
      const blocks = [];
      let i = 0;
      let key = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') { i += 1; continue; }
        if (/^\s*```/u.test(line)) {
          const language = line.trim().slice(3).trim();
          const buffer = [];
          i += 1;
          while (i < lines.length && !/^\s*```/u.test(lines[i])) { buffer.push(lines[i]); i += 1; }
          i += 1;
          blocks.push(h('pre', { key: `b${key++}`, className: 'PS_pre' }, h('code', null, buffer.join('\n'))));
          continue;
        }
        const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
        if (heading) {
          const level = Math.min(6, heading[1].length);
          const tag = `h${level}`;
          blocks.push(h(tag, { key: `b${key++}`, className: `PS_mdH PS_mdH${level}` }, inline(heading[2], `h${key}`)));
          i += 1;
          continue;
        }
        if (/^\s*([-*_])\1{2,}\s*$/u.test(line)) {
          blocks.push(h('hr', { key: `b${key++}`, className: 'PS_hr' }));
          i += 1;
          continue;
        }
        if (/^\s*\|/u.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/u.test(lines[i + 1])) {
          const tableLines = [line, lines[i + 1]];
          i += 2;
          while (i < lines.length && /^\s*\|/u.test(lines[i])) { tableLines.push(lines[i]); i += 1; }
          blocks.push(parseTable(tableLines, `t${key++}`));
          continue;
        }
        if (/^\s*>\s?/u.test(line)) {
          const buffer = [];
          while (i < lines.length && /^\s*>\s?/u.test(lines[i])) { buffer.push(lines[i].replace(/^\s*>\s?/u, '')); i += 1; }
          blocks.push(h('blockquote', { key: `b${key++}`, className: 'PS_quote' }, inline(buffer.join(' '), `q${key}`)));
          continue;
        }
        const listMatch = /^\s*([-*+]|\d+\.)\s+/u.exec(line);
        if (listMatch) {
          const ordered = /\d+\./u.test(listMatch[1]);
          const items = [];
          while (i < lines.length) {
            const item = /^\s*([-*+]|\d+\.)\s+(.+)$/u.exec(lines[i]);
            if (!item) break;
            items.push(item[2]);
            i += 1;
          }
          const tag = ordered ? 'ol' : 'ul';
          blocks.push(h(tag, { key: `b${key++}`, className: 'PS_list' }, items.map((item, index) => h('li', { key: index }, inline(item, `l${key}-${index}`)))));
          continue;
        }
        const buffer = [line];
        i += 1;
        while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6})\s+/u.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/u.test(lines[i]) && !/^\s*>/u.test(lines[i]) && !/^\s*\|/u.test(lines[i]) && !/^\s*```/u.test(lines[i]) && !/^\s*([-*_])\1{2,}\s*$/u.test(lines[i])) {
          buffer.push(lines[i]);
          i += 1;
        }
        blocks.push(h('p', { key: `b${key++}`, className: 'PS_p' }, inline(buffer.join(' '), `p${key}`)));
      }
      return h('div', { className: `PS_md ${className ?? ''}` }, blocks.length > 0 ? blocks : h('p', { className: 'PS_muted' }, '（空）'));
    }

    // ── 评书文案解析：给阅读器高亮和 TTS 共用 ─────────────────────────────
    function splitSentences(text) {
      const source = String(text ?? '').trim();
      if (source === '') return [];
      try {
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
          const segmenter = new Intl.Segmenter('zh', { granularity: 'sentence' });
          return [...segmenter.segment(source)].map((entry) => entry.segment).filter((entry) => entry.trim() !== '');
        }
      } catch { /* fall through */ }
      return source.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? [source];
    }

    function parseScript(markdown) {
      const text = stripFrontmatter(markdown);
      const lines = text.replace(/\r\n?/gu, '\n').split('\n');
      const blocks = [];
      const speech = [];
      let paragraphIndex = 0;
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') { i += 1; continue; }
        if (/^\s*([-*_])\1{2,}\s*$/u.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue; }
        const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
        if (heading) {
          blocks.push({ type: 'heading', level: Math.min(6, heading[1].length), text: heading[2] });
          i += 1;
          continue;
        }
        if (/^\s*\|/u.test(line)) {
          const buffer = [];
          while (i < lines.length && /^\s*\|/u.test(lines[i])) { buffer.push(lines[i]); i += 1; }
          blocks.push({ type: 'table', text: buffer.join('\n') });
          continue;
        }
        const buffer = [line];
        i += 1;
        while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6})\s+/u.test(lines[i]) && !/^\s*([-*_])\1{2,}\s*$/u.test(lines[i]) && !/^\s*\|/u.test(lines[i])) {
          buffer.push(lines[i]);
          i += 1;
        }
        const paragraph = buffer.join(' ').replace(/\s+/gu, ' ').trim();
        if (paragraph === '') continue;
        // 同一个自然段里如果出现了多个【说话人】标记（AI 有时不另起段），
        // 按标记拆成多个块：阅读器分别显示，TTS 分别换音色。
        const segments = paragraph.split(/(?=【[^】]{1,24}】)/u).map((entry) => entry.trim()).filter((entry) => entry !== '');
        for (const segment of segments.length > 0 ? segments : [paragraph]) {
          const speakerMatch = /^【([^】]{1,24})】\s*/u.exec(segment);
          const speaker = speakerMatch ? speakerMatch[1] : '';
          const body = speakerMatch ? segment.slice(speakerMatch[0].length).trim() : segment;
          if (body === '') continue;
          const blockIndex = paragraphIndex;
          blocks.push({ type: 'paragraph', index: blockIndex, speaker, text: body });
          for (const sentence of splitSentences(body)) {
            let remaining = sentence.trim();
            while (remaining.length > 190) {
              const slice = remaining.slice(0, 190);
              const cut = Math.max(slice.lastIndexOf('，'), slice.lastIndexOf('、'), slice.lastIndexOf('；'), slice.lastIndexOf(','));
              const at = cut > 60 ? cut + 1 : 190;
              speech.push({ text: remaining.slice(0, at).trim(), speaker, blockIndex });
              remaining = remaining.slice(at).trim();
            }
            if (remaining !== '') speech.push({ text: remaining, speaker, blockIndex });
          }
          paragraphIndex += 1;
        }
      }
      return { blocks, speech };
    }

    function plainSpeechText(text) {
      return String(text ?? '')
        .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
        .replace(/[*_`>#]/gu, '')
        .replace(/——/gu, '，')
        .replace(/\s+/gu, ' ')
        .trim();
    }

    // ── TTS Hook ───────────────────────────────────────────────────────────
    function useTts(markdown) {
      const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
      const [voices, setVoices] = React.useState([]);
      const [voiceURI, setVoiceURI] = React.useState(() => {
        try { return localStorage.getItem('pingshu.tts.voice') ?? ''; } catch { return ''; }
      });
      const [rate, setRate] = React.useState(() => {
        try { return Number(localStorage.getItem('pingshu.tts.rate')) || 0.95; } catch { return 0.95; }
      });
      const [pitch, setPitch] = React.useState(() => {
        try { return Number(localStorage.getItem('pingshu.tts.pitch')) || 1; } catch { return 1; }
      });
      const [characterVoices, setCharacterVoices] = React.useState(() => {
        try { return localStorage.getItem('pingshu.tts.characters') === '1'; } catch { return true; }
      });
      const [status, setStatus] = React.useState('idle');
      const [current, setCurrent] = React.useState(-1);
      const parsed = React.useMemo(() => parseScript(markdown), [markdown]);
      const speech = parsed.speech;
      const aliveRef = React.useRef(true);
      const indexRef = React.useRef(0);
      const stoppedRef = React.useRef(true);

      React.useEffect(() => () => { aliveRef.current = false; try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }, []);

      React.useEffect(() => {
        if (!supported) return undefined;
        const load = () => {
          try { setVoices(window.speechSynthesis.getVoices()); } catch { /* ignore */ }
        };
        load();
        window.speechSynthesis.addEventListener?.('voiceschanged', load);
        return () => { try { window.speechSynthesis.removeEventListener?.('voiceschanged', load); } catch { /* ignore */ } };
      }, [supported]);

      React.useEffect(() => {
        try { localStorage.setItem('pingshu.tts.voice', voiceURI); } catch { /* ignore */ }
      }, [voiceURI]);
      React.useEffect(() => {
        try { localStorage.setItem('pingshu.tts.rate', String(rate)); } catch { /* ignore */ }
      }, [rate]);
      React.useEffect(() => {
        try { localStorage.setItem('pingshu.tts.pitch', String(pitch)); } catch { /* ignore */ }
      }, [pitch]);
      React.useEffect(() => {
        try { localStorage.setItem('pingshu.tts.characters', characterVoices ? '1' : '0'); } catch { /* ignore */ }
      }, [characterVoices]);

      const stop = React.useCallback(() => {
        stoppedRef.current = true;
        indexRef.current = 0;
        setStatus('idle');
        setCurrent(-1);
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
      }, []);

      React.useEffect(() => { stop(); }, [markdown, stop]);

      const zhVoices = React.useMemo(() => voices.filter((voice) => /^zh/iu.test(voice.lang)), [voices]);
      const narratorVoice = React.useMemo(() => {
        if (voiceURI) {
          const chosen = voices.find((voice) => voice.voiceURI === voiceURI);
          if (chosen) return chosen;
        }
        return zhVoices[0] ?? voices[0] ?? null;
      }, [voices, voiceURI, zhVoices]);
      const characterVoice = React.useMemo(() => {
        if (!characterVoices || zhVoices.length === 0) return null;
        return zhVoices.find((voice) => voice.voiceURI !== narratorVoice?.voiceURI) ?? null;
      }, [characterVoices, zhVoices, narratorVoice]);

      const speakAt = React.useCallback((index) => {
        if (!aliveRef.current) return;
        if (index >= speech.length) {
          stoppedRef.current = true;
          setStatus('idle');
          setCurrent(-1);
          return;
        }
        indexRef.current = index;
        setCurrent(index);
        const item = speech[index];
        const utterance = new SpeechSynthesisUtterance(plainSpeechText(item.text));
        utterance.lang = 'zh-CN';
        if (narratorVoice) utterance.voice = narratorVoice;
        utterance.rate = Math.max(0.5, Math.min(1.6, rate));
        utterance.pitch = Math.max(0.5, Math.min(1.6, pitch));
        utterance.volume = 1;
        const isCharacter = characterVoices && item.speaker && !/^(说书人|旁白|叙述者)$/u.test(item.speaker);
        if (isCharacter) {
          utterance.pitch = Math.max(0.5, Math.min(1.8, utterance.pitch + 0.12));
          utterance.rate = Math.max(0.5, Math.min(1.6, utterance.rate + 0.02));
          if (characterVoice) utterance.voice = characterVoice;
        }
        utterance.onend = () => {
          if (!aliveRef.current || stoppedRef.current) return;
          speakAt(index + 1);
        };
        utterance.onerror = (event) => {
          if (!aliveRef.current) return;
          const error = String(event?.error ?? '');
          if (error === 'interrupted' || error === 'canceled') return;
          stoppedRef.current = true;
          setStatus('idle');
          setCurrent(-1);
        };
        try {
          window.speechSynthesis.speak(utterance);
        } catch {
          stoppedRef.current = true;
          setStatus('idle');
        }
      }, [speech, narratorVoice, characterVoice, characterVoices, rate, pitch]);

      const play = React.useCallback(() => {
        if (!supported || speech.length === 0) return;
        stoppedRef.current = true;
        try {
          window.speechSynthesis.cancel();
          // cancel() 之后 paused 可能还是 true（Chrome），先 resume 再 speak，
          // 否则第二次点「朗读」会把话排进一个暂停的队列里。
          window.speechSynthesis.resume();
        } catch { /* ignore */ }
        stoppedRef.current = false;
        setStatus('playing');
        speakAt(0);
      }, [supported, speech.length, speakAt]);

      const pause = React.useCallback(() => {
        try { window.speechSynthesis.pause(); setStatus('paused'); } catch { /* ignore */ }
      }, []);
      const resume = React.useCallback(() => {
        try { window.speechSynthesis.resume(); setStatus('playing'); } catch { /* ignore */ }
      }, []);

      return {
        supported,
        voices,
        zhVoices,
        voiceURI,
        setVoiceURI,
        rate,
        setRate,
        pitch,
        setPitch,
        characterVoices,
        setCharacterVoices,
        status,
        current,
        total: speech.length,
        blocks: parsed.blocks,
        currentBlock: current >= 0 ? speech[current]?.blockIndex ?? -1 : -1,
        play,
        pause,
        resume,
        stop,
      };
    }

    // ── 通用控件 ───────────────────────────────────────────────────────────
    function Btn({ children, variant = 'normal', icon, className, ...rest }) {
      return h('button', { ...rest, type: rest.type ?? 'button', className: `PS_btn PS_btn_${variant} ${className ?? ''}` }, icon ? h('span', { className: 'PS_btnIcon', 'aria-hidden': 'true' }, icon) : null, children);
    }
    function IconBtn({ label, children, ...rest }) {
      return h('button', { ...rest, type: 'button', className: 'PS_iconBtn', 'aria-label': label, title: label }, children);
    }
    function Badge({ children, tone = 'muted' }) {
      return h('span', { className: `PS_badge PS_badge_${tone}` }, children);
    }
    function Field({ label, hint, children }) {
      return h('label', { className: 'PS_field' }, h('span', { className: 'PS_fieldLabel' }, label), children, hint ? h('span', { className: 'PS_hint' }, hint) : null);
    }
    function Progress({ value, tone = 'brand' }) {
      return h('div', { className: `PS_progress PS_progress_${tone}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(value ?? 0) }, h('div', { className: 'PS_progressFill', style: { width: `${Math.max(0, Math.min(100, value ?? 0))}%` } }));
    }
    function Modal({ title, children, onClose, footer, wide }) {
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);
      return h('div', { className: 'PS_overlay', role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: `PS_modal ${wide ? 'PS_modalWide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'PS_modalHead' }, h('h3', { className: 'PS_modalTitle' }, title), h(IconBtn, { label: T('关闭'), onClick: onClose }, '×')),
          h('div', { className: 'PS_modalBody' }, children),
          footer ? h('div', { className: 'PS_modalFoot' }, footer) : null
        )
      );
    }

    function ErrorBoundary({ children }) {
      return h(ErrorBoundaryInner, null, children);
    }
    class ErrorBoundaryInner extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      componentDidCatch(error) { console.error('[pingshu] panel crashed', error); }
      render() {
        if (this.state.error) {
          return h('div', { className: 'PS_root PS_center' },
            h('div', { className: 'PS_card PS_pad' },
              h('h3', null, '评书面板出了点问题'),
              h('p', { className: 'PS_muted' }, String(this.state.error?.message ?? this.state.error)),
              h(Btn, { variant: 'primary', onClick: () => window.location.reload() }, '刷新页面')
            )
          );
        }
        return this.props.children;
      }
    }

    // ── 侧栏图标 ───────────────────────────────────────────────────────────
    function PingshuGlyph({ size = 18 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3.2 5.4c2-1 4-1 6 .2v12.8c-2-1.2-4-1.2-6-.2V5.4Z', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
        h('path', { d: 'M20.8 5.4c-2-1-4-1-6 .2v12.8c2-1.2 4-1.2 6-.2V5.4Z', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
        h('path', { d: 'M12 5.6v12.8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M17.4 16.2c1.3.8 2 1.9 2 3.2M15 17.6c.7.5 1.1 1.1 1.1 1.9', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })
      );
    }

    // ── 导入对话框 ─────────────────────────────────────────────────────────
    function ImportDialog({ onClose, onSubmit, onDone }) {
      const [file, setFile] = React.useState(null);
      const [title, setTitle] = React.useState('');
      const [author, setAuthor] = React.useState('');
      const [drag, setDrag] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [progress, setProgress] = React.useState(0);
      const [phase, setPhase] = React.useState('');
      const [error, setError] = React.useState('');
      const inputRef = React.useRef(null);

      const pick = (selected) => {
        if (!selected) return;
        setFile(selected);
        setError('');
        if (!title.trim()) setTitle(selected.name.replace(/\.[^.]+$/u, '').replace(/[_-]+/gu, ' ').trim());
      };
      const onDrop = (event) => {
        event.preventDefault();
        setDrag(false);
        const selected = event.dataTransfer?.files?.[0];
        pick(selected);
      };
      const submit = async (analyze) => {
        if (!file) { setError('请先选择一本书'); return; }
        if (file.size > 80 * 1024 * 1024) { setError(`文件太大（${formatSize(file.size)}），上限 80MB`); return; }
        setBusy(true);
        setError('');
        setProgress(0);
        setPhase(T('上传中…'));
        try {
          const result = await onSubmit({
            file,
            title: title.trim(),
            author: author.trim(),
            analyze,
          }, (value, text) => {
            setProgress(value);
            if (text) setPhase(text);
          });
          await onDone(result, analyze);
          onClose();
        } catch (submitError) {
          setError(submitError instanceof Error ? submitError.message : String(submitError));
          setBusy(false);
          setPhase('');
        }
      };

      return h(Modal, {
        title: T('新建项目'),
        onClose: busy ? () => {} : onClose,
        footer: h(React.Fragment, null,
          h(Btn, { onClick: onClose, disabled: busy }, T('取消')),
          h(Btn, { variant: 'normal', onClick: () => void submit(false), disabled: busy }, T('只导入')),
          h(Btn, { variant: 'primary', onClick: () => void submit(true), disabled: busy }, busy ? T('上传中…') : T('导入并开始分析'))
        ),
      },
        h('div', {
          className: `PS_drop ${drag ? 'PS_dropActive' : ''}`,
          onDragOver: (event) => { event.preventDefault(); setDrag(true); },
          onDragLeave: () => setDrag(false),
          onDrop,
          onClick: (event) => { if (event.target === inputRef.current) return; inputRef.current?.click(); },
          role: 'button',
          tabIndex: 0,
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click(); },
        },
          h('div', { className: 'PS_dropIcon' }, '＋'),
          h('div', { className: 'PS_dropTitle' }, file ? file.name : '把 EPUB / PDF / TXT / Markdown 拖到这里，或点击选择'),
          h('div', { className: 'PS_hint' }, file ? `${formatSize(file.size)} · ${file.type || '未知类型'}` : '文件只保存在本机，不会上传到第三方'),
          h('input', {
            ref: inputRef,
            type: 'file',
            accept: '.epub,.pdf,.txt,.md,.markdown,application/epub+zip,application/pdf,text/plain,text/markdown',
            style: { display: 'none' },
            onClick: (event) => event.stopPropagation(),
            onChange: (event) => pick(event.target.files?.[0]),
          })
        ),
        h('div', { className: 'PS_formGrid' },
          h(Field, { label: '书名' }, h('input', { className: 'PS_input', value: title, onChange: (event) => setTitle(event.target.value), placeholder: '例如：三国演义', disabled: busy })),
          h(Field, { label: '作者（可选）' }, h('input', { className: 'PS_input', value: author, onChange: (event) => setAuthor(event.target.value), placeholder: '例如：罗贯中', disabled: busy }))
        ),
        busy ? h('div', { className: 'PS_importProgress' }, h(Progress, { value: progress * 100 }), h('div', { className: 'PS_hint' }, `${phase} ${Math.round(progress * 100)}%`)) : null,
        error ? h('div', { className: 'PS_error' }, error) : null,
        h('div', { className: 'PS_hint PS_mt' }, '导入完成后会自动开一个新对话做书目分析；选「只导入」则稍后手动开始。')
      );
    }

    // ── 开讲对话框 ─────────────────────────────────────────────────────────
    function SpeakDialog({ chapter, previous, onClose, onConfirm }) {
      const [style, setStyle] = React.useState('传统评书');
      const [explanation, setExplanation] = React.useState('适中');
      const [notes, setNotes] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const submit = async () => {
        setBusy(true);
        setError('');
        try {
          const ok = await onConfirm({ style, explanation, notes }, previous?.versionId);
          if (ok === false) {
            setError('对话没有开起来，请重试；如果一直失败，请检查插件是否启用。');
            return;
          }
          onClose();
        } catch (submitError) {
          setError(submitError instanceof Error ? submitError.message : String(submitError));
        } finally {
          setBusy(false);
        }
      };
      return h(Modal, {
        title: previous ? `重讲 · ${chapter?.title ?? ''}` : `讲这一回 · ${chapter?.title ?? ''}`,
        onClose,
        footer: h(React.Fragment, null,
          h(Btn, { onClick: onClose, disabled: busy }, T('取消')),
          h(Btn, { variant: 'primary', onClick: () => void submit(), disabled: busy }, busy ? '正在开对话…' : '开讲（新对话）')
        ),
      },
        previous ? h('div', { className: 'PS_notice' }, `这一回已经讲过 ${previous.versionId}；AI 会读上一版再按你的要求调整。`) : null,
        h('div', { className: 'PS_notice' }, '不设字数/时长上限：AI 会把这一回的故事完整讲完；原文短就按原文讲，不编造。'),
        h('div', { className: 'PS_formGrid' },
          h(Field, { label: '风格' }, h('select', { className: 'PS_input', value: style, onChange: (event) => setStyle(event.target.value), disabled: busy },
            ['传统评书', '轻松幽默', '少儿版', '悬疑加快'].map((value) => h('option', { key: value, value }, value))
          )),
          h(Field, { label: '讲解力度', hint: '精简=只解释影响理解的概念；详细=多给背景、类比、人物关系' }, h('select', { className: 'PS_input', value: explanation, onChange: (event) => setExplanation(event.target.value), disabled: busy },
            ['精简', '适中', '详细'].map((value) => h('option', { key: value, value }, value))
          ))
        ),
        h(Field, { label: '备注（可选）' }, h('textarea', {
          className: 'PS_input PS_textarea',
          rows: 3,
          value: notes,
          onChange: (event) => setNotes(event.target.value),
          placeholder: '例如：多讲讲官职；对话再口语化一点；给孩子听，少讲血腥',
          disabled: busy,
        })),
        error ? h('div', { className: 'PS_error' }, error) : null
      );
    }

    // ── 开播按钮 / TTS 播放器 ──────────────────────────────────────────────
    function BrowserTtsControls({ tts, autoPlay }) {
      const [showSettings, setShowSettings] = React.useState(false);
      React.useEffect(() => {
        if (!autoPlay || tts.total === 0) return undefined;
        const timer = setTimeout(() => tts.play(), 140);
        return () => clearTimeout(timer);
      }, []);
      if (!tts.supported) {
        return h('div', { className: 'PS_ttsBody' }, h('div', { className: 'PS_error' }, '当前浏览器不支持语音朗读（Web Speech API）。仍可阅读文案，或换一个支持中文语音的浏览器。'));
      }
      const noZh = tts.zhVoices.length === 0;
      const isPlaying = tts.status === 'playing';
      const isPaused = tts.status === 'paused';
      return h('div', { className: 'PS_ttsBody' },
        h('div', { className: 'PS_ttsMain' },
          h(Btn, {
            variant: 'primary',
            onClick: () => {
              if (isPlaying) tts.pause();
              else if (isPaused) tts.resume();
              else tts.play();
            },
            disabled: tts.total === 0,
          }, isPlaying ? '暂停' : isPaused ? '继续' : '朗读'),
          h(Btn, { onClick: tts.stop, disabled: tts.status === 'idle' }, '停止'),
          h('div', { className: 'PS_ttsMeta' },
            h('span', null, tts.total > 0 ? `第 ${Math.max(1, tts.current + 1)}/${tts.total} 句` : '没有可朗读的文字'),
            h('span', { className: 'PS_muted' }, noZh ? '（没找到中文语音，可能读得不准）' : (tts.voiceURI ? '' : '跟随系统默认中文语音'))
          )
        ),
        h('div', { className: 'PS_ttsProgress' }, h(Progress, { value: tts.total > 0 ? ((tts.current + 1) / tts.total) * 100 : 0 })),
        h('div', { className: 'PS_ttsControls' },
          h('label', { className: 'PS_inlineField' }, '语速', h('input', { type: 'range', min: 0.6, max: 1.5, step: 0.05, value: tts.rate, onChange: (event) => tts.setRate(Number(event.target.value)) })),
          h('label', { className: 'PS_inlineField' }, '音调', h('input', { type: 'range', min: 0.7, max: 1.3, step: 0.05, value: tts.pitch, onChange: (event) => tts.setPitch(Number(event.target.value)) })),
          h('label', { className: 'PS_check' }, h('input', { type: 'checkbox', checked: tts.characterVoices, onChange: (event) => tts.setCharacterVoices(event.target.checked) }), '角色变声'),
          h(Btn, { variant: 'ghost', onClick: () => setShowSettings((value) => !value) }, '音色'),
          h('select', {
            className: 'PS_input PS_voiceSelect',
            value: tts.voiceURI,
            onChange: (event) => tts.setVoiceURI(event.target.value),
            'aria-label': '叙述者音色',
          },
            h('option', { value: '' }, '默认中文语音'),
            tts.voices.map((voice) => h('option', { key: voice.voiceURI, value: voice.voiceURI }, `${voice.name}${voice.lang ? `（${voice.lang}）` : ''}`))
          )
        ),
        showSettings ? h('div', { className: 'PS_hint PS_ttsHint' }, '角色变声会在人物对白时换一个中文音色（没有第二个中文音色时只调整音调）。音色列表来自操作系统；没有中文语音时请先在系统里安装。') : null
      );
    }

    // ── TTS：浏览器 / 火山豆包 / MOSS-TTSD 切换 ─────────────────────────────
    function TtsBar({ api, projectId, chapterId, versionId, markdown, autoPlay, onHighlight }) {
      const browserTts = useTts(markdown);
      const [config, setConfig] = React.useState(null);
      const [provider, setProvider] = React.useState('browser');
      const [configOpen, setConfigOpen] = React.useState(false);
      const [error, setError] = React.useState('');
      const touchedRef = React.useRef(false);

      React.useEffect(() => {
        let alive = true;
        if (!api) return undefined;
        api.getTtsConfig().then((value) => {
          if (!alive) return;
          setConfig(value);
          if (!touchedRef.current) setProvider(['moss', 'volcengine', 'siliconflow'].includes(value?.provider) ? value.provider : 'browser');
        }).catch((loadError) => {
          if (alive) setError(loadError instanceof Error ? loadError.message : String(loadError));
        });
        return () => { alive = false; };
      }, [api]);

      React.useEffect(() => {
        if (provider === 'browser') {
          onHighlight({ start: browserTts.currentBlock, end: browserTts.currentBlock });
        }
      }, [provider, browserTts.currentBlock, onHighlight]);

      React.useEffect(() => {
        if (provider !== 'browser') browserTts.stop();
      }, [provider, browserTts.stop]);

      React.useEffect(() => {
        onHighlight({ start: -1, end: -1 });
      }, [markdown, onHighlight]);

      const switchProvider = async (next) => {
        touchedRef.current = true;
        setProvider(next);
        setError('');
        onHighlight({ start: -1, end: -1 });
        if (next === 'browser') browserTts.stop();
        if (!api) return;
        try {
          const saved = await api.saveTtsConfig({ provider: next });
          setConfig(saved);
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : String(saveError));
        }
      };

      const onConfigSaved = (saved) => {
        setConfig(saved);
        setProvider(['moss', 'volcengine', 'siliconflow'].includes(saved?.provider) ? saved.provider : 'browser');
        setConfigOpen(false);
      };

      return h('div', { className: 'PS_ttsBar' },
        h('div', { className: 'PS_ttsProviderRow' },
          h('span', { className: 'PS_ttsProviderLabel' }, '朗读方式'),
          h('select', {
            className: 'PS_input PS_ttsProviderSelect',
            value: provider,
            onChange: (event) => void switchProvider(event.target.value),
            'aria-label': '朗读方式',
          },
            h('option', { value: 'browser' }, '浏览器语音'),
            h('option', { value: 'volcengine' }, '火山豆包'),
            h('option', { value: 'siliconflow' }, '硅基流动'),
            h('option', { value: 'moss' }, 'MOSS-TTSD')
          ),
          provider !== 'browser' ? h(Btn, { variant: 'ghost', onClick: () => setConfigOpen(true) }, '配置') : null
        ),
        provider === 'browser'
          ? h(BrowserTtsControls, { tts: browserTts, autoPlay })
          : h(CloudTtsControls, {
              key: provider,
              api,
              provider,
              projectId,
              chapterId,
              versionId,
              config,
              autoPlay,
              onConfig: () => setConfigOpen(true),
              onHighlight,
            }),
        error ? h('div', { className: 'PS_error' }, error) : null,
        configOpen && provider === 'moss' ? h(MossConfigDialog, {
          api,
          config,
          onClose: () => setConfigOpen(false),
          onSaved: onConfigSaved,
        }) : null,
        configOpen && provider === 'volcengine' ? h(VolcConfigDialog, {
          api,
          config,
          onClose: () => setConfigOpen(false),
          onSaved: onConfigSaved,
        }) : null,
        configOpen && provider === 'siliconflow' ? h(SiliconConfigDialog, {
          api,
          config,
          onClose: () => setConfigOpen(false),
          onSaved: onConfigSaved,
        }) : null
      );
    }

    function CloudTtsControls({ api, provider, projectId, chapterId, versionId, config, autoPlay, onConfig, onHighlight }) {
      const [job, setJob] = React.useState(null);
      const [audioIndex, setAudioIndex] = React.useState(-1);
      const [playing, setPlaying] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [audioDuration, setAudioDuration] = React.useState(0);
      const audioRef = React.useRef(null);
      const pollRef = React.useRef(null);
      const aliveRef = React.useRef(true);
      const autoRef = React.useRef(false);
      const configured = provider === 'moss'
        ? Boolean(config?.moss?.narrator?.file)
        : provider === 'volcengine'
          ? Boolean(config?.volcengine?.apiKeySet && config?.volcengine?.speaker)
          : Boolean(config?.siliconflow?.apiKeySet && config?.siliconflow?.model && config?.siliconflow?.voice);
      const chunks = Array.isArray(job?.chunks) ? job.chunks.filter(Boolean) : [];

      React.useEffect(() => () => {
        aliveRef.current = false;
        if (pollRef.current) clearTimeout(pollRef.current);
        const audio = audioRef.current;
        if (audio) {
          try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* ignore */ }
        }
      }, []);

      const playChunk = (index, list = chunks) => {
        const chunk = list[index];
        const audio = audioRef.current;
        if (!chunk || !audio) return;
        setAudioIndex(index);
        setPlaying(true);
        setAudioDuration(0);
        onHighlight({ start: chunk.blockStart, end: chunk.blockEnd });
        audio.src = new URL(chunk.url, window.location.origin).toString();
        const promise = audio.play();
        if (promise && typeof promise.catch === 'function') {
          promise.catch(() => {
            setPlaying(false);
            setError('浏览器阻止了自动播放；点「播放」继续。');
          });
        }
      };

      const poll = (jobId) => {
        const tick = async () => {
          if (!aliveRef.current) return;
          if (!api) { setBusy(false); setError('插件 API 不可用'); return; }
          try {
            const value = await api.ttsJob({ jobId });
            if (!aliveRef.current) return;
            setJob(value);
            if (value.status === 'ready') {
              setBusy(false);
              const list = Array.isArray(value.chunks) ? value.chunks.filter(Boolean) : [];
              if (list.length > 0) playChunk(0, list);
              return;
            }
            if (value.status === 'error' || value.status === 'canceled') {
              setBusy(false);
              setError(value.error || (value.status === 'canceled' ? '合成已取消' : '合成失败'));
              return;
            }
            if (pollRef.current) clearTimeout(pollRef.current);
            pollRef.current = setTimeout(tick, 1500);
          } catch (pollError) {
            if (!aliveRef.current) return;
            setBusy(false);
            setError(pollError instanceof Error ? pollError.message : String(pollError));
          }
        };
        void tick();
      };

      const start = async () => {
        setError('');
        if (pollRef.current) clearTimeout(pollRef.current);
        if (!configured) { onConfig(); return; }
        if (!api) { setError('插件 API 不可用'); return; }
        setJob(null);
        setAudioIndex(-1);
        setPlaying(false);
        onHighlight({ start: -1, end: -1 });
        setBusy(true);
        try {
          const value = await api.ttsStart({ projectId, chapterId, versionId, provider });
          if (!aliveRef.current) return;
          setJob(value);
          if (value.status === 'ready' && Array.isArray(value.chunks) && value.chunks.length > 0) {
            setBusy(false);
            playChunk(0, value.chunks);
          } else if (value.status === 'error') {
            setBusy(false);
            setError(value.error || '合成失败');
          } else {
            poll(value.jobId);
          }
        } catch (startError) {
          if (!aliveRef.current) return;
          setBusy(false);
          setError(startError instanceof Error ? startError.message : String(startError));
        }
      };

      React.useEffect(() => {
        if (!autoPlay || autoRef.current || !configured) return;
        autoRef.current = true;
        void start();
      }, [autoPlay, configured]);

      const pause = () => {
        const audio = audioRef.current;
        if (audio) audio.pause();
        setPlaying(false);
      };
      const resume = () => {
        const audio = audioRef.current;
        if (!audio) return;
        const promise = audio.play();
        if (promise && typeof promise.catch === 'function') promise.then(() => setPlaying(true)).catch(() => setError('播放失败'));
        else setPlaying(true);
      };
      const stop = () => {
        const audio = audioRef.current;
        if (audio) { audio.pause(); audio.currentTime = 0; }
        setPlaying(false);
        setAudioIndex(-1);
        onHighlight({ start: -1, end: -1 });
        if (job && (job.status === 'running' || job.status === 'queued')) {
          if (api) void api.ttsCancel({ jobId: job.jobId }).catch(() => undefined);
          setJob({ ...job, status: 'canceled' });
          setBusy(false);
        }
      };
      const cancel = () => {
        if (job?.jobId && api) void api.ttsCancel({ jobId: job.jobId }).catch(() => undefined);
        if (pollRef.current) clearTimeout(pollRef.current);
        setJob(job ? { ...job, status: 'canceled' } : null);
        setBusy(false);
      };
      const next = () => { if (audioIndex + 1 < chunks.length) playChunk(audioIndex + 1); };
      const prev = () => { if (audioIndex > 0) playChunk(audioIndex - 1); };

      const running = Boolean(job && (job.status === 'running' || job.status === 'queued'));
      const progress = job?.total ? Math.round((job.progress / job.total) * 100) : 0;

      return h('div', { className: 'PS_ttsBody' },
        h('audio', {
          ref: audioRef,
          style: { display: 'none' },
          onEnded: () => {
            if (audioIndex + 1 < chunks.length) playChunk(audioIndex + 1);
            else {
              setPlaying(false);
              setAudioIndex(-1);
              onHighlight({ start: -1, end: -1 });
            }
          },
          onLoadedMetadata: (event) => {
            const duration = Number(event.currentTarget.duration);
            if (Number.isFinite(duration) && duration > 0) setAudioDuration(duration);
          },
          onError: () => {
            setPlaying(false);
            setError('音频播放失败；请检查音频文件或重新合成。');
          },
        }),
        !configured ? h('div', { className: 'PS_notice' }, provider === 'moss'
          ? '还没有配置 MOSS-TTSD 的参考音频。先在「配置」里上传一段 10–30 秒的叙述者参考音频和逐字稿。'
          : provider === 'volcengine'
            ? '还没有配置火山豆包的 API Key 和音色。先在「配置」里填 API Key、Resource ID、Speaker ID。'
            : '还没有配置硅基流动的 API Key 和模型。先在「配置」里填 Key（或设置 SILICON_FLOW_API_KEY）、模型和 voice。') : null,
        h('div', { className: 'PS_ttsMain' },
          !running && (!job || job.status === 'ready' || job.status === 'error' || job.status === 'canceled')
            ? h(Btn, { variant: 'primary', onClick: () => void start(), disabled: busy }, busy ? '正在合成…' : (job?.status === 'ready' ? '重新合成' : '合成并朗读'))
            : null,
          running ? h('span', { className: 'PS_ttsMeta' }, `正在合成 ${job.progress}/${job.total} 段…`) : null,
          running ? h(Btn, { onClick: cancel }, '取消合成') : null,
          job?.status === 'ready' && chunks.length > 0
            ? h(React.Fragment, null,
                h(Btn, { variant: 'primary', onClick: () => { if (playing) pause(); else if (audioIndex >= 0) resume(); else playChunk(0); } }, playing ? '暂停' : (audioIndex >= 0 ? '继续' : '播放')),
                h(Btn, { onClick: stop }, '停止'),
                h(Btn, { onClick: prev, disabled: audioIndex <= 0 }, '上一段'),
                h(Btn, { onClick: next, disabled: audioIndex < 0 || audioIndex + 1 >= chunks.length }, '下一段')
              )
            : null,
          h(Btn, { variant: 'ghost', onClick: onConfig }, '配置')
        ),
        job?.status === 'ready' && chunks.length > 0
          ? h(React.Fragment, null,
              h('div', { className: 'PS_ttsProgress' }, h(Progress, { value: chunks.length ? ((Math.max(0, audioIndex) + 1) / chunks.length) * 100 : 0 })),
              h('div', { className: 'PS_ttsMeta' }, `第 ${Math.max(1, audioIndex + 1)}/${chunks.length} 段 · ${(() => {
                const seconds = Number(chunks[Math.max(0, audioIndex)]?.duration) || audioDuration || 0;
                return seconds <= 0 ? '时长未知' : seconds < 1 ? '不到 1 秒' : `约 ${Math.round(seconds)} 秒`;
              })()}`)
            )
          : running
            ? h('div', { className: 'PS_ttsProgress' }, h(Progress, { value: progress }))
            : null,
        h('div', { className: 'PS_hint PS_ttsHint' }, provider === 'moss'
          ? 'MOSS-TTSD 走本地 HTTP 服务；首次合成可能较慢，生成后缓存在本机。参考音频只使用你有权使用的声音。'
          : provider === 'volcengine'
            ? '火山豆包走官方云端接口；按字符计费；生成后缓存在本机。API Key 只保存在本地，不会回传到浏览器。'
            : '硅基流动走官方云端接口（MOSS-TTSD-v0.5 等模型）；按量计费；生成后缓存在本机。API Key 不会回传到浏览器。'),
        error ? h('div', { className: 'PS_error' }, error) : null
      );
    }

    function MossConfigDialog({ api, config, onClose, onSaved }) {
      const moss = config?.moss ?? {};
      const [endpoint, setEndpoint] = React.useState(moss.endpoint ?? 'http://127.0.0.1:30000/generate');
      const [narratorFile, setNarratorFile] = React.useState(moss.narrator?.file ?? '');
      const [narratorText, setNarratorText] = React.useState(moss.narrator?.text ?? '');
      const [characterFile, setCharacterFile] = React.useState(moss.character?.file ?? '');
      const [characterText, setCharacterText] = React.useState(moss.character?.text ?? '');
      const [maxNewTokens, setMaxNewTokens] = React.useState(moss.maxNewTokens ?? 8192);
      const [chunkChars, setChunkChars] = React.useState(moss.chunkChars ?? 1200);
      const [temperature, setTemperature] = React.useState(moss.temperature ?? 1.1);
      const [topP, setTopP] = React.useState(moss.topP ?? 0.9);
      const [topK, setTopK] = React.useState(moss.topK ?? 50);
      const [busy, setBusy] = React.useState('');
      const [test, setTest] = React.useState(null);
      const [error, setError] = React.useState('');
      const narratorInput = React.useRef(null);
      const characterInput = React.useRef(null);

      const upload = async (kind, file) => {
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) { setError('参考音频太大（上限 20MB）'); return; }
        setBusy(`upload-${kind}`);
        setError('');
        try {
          const data = await fileToBase64(file);
          const result = await api.uploadTtsReference({ kind, name: file.name, data });
          if (kind === 'narrator') setNarratorFile(result.file);
          else setCharacterFile(result.file);
        } catch (uploadError) {
          setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
        } finally {
          setBusy('');
        }
      };

      const save = async () => {
        if (!api) { setError('插件 API 不可用'); return; }
        setBusy('save');
        setError('');
        try {
          const saved = await api.saveTtsConfig({
            provider: 'moss',
            moss: {
              endpoint,
              narrator: { file: narratorFile, text: narratorText },
              character: { file: characterFile, text: characterText },
              maxNewTokens: Number(maxNewTokens) || 8192,
              chunkChars: Number(chunkChars) || 1200,
              temperature: Number(temperature) || 1.1,
              topP: Number(topP) || 0.9,
              topK: Number(topK) || 50,
            },
          });
          onSaved(saved);
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : String(saveError));
        } finally {
          setBusy('');
        }
      };

      const runTest = async () => {
        if (!api) { setError('插件 API 不可用'); return; }
        setBusy('test');
        setTest(null);
        setError('');
        try {
          setTest(await api.ttsTest({ endpoint }));
        } catch (testError) {
          setTest({ ok: false, error: testError instanceof Error ? testError.message : String(testError) });
        } finally {
          setBusy('');
        }
      };

      const fileName = (value) => (value ? String(value).split('/').pop() : '未上传');

      return h(Modal, {
        title: 'MOSS-TTSD 设置',
        onClose,
        wide: true,
        footer: h(React.Fragment, null,
          h(Btn, { onClick: onClose, disabled: Boolean(busy) }, T('取消')),
          h(Btn, { variant: 'primary', onClick: () => void save(), disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : T('保存'))
        ),
      },
        h('div', { className: 'PS_notice' }, '先按 MOSS-TTSD 官方文档启动 SGLang 推理服务（默认 30000 端口），再把地址填到这里。插件不打包模型；参考音频只使用你有权使用的声音。'),
        h('div', { className: 'PS_inline' },
          h('input', { className: 'PS_input PS_grow', value: endpoint, onChange: (event) => setEndpoint(event.target.value), placeholder: 'http://127.0.0.1:30000/generate', disabled: Boolean(busy) }),
          h(Btn, { onClick: () => void runTest(), disabled: Boolean(busy) }, busy === 'test' ? '测试中…' : '测试连接')
        ),
        test ? h('div', { className: test.ok ? 'PS_notice' : 'PS_error' }, test.warning || test.message || test.error || (test.ok ? '服务可达' : '连接失败')) : null,
        h('div', { className: 'PS_formGrid' },
          h(Field, { label: '叙述者参考音频', hint: '10–30 秒单人说话；建议 WAV' },
            h('div', { className: 'PS_fileRow' },
              h('input', { ref: narratorInput, type: 'file', accept: '.wav,.mp3,.flac,.ogg,.m4a,audio/*', style: { display: 'none' }, onChange: (event) => { void upload('narrator', event.target.files?.[0]); event.target.value = ''; } }),
              h(Btn, { onClick: () => narratorInput.current?.click(), disabled: Boolean(busy) }, narratorFile ? '更换' : '上传'),
              h('span', { className: 'PS_hint' }, fileName(narratorFile))
            )
          ),
          h(Field, { label: '叙述者参考文字', hint: '这段音频的逐字稿；越准确，克隆越稳' },
            h('textarea', { className: 'PS_input PS_textarea', rows: 3, value: narratorText, onChange: (event) => setNarratorText(event.target.value), placeholder: '把参考音频里说的话逐字写下来', disabled: Boolean(busy) })
          )
        ),
        h('div', { className: 'PS_formGrid' },
          h(Field, { label: '角色参考音频（可选）', hint: '不传则所有角色共用叙述者音色' },
            h('div', { className: 'PS_fileRow' },
              h('input', { ref: characterInput, type: 'file', accept: '.wav,.mp3,.flac,.ogg,.m4a,audio/*', style: { display: 'none' }, onChange: (event) => { void upload('character', event.target.files?.[0]); event.target.value = ''; } }),
              h(Btn, { onClick: () => characterInput.current?.click(), disabled: Boolean(busy) }, characterFile ? '更换' : '上传'),
              h('span', { className: 'PS_hint' }, fileName(characterFile))
            )
          ),
          h(Field, { label: '角色参考文字（可选）' },
            h('textarea', { className: 'PS_input PS_textarea', rows: 3, value: characterText, onChange: (event) => setCharacterText(event.target.value), placeholder: '角色参考音频的逐字稿', disabled: Boolean(busy) })
          )
        ),
        h('details', { className: 'PS_advanced' },
          h('summary', null, '高级参数'),
          h('div', { className: 'PS_formGrid PS_formGrid3' },
            h(Field, { label: 'max_new_tokens' }, h('input', { className: 'PS_input', type: 'number', min: 256, max: 16384, value: maxNewTokens, onChange: (event) => setMaxNewTokens(Number(event.target.value)), disabled: Boolean(busy) })),
            h(Field, { label: '每段字数' }, h('input', { className: 'PS_input', type: 'number', min: 300, max: 3000, value: chunkChars, onChange: (event) => setChunkChars(Number(event.target.value)), disabled: Boolean(busy) })),
            h(Field, { label: 'temperature' }, h('input', { className: 'PS_input', type: 'number', min: 0.1, max: 2, step: 0.05, value: temperature, onChange: (event) => setTemperature(Number(event.target.value)), disabled: Boolean(busy) })),
            h(Field, { label: 'top_p' }, h('input', { className: 'PS_input', type: 'number', min: 0.1, max: 1, step: 0.05, value: topP, onChange: (event) => setTopP(Number(event.target.value)), disabled: Boolean(busy) })),
            h(Field, { label: 'top_k' }, h('input', { className: 'PS_input', type: 'number', min: 1, max: 200, value: topK, onChange: (event) => setTopK(Number(event.target.value)), disabled: Boolean(busy) }))
          )
        ),
        error ? h('div', { className: 'PS_error' }, error) : null
      );
    }

    function VolcConfigDialog({ api, config, onClose, onSaved }) {
      const volc = config?.volcengine ?? {};
      const [endpoint, setEndpoint] = React.useState(volc.endpoint ?? 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
      const [apiKey, setApiKey] = React.useState('');
      const [resourceId, setResourceId] = React.useState(volc.resourceId ?? 'seed-tts-2.0');
      const [speaker, setSpeaker] = React.useState(volc.speaker ?? 'zh_female_vv_uranus_bigtts');
      const [sampleRate, setSampleRate] = React.useState(volc.sampleRate ?? 24000);
      const [speechRate, setSpeechRate] = React.useState(volc.speechRate ?? 0);
      const [loudnessRate, setLoudnessRate] = React.useState(volc.loudnessRate ?? 0);
      const [pitch, setPitch] = React.useState(volc.pitch ?? 0);
      const [model, setModel] = React.useState(volc.model ?? '');
      const [chunkChars, setChunkChars] = React.useState(volc.chunkChars ?? 1000);
      const [busy, setBusy] = React.useState('');
      const [test, setTest] = React.useState(null);
      const [error, setError] = React.useState('');
      const apiKeySet = Boolean(volc.apiKeySet);
      const apiKeyMasked = volc.apiKeyMasked ?? '';

      const runTest = async () => {
        if (!api) { setError('插件 API 不可用'); return; }
        setBusy('test');
        setTest(null);
        setError('');
        try {
          setTest(await api.volcTest({
            endpoint,
            apiKey,
            resourceId,
            speaker,
            sampleRate: Number(sampleRate),
          }));
        } catch (testError) {
          setTest({ ok: false, error: testError instanceof Error ? testError.message : String(testError) });
        } finally {
          setBusy('');
        }
      };

      const save = async () => {
        if (!api) { setError('插件 API 不可用'); return; }
        setBusy('save');
        setError('');
        try {
          const saved = await api.saveTtsConfig({
            provider: 'volcengine',
            volcengine: {
              endpoint,
              apiKey,
              resourceId,
              speaker,
              sampleRate: Number(sampleRate),
              speechRate: Number(speechRate),
              loudnessRate: Number(loudnessRate),
              pitch: Number(pitch),
              model,
              chunkChars: Number(chunkChars),
            },
          });
          onSaved(saved);
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : String(saveError));
        } finally {
          setBusy('');
        }
      };

      return h(Modal, {
        title: '火山豆包语音设置',
        onClose,
        wide: true,
        footer: h(React.Fragment, null,
          h(Btn, { onClick: onClose, disabled: Boolean(busy) }, T('取消')),
          h(Btn, { variant: 'primary', onClick: () => void save(), disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : T('保存'))
        ),
      },
        h('div', { className: 'PS_notice' }, 'Key 从火山引擎控制台「API Key 管理」获取；Speaker ID 从「音色库」复制。合成按字符计费；API Key 只保存在本机 tts.json（权限 600），不会回传到浏览器。'),
        h('div', { className: 'PS_formGrid' },
          h(Field, { label: 'API Key', hint: apiKeySet ? `已保存（${apiKeyMasked}）；留空保持不变` : '必填；从控制台 API Key 管理获取' },
            h('input', {
              className: 'PS_input',
              type: 'password',
              value: apiKey,
              onChange: (event) => setApiKey(event.target.value),
              placeholder: apiKeySet ? '已保存，留空不变' : '粘贴 API Key',
              autoComplete: 'off',
              disabled: Boolean(busy),
            })
          ),
          h(Field, { label: 'Resource ID', hint: '预置音色用 seed-tts-2.0；克隆音色用 seed-icl-2.0' },
            h('select', { className: 'PS_input', value: resourceId, onChange: (event) => setResourceId(event.target.value), disabled: Boolean(busy) },
              h('option', { value: 'seed-tts-2.0' }, 'seed-tts-2.0（语音合成 2.0）'),
              h('option', { value: 'seed-icl-2.0' }, 'seed-icl-2.0（声音复刻 2.0）')
            )
          )
        ),
        h('div', { className: 'PS_formGrid' },
          h(Field, { label: 'Speaker ID（音色 ID）', hint: '从控制台音色库复制；例如 zh_female_vv_uranus_bigtts' },
            h('input', { className: 'PS_input', value: speaker, onChange: (event) => setSpeaker(event.target.value), placeholder: 'zh_female_vv_uranus_bigtts', disabled: Boolean(busy) })
          ),
          h(Field, { label: '采样率', hint: 'MP3 推荐 24000' },
            h('select', { className: 'PS_input', value: sampleRate, onChange: (event) => setSampleRate(Number(event.target.value)), disabled: Boolean(busy) },
              [8000, 16000, 22050, 24000, 32000, 44100, 48000].map((rate) => h('option', { key: rate, value: rate }, `${rate} Hz`))
            )
          )
        ),
        h('div', { className: 'PS_formGrid PS_formGrid3' },
          h(Field, { label: '语速', hint: '-50 ~ 100，0 为正常' }, h('input', { className: 'PS_input', type: 'number', min: -50, max: 100, value: speechRate, onChange: (event) => setSpeechRate(Number(event.target.value)), disabled: Boolean(busy) })),
          h(Field, { label: '音量', hint: '-50 ~ 100，0 为正常' }, h('input', { className: 'PS_input', type: 'number', min: -50, max: 100, value: loudnessRate, onChange: (event) => setLoudnessRate(Number(event.target.value)), disabled: Boolean(busy) })),
          h(Field, { label: '音调', hint: '-12 ~ 12' }, h('input', { className: 'PS_input', type: 'number', min: -12, max: 12, value: pitch, onChange: (event) => setPitch(Number(event.target.value)), disabled: Boolean(busy) }))
        ),
        h('div', { className: 'PS_inline' },
          h(Btn, { onClick: () => void runTest(), disabled: Boolean(busy) }, busy === 'test' ? '测试中…' : '测试连接（会合成一小段）')
        ),
        test ? h('div', { className: test.ok ? 'PS_notice' : 'PS_error' }, test.message || test.error || (test.ok ? '连接成功' : '连接失败')) : null,
        h('details', { className: 'PS_advanced' },
          h('summary', null, '高级参数'),
          h('div', { className: 'PS_formGrid PS_formGrid3' },
            h(Field, { label: '服务地址' }, h('input', { className: 'PS_input', value: endpoint, onChange: (event) => setEndpoint(event.target.value), disabled: Boolean(busy) })),
            h(Field, { label: 'model（可选）', hint: '仅复刻音色需要；留空用默认' }, h('input', { className: 'PS_input', value: model, onChange: (event) => setModel(event.target.value), placeholder: 'seed-tts-2.0-standard', disabled: Boolean(busy) })),
            h(Field, { label: '每段字数', hint: '300–3000' }, h('input', { className: 'PS_input', type: 'number', min: 300, max: 3000, value: chunkChars, onChange: (event) => setChunkChars(Number(event.target.value)), disabled: Boolean(busy) }))
          )
        ),
        error ? h('div', { className: 'PS_error' }, error) : null
      );
    }

    function SiliconConfigDialog({ api, config, onClose, onSaved }) {
      const sf = config?.siliconflow ?? {};
      const [endpoint, setEndpoint] = React.useState(sf.endpoint ?? 'https://api.siliconflow.cn/v1/audio/speech');
      const [apiKey, setApiKey] = React.useState('');
      const [model, setModel] = React.useState(sf.model ?? 'fnlp/MOSS-TTSD-v0.5');
      const [voice, setVoice] = React.useState(sf.voice ?? 'fnlp/MOSS-TTSD-v0.5:alex');
      const [sampleRate, setSampleRate] = React.useState(sf.sampleRate ?? 44100);
      const [speed, setSpeed] = React.useState(sf.speed ?? 1);
      const [gain, setGain] = React.useState(sf.gain ?? 0);
      const [chunkChars, setChunkChars] = React.useState(sf.chunkChars ?? 1000);
      const [busy, setBusy] = React.useState('');
      const [test, setTest] = React.useState(null);
      const [error, setError] = React.useState('');
      const apiKeySet = Boolean(sf.apiKeySet);
      const apiKeySource = sf.apiKeySource ?? '';
      const apiKeyMasked = sf.apiKeyMasked ?? '';
      const preset = model === 'fnlp/MOSS-TTSD-v0.5'
        ? 'moss'
        : model === 'FunAudioLLM/CosyVoice2-0.5B'
          ? 'cosy'
          : 'custom';

      const choosePreset = (value) => {
        if (value === 'moss') {
          setModel('fnlp/MOSS-TTSD-v0.5');
          setVoice('fnlp/MOSS-TTSD-v0.5:alex');
        } else if (value === 'cosy') {
          setModel('FunAudioLLM/CosyVoice2-0.5B');
          setVoice('FunAudioLLM/CosyVoice2-0.5B:alex');
        }
      };

      const keyHint = apiKeySource === 'env'
        ? `已使用环境变量 SILICON_FLOW_API_KEY（${apiKeyMasked}）；留空沿用，填了覆盖`
        : apiKeySet
          ? `已保存（${apiKeyMasked}）；留空不变`
          : '可留空使用环境变量 SILICON_FLOW_API_KEY，或在这里填';

      const runTest = async () => {
        if (!api) { setError('插件 API 不可用'); return; }
        setBusy('test');
        setTest(null);
        setError('');
        try {
          setTest(await api.siliconTest({
            endpoint,
            apiKey,
            model,
            voice,
            sampleRate: Number(sampleRate),
          }));
        } catch (testError) {
          setTest({ ok: false, error: testError instanceof Error ? testError.message : String(testError) });
        } finally {
          setBusy('');
        }
      };

      const save = async () => {
        if (!api) { setError('插件 API 不可用'); return; }
        setBusy('save');
        setError('');
        try {
          const saved = await api.saveTtsConfig({
            provider: 'siliconflow',
            siliconflow: {
              endpoint,
              apiKey,
              model,
              voice,
              sampleRate: Number(sampleRate),
              speed: Number(speed),
              gain: Number(gain),
              chunkChars: Number(chunkChars),
            },
          });
          onSaved(saved);
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : String(saveError));
        } finally {
          setBusy('');
        }
      };

      return h(Modal, {
        title: '硅基流动语音设置',
        onClose,
        wide: true,
        footer: h(React.Fragment, null,
          h(Btn, { onClick: onClose, disabled: Boolean(busy) }, T('取消')),
          h(Btn, { variant: 'primary', onClick: () => void save(), disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : T('保存'))
        ),
      },
        h('div', { className: 'PS_notice' }, '硅基流动的 MOSS-TTSD 是 v0.5（不是本地那套 v1.0）；接口是 OpenAI 风格的 /v1/audio/speech。输入支持 [S1]/[S2] 双人对话标签，当前一个 voice 对应一个音色。API Key 不会回传到浏览器。'),
        h('div', { className: 'PS_formGrid' },
          h(Field, { label: 'API Key', hint: keyHint },
            h('input', {
              className: 'PS_input',
              type: 'password',
              value: apiKey,
              onChange: (event) => setApiKey(event.target.value),
              placeholder: apiKeySet ? '已设置，留空沿用' : '粘贴 SiliconFlow API Key',
              autoComplete: 'off',
              disabled: Boolean(busy),
            })
          ),
          h(Field, { label: '模型', hint: 'MOSS 用 [S1]/[S2]；CosyVoice2 是单音色，插件会自动去掉说话人标签' },
            h('select', {
              className: 'PS_input',
              value: preset,
              onChange: (event) => choosePreset(event.target.value),
              disabled: Boolean(busy),
              style: { marginBottom: '6px' },
            },
              h('option', { value: 'moss' }, 'MOSS-TTSD-v0.5（对话）'),
              h('option', { value: 'cosy' }, 'CosyVoice2-0.5B（单音色）'),
              h('option', { value: 'custom' }, '自定义模型')
            ),
            h('input', { className: 'PS_input', value: model, onChange: (event) => setModel(event.target.value), placeholder: 'fnlp/MOSS-TTSD-v0.5', disabled: Boolean(busy) })
          )
        ),
        h('div', { className: 'PS_formGrid' },
          h(Field, { label: 'voice', hint: '格式：模型:音色；MOSS 示例 fnlp/MOSS-TTSD-v0.5:alex' },
            h('input', { className: 'PS_input', value: voice, onChange: (event) => setVoice(event.target.value), placeholder: 'fnlp/MOSS-TTSD-v0.5:alex', disabled: Boolean(busy) })
          ),
          h(Field, { label: '采样率', hint: 'MP3 仅支持 32000/44100' },
            h('select', { className: 'PS_input', value: sampleRate, onChange: (event) => setSampleRate(Number(event.target.value)), disabled: Boolean(busy) },
              h('option', { value: 32000 }, '32000 Hz'),
              h('option', { value: 44100 }, '44100 Hz')
            )
          )
        ),
        h('div', { className: 'PS_formGrid PS_formGrid3' },
          h(Field, { label: '语速', hint: '0.25 ~ 4，1 为正常' }, h('input', { className: 'PS_input', type: 'number', min: 0.25, max: 4, step: 0.05, value: speed, onChange: (event) => setSpeed(Number(event.target.value)), disabled: Boolean(busy) })),
          h(Field, { label: '增益 dB', hint: '-10 ~ 10' }, h('input', { className: 'PS_input', type: 'number', min: -10, max: 10, step: 0.5, value: gain, onChange: (event) => setGain(Number(event.target.value)), disabled: Boolean(busy) })),
          h(Field, { label: '每段字数', hint: '300–3000' }, h('input', { className: 'PS_input', type: 'number', min: 300, max: 3000, value: chunkChars, onChange: (event) => setChunkChars(Number(event.target.value)), disabled: Boolean(busy) }))
        ),
        h('div', { className: 'PS_inline' },
          h(Btn, { onClick: () => void runTest(), disabled: Boolean(busy) }, busy === 'test' ? '测试中…' : '测试连接（会合成一小段）')
        ),
        test ? h('div', { className: test.ok ? 'PS_notice' : 'PS_error' }, test.message || test.error || (test.ok ? '连接成功' : '连接失败')) : null,
        h('details', { className: 'PS_advanced' },
          h('summary', null, '高级参数'),
          h('div', { className: 'PS_formGrid' },
            h(Field, { label: '服务地址' }, h('input', { className: 'PS_input', value: endpoint, onChange: (event) => setEndpoint(event.target.value), disabled: Boolean(busy) }))
          )
        ),
        error ? h('div', { className: 'PS_error' }, error) : null
      );
    }

    // ── 阅读器 ─────────────────────────────────────────────────────────────
    function ReaderModal({ reader, onClose, onPerform, onRetell, onDelete, onToast, api, projectId }) {
      const [fontSize, setFontSize] = React.useState(() => {
        try { return Number(localStorage.getItem('pingshu.reader.font')) || 19; } catch { return 19; }
      });
      const scrollRef = React.useRef(null);
      const [highlight, setHighlight] = React.useState({ start: -1, end: -1 });
      const blockRefs = React.useRef(new Map());
      React.useEffect(() => {
        try { localStorage.setItem('pingshu.reader.font', String(fontSize)); } catch { /* ignore */ }
      }, [fontSize]);
      React.useEffect(() => {
        if (highlight.start < 0) return;
        const node = blockRefs.current.get(highlight.start);
        if (node && typeof node.scrollIntoView === 'function') {
          try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
        }
      }, [highlight.start]);

      const isScript = reader.mode === 'performance';
      const parsed = isScript ? parseScript(reader.markdown) : null;
      const blocks = parsed?.blocks ?? [];
      return h('div', { className: 'PS_overlay PS_readerOverlay', role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h('div', { className: 'PS_reader', role: 'dialog', 'aria-modal': 'true', 'aria-label': reader.title },
          h('div', { className: 'PS_readerHead' },
            h('div', null,
              h('div', { className: 'PS_readerKicker' }, reader.kicker ?? ''),
              h('h2', { className: 'PS_readerTitle' }, reader.title ?? '')
            ),
            h('div', { className: 'PS_readerTools' },
              h(IconBtn, { label: '减小字号', onClick: () => setFontSize((value) => Math.max(15, value - 1)) }, 'A−'),
              h(IconBtn, { label: '增大字号', onClick: () => setFontSize((value) => Math.min(30, value + 1)) }, 'A+'),
              reader.mode === 'chapter' && onPerform ? h(Btn, { variant: 'primary', onClick: () => onPerform(reader.chapter) }, T('讲这一回')) : null,
              reader.mode === 'performance' && onRetell ? h(Btn, { onClick: () => onRetell(reader.meta, reader.chapter) }, T('重讲')) : null,
              reader.mode === 'performance' && onDelete ? h(Btn, { variant: 'danger', onClick: () => onDelete(reader.meta) }, T('删除')) : null,
              h(IconBtn, { label: T('关闭'), onClick: onClose }, '×')
            )
          ),
          h('div', { className: 'PS_readerBody', ref: scrollRef },
            reader.truncated ? h('div', { className: 'PS_warnText' }, '这一回太长，只载入了前面一部分；完整原文可以在项目目录的 chapters/ 里查看。') : null,
            isScript
              ? h('div', { className: 'PS_script', style: { '--ps-reader-font': `${fontSize}px` } },
                  blocks.map((block, index) => {
                    if (block.type === 'heading') {
                      const tag = `h${Math.min(6, block.level + 1)}`;
                      return h(tag, { key: `h${index}`, className: 'PS_scriptH' }, block.text);
                    }
                    if (block.type === 'hr') return h('hr', { key: `hr${index}`, className: 'PS_hr' });
                    if (block.type === 'table') return h('pre', { key: `t${index}`, className: 'PS_pre' }, block.text);
                    const blockIndex = block.index;
                    const active = highlight.start >= 0 && blockIndex >= highlight.start && blockIndex <= highlight.end;
                    return h('div', {
                      key: `p${index}`,
                      ref: (node) => { if (node) blockRefs.current.set(blockIndex, node); },
                      className: `PS_scriptP ${active ? 'PS_hl' : ''}`,
                    },
                      block.speaker ? h('span', { className: 'PS_speaker' }, block.speaker) : null,
                      h('span', { className: 'PS_scriptText' }, inline(block.text, `p${index}`))
                    );
                  })
                )
              : h('div', { className: 'PS_plainReader', style: { '--ps-reader-font': `${fontSize}px` } },
                  h(Markdown, { markdown: reader.markdown, title: reader.title, className: 'PS_readerMd' })
                ),
            reader.glossary?.length || reader.characters?.length
              ? h('div', { className: 'PS_sideNotes' },
                  reader.characters?.length ? h('div', { className: 'PS_sideCard' },
                    h('h4', null, '本回人物'),
                    reader.characters.slice(0, 12).map((character) => h('div', { key: character.name, className: 'PS_sideRow' },
                      h('strong', null, character.name),
                      character.role ? h('span', { className: 'PS_muted' }, ` · ${character.role}`) : null,
                      character.profile ? h('div', { className: 'PS_sideText' }, character.profile) : null
                    ))
                  ) : null,
                  reader.glossary?.length ? h('div', { className: 'PS_sideCard' },
                    h('h4', null, '名词解释'),
                    reader.glossary.filter((entry) => String(reader.markdown).includes(entry.term)).slice(0, 20).map((entry) => h('div', { key: entry.term, className: 'PS_sideRow' },
                      h('strong', null, entry.term),
                      h('div', { className: 'PS_sideText' }, entry.explanation, entry.analogy ? `；打个比方：${entry.analogy}` : '')
                    ))
                  ) : null
                )
              : null
          ),
          isScript ? h(TtsBar, {
            api,
            projectId,
            chapterId: reader.meta?.chapterId ?? reader.chapter?.id,
            versionId: reader.meta?.versionId,
            markdown: reader.markdown,
            autoPlay: reader.autoPlay === true,
            onHighlight: setHighlight,
          }) : null
        )
      );
    }

    // ── 项目侧栏 ───────────────────────────────────────────────────────────
    function ProjectRail({ projects, selectedId, search, onSearch, onSelect, onNew, loading }) {
      const filtered = projects.filter((project) => {
        const needle = search.trim().toLowerCase();
        if (needle === '') return true;
        return `${project.title} ${project.author ?? ''}`.toLowerCase().includes(needle);
      });
      return h('aside', { className: 'PS_rail' },
        h('div', { className: 'PS_railHead' },
          h('div', null,
            h('div', { className: 'PS_brandRow' }, h(PingshuGlyph, { size: 20 }), h('h1', { className: 'PS_brand' }, T('评书'))),
            h('div', { className: 'PS_muted PS_small' }, '把书说给您听')
          ),
          h(Btn, { variant: 'primary', onClick: onNew }, '＋ ' + T('新建项目'))
        ),
        h('input', { className: 'PS_input PS_search', value: search, onChange: (event) => onSearch(event.target.value), placeholder: '搜书名 / 作者', 'aria-label': '搜书名或作者' }),
        h('div', { className: 'PS_projectList' },
          loading ? h('div', { className: 'PS_muted PS_pad' }, '正在读取…') : null,
          !loading && filtered.length === 0
            ? h('div', { className: 'PS_emptyRail' },
                h('div', { className: 'PS_emptyGlyph' }, h(PingshuGlyph, { size: 34 })),
                h('div', { className: 'PS_emptyTitle' }, projects.length === 0 ? T('还没有书') : '没有匹配的书'),
                h('div', { className: 'PS_muted PS_small' }, projects.length === 0 ? T('上传一本 EPUB / PDF / TXT / Markdown，开一场评书。') : '换个书名或作者关键词试试。')
              )
            : null,
          filtered.map((project) => {
            const analysis = project.analysis ?? {};
            const summaryPercent = percent(analysis.chapterSummaries ?? 0, project.chapterCount ?? 0);
            return h('button', {
              key: project.id,
              type: 'button',
              className: `PS_projectRow ${project.id === selectedId ? 'PS_projectRowActive' : ''}`,
              onClick: () => onSelect(project.id),
            },
              h('div', { className: 'PS_projectTop' },
                h('span', { className: 'PS_projectTitle' }, project.title),
                project.status === 'importing' ? h(Badge, { tone: 'warn' }, '导入中') : project.status === 'error' ? h(Badge, { tone: 'error' }, '失败') : null
              ),
              h('div', { className: 'PS_projectMeta' }, `${project.chapterCount ?? 0} 回 · ${formatChars(project.charCount ?? 0)}${project.author ? ` · ${project.author}` : ''}`),
              h('div', { className: 'PS_projectBottom' },
                h('span', { className: 'PS_muted PS_small' }, `摘要 ${summaryPercent}%`),
                h('span', { className: 'PS_muted PS_small' }, `${project.performanceCount ?? 0} 版评书`)
              )
            );
          })
        )
      );
    }

    // ── 项目头部 ───────────────────────────────────────────────────────────
    function ProjectHeader({ project, busy, onAnalyze, onRefresh, onRename, onDelete, onOpenChat, onResplit }) {
      const analysis = project.analysis ?? {};
      const summaryPercent = percent(analysis.chapterSummaries ?? 0, project.chapterCount ?? 0);
      const status = project.status === 'importing' ? '导入中' : project.status === 'error' ? '导入失败' : '就绪';
      return h('div', { className: 'PS_projectHead' },
        h('div', { className: 'PS_projectHeadMain' },
          h('div', { className: 'PS_titleRow' },
            h('h2', { className: 'PS_projectName' }, project.title),
            h(Badge, { tone: project.status === 'error' ? 'error' : project.status === 'importing' ? 'warn' : 'ok' }, status),
            project.format ? h(Badge, null, String(project.format).toUpperCase()) : null
          ),
          h('div', { className: 'PS_muted PS_small' },
            `${project.chapterCount ?? 0} 回 · ${formatChars(project.charCount ?? 0)}${project.author ? ` · ${project.author}` : ''} · ${analysis.chapterSummaries ?? 0} 回摘要 · ${project.performanceCount ?? 0} 版评书`
          ),
          h('div', { className: 'PS_headProgress' },
            h(Progress, { value: summaryPercent }),
            h('span', { className: 'PS_muted PS_small' }, `资料 ${summaryPercent}%`)
          ),
          project.warnings?.length ? h('div', { className: 'PS_warnText' }, project.warnings.join('；')) : null
        ),
        h('div', { className: 'PS_headActions' },
          h(Btn, { variant: 'primary', disabled: busy || project.status !== 'ready', onClick: onAnalyze }, analysis.complete ? T('重新分析') : (analysis.chapterSummaries > 0 ? T('继续分析') : T('开始分析'))),
          project.lastSessionId ? h(Btn, { onClick: onOpenChat }, T('打开最近对话')) : null,
          h(Btn, { onClick: onRefresh, disabled: busy }, T('刷新')),
          h(Btn, { onClick: onRename, disabled: busy }, T('改名')),
          h(Btn, { variant: 'danger', onClick: onDelete, disabled: busy }, T('删除')),
          h(Btn, { variant: 'ghost', onClick: onResplit, disabled: busy, title: '重建回目会重置章节摘要' }, '重新分章')
        )
      );
    }

    // ── 回目页 ─────────────────────────────────────────────────────────────
    function ChapterTab({ project, onRead, onPerform, onAnalyze, busy }) {
      const [search, setSearch] = React.useState('');
      const [limit, setLimit] = React.useState(100);
      const chapters = Array.isArray(project.chapters) ? project.chapters : [];
      const filtered = chapters.filter((chapter) => {
        const needle = search.trim().toLowerCase();
        return needle === '' || String(chapter.title).toLowerCase().includes(needle);
      });
      const visible = filtered.slice(0, limit);
      if (project.status === 'importing') {
        const stageLabels = { waiting: '等待上传', uploaded: '等待开始', reading: '读取文件', extracting: '提取文字', splitting: '识别回目', writing: '写入回目' };
        const stage = stageLabels[project.import?.stage] ?? '处理中';
        return h('div', { className: 'PS_importingCard' },
          h('h3', null, '正在导入…'),
          h('p', { className: 'PS_muted' }, `当前：${stage}。导入完成后这里会出现回目，并自动开一个分析对话。`),
          h('div', { className: 'PS_pulseBar', 'aria-hidden': 'true' }, h('div', { className: 'PS_pulseFill' }))
        );
      }
      if (project.status === 'error') {
        return h('div', { className: 'PS_errorCard' },
          h('h3', null, '导入没有完成'),
          h('p', null, project.import?.error ?? '未知错误'),
          h(Btn, { variant: 'primary', onClick: () => onAnalyze('retry-import') }, '重新导入'),
          h('p', { className: 'PS_muted PS_small' }, '如果是上传中断，重新导入会使用已保存的源文件；如果源文件没上传成功，请删除项目后重试。')
        );
      }
      if (chapters.length === 0) {
        return h('div', { className: 'PS_empty' },
          h('h3', null, '还没有回目'),
          h('p', { className: 'PS_muted' }, '导入完成后这里会列出每一回。'),
          h(Btn, { variant: 'primary', onClick: () => onAnalyze('retry-import') }, '重新导入')
        );
      }
      return h('div', { className: 'PS_tabBody' },
        h('div', { className: 'PS_tabToolbar' },
          h('input', { className: 'PS_input PS_search', value: search, onChange: (event) => setSearch(event.target.value), placeholder: '搜回目名', 'aria-label': '搜回目名' }),
          h('span', { className: 'PS_muted PS_small' }, `${filtered.length}/${chapters.length} 回`)
        ),
        h('div', { className: 'PS_chapterList' },
          visible.map((chapter) => h('div', { key: chapter.id, className: 'PS_chapterRow' },
            h('div', { className: 'PS_chapterIndex' }, chapter.index),
            h('div', { className: 'PS_chapterMain' },
              h('div', { className: 'PS_chapterTitle' }, chapter.title),
              h('div', { className: 'PS_chapterMeta' },
                h('span', null, formatChars(chapter.chars)),
                chapter.summary ? h(Badge, { tone: 'ok' }, '摘要✓') : h(Badge, null, '未摘要'),
                chapter.performances ? h(Badge, { tone: 'brand' }, `${chapter.performances} 版评书`) : null
              )
            ),
            h('div', { className: 'PS_chapterActions' },
              h(Btn, { onClick: () => onRead(chapter), disabled: busy }, T('读原文')),
              h(Btn, { variant: 'primary', onClick: () => onPerform(chapter), disabled: busy }, T('讲这一回'))
            )
          ))
        ),
        filtered.length > visible.length
          ? h('div', { className: 'PS_more' }, h(Btn, { onClick: () => setLimit((value) => value + 100) }, `显示更多（还有 ${filtered.length - visible.length} 回）`))
          : null
      );
    }

    // ── 资料页 ─────────────────────────────────────────────────────────────
    function DossierTab({ project, overview, onOpen, onFill, busy }) {
      const analysis = project.analysis ?? {};
      const cards = [
        {
          key: 'book', title: T('全书概要'), done: analysis.hasBookSummary, value: analysis.hasBookSummary ? '已写' : '未写',
          action: () => onOpen('book'),
        },
        {
          key: 'chapters', title: T('章节摘要'), done: (analysis.chapterSummaries ?? 0) >= (project.chapterCount ?? 0) && (project.chapterCount ?? 0) > 0,
          value: `${analysis.chapterSummaries ?? 0}/${project.chapterCount ?? 0} 回`,
          action: () => onOpen('chapter-index'),
        },
        {
          key: 'characters', title: T('人物'), done: (analysis.characters ?? 0) > 0, value: `${analysis.characters ?? 0} 人`,
          action: () => onOpen('characters'),
        },
        {
          key: 'timeline', title: T('时间线'), done: analysis.hasTimeline, value: analysis.hasTimeline ? '已写' : '未写',
          action: () => onOpen('timeline'),
        },
        {
          key: 'glossary', title: T('背景与术语'), done: (analysis.glossary ?? 0) > 0 || analysis.hasContext, value: `${analysis.glossary ?? 0} 条${analysis.hasContext ? ' · 背景✓' : ''}`,
          action: () => onOpen('glossary'),
        },
      ];
      return h('div', { className: 'PS_tabBody' },
        h('div', { className: 'PS_dossierGrid' },
          cards.map((card) => h('div', { key: card.key, className: 'PS_card PS_dossierCard' },
            h('div', { className: 'PS_dossierTop' },
              h('h3', null, card.title),
              card.done ? h(Badge, { tone: 'ok' }, '已有') : h(Badge, null, '待补')
            ),
            h('div', { className: 'PS_muted' }, card.value),
            h('div', { className: 'PS_cardActions' },
              h(Btn, { onClick: card.action, disabled: busy }, T('查看')),
              h(Btn, { variant: 'ghost', onClick: () => onFill(card.key), disabled: busy }, T('让 AI 补充'))
            )
          ))
        ),
        (analysis.chapterSummaries ?? 0) === 0
          ? h('div', { className: 'PS_empty PS_mt' },
              h('h3', null, T('还没有整理资料')),
              h('p', { className: 'PS_muted' }, '点「开始分析」会让 AI 逐回读原文、写摘要，再整理全书资料。'),
              h(Btn, { variant: 'primary', onClick: () => onFill('chapters'), disabled: busy || (project.chapterCount ?? 0) === 0 }, T('开始分析'))
            )
          : null
      );
    }

    function charactersFromOverview(overview) {
      return Array.isArray(overview?.characters) ? overview.characters : [];
    }

    // ── 评书页 ─────────────────────────────────────────────────────────────
    function PerformanceTab({ project, items, onOpen, onRetell, onDelete, onDownload, onJumpChapters, busy }) {
      if (!items || items.length === 0) {
        return h('div', { className: 'PS_empty' },
          h('h3', null, T('还没有讲过')),
          h('p', { className: 'PS_muted' }, '到「回目」里选一回，点「讲这一回」；AI 保存后，文案会按版本出现在这里。'),
          h(Btn, { variant: 'primary', onClick: onJumpChapters }, '去选一回')
        );
      }
      return h('div', { className: 'PS_tabBody' },
        h('div', { className: 'PS_perfList' },
          items.map((item) => h('div', { key: `${item.chapterId}-${item.versionId}`, className: 'PS_card PS_perfCard' },
            h('div', { className: 'PS_perfTop' },
              h('div', null,
                h('div', { className: 'PS_perfTitle' }, item.title || item.chapterTitle),
                h('div', { className: 'PS_muted PS_small' }, `${item.chapterTitle} · ${item.versionId} · ${formatChars(item.chars)} · 约 ${item.estimatedMinutes} 分钟${item.style ? ` · ${item.style}` : ''}`)
              ),
              h(Badge, { tone: 'brand' }, item.versionId)
            ),
            h('div', { className: 'PS_perfMeta' }, formatDate(item.createdAt), item.notes ? ` · ${item.notes}` : ''),
            h('div', { className: 'PS_cardActions' },
              h(Btn, { variant: 'primary', onClick: () => onOpen(item) }, T('阅读')),
              h(Btn, { onClick: () => onOpen(item, true) }, T('朗读')),
              h(Btn, { onClick: () => onDownload(item) }, '下载'),
              h(Btn, { onClick: () => onRetell(item), disabled: busy }, T('重讲')),
              h(Btn, { variant: 'danger', onClick: () => onDelete(item), disabled: busy }, T('删除'))
            )
          ))
        )
      );
    }

    function safeFileStem(value) {
      return String(value ?? 'pingshu').replace(/[\\/:*?"<>|\s]+/gu, '_').slice(0, 60) || 'pingshu';
    }

    // ── 主面板 ─────────────────────────────────────────────────────────────
    function PingshuPanel(props) {
      const api = props.api;
      const ctx = props.pingshuCtx;
      useLocaleTick();
      const [projects, setProjects] = React.useState([]);
      const [projectsLoading, setProjectsLoading] = React.useState(true);
      const [selectedId, setSelectedId] = React.useState(() => {
        try { return localStorage.getItem('pingshu.selected') || null; } catch { return null; }
      });
      const [project, setProject] = React.useState(null);
      const [projectLoading, setProjectLoading] = React.useState(false);
      const [projectError, setProjectError] = React.useState('');
      const [search, setSearch] = React.useState('');
      const [tab, setTab] = React.useState('chapters');
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [importOpen, setImportOpen] = React.useState(false);
      const [reader, setReader] = React.useState(null);
      const [speakTarget, setSpeakTarget] = React.useState(null);
      const [confirm, setConfirm] = React.useState(null);
      const [promptIssue, setPromptIssue] = React.useState(null);
      const [overview, setOverview] = React.useState(null);
      const [performances, setPerformances] = React.useState([]);
      const noticeTimer = React.useRef(null);
      const aliveRef = React.useRef(true);

      React.useEffect(() => () => { aliveRef.current = false; if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

      const toast = React.useCallback((kind, text) => {
        setNotice({ kind, text });
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNotice(null), 5200);
      }, []);

      const loadProjects = React.useCallback(async () => {
        try {
          const value = await api.listProjects();
          if (!aliveRef.current) return;
          setProjects(Array.isArray(value.projects) ? value.projects : []);
          setProjectsLoading(false);
        } catch (error) {
          if (!aliveRef.current) return;
          setProjectsLoading(false);
          toast('error', error instanceof Error ? error.message : String(error));
        }
      }, [api, toast]);

      const loadProject = React.useCallback(async (projectId, { scan = false } = {}) => {
        try {
          const value = await api.getProject({ projectId, scan });
          if (!aliveRef.current) return null;
          setProject(value.project);
          setProjectError('');
          return value.project;
        } catch (error) {
          if (!aliveRef.current) return null;
          setProjectError(error instanceof Error ? error.message : String(error));
          return null;
        }
      }, [api]);

      React.useEffect(() => { void loadProjects(); }, [loadProjects]);

      React.useEffect(() => {
        if (!selectedId) { setProject(null); return undefined; }
        let cancelled = false;
        let timer = null;
        setProjectLoading(true);
        void loadProject(selectedId).finally(() => { if (!cancelled) setProjectLoading(false); });
        const tick = async () => {
          if (cancelled) return;
          if (document.visibilityState === 'hidden') {
            timer = setTimeout(tick, 4000);
            return;
          }
          const current = await loadProject(selectedId);
          if (cancelled) return;
          timer = setTimeout(tick, current?.status === 'importing' ? 800 : 4000);
        };
        timer = setTimeout(tick, 1200);
        const onVisible = () => { if (document.visibilityState === 'visible') void loadProject(selectedId); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [selectedId, loadProject]);

      React.useEffect(() => {
        if (!project) { setOverview(null); setPerformances([]); return; }
        if (tab === 'dossier' || tab === 'performances') {
          void api.getDossier({ projectId: project.id }).then((value) => { if (aliveRef.current) setOverview(value); }).catch(() => undefined);
        }
        if (tab === 'performances' || tab === 'chapters') {
          void api.listPerformances({ projectId: project.id }).then((value) => { if (aliveRef.current) setPerformances(Array.isArray(value.items) ? value.items : []); }).catch(() => undefined);
        }
      }, [project?.id, project?.updatedAt, tab, api]);

      const rememberSelected = (projectId) => {
        try {
          if (projectId) localStorage.setItem('pingshu.selected', projectId);
          else localStorage.removeItem('pingshu.selected');
        } catch { /* ignore */ }
      };

      React.useEffect(() => {
        if (!selectedId || projectsLoading) return;
        if (projects.some((entry) => entry.id === selectedId)) return;
        setSelectedId(null);
        setProject(null);
        rememberSelected(null);
      }, [projects, projectsLoading, selectedId]);

      const selectProject = (projectId) => {
        setSelectedId(projectId);
        rememberSelected(projectId);
        setProject(null);
        setTab('chapters');
        setProjectError('');
      };

      const refreshProject = async (scan = true) => {
        if (!project) return;
        setBusy('refresh');
        try {
          const value = await loadProject(project.id, { scan });
          if (value) toast('ok', '已刷新');
          await loadProjects();
        } finally { setBusy(''); }
      };

      const openSession = async (result) => {
        if (!result?.sessionId) return;
        if (result.promptSent === false) {
          // 提示词没发出去时不要切走：面板一卸载，提示词就再也看不到。
          setPromptIssue(result);
          return;
        }
        const uiWorkspace = await getService(ctx, 'uiWorkspace');
        if (!uiWorkspace) {
          toast('warn', '对话已创建，但当前环境不能自动切过去；请在左侧「书名」分组里打开。');
          return;
        }
        try {
          uiWorkspace.openSession(result.sessionId);
        } catch (error) {
          toast('warn', `对话已创建，请手动打开：${error instanceof Error ? error.message : String(error)}`);
        }
      };

      const startAnalyze = async (focus) => {
        if (!project) return;
        setBusy('analyze');
        try {
          const result = await api.startConversation({ projectId: project.id, intent: 'analyze', focus: focus === 'chapters' ? undefined : focus });
          await openSession(result);
          await loadProjects();
        } catch (error) {
          toast('error', error instanceof Error ? error.message : String(error));
        } finally { setBusy(''); }
      };

      const startPerform = async (chapter, options, previousVersionId) => {
        if (!project) return;
        setBusy('perform');
        try {
          const result = await api.startConversation({ projectId: project.id, intent: 'perform', chapterId: chapter.id, options, previousVersionId });
          await openSession(result);
          await loadProjects();
          return result.promptSent !== false;
        } catch (error) {
          toast('error', error instanceof Error ? error.message : String(error));
          return false;
        } finally { setBusy(''); }
      };

      const startResplit = async () => {
        if (!project) return;
        setConfirm(null);
        setBusy('resplit');
        try {
          const result = await api.startConversation({ projectId: project.id, intent: 'resplit' });
          await openSession(result);
        } catch (error) {
          toast('error', error instanceof Error ? error.message : String(error));
        } finally { setBusy(''); }
      };

      const submitImport = async ({ file, title, author }, onProgress) => {
        const created = await api.createProject({ title, author, filename: file.name });
        onProgress(0.03, T('上传中…'));
        await uploadFile(created.uploadUrl, file, (value) => onProgress(0.03 + value * 0.7, T('上传中…')));
        onProgress(0.75, T('识别回目中…'));
        await api.startImport({ projectId: created.projectId });
        const imported = await waitForImport(api, created.projectId, onProgress);
        onProgress(1, '完成');
        return { ...imported, projectId: created.projectId };
      };

      const onImportDone = async (result, analyze) => {
        await loadProjects();
        setSelectedId(result.projectId);
        rememberSelected(result.projectId);
        setProject(result.project);
        setTab('chapters');
        if (analyze) {
          setBusy('analyze');
          try {
            const conversation = await api.startConversation({ projectId: result.projectId, intent: 'analyze' });
            await openSession(conversation);
          } catch (error) {
            toast('warn', `书已导入，但分析对话没开起来：${error instanceof Error ? error.message : String(error)}`);
          } finally { setBusy(''); }
        } else {
          toast('ok', '导入完成；可以点「开始分析」让 AI 整理资料。');
        }
      };

      const openChapter = async (chapter) => {
        if (!project) return;
        setBusy('chapter');
        try {
          const result = await loadFullChapter(api, project.id, chapter.id);
          setReader({ mode: 'chapter', title: chapter.title, kicker: `《${project.title}》`, chapter, markdown: result.text, truncated: result.truncated });
        } catch (error) {
          toast('error', error instanceof Error ? error.message : String(error));
        } finally { setBusy(''); }
      };

      const openAnalysis = async (kind) => {
        if (!project || !overview) return;
        try {
          if (kind === 'characters') {
            setReader({
              mode: 'analysis',
              title: '人物',
              kicker: `《${project.title}》`,
              markdown: charactersFromOverview(overview).map((character) => `## ${character.name}\n\n${character.role ? `*${character.role}*\n\n` : ''}${character.profile ?? ''}`).join('\n\n') || '（还没有人物资料）',
            });
            return;
          }
          if (kind === 'chapter-index') {
            const chapters = project.chapters.map((chapter) => `- ${chapter.index}. ${chapter.title}（${chapter.chars} 字${chapter.summary ? ' · 已摘要' : ''}${chapter.performances ? ` · ${chapter.performances} 版评书` : ''}）`);
            setReader({ mode: 'analysis', title: '回目', kicker: `《${project.title}》`, markdown: `# 回目\n\n${chapters.join('\n')}` });
            return;
          }
          const result = await api.getAnalysis({ projectId: project.id, kind });
          setReader({ mode: 'analysis', title: kind === 'book' ? '全书概要' : kind === 'timeline' ? '时间线' : kind === 'glossary' ? '名词解释' : '时代与背景', kicker: `《${project.title}》`, markdown: result.content });
        } catch (error) {
          toast('error', error instanceof Error ? error.message : String(error));
        }
      };

      const openPerformance = async (item, autoPlay = false) => {
        if (!project) return;
        setBusy('performance');
        try {
          const value = await api.getPerformance({ projectId: project.id, chapterId: item.chapterId, versionId: item.versionId });
          let dossier = null;
          try { dossier = await api.getDossier({ projectId: project.id, chapterId: item.chapterId }); } catch { dossier = null; }
          setReader({
            mode: 'performance',
            title: value.meta.title || item.chapterTitle,
            kicker: `《${project.title}》· ${item.chapterTitle} · ${item.versionId}`,
            markdown: value.script,
            meta: value.meta,
            chapter: project.chapters.find((chapter) => chapter.id === item.chapterId),
            characters: dossier?.characters ?? [],
            glossary: dossier?.glossary ?? [],
            autoPlay: autoPlay === true,
          });
        } catch (error) {
          toast('error', error instanceof Error ? error.message : String(error));
        } finally { setBusy(''); }
      };

      const deletePerformanceItem = async (item) => {
        if (!project) return;
        setConfirm({
          title: '删除这一版评书？',
          message: `${item.chapterTitle} · ${item.versionId}。删除后不可恢复；旧版本不会被其他版本替代。`,
          confirmLabel: '删除',
          danger: true,
          onConfirm: async () => {
            setConfirm(null);
            setBusy('delete-performance');
            try {
              await api.deletePerformance({ projectId: project.id, chapterId: item.chapterId, versionId: item.versionId });
              toast('ok', '已删除这一版');
              setReader(null);
              const value = await api.listPerformances({ projectId: project.id });
              setPerformances(Array.isArray(value.items) ? value.items : []);
              await loadProject(project.id);
            } catch (error) {
              toast('error', error instanceof Error ? error.message : String(error));
            } finally { setBusy(''); }
          },
        });
      };

      const renameProject = () => {
        if (!project) return;
        setConfirm({
          title: '改书名',
          message: '书名会同步到左侧工作区标题。',
          input: project.title,
          confirmLabel: '保存',
          onConfirm: async (value) => {
            setConfirm(null);
            const title = String(value ?? '').trim();
            if (title === '') return;
            setBusy('rename');
            try {
              await api.renameProject({ projectId: project.id, title });
              toast('ok', '已改名');
              await loadProjects();
              await loadProject(project.id);
            } catch (error) {
              toast('error', error instanceof Error ? error.message : String(error));
            } finally { setBusy(''); }
          },
        });
      };

      const removeProject = () => {
        if (!project) return;
        setConfirm({
          title: `删除《${project.title}》？`,
          message: '项目目录会被整个移除，无法撤销。对话记录会保留，但工作区分组会移除；正在跑的对话里的工具会报「项目不存在」。',
          confirmLabel: '删除项目',
          danger: true,
          onConfirm: async () => {
            setConfirm(null);
            setBusy('delete-project');
            try {
              await api.deleteProject({ projectId: project.id });
              setProject(null);
              setSelectedId(null);
              rememberSelected(null);
              setReader(null);
              toast('ok', '项目已删除');
              await loadProjects();
            } catch (error) {
              toast('error', error instanceof Error ? error.message : String(error));
            } finally { setBusy(''); }
          },
        });
      };

      const deleteReaderPerformance = (meta) => {
        if (!meta) return;
        void deletePerformanceItem(meta);
      };

      const retell = (meta, chapter) => {
        if (!chapter) { toast('warn', '找不到对应回目'); return; }
        setReader(null);
        setSpeakTarget({ chapter, previous: meta });
      };

      const openRecentChat = async () => {
        if (!project) return;
        if (project.lastSessionId) {
          const uiWorkspace = await getService(ctx, 'uiWorkspace');
          if (uiWorkspace) {
            try { uiWorkspace.openSession(project.lastSessionId); return; } catch { /* fallback */ }
          }
        }
        if (project.workspaceId) {
          const uiWorkspace = await getService(ctx, 'uiWorkspace');
          if (uiWorkspace) {
            try { uiWorkspace.openWorkspace(project.workspaceId); return; } catch { /* fallback */ }
          }
        }
        toast('warn', '还没有可打开的对话；点「开始分析」或「讲这一回」会新建一个。');
      };

      const content = !api
        ? h('div', { className: 'PS_empty' }, '评书 API 没有注入，请确认插件已启用。')
        : !selectedId
          ? h('div', { className: 'PS_welcome' },
              h('div', { className: 'PS_welcomeGlyph' }, h(PingshuGlyph, { size: 56 })),
              h('h2', null, T('评书工作台')),
              h('p', { className: 'PS_muted' }, '上传一本电子书，AI 会拆回目、整理人物与背景，再按你的要求把某一回说成评书。'),
              h(Btn, { variant: 'primary', onClick: () => setImportOpen(true) }, '＋ ' + T('新建项目')),
              h('div', { className: 'PS_welcomeSteps' },
                h('div', { className: 'PS_step' }, h('strong', null, '① 导入'), h('span', null, 'EPUB / PDF / TXT / Markdown')),
                h('div', { className: 'PS_step' }, h('strong', null, '② 分析'), h('span', null, '摘要、人物、时间线、背景')),
                h('div', { className: 'PS_step' }, h('strong', null, '③ 开讲'), h('span', null, '选一回，AI 写评书文案')),
                h('div', { className: 'PS_step' }, h('strong', null, '④ 听书'), h('span', null, '点朗读，跟着高亮听'))
              )
            )
          : projectLoading && !project
            ? h('div', { className: 'PS_empty' }, '正在载入项目…')
            : project
              ? h('div', { className: 'PS_main' },
                  h(ProjectHeader, {
                    project,
                    busy: Boolean(busy),
                    onAnalyze: () => void startAnalyze(),
                    onRefresh: () => void refreshProject(true),
                    onRename: renameProject,
                    onDelete: removeProject,
                    onOpenChat: () => void openRecentChat(),
                    onResplit: () => setConfirm({
                      title: '重新分章？',
                      message: '会重建回目、归档旧章节摘要与旧评书，然后开一个新对话让 AI 找正确的回目边界。旧资料会保留在 .archive 目录，但界面上不再显示。建议先确认切分确实错了。',
                      confirmLabel: '开对话重新分章',
                      danger: true,
                      onConfirm: () => void startResplit(),
                    }),
                  }),
                  h('div', { className: 'PS_tabs', role: 'tablist' },
                    [['chapters', `回目（${project.chapterCount ?? 0}）`], ['dossier', '书目资料'], ['performances', `评书（${performances.length}）`]].map(([key, label]) => h('button', {
                      key, type: 'button', role: 'tab', 'aria-selected': tab === key,
                      className: `PS_tab ${tab === key ? 'PS_tabActive' : ''}`,
                      onClick: () => setTab(key),
                    }, label))
                  ),
                  tab === 'chapters' ? h(ChapterTab, {
                    project,
                    busy: Boolean(busy),
                    onRead: (chapter) => void openChapter(chapter),
                    onPerform: (chapter) => setSpeakTarget({ chapter, previous: null }),
                    onAnalyze: (mode) => mode === 'retry-import' ? void retryImport() : void startAnalyze(),
                  }) : tab === 'dossier' ? h(DossierTab, {
                    project,
                    overview,
                    busy: Boolean(busy),
                    onOpen: (kind) => void openAnalysis(kind),
                    onFill: (kind) => {
                      const focus = kind === 'book' ? 'book' : kind === 'characters' ? 'characters' : kind === 'timeline' ? 'timeline' : kind === 'glossary' ? 'glossary' : 'chapters';
                      void startAnalyze(focus);
                    },
                  }) : h(PerformanceTab, {
                    project,
                    items: performances,
                    busy: Boolean(busy),
                    onOpen: (item, autoPlay) => void openPerformance(item, autoPlay),
                    onRetell: (item) => setSpeakTarget({ chapter: project.chapters.find((chapter) => chapter.id === item.chapterId), previous: item }),
                    onDelete: (item) => void deletePerformanceItem(item),
                    onDownload: async (item) => {
                      try {
                        const value = await api.getPerformance({ projectId: project.id, chapterId: item.chapterId, versionId: item.versionId });
                        downloadText(`${safeFileStem(project.title)}-${safeFileStem(item.chapterTitle)}-${item.versionId}.md`, value.script);
                      } catch (error) {
                        toast('error', error instanceof Error ? error.message : String(error));
                      }
                    },
                    onJumpChapters: () => setTab('chapters'),
                  })
                )
              : h('div', { className: 'PS_empty' },
                  h('h3', null, projectError ? '项目读取失败' : '选择一个项目'),
                  h('p', { className: 'PS_muted' }, projectError || '从左侧选一本书，或新建项目。')
                );

      async function retryImport() {
        if (!project) return;
        setBusy('retry-import');
        try {
          await api.startImport({ projectId: project.id });
          toast('ok', '开始重新导入…');
          await waitForImport(api, project.id);
          await loadProject(project.id, { scan: true });
          await loadProjects();
        } catch (error) {
          toast('error', error instanceof Error ? error.message : String(error));
        } finally { setBusy(''); }
      }

      return h('div', { className: 'PS_root' },
        h(ProjectRail, {
          projects,
          selectedId,
          search,
          onSearch: setSearch,
          onSelect: selectProject,
          onNew: () => setImportOpen(true),
          loading: projectsLoading,
        }),
        h('section', { className: 'PS_contentWrap' },
          !api ? h('div', { className: 'PS_empty' }, '评书 API 没有注入，请确认插件已启用。') : content
        ),
        notice ? h('div', { className: `PS_toast PS_toast_${notice.kind}` }, notice.text) : null,
        importOpen ? h(ImportDialog, {
          onClose: () => setImportOpen(false),
          onSubmit: submitImport,
          onDone: onImportDone,
        }) : null,
        speakTarget ? h(SpeakDialog, {
          chapter: speakTarget.chapter,
          previous: speakTarget.previous,
          onClose: () => setSpeakTarget(null),
          onConfirm: (options, previousVersionId) => startPerform(speakTarget.chapter, options, previousVersionId),
        }) : null,
        confirm ? h(ConfirmDialog, { spec: confirm, onClose: () => setConfirm(null) }) : null,
        promptIssue ? h(PromptIssueDialog, {
          issue: promptIssue,
          onClose: () => setPromptIssue(null),
          onOpen: async () => {
            const uiWorkspace = await getService(ctx, 'uiWorkspace');
            if (uiWorkspace && promptIssue.sessionId) {
              try { uiWorkspace.openSession(promptIssue.sessionId); setPromptIssue(null); return; } catch { /* fall through */ }
            }
            toast('warn', '当前环境不能自动切过去；请在左侧「书名」分组里打开那个对话。');
          },
        }) : null,
        reader ? h(ReaderModal, {
          reader,
          api,
          projectId: project?.id,
          onClose: () => setReader(null),
          onPerform: (chapter) => { setReader(null); if (chapter) setSpeakTarget({ chapter, previous: null }); },
          onRetell: (meta, chapter) => retell(meta, chapter),
          onDelete: (meta) => deleteReaderPerformance(meta),
          onToast: toast,
        }) : null
      );
    }

    // ── 通用对话框 ─────────────────────────────────────────────────────────
    function ConfirmDialog({ spec, onClose }) {
      const [value, setValue] = React.useState(spec.input ?? '');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const run = async () => {
        setBusy(true);
        setError('');
        try { await spec.onConfirm(value); } catch (runError) { setError(runError instanceof Error ? runError.message : String(runError)); } finally { setBusy(false); }
      };
      return h(Modal, {
        title: spec.title,
        onClose,
        footer: h(React.Fragment, null,
          h(Btn, { onClick: onClose, disabled: busy }, T('取消')),
          h(Btn, { variant: spec.danger ? 'danger' : 'primary', onClick: () => void run(), disabled: busy }, spec.confirmLabel ?? T('确定'))
        ),
      },
        h('p', { className: 'PS_modalText' }, spec.message),
        spec.input !== undefined ? h('input', { className: 'PS_input', value, onChange: (event) => setValue(event.target.value), autoFocus: true }) : null,
        error ? h('div', { className: 'PS_error' }, error) : null
      );
    }

    function PromptIssueDialog({ issue, onClose, onOpen }) {
      const [copied, setCopied] = React.useState(false);
      return h(Modal, {
        title: '对话已创建，但自动提示词没发出去',
        onClose,
        wide: true,
        footer: h(React.Fragment, null,
          h(Btn, { onClick: onClose }, T('关闭')),
          h(Btn, {
            onClick: async () => { if (await copyText(issue.promptText)) { setCopied(true); setTimeout(() => setCopied(false), 2000); } },
          }, copied ? '已复制' : '复制提示词'),
          h(Btn, { variant: 'primary', onClick: onOpen }, '打开对话')
        ),
      },
        h('p', { className: 'PS_modalText' }, issue.error ?? '请打开这个对话，把下面的任务说明粘贴到输入框里再发送。'),
        h('pre', { className: 'PS_pre PS_promptPre' }, issue.promptText ?? '')
      );
    }

    // ── 网络辅助 ───────────────────────────────────────────────────────────
    function uploadFile(url, file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', new URL(url, window.location.origin).toString());
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        xhr.responseType = 'json';
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) onProgress(event.loaded / Math.max(1, event.total));
        };
        xhr.onload = () => {
          let body = xhr.response;
          if (!body) {
            try { body = JSON.parse(xhr.responseText || '{}'); } catch { body = {}; }
          }
          if (xhr.status >= 200 && xhr.status < 300 && body?.ok) resolve(body);
          else reject(new Error(body?.error ?? `上传失败（HTTP ${xhr.status}）`));
        };
        xhr.onerror = () => reject(new Error('上传失败：网络错误'));
        xhr.onabort = () => reject(new Error('上传已取消'));
        xhr.send(file);
      });
    }

    async function waitForImport(api, projectId, onProgress) {
      const started = Date.now();
      for (let i = 0; i < 450; i += 1) {
        const value = await api.getProject({ projectId });
        const project = value.project;
        if (project.status === 'importing') {
          if (onProgress) onProgress(0.78 + Math.min(0.18, i * 0.002), T('识别回目中…'));
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        if (project.status === 'error') throw new Error(project.import?.error ?? '导入失败');
        if (project.status === 'ready') return value;
        if (Date.now() - started > 5 * 60 * 1000) throw new Error('导入超时；请刷新项目或重试');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('导入超时；请刷新项目或重试');
    }

    async function loadFullChapter(api, projectId, chapterId) {
      const parts = [];
      let offset = 0;
      let truncated = false;
      for (let i = 0; i < 6; i += 1) {
        const value = await api.getChapter({ projectId, chapterId, offset, maxChars: 60000 });
        parts.push(value.text ?? '');
        if (value.nextOffset === null || value.nextOffset === undefined) return { text: parts.join(''), truncated: false };
        offset = value.nextOffset;
        truncated = true;
      }
      return { text: parts.join(''), truncated };
    }

    // ── 样式 ───────────────────────────────────────────────────────────────
    const CSS = `
      .PS_root, .PS_root * { box-sizing: border-box; }
      .PS_root {
        height: 100%; min-height: 0; display: flex; width: 100%;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif);
        font-size: 14px; line-height: 1.55;
      }
      .PS_rail { width: 286px; flex: 0 0 286px; border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; min-height: 0; }
      .PS_railHead { padding: 18px 16px 10px; display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
      .PS_brandRow { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-primary); }
      .PS_brand { font-size: 18px; font-weight: 650; margin: 0; letter-spacing: .02em; }
      .PS_search { margin: 0 16px 10px; width: calc(100% - 32px); }
      .PS_projectList { overflow: auto; padding: 0 8px 16px; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
      .PS_projectRow { text-align: left; border: 1px solid transparent; background: transparent; color: inherit; border-radius: 10px; padding: 10px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; font: inherit; }
      .PS_projectRow:hover { background: var(--dsw-alias-bg-layer-2); }
      .PS_projectRowActive { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
      .PS_projectTop { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .PS_projectTitle { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .PS_projectMeta, .PS_projectBottom { display: flex; justify-content: space-between; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .PS_contentWrap { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
      .PS_main { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
      .PS_projectHead { padding: 18px 22px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
      .PS_projectHeadMain { display: flex; flex-direction: column; gap: 8px; }
      .PS_titleRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .PS_projectName { margin: 0; font-size: 22px; line-height: 1.25; }
      .PS_headProgress { display: flex; align-items: center; gap: 10px; max-width: 420px; }
      .PS_headActions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
      .PS_tabs { display: flex; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
      .PS_tab { border: none; background: transparent; color: var(--dsw-alias-label-secondary); padding: 11px 12px 10px; cursor: pointer; border-bottom: 2px solid transparent; font: inherit; }
      .PS_tab:hover { color: var(--dsw-alias-label-primary); }
      .PS_tabActive { color: var(--dsw-alias-brand-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
      .PS_tabBody { flex: 1; min-height: 0; overflow: auto; padding: 18px 22px 30px; }
      .PS_tabToolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
      .PS_tabToolbar .PS_search { margin: 0; flex: 1; width: auto; }
      .PS_chapterList { display: flex; flex-direction: column; gap: 6px; }
      .PS_chapterRow { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
      .PS_chapterRow:hover { border-color: var(--dsw-alias-border-l2); }
      .PS_chapterIndex { width: 34px; flex: 0 0 34px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .PS_chapterMain { flex: 1; min-width: 0; }
      .PS_chapterTitle { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .PS_chapterMeta { display: flex; gap: 6px; align-items: center; margin-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; flex-wrap: wrap; }
      .PS_chapterActions { display: flex; gap: 6px; flex: 0 0 auto; }
      .PS_btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 11px; cursor: pointer; font: inherit; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
      .PS_btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
      .PS_btn:disabled { opacity: .5; cursor: not-allowed; }
      .PS_btn_primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
      .PS_btn_primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--dsw-alias-brand-primary); }
      .PS_btn_danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); background: transparent; }
      .PS_btn_ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
      .PS_btn_ghost:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
      .PS_iconBtn { border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 20px; line-height: 1; width: 30px; height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; }
      .PS_iconBtn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .PS_input { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 8px 10px; font: inherit; outline: none; min-width: 0; }
      .PS_input:focus { border-color: var(--dsw-alias-brand-primary); }
      .PS_textarea { resize: vertical; width: 100%; }
      .PS_field { display: flex; flex-direction: column; gap: 6px; }
      .PS_fieldLabel { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .PS_hint { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .PS_muted { color: var(--dsw-alias-label-secondary); }
      .PS_small { font-size: 12px; }
      .PS_mt { margin-top: 14px; }
      .PS_pad { padding: 18px; }
      .PS_center { align-items: center; justify-content: center; }
      .PS_card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; }
      .PS_cardActions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
      .PS_badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 1px 8px; font-size: 11px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); white-space: nowrap; }
      .PS_badge_ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .PS_badge_error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .PS_badge_warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .PS_badge_brand { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .PS_progress { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; flex: 1; }
      .PS_progressFill { height: 100%; background: var(--dsw-alias-brand-primary); border-radius: 999px; transition: width .2s ease; }
      .PS_progress_error .PS_progressFill { background: var(--dsw-alias-state-error-primary); }
      .PS_dossierGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
      .PS_dossierCard { padding: 14px; }
      .PS_dossierTop { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .PS_dossierTop h3 { margin: 0 0 4px; font-size: 15px; }
      .PS_perfList { display: flex; flex-direction: column; gap: 10px; }
      .PS_perfCard { padding: 14px; }
      .PS_perfTop { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
      .PS_perfTitle { font-weight: 650; }
      .PS_perfMeta { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 4px; }
      .PS_empty { flex: 1; min-height: 240px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 34px; }
      .PS_emptyRail { padding: 28px 16px; text-align: center; display: flex; flex-direction: column; gap: 8px; align-items: center; }
      .PS_emptyGlyph { color: var(--dsw-alias-label-secondary); opacity: .8; }
      .PS_emptyTitle { font-weight: 650; }
      .PS_welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 40px; text-align: center; }
      .PS_welcomeGlyph { color: var(--dsw-alias-brand-primary); opacity: .9; }
      .PS_welcome h2 { margin: 0; font-size: 28px; }
      .PS_welcomeSteps { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; max-width: 720px; margin-top: 14px; width: 100%; }
      .PS_step { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 4px; background: var(--dsw-alias-bg-layer-1); text-align: left; }
      .PS_step span { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .PS_error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 8px 10px; margin-top: 10px; font-size: 12px; }
      .PS_errorCard { margin: 22px; padding: 18px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 10px; }
      .PS_importingCard { margin: 22px; padding: 18px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 10px; }
      .PS_pulseBar { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; position: relative; }
      .PS_pulseFill { position: absolute; inset: 0; width: 40%; border-radius: 999px; background: var(--dsw-alias-brand-primary); animation: PS_pulse 1.3s ease-in-out infinite; }
      @keyframes PS_pulse { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
      .PS_warnText { color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
      .PS_overlay { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,.38); display: flex; align-items: center; justify-content: center; padding: 24px; }
      .PS_modal { width: min(620px, 100%); max-height: 86vh; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; display: flex; flex-direction: column; box-shadow: 0 24px 70px rgba(0,0,0,.28); }
      .PS_modalWide { width: min(860px, 100%); }
      .PS_modalHead { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 16px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .PS_modalTitle { margin: 0; font-size: 17px; }
      .PS_modalBody { padding: 18px; overflow: auto; }
      .PS_modalFoot { padding: 12px 18px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
      .PS_modalText { margin: 0 0 12px; color: var(--dsw-alias-label-secondary); }
      .PS_drop { border: 1.5px dashed var(--dsw-alias-border-l2); border-radius: 12px; padding: 26px 18px; text-align: center; cursor: pointer; display: flex; flex-direction: column; gap: 6px; align-items: center; background: var(--dsw-alias-bg-layer-1); }
      .PS_drop:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .PS_dropActive { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
      .PS_dropIcon { font-size: 26px; color: var(--dsw-alias-brand-primary); }
      .PS_dropTitle { font-weight: 600; }
      .PS_formGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
      .PS_importProgress { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
      .PS_notice { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .PS_readerOverlay { padding: 18px; }
      .PS_reader { width: min(980px, 100%); height: min(92vh, 980px); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.32); }
      .PS_readerHead { display: flex; justify-content: space-between; gap: 12px; padding: 16px 22px; border-bottom: 1px solid var(--dsw-alias-border-l1); align-items: flex-start; }
      .PS_readerKicker { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 3px; }
      .PS_readerTitle { margin: 0; font-size: 20px; line-height: 1.35; }
      .PS_readerTools { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
      .PS_readerBody { flex: 1; min-height: 0; overflow: auto; padding: 26px 30px 36px; }
      .PS_plainReader, .PS_script { max-width: 760px; margin: 0 auto; }
      .PS_readerMd, .PS_plainReader { font-family: "Songti SC", "STSong", "Noto Serif CJK SC", "Noto Serif SC", serif; font-size: var(--ps-reader-font, 19px); line-height: 1.95; }
      .PS_script { font-family: "Songti SC", "STSong", "Noto Serif CJK SC", "Noto Serif SC", serif; font-size: var(--ps-reader-font, 19px); line-height: 1.95; }
      .PS_scriptH { font-family: var(--dsw-font-family, -apple-system, "PingFang SC", sans-serif); font-size: 16px; color: var(--dsw-alias-brand-primary); margin: 26px 0 10px; letter-spacing: .06em; }
      .PS_scriptH:first-child { margin-top: 0; }
      .PS_scriptP { margin: 0 0 14px; padding: 6px 10px; border-radius: 8px; transition: background .15s ease; }
      .PS_scriptP.PS_hl { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
      .PS_speaker { display: inline-block; font-family: var(--dsw-font-family, -apple-system, "PingFang SC", sans-serif); font-size: 12px; color: var(--dsw-alias-brand-primary); border: 1px solid var(--dsw-alias-brand-primary); border-radius: 999px; padding: 0 7px; margin-right: 8px; vertical-align: 1px; }
      .PS_scriptText { }
      .PS_readerMd h1, .PS_readerMd h2, .PS_readerMd h3, .PS_readerMd h4 { font-family: var(--dsw-font-family, -apple-system, "PingFang SC", sans-serif); line-height: 1.4; margin: 1.4em 0 .6em; }
      .PS_readerMd h1 { font-size: 1.5em; }
      .PS_readerMd h2 { font-size: 1.25em; color: var(--dsw-alias-brand-primary); }
      .PS_readerMd h3 { font-size: 1.1em; }
      .PS_readerMd p { margin: 0 0 .9em; }
      .PS_readerMd ul, .PS_readerMd ol { padding-left: 1.4em; margin: 0 0 .9em; }
      .PS_readerMd li { margin: .2em 0; }
      .PS_readerMd blockquote { margin: 0 0 1em; padding: 6px 14px; border-left: 3px solid var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-radius: 0 8px 8px 0; }
      .PS_readerMd code, .PS_code { background: var(--dsw-alias-bg-layer-2); padding: 1px 5px; border-radius: 5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
      .PS_pre { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px; overflow: auto; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.55; }
      .PS_hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1); margin: 1.4em 0; }
      .PS_tableWrap { overflow: auto; margin: 0 0 1em; }
      .PS_table { border-collapse: collapse; width: 100%; font-size: .92em; }
      .PS_table th, .PS_table td { border: 1px solid var(--dsw-alias-border-l1); padding: 6px 9px; text-align: left; vertical-align: top; }
      .PS_table th { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
      .PS_sideNotes { max-width: 760px; margin: 30px auto 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
      .PS_sideCard { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px; background: var(--dsw-alias-bg-layer-1); }
      .PS_sideCard h4 { margin: 0 0 8px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
      .PS_sideRow { font-size: 13px; margin-bottom: 8px; }
      .PS_sideText { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.55; }
      .PS_ttsBar { border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); padding: 10px 18px 12px; display: flex; flex-direction: column; gap: 8px; }
      .PS_ttsBody { display: flex; flex-direction: column; gap: 8px; }
      .PS_ttsProviderRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .PS_ttsProviderLabel { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .PS_ttsProviderSelect { max-width: 180px; font-size: 12px; padding: 4px 8px; }
      .PS_inline { display: flex; align-items: center; gap: 8px; }
      .PS_grow { flex: 1; min-width: 0; }
      .PS_fileRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .PS_formGrid3 { grid-template-columns: repeat(3, 1fr); }
      .PS_advanced { margin-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; }
      .PS_advanced summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; margin-bottom: 10px; }
      .PS_ttsMain { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .PS_ttsMeta { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); margin-left: 4px; }
      .PS_ttsProgress { padding: 0 2px; }
      .PS_ttsControls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .PS_inlineField { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .PS_inlineField input[type=range] { width: 110px; accent-color: var(--dsw-alias-brand-primary); }
      .PS_check { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .PS_voiceSelect { max-width: 230px; font-size: 12px; padding: 5px 8px; }
      .PS_ttsHint { font-size: 11px; }
      .PS_toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 120; padding: 10px 16px; border-radius: 10px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 12px 32px rgba(0,0,0,.22); max-width: min(720px, 90vw); font-size: 13px; }
      .PS_toast_error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .PS_toast_warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
      .PS_toast_ok { border-color: var(--dsw-alias-state-success-primary); }
      .PS_promptPre { max-height: 45vh; white-space: pre-wrap; }
      .PS_more { display: flex; justify-content: center; margin-top: 12px; }
      @media (max-width: 900px) {
        .PS_root { flex-direction: column; }
        .PS_rail { width: 100%; flex: 0 0 auto; max-height: 42vh; border-right: none; border-bottom: 1px solid var(--dsw-alias-border-l1); }
        .PS_projectList { max-height: 26vh; }
        .PS_formGrid, .PS_formGrid3 { grid-template-columns: 1fr; }
        .PS_readerOverlay { padding: 8px; }
        .PS_reader { height: 96vh; border-radius: 12px; }
        .PS_readerBody { padding: 18px 16px 26px; }
        .PS_projectHead { padding: 14px 16px 10px; }
        .PS_tabs { padding: 0 12px; overflow-x: auto; }
        .PS_tabBody { padding: 14px 14px 24px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .PS_progressFill, .PS_scriptP { transition: none; }
      }
    `;

    // ── 插件体 ─────────────────────────────────────────────────────────────
    const inject = ['slots', 'remote'];

    function apply(ctx) {
      attachI18n(ctx);
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const style = document.createElement('style');
        style.setAttribute('data-plugin', PACKAGE);
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => { style.remove(); };
      }, `${PACKAGE}: styles`);

      const mount = ctx.remote.$mount(CONTRIBUTION);
      const api = createApi(ctx, mount);

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 38,
        label: () => T('评书'),
      }, PingshuGlyph));

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ api, pingshuCtx: ctx }),
      }, (props) => h(ErrorBoundary, null, h(PingshuPanel, props))));
    }

    return { inject, apply, PingshuGlyph, PingshuPanel, ReaderModal, ImportDialog, SpeakDialog, parseScript, CSS };
  },
});
