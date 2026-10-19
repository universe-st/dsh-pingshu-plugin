import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectRecord, writeChapters, readProject, projectDir } from '../lib/store.js';
import { startConversation, ensureWorkspace } from '../lib/conversations.js';

test('startConversation creates a workspace session and admits the prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingshu-conv-'));
  process.env.PINGSHU_DATA_DIR = dir;
  try {
    const project = await createProjectRecord({ title: '对话测试书', author: '作者', filename: 'x.epub' });
    await writeChapters(project.id, [
      { index: 1, id: 'ch-000001', title: '第一回 开场', text: '第一回正文。', chars: 6 },
      { index: 2, id: 'ch-000002', title: '第二回 继续', text: '第二回正文。', chars: 6 },
    ], '第一回正文。\n\n第二回正文。');

    const calls = { createWorkspace: [], createSession: [], rename: [], prompt: [] };
    let promptAccepted = true;
    const ctx = new Context();
    ctx.provide('workspaceRegistry', {
      get: () => undefined,
      create: async (path, title) => { calls.createWorkspace.push({ path, title }); return { id: 'w-test' }; },
      delete: async () => true,
    });
    ctx.provide('sessionController', {
      create: async (request) => { calls.createSession.push(request); return { sessionId: 's-test' }; },
      rename: async (request) => { calls.rename.push(request); return { title: request.title, seq: 1 }; },
      prompt: async (request) => { calls.prompt.push(request); return promptAccepted ? { accepted: true } : { accepted: false }; },
    });

    const result = await startConversation(ctx, project.id, { intent: 'analyze' });
    assert.equal(result.sessionId, 's-test');
    assert.equal(result.workspaceId, 'w-test');
    assert.equal(result.promptSent, true);
    assert.equal(calls.createWorkspace[0].path, projectDir(project.id));
    assert.equal(calls.createWorkspace[0].title, '对话测试书');
    assert.equal(calls.createSession[0].workspaceId, 'w-test');
    assert.equal(calls.createSession[0].cwd, undefined);
    assert.equal(calls.rename[0].title, '《对话测试书》· 书目分析');
    assert.ok(calls.prompt[0].content[0].text.includes(project.id));
    assert.ok(calls.prompt[0].content[0].text.includes('pingshu_get_guide'));
    assert.equal((await readProject(project.id)).lastSessionId, 's-test');

    const perform = await startConversation(ctx, project.id, { intent: 'perform', chapterId: 'ch-000001', options: { durationMinutes: 15 } });
    assert.equal(perform.promptSent, true);
    assert.ok(calls.prompt[1].content[0].text.includes('第一回 开场'));
    assert.ok(calls.prompt[1].content[0].text.includes('pingshu_save_performance'));
    assert.ok(calls.prompt[1].content[0].text.includes('不设字数'));

    promptAccepted = false;
    const failed = await startConversation(ctx, project.id, { intent: 'analyze', focus: 'characters' });
    assert.equal(failed.promptSent, false);
    assert.ok(failed.error);
    assert.ok(failed.promptText.includes('pingshu_save_dossier'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startConversation falls back to cwd when there is no workspace service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pingshu-conv-cwd-'));
  process.env.PINGSHU_DATA_DIR = dir;
  try {
    const project = await createProjectRecord({ title: '无工作区书', filename: 'x.epub' });
    await writeChapters(project.id, [{ index: 1, id: 'ch-000001', title: '第一回', text: '正文。', chars: 2 }], '正文。');
    const calls = [];
    const ctx = new Context();
    ctx.provide('sessionController', {
      create: async (request) => { calls.push(request); return { sessionId: 's-cwd' }; },
      rename: async () => ({}),
      prompt: async () => ({ accepted: true }),
    });
    const result = await startConversation(ctx, project.id, { intent: 'analyze' });
    assert.equal(result.sessionId, 's-cwd');
    assert.equal(calls[0].workspaceId, undefined);
    assert.equal(calls[0].cwd, projectDir(project.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureWorkspace reuses an existing registration', async () => {
  const ctx = new Context();
  ctx.provide('workspaceRegistry', {
    get: (id) => (id === 'w-existing' ? { id } : undefined),
    create: async () => ({ id: 'w-new' }),
  });
  const project = { id: 'b000000000001', title: '书', workspaceId: 'w-existing' };
  const result = await ensureWorkspace(ctx, project);
  assert.equal(result.workspaceId, 'w-existing');
});
