/**
 * 评书 —— 项目持久化层。
 *
 * 所有用户数据都在 `$DSH_HOME/pingshu/projects/<id>/` 下，普通文件、可备份、可手改。
 * 这一层只做文件与项目元数据；分析资料的合并/渲染在 dossier.js，解析在 parse/。
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

export const SCHEMA_VERSION = 1;
export const PROJECT_ID_PATTERN = /^b[a-z0-9]{6,32}$/;
export const CHAPTER_ID_PATTERN = /^ch-\d{6,}$/;
export const VERSION_ID_PATTERN = /^v\d{1,6}$/;
export const MAX_PROJECT_TITLE = 120;

const locks = new Map();

function nowIso() {
  return new Date().toISOString();
}

/** 数据根；测试可用 PINGSHU_DATA_DIR 指向临时目录。 */
export function dataRoot() {
  if (process.env.PINGSHU_DATA_DIR) return resolve(process.env.PINGSHU_DATA_DIR);
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'pingshu');
}

export function projectsRoot() {
  return join(dataRoot(), 'projects');
}

export function projectDir(projectId) {
  assertProjectId(projectId);
  const dir = resolve(projectsRoot(), projectId);
  const root = resolve(projectsRoot()) + sep;
  if (!dir.startsWith(root)) throw new Error('非法的项目路径');
  return dir;
}

export function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error('项目 id 不合法（应形如 b1a2c3d4e5f6）');
  }
}

export function assertChapterId(chapterId) {
  if (typeof chapterId !== 'string' || !CHAPTER_ID_PATTERN.test(chapterId)) {
    throw new Error('章节 id 不合法（应形如 ch-000001）');
  }
}

export function assertVersionId(versionId) {
  if (typeof versionId !== 'string' || !VERSION_ID_PATTERN.test(versionId)) {
    throw new Error('文案版本 id 不合法（应形如 v1）');
  }
}

/** 文件名清洗：去掉路径分隔符、控制字符、Windows 保留名，限制长度。 */
export function safeName(input, fallback = 'item') {
  let value = String(input ?? '').normalize('NFKC').trim();
  value = value.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_');
  value = value.replace(/\s+/gu, ' ').replace(/^\.+/, '').trim();
  if (value === '') value = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value)) value = `_${value}`;
  return [...value].slice(0, 48).join('');
}

export function safeSourceFileName(filename) {
  const base = safeName(String(filename ?? 'book').replace(/\.[^.]+$/u, ''), 'book');
  const ext = extname(String(filename ?? '')).toLowerCase();
  const allowed = new Set(['.pdf', '.epub', '.txt', '.md', '.markdown']);
  return `${base}${allowed.has(ext) ? ext : '.bin'}`;
}

export function detectFormatFromName(filename) {
  const ext = extname(String(filename ?? '')).toLowerCase();
  if (ext === '.epub') return 'epub';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.txt') return 'txt';
  if (ext === '.md' || ext === '.markdown') return 'md';
  return 'unknown';
}

export function formatLabel(format) {
  return ({ epub: 'EPUB', pdf: 'PDF', txt: 'TXT', md: 'Markdown' })[format] ?? String(format ?? '未知');
}

export function countChars(text) {
  return [...String(text ?? '').replace(/\s/gu, '')].length;
}

export function truncateText(text, maxChars) {
  const chars = [...String(text ?? '')];
  if (chars.length <= maxChars) return { text: String(text ?? ''), truncated: false, totalChars: chars.length };
  return { text: chars.slice(0, maxChars).join(''), truncated: true, totalChars: chars.length };
}

/** 读-改-写串行链：同一个项目内的写入不互相踩。 */
export function withProjectLock(projectId, fn) {
  const previous = locks.get(projectId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  locks.set(projectId, run.then(() => undefined, () => undefined));
  return run;
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function writeAtomic(path, content) {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch {
    await rm(path, { force: true });
    await rename(tmp, path);
  }
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function projectPaths(projectId) {
  const dir = projectDir(projectId);
  return {
    dir,
    projectJson: join(dir, 'project.json'),
    sourceDir: join(dir, 'source'),
    sourceFile: (ext) => join(dir, 'source', `book.${ext}`),
    textFile: join(dir, 'text', 'book.txt'),
    chaptersDir: join(dir, 'chapters'),
    summariesDir: join(dir, 'summaries'),
    chapterSummariesDir: join(dir, 'summaries', 'chapters'),
    bookSummaryFile: join(dir, 'summaries', 'book.md'),
    charactersDir: join(dir, 'characters'),
    charactersIndex: join(dir, 'characters', 'index.json'),
    timelineDir: join(dir, 'timeline'),
    timelineJson: join(dir, 'timeline', 'timeline.json'),
    timelineMd: join(dir, 'timeline', 'timeline.md'),
    backgroundDir: join(dir, 'background'),
    glossaryJson: join(dir, 'background', 'glossary.json'),
    glossaryMd: join(dir, 'background', 'glossary.md'),
    contextMd: join(dir, 'background', 'context.md'),
    performancesDir: join(dir, 'performances'),
  };
}

export function chapterFile(projectId, chapterId) {
  assertChapterId(chapterId);
  return join(projectPaths(projectId).chaptersDir, `${chapterId}.md`);
}

export function chapterSummaryFile(projectId, chapterId) {
  assertChapterId(chapterId);
  return join(projectPaths(projectId).chapterSummariesDir, `${chapterId}.md`);
}

export function chapterSummaryJson(projectId, chapterId) {
  assertChapterId(chapterId);
  return join(projectPaths(projectId).chapterSummariesDir, `${chapterId}.json`);
}

export function performanceDir(projectId, chapterId) {
  assertChapterId(chapterId);
  return join(projectPaths(projectId).performancesDir, chapterId);
}

export function performanceFile(projectId, chapterId, versionId) {
  assertVersionId(versionId);
  return join(performanceDir(projectId, chapterId), `${versionId}.md`);
}

export function performanceIndexFile(projectId, chapterId) {
  assertChapterId(chapterId);
  return join(performanceDir(projectId, chapterId), 'index.json');
}

/** 在 frontmatter 里安全地写扁平值：字符串用 JSON 引号（合法的 YAML 双引号标量）。 */
function frontmatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' || typeof value === 'boolean') lines.push(`${key}: ${value}`);
    else lines.push(`${key}: ${JSON.stringify(String(value))}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function stripFrontmatter(markdown) {
  const text = String(markdown ?? '');
  if (!text.startsWith('---')) return text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
  if (!match) return text;
  return text.slice(match[0].length);
}

export function readFrontmatter(markdown) {
  const text = String(markdown ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
  if (!match) return {};
  try {
    const value = parseYaml(match[1]);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function chapterMarkdown(chapter) {
  const meta = {
    id: chapter.id,
    index: chapter.index,
    title: chapter.title,
    chars: chapter.chars,
    source: chapter.source || undefined,
  };
  return `${frontmatter(meta)}\n\n# ${chapter.title}\n\n${String(chapter.text ?? '').trim()}\n`;
}

export async function createProjectRecord({ title, author = '', filename = '' } = {}) {
  const cleanTitle = String(title ?? '').trim().slice(0, MAX_PROJECT_TITLE) || defaultTitleFromFilename(filename);
  const cleanAuthor = String(author ?? '').trim().slice(0, 80);
  let projectId = `b${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
  let dir = projectDir(projectId);
  for (let attempt = 0; attempt < 5 && existsSync(dir); attempt += 1) {
    projectId = `b${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
    dir = projectDir(projectId);
  }
  await ensureDir(dir);
  const paths = projectPaths(projectId);
  await Promise.all([
    ensureDir(paths.sourceDir),
    ensureDir(paths.chaptersDir),
    ensureDir(paths.chapterSummariesDir),
    ensureDir(paths.charactersDir),
    ensureDir(paths.timelineDir),
    ensureDir(paths.backgroundDir),
    ensureDir(paths.performancesDir),
  ]);
  const now = nowIso();
  const project = {
    schemaVersion: SCHEMA_VERSION,
    id: projectId,
    title: cleanTitle,
    author: cleanAuthor,
    format: detectFormatFromName(filename),
    language: 'zh',
    createdAt: now,
    updatedAt: now,
    status: 'created',
    import: { stage: 'waiting', error: null, startedAt: null },
    source: null,
    sourceName: String(filename ?? ''),
    charCount: 0,
    workspaceId: null,
    lastSessionId: null,
    warnings: [],
    chapters: [],
    analysis: emptyAnalysis(),
    performanceCount: 0,
  };
  await writeProjectJson(project);
  return project;
}

export function emptyAnalysis() {
  return {
    chapterSummaries: 0,
    hasBookSummary: false,
    characters: 0,
    hasTimeline: false,
    glossary: 0,
    hasContext: false,
    complete: false,
  };
}

function defaultTitleFromFilename(filename) {
  const base = String(filename ?? '').split(/[\\/]/u).pop() ?? '';
  const withoutExt = base.replace(/\.[^.]+$/u, '').trim();
  return [...(withoutExt || '未命名书目')].slice(0, MAX_PROJECT_TITLE).join('');
}

export async function writeProjectJson(project) {
  await writeAtomic(projectPaths(project.id).projectJson, `${JSON.stringify(project, null, 2)}\n`);
}

export async function readProject(projectId) {
  assertProjectId(projectId);
  const project = await readJsonIfExists(projectPaths(projectId).projectJson);
  if (!project) throw new Error('项目不存在或 project.json 已丢失');
  if (!Array.isArray(project.chapters)) project.chapters = [];
  if (!project.analysis) project.analysis = emptyAnalysis();
  return project;
}

export async function projectExists(projectId) {
  try {
    await stat(projectPaths(projectId).projectJson);
    return true;
  } catch {
    return false;
  }
}

export async function listProjects() {
  let entries = [];
  try {
    entries = await readdir(projectsRoot(), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_ID_PATTERN.test(entry.name)) continue;
    const project = await readJsonIfExists(join(projectsRoot(), entry.name, 'project.json'));
    if (!project) continue;
    projects.push(project);
  }
  projects.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return projects.map(projectSummary);
}

export function projectSummary(project) {
  return {
    id: project.id,
    title: project.title,
    author: project.author,
    format: project.format,
    status: project.status,
    chapterCount: Array.isArray(project.chapters) ? project.chapters.length : 0,
    charCount: project.charCount ?? 0,
    analysis: project.analysis ?? emptyAnalysis(),
    performanceCount: project.performanceCount ?? 0,
    workspaceId: project.workspaceId ?? null,
    lastSessionId: project.lastSessionId ?? null,
    warnings: Array.isArray(project.warnings) ? project.warnings : [],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export async function mutateProject(projectId, mutate) {
  return withProjectLock(projectId, async () => {
    const project = await readProject(projectId);
    const result = await mutate(project);
    project.updatedAt = nowIso();
    await writeProjectJson(project);
    return result;
  });
}

export async function updateProjectFields(projectId, patch) {
  return mutateProject(projectId, (project) => {
    Object.assign(project, patch);
    return project;
  });
}

export async function renameProject(projectId, title) {
  const clean = String(title ?? '').trim().slice(0, MAX_PROJECT_TITLE);
  if (clean === '') throw new Error('书名不能为空');
  return mutateProject(projectId, (project) => {
    project.title = clean;
    return project;
  });
}

export async function deleteProjectRecord(projectId) {
  return withProjectLock(projectId, async () => {
    await rm(projectDir(projectId), { recursive: true, force: true });
  });
}

/** 写回目与全文；调用方负责先归档旧回目（重新分章时）。 */
export async function writeChapters(projectId, chapters, fullText, warnings = []) {
  return mutateProject(projectId, async (project) => {
    const paths = projectPaths(projectId);
    await ensureDir(paths.chaptersDir);
    await writeAtomic(paths.textFile, String(fullText ?? ''));
    for (const chapter of chapters) {
      await writeAtomic(chapterFile(projectId, chapter.id), chapterMarkdown(chapter));
    }
    project.chapters = chapters.map((chapter) => ({
      id: chapter.id,
      index: chapter.index,
      title: chapter.title,
      chars: chapter.chars,
      summary: false,
      performances: 0,
      source: chapter.source ?? null,
    }));
    project.charCount = chapters.reduce((sum, chapter) => sum + (chapter.chars ?? 0), 0);
    project.status = 'ready';
    project.import = { stage: 'done', error: null, startedAt: project.import?.startedAt ?? null, finishedAt: nowIso() };
    project.warnings = Array.isArray(warnings) ? warnings : [];
    return project;
  });
}

export async function archiveChapters(projectId) {
  const paths = projectPaths(projectId);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const archiveDir = join(paths.chaptersDir, '.archive', stamp);
  await ensureDir(archiveDir);
  try {
    const entries = await readdir(paths.chaptersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^ch-\d{6,}\.md$/u.test(entry.name)) continue;
      await rename(join(paths.chaptersDir, entry.name), join(archiveDir, entry.name));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return archiveDir;
}

export async function readChapter(projectId, chapterId) {
  const file = chapterFile(projectId, chapterId);
  const markdown = await readFile(file, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`找不到章节 ${chapterId}`);
    throw error;
  });
  const withoutFront = stripFrontmatter(markdown).replace(/^\s+/u, '');
  return { meta: readFrontmatter(markdown), body: withoutFront.replace(/^#\s+[^\n]*\n+/u, '').trimStart() };
}

export async function getChapterView(projectId, chapterId, { offset = 0, maxChars = 20000 } = {}) {
  const project = await readProject(projectId);
  const chapter = project.chapters.find((entry) => entry.id === chapterId);
  if (!chapter) throw new Error(`找不到章节 ${chapterId}`);
  const { body } = await readChapter(projectId, chapterId);
  const chars = [...body];
  const start = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, chars.length));
  const size = Math.max(500, Math.min(Number.isFinite(maxChars) ? Math.floor(maxChars) : 20000, 60000));
  const text = chars.slice(start, start + size).join('');
  const nextOffset = start + text.length < chars.length ? start + text.length : null;
  return {
    chapter: { id: chapter.id, index: chapter.index, title: chapter.title, chars: chapter.chars, summary: chapter.summary === true },
    text,
    offset: start,
    nextOffset,
    totalChars: chars.length,
  };
}

export async function getFullText(projectId) {
  return (await readTextIfExists(projectPaths(projectId).textFile)) ?? '';
}

// ── 评书文案 ─────────────────────────────────────────────────────────────

async function readPerformanceIndex(projectId, chapterId) {
  const index = await readJsonIfExists(performanceIndexFile(projectId, chapterId));
  if (index && Array.isArray(index.versions)) return index;
  return { chapterId, versions: [] };
}

async function writePerformanceIndex(projectId, chapterId, index) {
  await writeAtomic(performanceIndexFile(projectId, chapterId), `${JSON.stringify(index, null, 2)}\n`);
}

function versionNumber(versionId) {
  return Number(String(versionId).replace(/^v/u, '')) || 0;
}

function performanceMetaView(project, chapter, version) {
  const chars = Number(version.chars) || 0;
  return {
    ...version,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    bookTitle: project.title,
    estimatedMinutes: Math.max(1, Math.round(chars / 260)),
  };
}

export async function savePerformance(projectId, chapterId, script, options = {}) {
  const body = stripFrontmatter(script).trim();
  if (body.length < 200) throw new Error('文案太短（至少 200 个字符），请先写完再保存');
  if (body.length > 120000) throw new Error('文案太长（超过 12 万字符），请分段保存或缩短');
  const chars = countChars(body);
  const createdAt = nowIso();
  return mutateProject(projectId, async (project) => {
    const chapter = project.chapters.find((entry) => entry.id === chapterId);
    if (!chapter) throw new Error(`找不到章节 ${chapterId}`);
    const dir = performanceDir(projectId, chapterId);
    await ensureDir(dir);
    const index = await readPerformanceIndex(projectId, chapterId);
    const next = Math.max(0, ...index.versions.map((entry) => versionNumber(entry.versionId))) + 1;
    const versionId = `v${next}`;
    const meta = {
      versionId,
      title: String(options.title ?? chapter.title).trim().slice(0, 160) || chapter.title,
      style: String(options.style ?? '').trim().slice(0, 60) || null,
      durationMinutes: Number.isFinite(Number(options.durationMinutes)) ? Number(options.durationMinutes) : null,
      notes: String(options.notes ?? '').trim().slice(0, 4000) || null,
      chars,
      createdAt,
      file: `${versionId}.md`,
    };
    const markdown = `${frontmatter({
      version: versionId,
      project: projectId,
      chapter: chapterId,
      title: meta.title,
      style: meta.style ?? undefined,
      durationMinutes: meta.durationMinutes ?? undefined,
      chars,
      createdAt,
      chapterTitle: chapter.title,
    })}\n\n${body}\n`;
    await writeAtomic(performanceFile(projectId, chapterId, versionId), markdown);
    index.versions.push(meta);
    await writePerformanceIndex(projectId, chapterId, index);
    chapter.performances = index.versions.length;
    project.performanceCount = project.chapters.reduce((sum, entry) => sum + (Number(entry.performances) || 0), 0);
    return performanceMetaView(project, chapter, meta);
  });
}

export async function listPerformances(projectId, chapterId) {
  const project = await readProject(projectId);
  const chapters = chapterId
    ? project.chapters.filter((entry) => entry.id === chapterId)
    : project.chapters;
  const items = [];
  for (const chapter of chapters) {
    const index = await readPerformanceIndex(projectId, chapter.id);
    for (const version of index.versions) items.push(performanceMetaView(project, chapter, version));
  }
  items.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  return { items };
}

export async function getPerformance(projectId, chapterId, versionId) {
  const project = await readProject(projectId);
  const chapter = project.chapters.find((entry) => entry.id === chapterId);
  if (!chapter) throw new Error(`找不到章节 ${chapterId}`);
  const index = await readPerformanceIndex(projectId, chapterId);
  if (index.versions.length === 0) throw new Error('这一回还没有评书文案');
  const version = versionId
    ? index.versions.find((entry) => entry.versionId === versionId)
    : index.versions[index.versions.length - 1];
  if (!version) throw new Error(`找不到文案版本 ${versionId}`);
  const markdown = await readFile(performanceFile(projectId, chapterId, version.versionId), 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') throw new Error('文案文件已丢失');
    throw error;
  });
  return {
    meta: performanceMetaView(project, chapter, version),
    script: stripFrontmatter(markdown).trim(),
    markdown,
  };
}

export async function deletePerformance(projectId, chapterId, versionId) {
  return mutateProject(projectId, async (project) => {
    const chapter = project.chapters.find((entry) => entry.id === chapterId);
    if (!chapter) throw new Error(`找不到章节 ${chapterId}`);
    const index = await readPerformanceIndex(projectId, chapterId);
    const position = index.versions.findIndex((entry) => entry.versionId === versionId);
    if (position < 0) throw new Error(`找不到文案版本 ${versionId}`);
    index.versions.splice(position, 1);
    await writePerformanceIndex(projectId, chapterId, index);
    await rm(performanceFile(projectId, chapterId, versionId), { force: true });
    chapter.performances = index.versions.length;
    project.performanceCount = project.chapters.reduce((sum, entry) => sum + (Number(entry.performances) || 0), 0);
    return { ok: true, chapterId, versionId };
  });
}

// ── 对话关联 ─────────────────────────────────────────────────────────────

export async function setWorkspaceId(projectId, workspaceId) {
  return mutateProject(projectId, (project) => {
    project.workspaceId = workspaceId ?? null;
    return project;
  });
}

export async function setLastSession(projectId, sessionId, intent) {
  return mutateProject(projectId, (project) => {
    project.lastSessionId = sessionId ?? null;
    project.lastIntent = intent ?? null;
    return project;
  });
}

// ── 杂项 ────────────────────────────────────────────────────────────────

export async function readTextFile(path) {
  return readTextIfExists(path);
}

export async function writeTextFile(path, content) {
  await writeAtomic(path, content);
}

export async function readJsonFile(path) {
  return readJsonIfExists(path);
}

export async function writeJsonFile(path, value) {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function listChapterFiles(projectId) {
  try {
    const entries = await readdir(projectPaths(projectId).chaptersDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^ch-\d{6,}\.md$/u.test(entry.name))
      .map((entry) => entry.name.replace(/\.md$/u, ''))
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function listPerformanceChapterDirs(projectId) {
  try {
    const entries = await readdir(projectPaths(projectId).performancesDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && CHAPTER_ID_PATTERN.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function listChapterSummaryFiles(projectId) {
  try {
    const entries = await readdir(projectPaths(projectId).chapterSummariesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^ch-\d{6,}\.json$/u.test(entry.name))
      .map((entry) => entry.name.replace(/\.json$/u, ''))
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
