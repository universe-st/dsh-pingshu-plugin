/**
 * 书目资料：章节摘要、全书概要、人物、时间线、背景/术语。
 *
 * 设计要点：
 * - 所有资料都是普通 Markdown + JSON 索引，UI/AI/人 都能读。
 * - 人物/术语按 name/alias 合并，避免同一个人出现两次。
 * - getDossier 是「讲这一回」的上下文包，必须有长度上限，并告诉模型哪里能取全文。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chapterSummaryFile,
  chapterSummaryJson,
  countChars,
  emptyAnalysis,
  fileExists,
  listChapterFiles,
  listChapterSummaryFiles,
  listProjects,
  listPerformanceChapterDirs,
  mutateProject,
  performanceDir,
  performanceIndexFile,
  projectPaths,
  readChapter,
  readJsonFile,
  readProject,
  readTextFile,
  safeName,
  stripFrontmatter,
  truncateText,
  writeJsonFile,
  writeTextFile,
} from './store.js';

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanList(value, max = 40) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => cleanString(entry, 80)).filter((entry) => entry !== ''))].slice(0, max);
}

function escapeTable(text) {
  return String(text ?? '').replace(/\|/gu, '\\|').replace(/\n+/gu, ' ');
}

function frontmatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number' || typeof value === 'boolean') lines.push(`${key}: ${value}`);
    else lines.push(`${key}: ${JSON.stringify(String(value))}`);
  }
  lines.push('---');
  return lines.join('\n');
}

// ── 章节摘要 ─────────────────────────────────────────────────────────────

export async function saveChapterSummary(projectId, chapterId, summary, extras = {}) {
  const body = cleanString(summary, 20000);
  if (body.length < 80) throw new Error('章节摘要太短（至少 80 个字符）');
  const characters = cleanList(extras.characters);
  const terms = cleanList(extras.terms);
  const events = Array.isArray(extras.events)
    ? extras.events.slice(0, 40).map((event) => ({
        when: cleanString(event?.when, 120),
        event: cleanString(event?.event, 400),
        chapter: chapterId,
      })).filter((event) => event.event !== '')
    : [];
  return mutateProject(projectId, async (project) => {
    const chapter = project.chapters.find((entry) => entry.id === chapterId);
    if (!chapter) throw new Error(`找不到章节 ${chapterId}`);
    const meta = {
      chapterId,
      title: chapter.title,
      characters,
      terms,
      events,
      chars: countChars(body),
      updatedAt: nowIso(),
    };
    const markdown = `${frontmatter({ chapter: chapterId, title: chapter.title, chars: meta.chars, updatedAt: meta.updatedAt })}\n\n# ${chapter.title} · 章节摘要\n\n${body}\n`;
    await writeTextFile(chapterSummaryFile(projectId, chapterId), markdown);
    await writeJsonFile(chapterSummaryJson(projectId, chapterId), meta);
    chapter.summary = true;
    const summaryFiles = new Set(await listChapterSummaryFiles(projectId));
    project.analysis.chapterSummaries = summaryFiles.size;
    project.analysis.complete = isAnalysisComplete(project, summaryFiles.size);
    return {
      ok: true,
      chapterId,
      progress: { done: summaryFiles.size, total: project.chapters.length },
      nextChapter: project.chapters.find((entry) => !entry.summary) ?? null,
    };
  });
}

function isAnalysisComplete(project, summaryCount) {
  return summaryCount >= project.chapters.length
    && project.analysis.hasBookSummary === true
    && project.analysis.hasTimeline === true
    && project.analysis.characters > 0;
}

// ── 人物 ────────────────────────────────────────────────────────────────

async function readCharactersIndex(projectId) {
  const raw = await readJsonFile(projectPaths(projectId).charactersIndex);
  if (raw && Array.isArray(raw.characters)) return raw;
  return { characters: [] };
}

function sameCharacter(entry, name, aliases) {
  const names = new Set([entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]);
  if (names.has(name)) return true;
  return aliases.some((alias) => names.has(alias));
}

function characterSlug(projectId, name, existing, characters) {
  if (existing && existing.file) return existing.file.replace(/\.md$/u, '');
  if (existing && existing.slug) return existing.slug;
  const base = safeName(name, 'character');
  let slug = base;
  let suffix = 2;
  while (characters.some((entry) => entry.file === `${slug}.md`)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function characterMarkdown(character) {
  const lines = [`# 人物：${character.name}`];
  if (character.role) lines.push('', `> ${character.role}`);
  lines.push('');
  const profile = String(character.profile ?? '').trim();
  if (profile !== '') {
    lines.push(profile);
  } else {
    const fields = [
      ['身份', character.identity],
      ['外貌/标志', character.appearance],
      ['性格', character.personality],
      ['人物关系', character.relationships],
      ['人物弧光', character.arc],
      ['说话风格', character.speechStyle],
      ['首次出场', character.firstChapter],
      ['关键场景', character.keyScenes],
    ];
    for (const [label, value] of fields) {
      const text = String(value ?? '').trim();
      if (text !== '') lines.push(`- **${label}**：${text}`);
    }
  }
  return `${frontmatter({
    name: character.name,
    aliases: (character.aliases ?? []).join('、'),
    role: character.role,
    firstChapter: character.firstChapter,
    updatedAt: character.updatedAt,
  })}\n\n${lines.join('\n').trim()}\n`;
}

async function saveCharacters(projectId, characters) {
  if (!Array.isArray(characters) || characters.length === 0) return { saved: 0, total: 0 };
  const paths = projectPaths(projectId);
  const index = await readCharactersIndex(projectId);
  let saved = 0;
  for (const raw of characters.slice(0, 100)) {
    const name = cleanString(raw?.name, 80);
    if (name === '') continue;
    const aliases = cleanList(raw?.aliases);
    const existing = index.characters.find((entry) => sameCharacter(entry, name, aliases));
    const slug = characterSlug(projectId, name, existing, index.characters);
    const file = `${slug}.md`;
    const updatedAt = nowIso();
    const character = {
      name,
      aliases: [...new Set([...(existing?.aliases ?? []), ...aliases])],
      role: cleanString(raw?.role ?? existing?.role, 200),
      identity: cleanString(raw?.identity ?? existing?.identity, 600),
      appearance: cleanString(raw?.appearance ?? existing?.appearance, 600),
      personality: cleanString(raw?.personality ?? existing?.personality, 600),
      relationships: cleanString(raw?.relationships ?? existing?.relationships, 1200),
      arc: cleanString(raw?.arc ?? existing?.arc, 1200),
      speechStyle: cleanString(raw?.speechStyle ?? existing?.speechStyle, 600),
      firstChapter: cleanString(raw?.firstChapter ?? existing?.firstChapter, 120),
      keyScenes: cleanString(raw?.keyScenes ?? existing?.keyScenes, 1200),
      profile: cleanString(raw?.profile ?? existing?.profile, 6000),
      file,
      slug,
      updatedAt,
    };
    await writeTextFile(join(paths.charactersDir, file), characterMarkdown(character));
    if (existing) Object.assign(existing, character);
    else index.characters.push(character);
    saved += 1;
  }
  index.characters.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh'));
  await writeJsonFile(paths.charactersIndex, index);
  await writeTextFile(join(paths.charactersDir, 'index.md'), renderCharacterIndex(index.characters));
  return { saved, total: index.characters.length };
}

function renderCharacterIndex(characters) {
  const lines = ['# 人物索引', ''];
  for (const character of characters) {
    const role = character.role ? ` — ${character.role}` : '';
    lines.push(`- [${character.name}](${character.file})${role}`);
  }
  if (characters.length === 0) lines.push('（还没有人物资料）');
  return `${lines.join('\n')}\n`;
}

// ── 术语 ────────────────────────────────────────────────────────────────

async function readGlossary(projectId) {
  const raw = await readJsonFile(projectPaths(projectId).glossaryJson);
  if (raw && Array.isArray(raw.entries)) return raw;
  return { entries: [] };
}

function sameTerm(entry, term) {
  const names = new Set([entry.term, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]);
  return names.has(term);
}

function glossaryMarkdown(entries) {
  const lines = ['# 名词解释', ''];
  for (const entry of entries) {
    lines.push(`## ${entry.term}`);
    if (entry.category) lines.push('', `*${entry.category}*`);
    lines.push('', entry.explanation || '');
    if (entry.analogy) lines.push('', `打个比方：${entry.analogy}`);
    if (entry.firstChapter) lines.push('', `首次出现：${entry.firstChapter}`);
    if (entry.why) lines.push('', `为什么重要：${entry.why}`);
    lines.push('');
  }
  if (entries.length === 0) lines.push('（还没有名词解释）');
  return `${lines.join('\n').trim()}\n`;
}

async function saveGlossary(projectId, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { saved: 0, total: 0 };
  const paths = projectPaths(projectId);
  const glossary = await readGlossary(projectId);
  let saved = 0;
  for (const raw of entries.slice(0, 200)) {
    const term = cleanString(raw?.term, 80);
    if (term === '') continue;
    const existing = glossary.entries.find((entry) => sameTerm(entry, term));
    const updatedAt = nowIso();
    const entry = {
      term,
      aliases: [...new Set([...(existing?.aliases ?? []), ...cleanList(raw?.aliases)])],
      category: cleanString(raw?.category ?? existing?.category, 40),
      explanation: cleanString(raw?.explanation ?? existing?.explanation, 2000),
      analogy: cleanString(raw?.analogy ?? existing?.analogy, 600),
      firstChapter: cleanString(raw?.firstChapter ?? existing?.firstChapter, 120),
      why: cleanString(raw?.why ?? existing?.why, 600),
      updatedAt,
    };
    if (existing) Object.assign(existing, entry);
    else glossary.entries.push(entry);
    saved += 1;
  }
  glossary.entries.sort((a, b) => String(a.term ?? '').localeCompare(String(b.term ?? ''), 'zh'));
  await writeJsonFile(paths.glossaryJson, glossary);
  await writeTextFile(paths.glossaryMd, glossaryMarkdown(glossary.entries));
  return { saved, total: glossary.entries.length };
}

// ── 时间线 ──────────────────────────────────────────────────────────────

function timelineMarkdown(events) {
  const lines = ['# 时间线', '', '| 时间 | 事件 | 回目 |', '| --- | --- | --- |'];
  for (const event of events) {
    lines.push(`| ${escapeTable(event.when) || '—'} | ${escapeTable(event.event)} | ${escapeTable(event.chapter ?? '')} |`);
  }
  if (events.length === 0) lines.push('| — | （还没有时间线） | — |');
  return `${lines.join('\n')}\n`;
}

async function saveTimeline(projectId, timeline) {
  const paths = projectPaths(projectId);
  if (typeof timeline === 'string' && timeline.trim() !== '') {
    const body = timeline.trim();
    await writeTextFile(paths.timelineMd, body.startsWith('#') ? body : `# 时间线\n\n${body}\n`);
    await writeJsonFile(paths.timelineJson, { events: [] });
    return { saved: true, events: 0 };
  }
  if (!Array.isArray(timeline) || timeline.length === 0) return { saved: false, events: 0 };
  const events = timeline.slice(0, 500).map((event) => ({
    when: cleanString(event?.when, 120),
    event: cleanString(event?.event, 600),
    chapter: cleanString(event?.chapter, 120),
  })).filter((event) => event.event !== '');
  await writeTextFile(paths.timelineMd, timelineMarkdown(events));
  await writeJsonFile(paths.timelineJson, { events });
  return { saved: true, events: events.length };
}

// ── 全书概要 / 背景 ──────────────────────────────────────────────────────

async function saveBookSummary(projectId, project, summary) {
  const body = cleanString(summary, 20000);
  if (body === '') return false;
  const title = project.title ? `# 《${project.title}》全书概要` : '# 全书概要';
  await writeTextFile(projectPaths(projectId).bookSummaryFile, `${title}\n\n${body}\n`);
  return true;
}

async function saveContext(projectId, context) {
  const body = cleanString(context, 20000);
  if (body === '') return false;
  await writeTextFile(projectPaths(projectId).contextMd, body.startsWith('#') ? `${body}\n` : `# 时代与背景\n\n${body}\n`);
  return true;
}

// ── 对外：保存整包资料 ──────────────────────────────────────────────────

export async function saveDossier(projectId, payload = {}) {
  return mutateProject(projectId, async (project) => {
    const paths = projectPaths(projectId);
    const files = [];
    let hasBookSummary = project.analysis.hasBookSummary;
    let hasTimeline = project.analysis.hasTimeline;
    let hasContext = project.analysis.hasContext;
    if (payload.bookSummary !== undefined) {
      hasBookSummary = await saveBookSummary(projectId, project, payload.bookSummary);
      if (hasBookSummary) files.push('summaries/book.md');
    }
    const characterResult = await saveCharacters(projectId, payload.characters);
    if (characterResult.saved > 0) files.push(`characters/*.md（${characterResult.saved} 个）`);
    const timelineResult = await saveTimeline(projectId, payload.timeline);
    if (timelineResult.saved) {
      hasTimeline = true;
      files.push('timeline/timeline.md');
    }
    const glossaryResult = await saveGlossary(projectId, payload.glossary);
    if (glossaryResult.saved > 0) files.push(`background/glossary.md（${glossaryResult.saved} 条）`);
    if (payload.context !== undefined) {
      hasContext = await saveContext(projectId, payload.context);
      if (hasContext) files.push('background/context.md');
    }
    const summaryFiles = new Set(await listChapterSummaryFiles(projectId));
    const characters = await readCharactersIndex(projectId);
    const glossary = await readGlossary(projectId);
    project.analysis = {
      ...emptyAnalysis(),
      chapterSummaries: summaryFiles.size,
      hasBookSummary,
      characters: characters.characters.length,
      hasTimeline,
      glossary: glossary.entries.length,
      hasContext,
      complete: false,
    };
    project.analysis.complete = isAnalysisComplete(project, summaryFiles.size);
    return {
      ok: true,
      files,
      counts: {
        characters: characters.characters.length,
        glossary: glossary.entries.length,
        chapterSummaries: summaryFiles.size,
      },
      analysis: project.analysis,
    };
  });
}

// ── 对外：状态 / 修复 ───────────────────────────────────────────────────

export async function computeAnalysis(projectId, project) {
  const summaryFiles = new Set(await listChapterSummaryFiles(projectId));
  const characters = await readCharactersIndex(projectId);
  const glossary = await readGlossary(projectId);
  const paths = projectPaths(projectId);
  const hasBookSummary = await fileExists(paths.bookSummaryFile);
  const hasTimeline = await fileExists(paths.timelineMd);
  const hasContext = await fileExists(paths.contextMd);
  const analysis = {
    chapterSummaries: summaryFiles.size,
    hasBookSummary,
    characters: characters.characters.length,
    hasTimeline,
    glossary: glossary.entries.length,
    hasContext,
    complete: false,
  };
  analysis.complete = summaryFiles.size >= project.chapters.length
    && hasBookSummary && hasTimeline && characters.characters.length > 0;
  return { analysis, summaryFiles, characters: characters.characters, glossary: glossary.entries };
}

export async function analysisStatus(projectId, { limit = 50 } = {}) {
  const project = await readProject(projectId);
  const { analysis, summaryFiles } = await computeAnalysis(projectId, project);
  const missing = project.chapters
    .filter((chapter) => !summaryFiles.has(chapter.id))
    .map((chapter) => ({ id: chapter.id, index: chapter.index, title: chapter.title, chars: chapter.chars }));
  const dossierMissing = [];
  if (!analysis.hasBookSummary) dossierMissing.push('bookSummary');
  if (analysis.characters === 0) dossierMissing.push('characters');
  if (!analysis.hasTimeline) dossierMissing.push('timeline');
  if (analysis.glossary === 0) dossierMissing.push('glossary');
  if (!analysis.hasContext) dossierMissing.push('context');
  return {
    projectId,
    title: project.title,
    status: project.status,
    chapterCount: project.chapters.length,
    analysis,
    chapterSummaries: {
      done: summaryFiles.size,
      total: project.chapters.length,
      missing: missing.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))),
      missingCount: missing.length,
    },
    dossier: {
      complete: analysis.complete,
      missing: dossierMissing,
    },
    nextChapters: missing.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))),
  };
}

export async function analysisBatches(projectId, { batchSize = 4, limit = 200 } = {}) {
  const project = await readProject(projectId);
  const { analysis, summaryFiles } = await computeAnalysis(projectId, project);
  const missing = project.chapters.filter((chapter) => !summaryFiles.has(chapter.id));
  const size = Math.max(1, Math.min(Number(batchSize) || 4, 8));
  const max = Math.max(1, Math.min(Number(limit) || 200, 500));
  const batches = [];
  for (let i = 0; i < missing.length && batches.length < max; i += size) {
    batches.push({
      index: batches.length + 1,
      chapters: missing.slice(i, i + size).map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        chars: chapter.chars,
      })),
    });
  }
  const dossierMissing = [];
  if (!analysis.hasBookSummary) dossierMissing.push('bookSummary');
  if (analysis.characters === 0) dossierMissing.push('characters');
  if (!analysis.hasTimeline) dossierMissing.push('timeline');
  if (analysis.glossary === 0) dossierMissing.push('glossary');
  if (!analysis.hasContext) dossierMissing.push('context');
  return {
    projectId,
    title: project.title,
    chapterCount: project.chapters.length,
    missingCount: missing.length,
    batchSize: size,
    batches,
    dossierMissing,
    analysis,
  };
}

export async function repairProject(projectId) {
  return mutateProject(projectId, async (project) => {
    const paths = projectPaths(projectId);
    const chapterFiles = await listChapterFiles(projectId);
    const byId = new Map(project.chapters.map((chapter) => [chapter.id, chapter]));
    const chapters = [];
    for (const chapterId of chapterFiles) {
      const existing = byId.get(chapterId);
      let meta = existing;
      if (!existing) {
        try {
          const { meta: front } = await readChapter(projectId, chapterId);
          meta = {
            id: chapterId,
            index: Number(front.index) || chapters.length + 1,
            title: String(front.title ?? chapterId),
            chars: Number(front.chars) || 0,
            summary: false,
            performances: 0,
            source: front.source ?? null,
          };
        } catch {
          meta = null;
        }
      }
      if (!meta) continue;
      chapters.push(meta);
    }
    chapters.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
    const summaryFiles = new Set(await listChapterSummaryFiles(projectId));
    const performanceDirs = new Set(await listPerformanceChapterDirs(projectId));
    for (const chapter of chapters) {
      chapter.summary = summaryFiles.has(chapter.id);
      if (performanceDirs.has(chapter.id)) {
        const index = await readJsonFile(performanceIndexFile(projectId, chapter.id));
        chapter.performances = Array.isArray(index?.versions) ? index.versions.length : 0;
      } else {
        chapter.performances = 0;
      }
    }
    project.chapters = chapters;
    project.charCount = chapters.reduce((sum, chapter) => sum + (Number(chapter.chars) || 0), 0);
    project.performanceCount = chapters.reduce((sum, chapter) => sum + (Number(chapter.performances) || 0), 0);
    const computed = await computeAnalysis(projectId, project);
    project.analysis = computed.analysis;
    if (project.status === 'importing') {
      project.status = 'error';
      project.import = { ...(project.import ?? {}), stage: 'error', error: '上次导入中断，请重试' };
    }
    return project;
  });
}

export async function getProjectView(projectId, { scan = false } = {}) {
  let project = await readProject(projectId);
  if (scan) {
    project = await repairProject(projectId);
  } else {
    const computed = await computeAnalysis(projectId, project);
    project.analysis = computed.analysis;
  }
  return {
    ...project,
    chapterCount: project.chapters.length,
    performanceCount: project.chapters.reduce((sum, chapter) => sum + (Number(chapter.performances) || 0), 0),
  };
}

// ── 对外：读单个资料文件 ────────────────────────────────────────────────

export async function getAnalysis(projectId, { kind, chapterId, name } = {}) {
  const paths = projectPaths(projectId);
  const project = await readProject(projectId);
  const type = String(kind ?? '').trim();
  let path;
  let meta = null;
  if (type === 'book') {
    path = paths.bookSummaryFile;
  } else if (type === 'chapter') {
    if (!chapterId) throw new Error('读章节摘要需要 chapterId');
    path = chapterSummaryFile(projectId, chapterId);
  } else if (type === 'character') {
    const index = await readCharactersIndex(projectId);
    const query = String(name ?? '').trim();
    const entry = index.characters.find((character) => character.name === query || (character.aliases ?? []).includes(query));
    if (!entry) throw new Error(`找不到人物「${query}」`);
    path = join(paths.charactersDir, entry.file);
    meta = entry;
  } else if (type === 'timeline') {
    path = paths.timelineMd;
  } else if (type === 'glossary') {
    path = paths.glossaryMd;
  } else if (type === 'context') {
    path = paths.contextMd;
  } else if (type === 'chapter-index') {
    const text = renderChapterIndex(project);
    return { content: text, path: 'chapters', meta: null };
  } else {
    throw new Error(`未知资料类型：${type}`);
  }
  const content = await readTextFile(path);
  if (content === undefined) throw new Error('这份资料还没生成');
  const body = stripFrontmatter(content);
  const truncated = truncateText(body, 40000);
  return { content: truncated.text, path, meta, truncated: truncated.truncated, totalChars: truncated.totalChars };
}

function renderChapterIndex(project) {
  const lines = ['# 回目', ''];
  for (const chapter of project.chapters) {
    lines.push(`${chapter.index}. ${chapter.title}（${chapter.chars} 字${chapter.summary ? ' · 已摘要' : ''}${chapter.performances ? ` · ${chapter.performances} 版评书` : ''}）`);
  }
  return `${lines.join('\n')}\n`;
}

// ── 对外：讲这一回的资料包 ──────────────────────────────────────────────

function pickCharacters(characters, chapterMeta, chapterText) {
  const named = new Set(cleanList(chapterMeta?.characters, 20));
  const scored = characters.map((character) => {
    let score = 0;
    if (named.has(character.name)) score += 100;
    if (named.has(character.name) || (character.aliases ?? []).some((alias) => named.has(alias))) score += 50;
    if (chapterText && chapterText.includes(character.name)) score += 20;
    if (character.firstChapter && chapterMeta?.title && character.firstChapter === chapterMeta.title) score += 10;
    return { character, score };
  });
  scored.sort((a, b) => b.score - a.score || String(a.character.name).localeCompare(String(b.character.name), 'zh'));
  return scored.map((entry) => entry.character);
}

function pickGlossary(glossary, chapterText, chapterSummary) {
  const haystack = `${chapterText ?? ''}\n${chapterSummary ?? ''}`;
  const matched = glossary.filter((entry) => haystack.includes(entry.term));
  if (matched.length > 0) return matched.slice(0, 40);
  return glossary.slice(0, 20);
}

export async function getDossier(projectId, chapterId) {
  const project = await readProject(projectId);
  const paths = projectPaths(projectId);
  const chapter = chapterId ? project.chapters.find((entry) => entry.id === chapterId) : null;
  if (chapterId && !chapter) throw new Error(`找不到章节 ${chapterId}`);
  const bookSummaryRaw = (await readTextFile(paths.bookSummaryFile)) ?? '';
  let chapterSummaryRaw = '';
  let chapterMeta = null;
  let chapterText = '';
  if (chapter) {
    chapterSummaryRaw = stripFrontmatter((await readTextFile(chapterSummaryFile(projectId, chapter.id))) ?? '');
    chapterMeta = await readJsonFile(chapterSummaryJson(projectId, chapter.id));
    try {
      const { body } = await readChapter(projectId, chapter.id);
      chapterText = body;
    } catch {
      chapterText = '';
    }
  }
  const charactersIndex = await readCharactersIndex(projectId);
  const glossary = await readGlossary(projectId);
  const timelineRaw = (await readTextFile(paths.timelineMd)) ?? '';
  const contextRaw = (await readTextFile(paths.contextMd)) ?? '';
  const selectedCharacters = pickCharacters(charactersIndex.characters, chapterMeta, chapterText).slice(0, 12);
  const selectedGlossary = pickGlossary(glossary.entries, chapterText, chapterSummaryRaw).slice(0, 30);
  let previousPerformance = null;
  if (chapter) {
    const index = await readJsonFile(performanceIndexFile(projectId, chapter.id));
    const versions = Array.isArray(index?.versions) ? index.versions : [];
    if (versions.length > 0) {
      const last = versions[versions.length - 1];
      const markdown = (await readTextFile(join(performanceDir(projectId, chapter.id), last.file))) ?? '';
      const body = markdown.replace(/^---[\s\S]*?---\u000a?/u, '').trim();
      previousPerformance = {
        versionId: last.versionId,
        title: last.title,
        createdAt: last.createdAt,
        chars: last.chars,
        ending: body.slice(-600),
        path: join(performanceDir(projectId, chapter.id), last.file),
      };
    }
  }
  const bookSummary = truncateText(bookSummaryRaw, 5000);
  const chapterSummary = truncateText(chapterSummaryRaw, 4000);
  const timeline = truncateText(timelineRaw, 5000);
  const context = truncateText(contextRaw, 4000);
  return {
    project: {
      id: project.id,
      title: project.title,
      author: project.author,
      format: project.format,
      language: project.language,
      chapterCount: project.chapters.length,
    },
    chapter: chapter
      ? { id: chapter.id, index: chapter.index, title: chapter.title, chars: chapter.chars, summary: chapter.summary === true }
      : null,
    bookSummary: { text: bookSummary.text, path: paths.bookSummaryFile, truncated: bookSummary.truncated },
    chapterSummary: chapter
      ? { text: chapterSummary.text, path: chapterSummaryFile(projectId, chapter.id), truncated: chapterSummary.truncated }
      : null,
    chapterText: chapter
      ? { path: `chapters/${chapter.id}.md`, chars: chapter.chars, preview: chapterText.slice(0, 1200) }
      : null,
    characters: selectedCharacters.map((character) => ({
      name: character.name,
      aliases: character.aliases ?? [],
      role: character.role ?? '',
      profile: truncateText(character.profile || character.relationships || '', 1200).text,
      path: join(paths.charactersDir, character.file),
    })),
    characterCount: charactersIndex.characters.length,
    timeline: { text: timeline.text, path: paths.timelineMd, truncated: timeline.truncated },
    glossary: selectedGlossary.map((entry) => ({
      term: entry.term,
      category: entry.category ?? '',
      explanation: entry.explanation ?? '',
      analogy: entry.analogy ?? '',
      firstChapter: entry.firstChapter ?? '',
    })),
    glossaryCount: glossary.entries.length,
    context: { text: context.text, path: paths.contextMd, truncated: context.truncated },
    previousPerformance,
    paths: {
      chapter: chapter ? `chapters/${chapter.id}.md` : null,
      bookSummary: paths.bookSummaryFile,
      chapterSummary: chapter ? chapterSummaryFile(projectId, chapter.id) : null,
      characters: paths.charactersDir,
      timeline: paths.timelineMd,
      glossary: paths.glossaryMd,
      context: paths.contextMd,
    },
  };
}

// ── 对外：搜索 ──────────────────────────────────────────────────────────

export async function resolveQuery(query, { limit = 12 } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') throw new Error('请给一个书名、回目名或关键词');
  const max = Math.max(1, Math.min(Number(limit) || 12, 50));
  const summaries = await listProjects();
  const projectMatches = [];
  const chapterMatches = [];
  for (const summary of summaries) {
    const title = String(summary.title ?? '').toLowerCase();
    const haystack = `${summary.title} ${summary.author ?? ''}`.toLowerCase();
    if (haystack.includes(needle) || (title.length >= 2 && needle.includes(title))) {
      projectMatches.push(summary);
    }
    if (projectMatches.length >= max && chapterMatches.length >= max) break;
    const project = await readProject(summary.id);
    for (const chapter of project.chapters) {
      const chapterTitle = String(chapter.title ?? '').toLowerCase();
      if (chapterTitle.includes(needle) || (chapterTitle.length >= 2 && needle.includes(chapterTitle))) {
        chapterMatches.push({
          projectId: project.id,
          projectTitle: project.title,
          chapterId: chapter.id,
          index: chapter.index,
          title: chapter.title,
          chars: chapter.chars,
        });
        if (chapterMatches.length >= max) break;
      }
    }
  }
  return {
    query,
    projects: projectMatches.slice(0, max),
    chapters: chapterMatches.slice(0, max),
  };
}

