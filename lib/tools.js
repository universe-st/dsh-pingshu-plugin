/**
 * 评书 —— 对话调用面（模型工具）。
 *
 * 工具只编排 PingshuGateway 上已有的方法，避免界面和模型各写一份业务逻辑。
 * 每个工具的输出都经过 jsonSafe（DSH 对工具输出做无损 JSON 校验，undefined 键会失败）。
 */
import { loadGuide } from './prompts.js';

const PREFIX = 'pingshu';
const OBJECT_SCHEMA = { type: 'object', additionalProperties: true };

const SYSTEM_PROMPT = [
  '## 评书',
  '「评书」面板把电子书拆成回目，并用中国传统评书讲给用户听。工具名以 pingshu_ 开头。',
  '- 用户提到已导入的书、要整理人物/时间线/背景、或要讲某一回时，先用 pingshu_resolve 或 pingshu_list_projects 找到项目。',
  '- 写评书文案前必须调用 pingshu_get_guide({topic:"performance"})；整理书目资料前必须调用 pingshu_get_guide({topic:"analysis"})。',
  '- 整理书目资料要一次做完：用 pingshu_analysis_batches + subagent 分批处理，直到 pingshu_analysis_status 没有缺章，再写全书资料；不要停下来问用户是否继续。',
  '- 讲某一回：先 pingshu_get_dossier，再 pingshu_read_chapter（长回分段读），然后写；不得编造原文没有的情节。',
  '- 保存文案用 pingshu_save_performance；每次保存都是新版本。保存后告诉用户到「评书」面板试听。',
  '- 上传/新建项目只能在「评书」面板完成；不要用工具创建项目，也不要直接改写 chapters/ 与 project.json。',
].join('\n');

function textBlocks(text) {
  return [{ type: 'text', text: String(text ?? '') }];
}

function jsonSafe(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      output[key] = jsonSafe(entry);
    }
    return output;
  }
  return String(value);
}

function asString(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function requireProjectId(args) {
  const projectId = asString(args?.projectId).trim();
  if (projectId === '') throw new Error('缺少 projectId；先用 pingshu_resolve 或 pingshu_list_projects 找到项目');
  return projectId;
}

function requireChapterId(args) {
  const chapterId = asString(args?.chapterId).trim();
  if (chapterId === '') throw new Error('缺少 chapterId；先用 pingshu_get_project 或 pingshu_resolve 找到回目');
  return chapterId;
}

function shortList(entries, render) {
  return entries.map(render).join('\n');
}

function renderProjectList(value) {
  const projects = Array.isArray(value?.projects) ? value.projects : [];
  if (projects.length === 0) return '还没有导入书。请让用户到「评书」面板上传 EPUB / PDF / TXT / Markdown。';
  return shortList(projects, (project) => {
    const analysis = project.analysis ?? {};
    const progress = `${analysis.chapterSummaries ?? 0}/${project.chapterCount ?? 0} 回摘要`;
    return `- ${project.title}（${project.id}）${project.author ? ` · ${project.author}` : ''} · ${project.chapterCount ?? 0} 回 · ${progress} · ${project.performanceCount ?? 0} 版评书`;
  });
}

function renderResolve(value) {
  const lines = [`查询：${value?.query ?? ''}`];
  const projects = Array.isArray(value?.projects) ? value.projects : [];
  const chapters = Array.isArray(value?.chapters) ? value.chapters : [];
  if (projects.length > 0) {
    lines.push('', '匹配的书：');
    lines.push(...projects.map((project) => `- ${project.title}（${project.id}）· ${project.chapterCount ?? 0} 回`));
  }
  if (chapters.length > 0) {
    lines.push('', '匹配的回目：');
    lines.push(...chapters.map((chapter) => `- 《${chapter.projectTitle}》${chapter.title}（projectId=${chapter.projectId}, chapterId=${chapter.chapterId}）`));
  }
  if (projects.length === 0 && chapters.length === 0) {
    lines.push('', '没有找到。请确认书名/回目名，或让用户先在「评书」面板导入这本书。');
  }
  return lines.join('\n');
}

function renderProject(value) {
  const project = value?.project ?? value;
  if (!project) return '没有项目数据';
  const analysis = project.analysis ?? {};
  const lines = [
    `《${project.title}》（${project.id}）`,
    `状态：${project.status}；格式：${project.format}；回目：${project.chapterCount ?? project.chapters?.length ?? 0}；总字数：${project.charCount ?? 0}`,
    project.author ? `作者：${project.author}` : '',
    `资料：章节摘要 ${analysis.chapterSummaries ?? 0}/${project.chapterCount ?? 0}；全书概要 ${analysis.hasBookSummary ? '✓' : '—'}；人物 ${analysis.characters ?? 0}；时间线 ${analysis.hasTimeline ? '✓' : '—'}；术语 ${analysis.glossary ?? 0}；背景 ${analysis.hasContext ? '✓' : '—'}`,
    `评书文案：${project.performanceCount ?? 0} 版`,
    project.warnings?.length ? `警告：${project.warnings.join('；')}` : '',
    '',
    '回目：',
  ].filter((line) => line !== '');
  const chapters = Array.isArray(project.chapters) ? project.chapters : [];
  for (const chapter of chapters) {
    lines.push(`${chapter.index}. ${chapter.title}（${chapter.id}，${chapter.chars} 字${chapter.summary ? '，已摘要' : ''}${chapter.performances ? `，${chapter.performances} 版评书` : ''}）`);
  }
  if (project.chaptersTruncated) lines.push('…回目太多，已截断；用 pingshu_resolve 按回目名查找具体章节。');
  if (chapters.length === 0) lines.push('（还没有回目，可能还在导入）');
  return lines.join('\n');
}

function renderChapter(value) {
  const chapter = value?.chapter ?? {};
  const next = value?.nextOffset;
  const lines = [
    `【${chapter.title ?? chapter.id}】共 ${value?.totalChars ?? chapter.chars ?? 0} 字；本次从 ${value?.offset ?? 0} 开始，读到 ${(value?.offset ?? 0) + asString(value?.text).length}。`,
    '',
    asString(value?.text),
  ];
  if (next !== null && next !== undefined) {
    lines.push('', `（还没读完。继续调用 pingshu_read_chapter，offset=${next}）`);
  }
  return lines.join('\n');
}

function renderAnalysisStatus(value) {
  const analysis = value?.analysis ?? {};
  const summaries = value?.chapterSummaries ?? {};
  const lines = [
    `《${value?.title ?? ''}》分析进度：`,
    `- 章节摘要：${summaries.done ?? 0}/${summaries.total ?? 0}（缺 ${summaries.missingCount ?? 0}）`,
    `- 全书概要：${analysis.hasBookSummary ? '已写' : '未写'}`,
    `- 人物：${analysis.characters ?? 0} 条`,
    `- 时间线：${analysis.hasTimeline ? '已写' : '未写'}`,
    `- 术语：${analysis.glossary ?? 0} 条`,
    `- 背景：${analysis.hasContext ? '已写' : '未写'}`,
  ];
  const next = Array.isArray(value?.nextChapters) ? value.nextChapters : [];
  if (next.length > 0) {
    lines.push('', '下一批待处理：');
    lines.push(...next.map((chapter) => `- ${chapter.title}（${chapter.id}，${chapter.chars} 字）`));
  } else {
    lines.push('', '章节摘要已齐。可以开始写/补全书资料。');
  }
  const missing = value?.dossier?.missing;
  if (Array.isArray(missing) && missing.length > 0) lines.push('', `还缺：${missing.join('、')}`);
  return lines.join('\n');
}

function renderAnalysisBatches(value) {
  const lines = [`《${value?.title ?? ''}》待处理回目：${value?.missingCount ?? 0} 回，每批 ${value?.batchSize ?? 4} 回`];
  const batches = Array.isArray(value?.batches) ? value.batches : [];
  for (const batch of batches) {
    lines.push(`- 第 ${batch.index} 批：${batch.chapters.map((chapter) => `${chapter.title}（${chapter.id}，${chapter.chars} 字）`).join('、')}`);
  }
  if (batches.length === 0) lines.push('章节摘要已齐；可以直接写/补全书资料。');
  if (Array.isArray(value?.dossierMissing) && value.dossierMissing.length > 0) lines.push(`全书资料还缺：${value.dossierMissing.join('、')}`);
  return lines.join('\n');
}

function renderDossier(value) {
  const lines = [`《${value?.project?.title ?? ''}》资料包`];
  if (value?.chapter) lines.push(`本回：${value.chapter.title}（${value.chapter.id}，${value.chapter.chars} 字）`);
  lines.push('', '## 全书概要', value?.bookSummary?.text || '（还没写）');
  if (value?.chapter) lines.push('', '## 本章摘要', value?.chapterSummary?.text || '（还没写）');
  if (Array.isArray(value?.characters) && value.characters.length > 0) {
    lines.push('', '## 相关人物');
    for (const character of value.characters) {
      lines.push(`- ${character.name}${character.role ? `（${character.role}）` : ''}：${character.profile || '（暂无小传）'}`);
    }
  }
  lines.push('', '## 时间线', value?.timeline?.text || '（还没写）');
  if (Array.isArray(value?.glossary) && value.glossary.length > 0) {
    lines.push('', '## 名词解释');
    for (const entry of value.glossary) {
      const explanation = String(entry.explanation ?? '').replace(/[。；;]+$/u, '');
      const analogy = String(entry.analogy ?? '').replace(/[。；;]+$/u, '');
      lines.push(`- ${entry.term}${entry.category ? `（${entry.category}）` : ''}：${explanation}${analogy ? `；打个比方：${analogy}` : ''}`);
    }
  }
  lines.push('', '## 时代与背景', value?.context?.text || '（还没写）');
  if (value?.previousPerformance) {
    lines.push('', '## 上一版结尾', `（${value.previousPerformance.versionId}，${value.previousPerformance.createdAt}）`, value.previousPerformance.ending || '');
  }
  lines.push('', '取全文：pingshu_read_chapter / pingshu_read_analysis。');
  return lines.join('\n');
}

function renderSaveChapter(value) {
  const lines = [`已保存章节摘要：${value?.chapterId ?? ''}`];
  if (value?.progress) lines.push(`进度：${value.progress.done}/${value.progress.total}`);
  if (value?.nextChapter) lines.push(`下一回：${value.nextChapter.title}（${value.nextChapter.id}）`);
  return lines.join('\n');
}

function renderSaveDossier(value) {
  const counts = value?.counts ?? {};
  return [
    '已保存书目资料。',
    `人物：${counts.characters ?? 0}；术语：${counts.glossary ?? 0}；章节摘要：${counts.chapterSummaries ?? 0}`,
    Array.isArray(value?.files) && value.files.length > 0 ? `写入：${value.files.join('、')}` : '',
    value?.analysis?.complete ? '资料已完整。' : '资料还不完整，可继续补。',
  ].filter((line) => line !== '').join('\n');
}

function renderAnalysisFile(value) {
  return [
    value?.path ? `文件：${value.path}` : '',
    value?.truncated ? `（已截断，共 ${value.totalChars} 字）` : '',
    '',
    asString(value?.content),
  ].filter((line) => line !== '').join('\n');
}

function renderSavePerformance(value) {
  return [
    `已保存评书文案：${value?.versionId ?? ''}`,
    `约 ${value?.chars ?? 0} 字，预计 ${value?.estimatedMinutes ?? 0} 分钟。`,
    '用户可以到「评书」面板打开这一版，直接点朗读。',
    '每次保存都是新版本，旧版不会丢。',
  ].join('\n');
}

function renderPerformanceList(value) {
  const items = Array.isArray(value?.items) ? value.items : [];
  if (items.length === 0) return '还没有评书文案。先讲一回，保存后就会出现在这里。';
  return shortList(items, (item) => `- 《${item.bookTitle}》${item.chapterTitle} ${item.versionId}：${item.title}${item.style ? ` · ${item.style}` : ''} · ${item.chars} 字 · ${item.createdAt}`);
}

function renderPerformance(value) {
  const meta = value?.meta ?? {};
  return [
    `《${meta.bookTitle ?? ''}》${meta.chapterTitle ?? ''} · ${meta.versionId ?? ''}${meta.style ? ` · ${meta.style}` : ''}`,
    `约 ${meta.chars ?? 0} 字，预计 ${meta.estimatedMinutes ?? 0} 分钟${meta.notes ? `；备注：${meta.notes}` : ''}`,
    '',
    asString(value?.script),
  ].join('\n');
}

function renderResplit(value) {
  if (value?.ok === false) return `重新分章没有执行：${value.error ?? '未知原因'}`;
  const chapters = value?.project?.chapters ?? [];
  return [
    `已重新分章，共 ${chapters.length} 回。`,
    chapters.slice(0, 30).map((chapter) => `${chapter.index}. ${chapter.title}`).join('\n'),
    chapters.length > 30 ? '…' : '',
    Array.isArray(value?.warnings) ? value.warnings.join('；') : '',
  ].filter((line) => line !== '').join('\n');
}

export function registerPingshuTools(host, gateway) {
  const tools = host?.tools;
  const systemPrompt = host?.systemPrompt;
  const disposers = [];
  if (tools === undefined || tools === null) return disposers;

  const register = (definition) => {
    const execute = definition.execute;
    const wrapped = {
      ...definition,
      async execute(...args) {
        return jsonSafe(await execute.apply(this, args));
      },
    };
    disposers.push(tools.register(wrapped));
  };

  register({
    name: `${PREFIX}_list_projects`,
    description: '列出「评书」里已导入的书（轻量摘要）。用户只说“那本书”或要你找书时，先用它或 pingshu_resolve。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderProjectList(value)) },
    async execute() {
      return gateway.listProjects();
    },
  });

  register({
    name: `${PREFIX}_resolve`,
    description: '按书名、回目名或关键词定位项目和章节。用户说“讲讲《三国演义》第三回”时先用它拿到 projectId/chapterId；有歧义时把候选告诉用户。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '书名、回目名或关键词' },
        limit: { type: 'number', description: '最多返回多少条，默认 12' },
      },
      required: ['query'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderResolve(value)) },
    async execute(args) {
      return gateway.resolve({ query: asString(args?.query), limit: asNumber(args?.limit, 12) });
    },
  });

  register({
    name: `${PREFIX}_get_project`,
    description: '看一本书的元数据、回目列表（给模型时截断到 100 条）和分析进度。需要具体回目时再用 pingshu_resolve。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { projectId: { type: 'string', description: '项目 id（b…）' } },
      required: ['projectId'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderProject(value)) },
    async execute(args) {
      const projectId = requireProjectId(args);
      const value = await gateway.getProject({ projectId });
      const project = value.project;
      const chapters = Array.isArray(project.chapters) ? project.chapters : [];
      return {
        project: {
          ...project,
          chapters: chapters.slice(0, 100).map((chapter) => ({
            id: chapter.id,
            index: chapter.index,
            title: chapter.title,
            chars: chapter.chars,
            summary: chapter.summary,
            performances: chapter.performances,
          })),
          chaptersTruncated: chapters.length > 100,
        },
      };
    },
  });

  register({
    name: `${PREFIX}_read_chapter`,
    description: '读一回原文。默认最多 2 万字；返回 nextOffset 时继续调用并传 offset。不要凭记忆编造原文没有的情节。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        chapterId: { type: 'string', description: '章节 id（ch-…）' },
        offset: { type: 'number', description: '从第几个字符开始，默认 0' },
        maxChars: { type: 'number', description: '本次最多读多少字，默认 20000，最大 60000' },
      },
      required: ['projectId', 'chapterId'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderChapter(value)) },
    async execute(args) {
      return gateway.getChapter({
        projectId: requireProjectId(args),
        chapterId: requireChapterId(args),
        offset: asNumber(args?.offset, 0),
        maxChars: asNumber(args?.maxChars, 20000),
      });
    },
  });

  register({
    name: `${PREFIX}_analysis_status`,
    description: '看一本书还缺哪些章节摘要/全书资料，返回下一批要处理的回目。整理资料前先调它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        limit: { type: 'number', description: '返回多少条待处理回目，默认 50' },
      },
      required: ['projectId'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderAnalysisStatus(value)) },
    async execute(args) {
      return gateway.analysisStatus({ projectId: requireProjectId(args), limit: asNumber(args?.limit, 50) });
    },
  });

  register({
    name: `${PREFIX}_analysis_batches`,
    description: '把还没写摘要的回目按批分组（默认每批 4 回），方便开子代理并行处理。分析任务要一次做完：用 subagent 每批一个子代理，全部摘要完成后再写全书资料，不要停下来问用户是否继续。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        batchSize: { type: 'number', description: '每批几回，默认 4，最大 8' },
        limit: { type: 'number', description: '最多返回多少批，默认 200' },
      },
      required: ['projectId'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderAnalysisBatches(value)) },
    async execute(args) {
      return gateway.analysisBatches({
        projectId: requireProjectId(args),
        batchSize: asNumber(args?.batchSize, 4),
        limit: asNumber(args?.limit, 200),
      });
    },
  });

  register({
    name: `${PREFIX}_save_chapter_summary`,
    description: '保存某一回的摘要与要素（人物/术语/时间线事件）。摘要 200–400 字；保存后进度自动更新。逐回保存，不要攒到最后。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        chapterId: { type: 'string', description: '章节 id' },
        summary: { type: 'string', description: '章节摘要 Markdown，200–400 字' },
        characters: { type: 'array', items: { type: 'string' }, description: '本回出场人物名（用最常用的名字）' },
        terms: { type: 'array', items: { type: 'string' }, description: '本回需要解释的术语/官职/地名/典故' },
        events: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { when: { type: 'string' }, event: { type: 'string' }, chapter: { type: 'string' } },
            required: ['event'],
          },
          description: '故事时间线上的事件',
        },
      },
      required: ['projectId', 'chapterId', 'summary'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderSaveChapter(value)) },
    async execute(args) {
      return gateway.saveChapterSummary({
        projectId: requireProjectId(args),
        chapterId: requireChapterId(args),
        summary: asString(args?.summary),
        characters: Array.isArray(args?.characters) ? args.characters.map(asString) : undefined,
        terms: Array.isArray(args?.terms) ? args.terms.map(asString) : undefined,
        events: Array.isArray(args?.events) ? args.events.map((event) => ({
          when: asString(event?.when),
          event: asString(event?.event),
          chapter: asString(event?.chapter),
        })) : undefined,
      });
    },
  });

  register({
    name: `${PREFIX}_save_dossier`,
    description: '保存全书层面的资料：全书概要、人物、时间线、背景/术语。可以一次只传一部分；人物/术语会按 name/alias 合并，多次增量保存。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        bookSummary: { type: 'string', description: '全书概要 Markdown，800–1200 字' },
        characters: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '人物数组：{name, aliases?, role?, identity?, appearance?, personality?, relationships?, arc?, speechStyle?, firstChapter?, keyScenes?, profile?}',
        },
        timeline: {
          description: '时间线：Markdown 字符串，或 [{when, event, chapter}] 数组',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object', additionalProperties: true } }],
        },
        glossary: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '术语数组：{term, aliases?, category?, explanation, analogy?, firstChapter?, why?}',
        },
        context: { type: 'string', description: '时代与背景 Markdown' },
      },
      required: ['projectId'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderSaveDossier(value)) },
    async execute(args) {
      return gateway.saveDossier({
        projectId: requireProjectId(args),
        bookSummary: args?.bookSummary === undefined ? undefined : asString(args.bookSummary),
        characters: Array.isArray(args?.characters) ? args.characters.map(asRecord) : undefined,
        timeline: args?.timeline === undefined ? undefined : (typeof args.timeline === 'string' ? args.timeline : (Array.isArray(args.timeline) ? args.timeline.map(asRecord) : undefined)),
        glossary: Array.isArray(args?.glossary) ? args.glossary.map(asRecord) : undefined,
        context: args?.context === undefined ? undefined : asString(args.context),
      });
    },
  });

  register({
    name: `${PREFIX}_read_analysis`,
    description: '读某一份资料全文（全书概要/章节摘要/人物/时间线/术语/背景）。需要完整人物小传或某回摘要时用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        kind: { type: 'string', enum: ['book', 'chapter', 'character', 'timeline', 'glossary', 'context'], description: '资料类型' },
        chapterId: { type: 'string', description: 'kind=chapter 时必填' },
        name: { type: 'string', description: 'kind=character 时填人物名' },
      },
      required: ['projectId', 'kind'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderAnalysisFile(value)) },
    async execute(args) {
      return gateway.getAnalysis({
        projectId: requireProjectId(args),
        kind: asString(args?.kind),
        chapterId: asString(args?.chapterId) || undefined,
        name: asString(args?.name) || undefined,
      });
    },
  });

  register({
    name: `${PREFIX}_get_dossier`,
    description: '取“讲这一回”的紧凑资料包：全书概要、本章摘要、相关人物、时间线、名词解释、时代背景、上一版结尾。返回有长度上限；需要全文时用 pingshu_read_chapter / pingshu_read_analysis。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        chapterId: { type: 'string', description: '要讲的章节 id；省略则只返回全书资料' },
      },
      required: ['projectId'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderDossier(value)) },
    async execute(args) {
      return gateway.getDossier({
        projectId: requireProjectId(args),
        chapterId: asString(args?.chapterId) || undefined,
      });
    },
  });

  register({
    name: `${PREFIX}_save_performance`,
    description: '保存一版评书文案。每次调用新建版本、不覆盖旧版；不设字数/时长上限，按故事完整度写。保存后告诉用户到「评书」面板试听。写文案前先 pingshu_get_guide({topic:"performance"})。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        chapterId: { type: 'string', description: '章节 id' },
        script: { type: 'string', description: '完整评书文案 Markdown，含 # 回目 / ## 开场 / ## 正文 / ## 扣子 / ## 下回预告' },
        title: { type: 'string', description: '文案标题，默认回目名' },
        style: { type: 'string', description: '风格，如 传统评书/轻松幽默/少儿版' },
        durationMinutes: { type: 'number', description: '可选，仅用于界面显示估算；不是字数/时长限制' },
        notes: { type: 'string', description: '本次改编备注' },
      },
      required: ['projectId', 'chapterId', 'script'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderSavePerformance(value)) },
    async execute(args) {
      return gateway.savePerformance({
        projectId: requireProjectId(args),
        chapterId: requireChapterId(args),
        script: asString(args?.script),
        title: asString(args?.title) || undefined,
        style: asString(args?.style) || undefined,
        durationMinutes: args?.durationMinutes === undefined ? undefined : asNumber(args.durationMinutes, 25),
        notes: asString(args?.notes) || undefined,
      });
    },
  });

  register({
    name: `${PREFIX}_list_performances`,
    description: '列出一本书或某一回已经讲过的评书版本。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        chapterId: { type: 'string', description: '只看某一回时填' },
      },
      required: ['projectId'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderPerformanceList(value)) },
    async execute(args) {
      return gateway.listPerformances({
        projectId: requireProjectId(args),
        chapterId: asString(args?.chapterId) || undefined,
      });
    },
  });

  register({
    name: `${PREFIX}_read_performance`,
    description: '读一版评书文案全文；不给 versionId 时读最新版。重讲前先用它看上一版。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        chapterId: { type: 'string', description: '章节 id' },
        versionId: { type: 'string', description: '版本 id（v1/v2…），省略读最新版' },
      },
      required: ['projectId', 'chapterId'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderPerformance(value)) },
    async execute(args) {
      return gateway.getPerformance({
        projectId: requireProjectId(args),
        chapterId: requireChapterId(args),
        versionId: asString(args?.versionId) || undefined,
      });
    },
  });

  register({
    name: `${PREFIX}_get_guide`,
    description: '读《评书表演手册》/《书目资料整理手册》。写任何评书文案前必须先调用 topic=performance；整理书目资料前必须调用 topic=analysis。返回完整手册，不要在回答里复述。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: { type: 'string', enum: ['performance', 'analysis', 'all'], description: '要读哪一本手册' },
      },
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(value?.markdown ?? '') },
    async execute(args) {
      const topic = ['performance', 'analysis', 'all'].includes(asString(args?.topic)) ? asString(args.topic) : 'all';
      return loadGuide(topic);
    },
  });

  register({
    name: `${PREFIX}_resplit_chapters`,
    description: '⚠️ 破坏性：用每回正文开头的原文 markers 重建回目，会重置章节摘要、归档旧评书。只有用户明确同意后才传 confirm:true。markers 必须在全文中唯一且按顺序。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        confirm: { type: 'boolean', description: '用户已明确同意时传 true' },
        markers: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', description: '这一回的回目名' },
              start: { type: 'string', description: '这一回正文开头的一段原文（必须唯一且按顺序）' },
            },
            required: ['title', 'start'],
          },
          description: '每回一个 marker，至少两个',
        },
      },
      required: ['projectId', 'markers'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => textBlocks(renderResplit(value)) },
    async execute(args) {
      return gateway.resplitChapters({
        projectId: requireProjectId(args),
        confirm: args?.confirm === true,
        markers: Array.isArray(args?.markers) ? args.markers.map((marker) => ({
          title: asString(marker?.title),
          start: asString(marker?.start),
        })) : [],
      });
    },
  });

  if (systemPrompt !== undefined && systemPrompt !== null) {
    disposers.push(systemPrompt.section({ name: 'pingshu', order: 100, text: SYSTEM_PROMPT }));
  }
  return disposers;
}

export { SYSTEM_PROMPT };
