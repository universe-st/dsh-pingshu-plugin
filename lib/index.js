/**
 * 评书 —— 宿主半区。
 *
 * 一个 Typert 远程服务（`pingshu`）承担项目/章节/资料/文案的控制面；
 * 一条 prefix HTTP 路由接收原始电子书上传；一组 Agent 工具让对话里的 AI
 * 读写项目、调整分章；startConversation 把界面操作变成「书名工作区里的新对话」。
 */
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import {
  archiveChapters,
  createProjectRecord,
  deleteProjectRecord,
  getChapterView,
  getPerformance,
  getFullText,
  listPerformances,
  listProjects,
  mutateProject,
  projectDir,
  projectPaths,
  readChapter,
  readProject,
  renameProject,
  savePerformance,
  deletePerformance,
  writeChapters,
} from './store.js';
import {
  analysisBatches,
  analysisStatus,
  getAnalysis,
  getDossier,
  getProjectView,
  repairProject,
  resolveQuery,
  saveChapterSummary,
  saveDossier,
} from './dossier.js';
import { adjustChapters, inspectChapterSplit, resplitByMarkers } from './chapters.js';
import { parseBook } from './parse.js';
import { loadGuide } from './prompts.js';
import { ensureWorkspace, startConversation, syncWorkspaceTitle } from './conversations.js';
import { MANIFEST, METHODS, PACKAGE_NAME, SERVICE_NAME } from './wire.js';
import { registerPingshuTools } from './tools.js';
import * as tts from './tts.js';

export const name = PACKAGE_NAME;
/**
 * webServer 必须是硬依赖：路由要等真正 listen 成功后才能注册；
 * typert 是远程服务与工具面的前提。
 */
export const inject = ['typert', 'webServer'];

const ROUTE_PREFIX = '/dsh-pingshu';
const UPLOAD_ROUTE = `${ROUTE_PREFIX}/upload`;
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const TOKEN_TTL_MS = 30 * 60 * 1000;

function now() {
  return Date.now();
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sniffFormat(firstBytes, filename) {
  const bytes = firstBytes instanceof Uint8Array ? firstBytes : new Uint8Array(firstBytes ?? []);
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'epub';
  const ext = String(filename ?? '').toLowerCase().split('.').pop();
  if (ext === 'txt') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'unknown';
}

async function readFirstBytes(path, length = 8) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function cleanupSourceFiles(projectId, keepName) {
  const dir = projectPaths(projectId).sourceDir;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('book.')) continue;
    if (entry.name === keepName) continue;
    await rm(join(dir, entry.name), { force: true });
  }
}

async function archiveChapterArtifacts(projectId) {
  const paths = projectPaths(projectId);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  try {
    const summaryArchive = join(paths.chapterSummariesDir, '.archive', stamp);
    await mkdir(summaryArchive, { recursive: true });
    const entries = await readdir(paths.chapterSummariesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^ch-\d{6,}\.(md|json)$/u.test(entry.name)) continue;
      await rename(join(paths.chapterSummariesDir, entry.name), join(summaryArchive, entry.name));
    }
  } catch {
    /* 没有就算了 */
  }
  try {
    const perfArchive = join(paths.performancesDir, '.archive', stamp);
    await mkdir(perfArchive, { recursive: true });
    const entries = await readdir(paths.performancesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^ch-\d{6,}$/u.test(entry.name)) continue;
      await rename(join(paths.performancesDir, entry.name), join(perfArchive, entry.name));
    }
  } catch {
    /* 没有就算了 */
  }
}

export class PingshuGateway extends TypertRemoteService {
  uploadTokens = new Map();
  importChain = Promise.resolve();

  constructor(ctx) {
    super(ctx, SERVICE_NAME);
  }

  // ── 项目 ──────────────────────────────────────────────────────────────

  async listProjects() {
    return { projects: await listProjects() };
  }

  async getProject(payload) {
    const project = await getProjectView(payload.projectId, { scan: payload.scan === true });
    return { project };
  }

  async repairProject(payload) {
    const project = await repairProject(payload.projectId);
    return { project: await getProjectView(project.id, { scan: false }) };
  }

  async createProject(payload) {
    const project = await createProjectRecord({
      title: payload.title,
      author: payload.author,
      filename: payload.filename,
    });
    const workspace = await ensureWorkspace(this.ctx, project);
    const token = this.issueUploadToken(project.id);
    return {
      projectId: project.id,
      uploadUrl: `${UPLOAD_ROUTE}/${token}`,
      workspaceId: workspace.workspaceId,
      warning: workspace.warning ?? undefined,
    };
  }

  async reissueUpload(payload) {
    const project = await readProject(payload.projectId);
    const token = this.issueUploadToken(project.id);
    return { projectId: project.id, uploadUrl: `${UPLOAD_ROUTE}/${token}` };
  }

  async startImport(payload) {
    const project = await readProject(payload.projectId);
    if (project.status === 'importing') return { started: false, reason: 'already-importing' };
    if (!project.source?.file) throw new Error('文件还没上传完，请先上传电子书');
    await mutateProject(project.id, (current) => {
      current.status = 'importing';
      current.import = { stage: 'reading', error: null, startedAt: new Date().toISOString() };
      return current;
    });
    this.enqueueImport(project.id);
    return { started: true };
  }

  async deleteProject(payload) {
    let project;
    try {
      project = await readProject(payload.projectId);
    } catch {
      project = null;
    }
    this.removeTokensForProject(payload.projectId);
    await deleteProjectRecord(payload.projectId);
    if (project?.workspaceId) {
      try {
        const registry = this.ctx.get('workspaceRegistry');
        await registry?.delete(project.workspaceId);
      } catch {
        /* 工作区可能已经不存在 */
      }
    }
    return { ok: true };
  }

  async renameProject(payload) {
    const project = await renameProject(payload.projectId, payload.title);
    await syncWorkspaceTitle(this.ctx, project);
    return { ok: true, project: await getProjectView(project.id, { scan: false }) };
  }

  // ── 章节 / 资料 ────────────────────────────────────────────────────────

  async getChapter(payload) {
    return getChapterView(payload.projectId, payload.chapterId, {
      offset: payload.offset,
      maxChars: payload.maxChars,
    });
  }

  async getAnalysis(payload) {
    return getAnalysis(payload.projectId, {
      kind: payload.kind,
      chapterId: payload.chapterId,
      name: payload.name,
    });
  }

  async saveChapterSummary(payload) {
    return saveChapterSummary(payload.projectId, payload.chapterId, payload.summary, {
      characters: payload.characters,
      terms: payload.terms,
      events: payload.events,
    });
  }

  async saveDossier(payload) {
    return saveDossier(payload.projectId, {
      bookSummary: payload.bookSummary,
      characters: payload.characters,
      timeline: payload.timeline,
      glossary: payload.glossary,
      context: payload.context,
    });
  }

  async analysisStatus(payload) {
    return analysisStatus(payload.projectId, { limit: payload.limit });
  }

  async analysisBatches(payload) {
    return analysisBatches(payload.projectId, { batchSize: payload.batchSize, limit: payload.limit });
  }

  async getDossier(payload) {
    return getDossier(payload.projectId, payload.chapterId);
  }

  // ── 评书文案 ───────────────────────────────────────────────────────────

  async savePerformance(payload) {
    return savePerformance(payload.projectId, payload.chapterId, payload.script, {
      title: payload.title,
      style: payload.style,
      durationMinutes: payload.durationMinutes,
      notes: payload.notes,
    });
  }

  async listPerformances(payload) {
    return listPerformances(payload.projectId, payload.chapterId);
  }

  async getPerformance(payload) {
    return getPerformance(payload.projectId, payload.chapterId, payload.versionId);
  }

  async deletePerformance(payload) {
    return deletePerformance(payload.projectId, payload.chapterId, payload.versionId);
  }

  // ── 重新分章 ───────────────────────────────────────────────────────────

  async resplitChapters(payload) {
    if (payload.confirm !== true) {
      return { ok: false, error: '重新分章会重建回目并重置章节摘要；确认后请传 confirm:true' };
    }
    const project = await readProject(payload.projectId);
    const fullText = await getFullText(payload.projectId);
    if (fullText.trim() === '') throw new Error('找不到全文，无法重新分章');
    const result = resplitByMarkers(fullText, payload.markers);
    if (!result.ok) return result;
    await archiveChapters(payload.projectId);
    await archiveChapterArtifacts(payload.projectId);
    const warnings = ['已重新分章；旧章节摘要与旧评书已归档到 .archive 目录'];
    await writeChapters(payload.projectId, result.chapters, fullText, warnings);
    await mutateProject(payload.projectId, (current) => {
      current.analysis = {
        chapterSummaries: 0,
        hasBookSummary: current.analysis?.hasBookSummary ?? false,
        characters: current.analysis?.characters ?? 0,
        hasTimeline: current.analysis?.hasTimeline ?? false,
        glossary: current.analysis?.glossary ?? 0,
        hasContext: current.analysis?.hasContext ?? false,
        complete: false,
      };
      current.performanceCount = 0;
      return current;
    });
    return {
      ok: true,
      project: await getProjectView(payload.projectId, { scan: true }),
      warnings,
    };
  }

  /**
   * 在现有回目上做增量调整（inspect 只体检；apply 才写盘）。
   * 适合目录残片、-1/-2 拆回、附录没切开这类局部问题，不必整本书重来。
   */
  async adjustChapters(payload) {
    const project = await readProject(payload.projectId);
    const fullText = await getFullText(payload.projectId);
    if (fullText.trim() === '') throw new Error('找不到全文，无法调整分章');
    const chapters = [];
    for (const chapter of project.chapters) {
      const { body } = await readChapter(payload.projectId, chapter.id);
      chapters.push({
        id: chapter.id,
        index: chapter.index,
        title: chapter.title,
        text: body,
        chars: chapter.chars,
      });
    }
    if (payload.action === undefined || payload.action === 'inspect') {
      const report = inspectChapterSplit(chapters);
      return { ...report, projectId: project.id, action: 'inspect' };
    }
    if (payload.action !== 'apply') return { ok: false, error: `不支持的动作：${payload.action}` };
    if (payload.confirm !== true) {
      return { ok: false, error: '调整分章会重建回目并重置章节摘要；确认后请传 confirm:true' };
    }
    const ops = Array.isArray(payload.ops) ? payload.ops : [];
    if (ops.length === 0) return { ok: false, error: 'apply 至少需要一个操作' };
    const result = adjustChapters({ fullText, chapters, ops });
    if (!result.ok) return result;
    await archiveChapters(payload.projectId);
    await archiveChapterArtifacts(payload.projectId);
    const warnings = ['已调整分章；旧章节摘要与旧评书已归档到 .archive 目录'];
    await writeChapters(payload.projectId, result.chapters, fullText, warnings);
    await mutateProject(payload.projectId, (current) => {
      current.analysis = {
        chapterSummaries: 0,
        hasBookSummary: current.analysis?.hasBookSummary ?? false,
        characters: current.analysis?.characters ?? 0,
        hasTimeline: current.analysis?.hasTimeline ?? false,
        glossary: current.analysis?.glossary ?? 0,
        hasContext: current.analysis?.hasContext ?? false,
        complete: false,
      };
      current.performanceCount = 0;
      return current;
    });
    return {
      ok: true,
      action: 'apply',
      summary: result.summary,
      project: await getProjectView(payload.projectId, { scan: true }),
      warnings,
    };
  }

  // ── 搜索 / 对话 / 手册 ─────────────────────────────────────────────────

  async resolve(payload) {
    return resolveQuery(payload.query, { limit: payload.limit });
  }

  async startConversation(payload) {
    return startConversation(this.ctx, payload.projectId, {
      intent: payload.intent,
      chapterId: payload.chapterId,
      focus: payload.focus,
      options: payload.options,
      instruction: payload.instruction,
      previousVersionId: payload.previousVersionId,
    });
  }

  async getGuide(payload) {
    return loadGuide(payload?.topic ?? 'all');
  }

  async getTtsConfig() {
    return tts.getTtsConfig();
  }

  async saveTtsConfig(payload) {
    return tts.saveTtsConfig(payload);
  }

  async uploadTtsReference(payload) {
    return tts.uploadTtsReference(payload);
  }

  async ttsTest(payload) {
    return tts.testTts(payload?.endpoint);
  }

  async volcTest(payload) {
    return tts.testVolcengine(payload ?? {});
  }

  async siliconTest(payload) {
    return tts.testSiliconFlow(payload ?? {});
  }

  async ttsStart(payload) {
    return tts.startTtsJob(payload);
  }

  async ttsJob(payload) {
    return tts.getTtsJob(payload.jobId);
  }

  async ttsCancel(payload) {
    return tts.cancelTtsJob(payload.jobId);
  }

  assertSurface() {
    for (const spec of METHODS) {
      if (typeof this[spec.method] !== 'function') throw new Error(`pingshu 缺少方法：${spec.method}`);
    }
  }

  // ── 上传 ──────────────────────────────────────────────────────────────

  issueUploadToken(projectId) {
    for (const [token, entry] of this.uploadTokens) {
      if (entry.expiresAt < now()) this.uploadTokens.delete(token);
    }
    const token = randomUUID().replace(/-/gu, '');
    this.uploadTokens.set(token, { projectId, expiresAt: now() + TOKEN_TTL_MS });
    return token;
  }

  removeTokensForProject(projectId) {
    for (const [token, entry] of this.uploadTokens) {
      if (entry.projectId === projectId) this.uploadTokens.delete(token);
    }
  }

  enqueueImport(projectId) {
    const run = () => this.runImport(projectId).catch(() => undefined);
    this.importChain = this.importChain.then(run, run);
    return this.importChain;
  }

  async runImport(projectId) {
    try {
      const project = await readProject(projectId);
      if (!project.source?.file) throw new Error('找不到上传的源文件');
      const bytes = new Uint8Array(await readFile(join(projectDir(projectId), project.source.file)));
      await mutateProject(projectId, (current) => {
        current.import = { ...(current.import ?? {}), stage: 'extracting', error: null };
        return current;
      });
      const parsed = await parseBook(bytes, project.source.name || project.sourceName);
      await mutateProject(projectId, (current) => {
        current.import = { ...(current.import ?? {}), stage: 'splitting' };
        return current;
      });
      // 重新导入时，旧回目与旧摘要/文案先归档，避免同 id 串味。
      await archiveChapters(projectId);
      await archiveChapterArtifacts(projectId);
      await writeChapters(projectId, parsed.chapters, parsed.fullText, parsed.warnings);
      const updatedProject = await mutateProject(projectId, (current) => {
        const filenameBase = String(current.sourceName ?? '').replace(/\.[^.]+$/u, '').trim();
        if ((current.title === filenameBase || !current.title) && parsed.title) current.title = parsed.title;
        if (!current.author && parsed.author) current.author = parsed.author;
        current.format = parsed.format;
        current.language = parsed.language || current.language || 'zh';
        current.warnings = parsed.warnings ?? [];
        current.import = {
          stage: 'done',
          error: null,
          startedAt: current.import?.startedAt ?? null,
          finishedAt: new Date().toISOString(),
        };
        return current;
      });
      // 书名可能从“文件名”换成了 EPUB/PDF 元数据名；同步到左侧工作区标题。
      await syncWorkspaceTitle(this.ctx, updatedProject);
    } catch (error) {
      await mutateProject(projectId, (current) => {
        current.status = 'error';
        current.import = {
          ...(current.import ?? {}),
          stage: 'error',
          error: errorMessage(error),
        };
        return current;
      }).catch(() => undefined);
    }
  }

  async handleAudioRoute(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rest = url.pathname.slice('/dsh-pingshu/audio/'.length);
    const [hash, file] = rest.split('/');
    const found = await tts.audioFile(hash, file);
    if (!found) {
      sendJson(res, 404, { ok: false, error: '音频不存在' });
      return;
    }
    const data = await readFile(found.path);
    res.statusCode = 200;
    res.setHeader('content-type', found.mime ?? 'audio/wav');
    res.setHeader('content-length', String(data.length));
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  }

  async handleUploadRoute(req, res) {
    let tempPath = null;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/dsh-pingshu/audio/')) {
        await this.handleAudioRoute(req, res);
        return;
      }
      if (!url.pathname.startsWith(`${UPLOAD_ROUTE}/`)) {
        sendJson(res, 404, { ok: false, error: 'not-found' });
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      const token = decodeURIComponent(url.pathname.slice(UPLOAD_ROUTE.length + 1));
      const entry = this.uploadTokens.get(token);
      if (!entry) {
        sendJson(res, 403, { ok: false, error: '上传链接无效或已使用' });
        return;
      }
      if (entry.expiresAt < now()) {
        this.uploadTokens.delete(token);
        sendJson(res, 403, { ok: false, error: '上传链接已过期' });
        return;
      }
      const project = await readProject(entry.projectId);
      const declaredLength = Number(req.headers['content-length'] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
        req.resume();
        sendJson(res, 413, { ok: false, error: `文件太大（上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）` });
        return;
      }
      tempPath = join(projectPaths(project.id).sourceDir, `.upload-${token}.part`);
      const handle = await open(tempPath, 'w', 0o600);
      let bytes = 0;
      let tooLarge = false;
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > MAX_UPLOAD_BYTES) {
            tooLarge = true;
            break;
          }
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }
      if (tooLarge) {
        await rm(tempPath, { force: true });
        sendJson(res, 413, { ok: false, error: `文件太大（上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）` });
        return;
      }
      const first = await readFirstBytes(tempPath);
      const format = sniffFormat(first, project.sourceName);
      if (format === 'unknown') {
        await rm(tempPath, { force: true });
        sendJson(res, 415, { ok: false, error: '只支持 EPUB、PDF、TXT、Markdown' });
        return;
      }
      const ext = format === 'md' ? 'md' : format;
      const fileName = `book.${ext}`;
      await rm(join(projectPaths(project.id).sourceDir, fileName), { force: true });
      await rename(tempPath, join(projectPaths(project.id).sourceDir, fileName));
      await cleanupSourceFiles(project.id, fileName);
      await mutateProject(project.id, (current) => {
        current.source = { file: `source/${fileName}`, bytes, name: current.sourceName };
        current.format = format;
        current.status = 'created';
        current.import = { stage: 'uploaded', error: null, startedAt: null };
        return current;
      });
      this.uploadTokens.delete(token);
      sendJson(res, 200, { ok: true, format, bytes, file: `source/${fileName}` });
    } catch (error) {
      if (tempPath) {
        try { await rm(tempPath, { force: true }); } catch { /* ignore */ }
      }
      sendJson(res, 500, { ok: false, error: errorMessage(error) });
    }
  }
}

async function recoverStaleImports() {
  try {
    const projects = await listProjects();
    for (const summary of projects) {
      if (summary.status !== 'importing') continue;
      await mutateProject(summary.id, (current) => {
        current.status = 'error';
        current.import = { ...(current.import ?? {}), stage: 'error', error: '上次导入中断，请重试' };
        return current;
      }).catch(() => undefined);
    }
  } catch {
    /* 启动恢复失败不影响插件 */
  }
}

export function apply(ctx) {
  const gateway = new PingshuGateway(ctx);
  gateway.assertSurface();
  ctx.effect(() => ctx.typert.register(MANIFEST), 'pingshu: typert manifest');
  ctx.effect(() => {
    const disposers = registerPingshuTools(
      { tools: ctx.get('tools'), systemPrompt: ctx.get('systemPrompt') },
      gateway,
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'pingshu: tools');
  const webServer = ctx.get('webServer');
  if (webServer !== undefined && webServer !== null) {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res) => gateway.handleUploadRoute(req, res) }),
      'pingshu: upload route',
    );
  }
  void recoverStaleImports();
}

export { METHODS };
