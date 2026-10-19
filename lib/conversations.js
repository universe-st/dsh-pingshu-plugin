/**
 * 对话桥：项目 = 工作区，操作 = 新 Session。
 *
 * 界面上的「导入并分析」「讲这一回」「补充人物」等都走这里：
 * 1. 确保项目目录已注册成 DSH 工作区（书名会出现在侧栏）；
 * 2. 新建 Session，cwd 指向项目目录；
 * 3. 改名成可读标题；
 * 4. 把任务提示词作为第一轮发进去。
 *
 * 客户端拿到 sessionId 后用 uiWorkspace.openSession 切过去。
 */
import { randomUUID } from 'node:crypto';
import { projectDir, readProject, setLastSession, setWorkspaceId } from './store.js';
import { buildPrompt, sessionTitleFor } from './prompts.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function ensureWorkspace(ctx, project) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined || registry === null) return { workspaceId: project.workspaceId ?? null, warning: '当前环境没有工作区服务，对话会落在未分组里' };
  if (project.workspaceId) {
    try {
      const existing = registry.get(project.workspaceId);
      if (existing) return { workspaceId: existing.id, warning: null };
    } catch {
      /* recreate below */
    }
  }
  try {
    const workspace = await registry.create(projectDir(project.id), project.title);
    if (project.workspaceId !== workspace.id) await setWorkspaceId(project.id, workspace.id);
    if (workspace.title !== project.title && typeof workspace.setTitle === 'function') {
      try { await workspace.setTitle(project.title); } catch { /* 标题同步失败不影响对话 */ }
    }
    return { workspaceId: workspace.id, warning: null };
  } catch (error) {
    return { workspaceId: project.workspaceId ?? null, warning: `工作区创建失败：${errorMessage(error)}` };
  }
}

export async function syncWorkspaceTitle(ctx, project) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined || registry === null || !project.workspaceId) return;
  try {
    const workspace = registry.get(project.workspaceId);
    if (workspace) await workspace.setTitle(project.title);
  } catch {
    /* 标题同步失败不影响项目 */
  }
}

async function admitPrompt(sessionController, sessionId, text) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // prompt(request, signal) 的第二个参数是必需的 AbortSignal；
      // 这里没有调用方信号，用一个新的 controller，避免 signal.throwIfAborted() 崩溃。
      const controller = new AbortController();
      const result = await sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, controller.signal);
      if (result && result.accepted === true) return { accepted: true };
      lastError = new Error('对话服务没有接受提示词');
    } catch (error) {
      lastError = error;
      const message = errorMessage(error);
      if (!/busy|正在|resume|not-found|not found|starting|writer/i.test(message)) break;
      await sleep(350 * (attempt + 1));
    }
  }
  return { accepted: false, error: errorMessage(lastError) };
}

/**
 * @returns {{sessionId:string, workspaceId:string|null, title:string, promptSent:boolean, error?:string, promptText:string}}
 */
export async function startConversation(ctx, projectId, request = {}) {
  const project = await readProject(projectId);
  const intent = String(request.intent ?? 'analyze');
  const chapterId = request.chapterId ? String(request.chapterId) : undefined;
  const chapter = chapterId ? project.chapters.find((entry) => entry.id === chapterId) : undefined;
  if (chapterId && !chapter) throw new Error(`找不到章节 ${chapterId}`);
  const promptText = buildPrompt(intent, project, {
    chapter,
    focus: request.focus,
    options: request.options,
    instruction: request.instruction,
    previousVersionId: request.previousVersionId,
  });
  const sessionController = ctx.get('sessionController');
  if (sessionController === undefined || sessionController === null) {
    throw new Error('当前环境不支持从插件创建对话（缺少 sessionController 服务）');
  }
  const workspace = await ensureWorkspace(ctx, project);
  let created;
  try {
    // session.create 只接受 workspaceId 或 cwd 其中一个，不能同时给。
    // 有工作区时用 workspaceId（cwd 由工作区路径决定），否则退回 cwd。
    const location = workspace.workspaceId
      ? { workspaceId: workspace.workspaceId }
      : { cwd: projectDir(project.id) };
    created = await sessionController.create(location);
  } catch (error) {
    throw new Error(`创建对话失败：${errorMessage(error)}`);
  }
  const sessionId = created?.sessionId;
  if (!sessionId) throw new Error('创建对话失败：没有返回 sessionId');
  const title = sessionTitleFor(intent, project, chapter, request.focus);
  try {
    await sessionController.rename({ sessionId, title });
  } catch {
    /* 改名失败不影响对话；自动标题仍然可用 */
  }
  const admitted = await admitPrompt(sessionController, sessionId, promptText);
  await setLastSession(projectId, sessionId, intent);
  return {
    sessionId,
    workspaceId: workspace.workspaceId,
    title,
    promptSent: admitted.accepted === true,
    error: admitted.accepted === true ? undefined : admitted.error,
    promptText,
    warning: workspace.warning ?? undefined,
  };
}
