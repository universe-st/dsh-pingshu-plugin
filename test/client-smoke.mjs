/**
 * 无浏览器渲染冒烟：用极简 React shim 渲染客户端组件，抓运行时错误。
 * 不替代真实 Web GUI 验收，只保证组件在初始 props 下能渲染。
 */
import assert from 'node:assert/strict';

let captured;
globalThis.window = {
  __ModuleLoader__: { load(definition) { captured = definition; } },
  localStorage: { getItem: () => null, setItem: () => {} },
  location: { origin: 'http://localhost' },
  setTimeout,
  clearTimeout,
};
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, appendChild() {} }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
  visibilityState: 'visible',
};
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });

function makeReact() {
  let hookIndex = 0;
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged };
    },
    useState(initial) { hookIndex += 1; return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useEffect() { hookIndex += 1; },
    useMemo(factory) { hookIndex += 1; return factory(); },
    useCallback(fn) { hookIndex += 1; return fn; },
    useRef(initial) { hookIndex += 1; return { current: initial }; },
    Component: class {
      constructor(props) { this.props = props ?? {}; this.state = {}; }
      setState() {}
    },
    _resetHooks() { hookIndex = 0; },
  };
  return React;
}

const React = makeReact();
await import('../lib/client.js');
assert.ok(captured, 'client module did not call __ModuleLoader__.load');
const mod = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});
assert.equal(typeof mod.PingshuPanel, 'function');
assert.equal(typeof mod.ReaderModal, 'function');
assert.equal(typeof mod.ImportDialog, 'function');
assert.equal(typeof mod.SpeakDialog, 'function');
assert.equal(typeof mod.parseScript, 'function');

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node);
  if (Array.isArray(node)) return node.map(render).join('');
  if (typeof node.type === 'function') {
    if (node.type.prototype && typeof node.type.prototype.render === 'function') {
      const instance = new node.type(node.props ?? {});
      return render(instance.render());
    }
    React._resetHooks();
    return render(node.type(node.props ?? {}));
  }
  const props = node.props ?? {};
  const attrs = [];
  if (props.className) attrs.push(`class="${escapeHtml(props.className)}"`);
  if (props.id) attrs.push(`id="${escapeHtml(props.id)}"`);
  if (props['aria-label']) attrs.push(`aria-label="${escapeHtml(props['aria-label'])}"`);
  return `<${node.type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${render(props.children)}</${node.type}>`;
}

const api = new Proxy({}, { get: () => async () => ({ projects: [] }) });
const ctx = { get: () => null, inject: () => () => {} };
const panel = render(React.createElement(mod.PingshuPanel, { api, pingshuCtx: ctx }));
assert.ok(panel.includes('评书'), 'panel should render the brand');
assert.ok(panel.includes('正在读取') || panel.includes('还没有书'), 'panel should render the project rail state');
assert.ok(panel.includes('评书工作台'), 'panel should render the welcome');

const script = `# 第一回 测试\n\n## 开场\n【说书人】各位听众，今天讲一个测试故事。\n\n## 正文\n【角色：张三】咱们走吧。\n\n## 扣子\n【说书人】欲知后事如何，且听下回分解。`;
const parsed = mod.parseScript(script);
assert.equal(parsed.blocks.filter((block) => block.type === 'paragraph').length, 3);
assert.ok(parsed.speech.length >= 3);
assert.ok(parsed.speech.some((segment) => segment.speaker === '角色：张三'));

const reader = {
  mode: 'performance',
  title: '第一回 测试',
  kicker: '《测试书》',
  markdown: script,
  meta: { versionId: 'v1', chapterId: 'ch-000001', chapterTitle: '第一回 测试' },
  chapter: { id: 'ch-000001', index: 1, title: '第一回 测试' },
  characters: [{ name: '张三', role: '主角', profile: '张三的小传' }],
  glossary: [{ term: '测试', explanation: '检查功能' }],
  autoPlay: false,
};
const readerHtml = render(React.createElement(mod.ReaderModal, {
  reader,
  onClose: () => {},
  onPerform: () => {},
  onRetell: () => {},
  onDelete: () => {},
  onToast: () => {},
}));
assert.ok(readerHtml.includes('第一回 测试'));
assert.ok(readerHtml.includes('张三'));
assert.ok(readerHtml.includes('不支持语音朗读') || readerHtml.includes('朗读'));

const chapterReader = { ...reader, mode: 'chapter', markdown: '# 第一回\n\n正文第一段。\n\n正文第二段。' };
const chapterHtml = render(React.createElement(mod.ReaderModal, {
  reader: chapterReader,
  onClose: () => {},
  onPerform: () => {},
  onRetell: () => {},
  onDelete: () => {},
  onToast: () => {},
}));
assert.ok(chapterHtml.includes('正文第一段'));
console.log('PASS: client smoke render (panel, reader, script parser)');
