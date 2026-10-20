/**
 * 对话提示词与手册加载。
 *
 * 系统提示词只放“怎么找工具、什么时候先读手册”；真正的写作方法在
 * prompts/*.md 里，由 pingshu_get_guide 按需取，避免每轮都占上下文。
 */
import { readFile } from 'node:fs/promises';

const cache = new Map();

const GUIDE_FILES = {
  performance: ['performance.md', '评书表演手册'],
  analysis: ['analysis.md', '书目资料整理手册'],
};

async function readPromptFile(filename) {
  const url = new URL(`../prompts/${filename}`, import.meta.url);
  return readFile(url, 'utf8');
}

export async function loadGuide(topic = 'all') {
  const key = String(topic ?? 'all');
  if (cache.has(key)) return cache.get(key);
  const parts = [];
  let title = '评书工作手册';
  if (key === 'performance' || key === 'all') {
    parts.push(await readPromptFile(GUIDE_FILES.performance[0]));
    title = key === 'performance' ? GUIDE_FILES.performance[1] : title;
  }
  if (key === 'analysis' || key === 'all') {
    parts.push(await readPromptFile(GUIDE_FILES.analysis[0]));
    title = key === 'analysis' ? GUIDE_FILES.analysis[1] : title;
  }
  if (parts.length === 0) throw new Error(`未知手册类型：${key}`);
  parts.push(await readPromptFile('accessibility.md'));
  const value = { topic: key, title, markdown: parts.join('\n\n---\n\n') };
  cache.set(key, value);
  return value;
}

function cleanText(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function clip(text, max) {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? String(text ?? '') : `${chars.slice(0, max).join('')}…`;
}

export function normalizePerformanceOptions(options = {}) {
  const style = ['传统评书', '轻松幽默', '少儿版', '悬疑加快'].includes(options.style) ? options.style : '传统评书';
  const explanation = ['精简', '适中', '详细'].includes(options.explanation) ? options.explanation : '适中';
  return {
    style,
    explanation,
    notes: cleanText(options.notes, 2000),
  };
}

export function sessionTitleFor(intent, project, chapter, focus) {
  const book = clip(project?.title ?? '未命名书目', 40);
  let title;
  if (intent === 'perform') {
    title = chapter ? `《${book}》· 第${chapter.index ?? ''}回 评书` : `《${book}》· 评书`;
  } else if (intent === 'resplit') {
    title = `《${book}》· 重新分章`;
  } else if (intent === 'analyze' && focus) {
    const labels = { characters: '补充人物', timeline: '补充时间线', glossary: '补充名词', context: '补充背景', book: '补充全书概要', chapters: '补充章节摘要' };
    title = `《${book}》· ${labels[focus] ?? '补充资料'}`;
  } else {
    title = `《${book}》· 书目分析`;
  }
  return clip(title, 80);
}

export function buildAnalysisPrompt(project, { focus, instruction } = {}) {
  const lines = [
    `你在「评书」插件里工作。项目 id：${project.id}；书名：《${project.title}》${project.author ? `；作者：${project.author}` : ''}。`,
    `这本书已经导入，共 ${project.chapters.length} 回，约 ${project.charCount} 字。不要重新上传，也不要修改 chapters/ 里的原文。`,
    '',
    '第一步：先调用 `pingshu_get_guide({topic:"analysis"})` 读《书目资料整理手册》，再调用 `pingshu_analysis_status({projectId:"' + project.id + '"})` 看缺什么。',
    '',
  ];
  if (focus === 'book' || focus === 'characters' || focus === 'timeline' || focus === 'glossary' || focus === 'context') {
    lines.push(
      '这次只补全书层面的资料，不重写已有的章节摘要。',
      '先读 `pingshu_read_analysis`（kind=book/character/timeline/glossary/context）看已有内容，再增量补写；已有内容不要覆盖成空。',
      '把结果用 `pingshu_save_dossier` 保存；人物/术语可以分多次保存，Host 会按 name/alias 合并。',
    );
  } else {
    lines.push(
      '任务：**一次把这本书的书目资料做完**，不要中途停下来问用户“要不要继续”。',
      '1. 调用 `pingshu_analysis_batches({projectId, batchSize:4})` 拿批次。',
      '2. 每一批开一个 `subagent`：prompt 里写清 projectId、这一批的 chapter id 和标题，并明确要求子代理：先读 `pingshu_get_guide({topic:"analysis"})`；只处理这些回目；每回先用 `pingshu_read_chapter` 读完（有 nextOffset 就继续读），再用 `pingshu_save_chapter_summary` 保存；不要写全书资料，不要调用 `pingshu_save_dossier`；完成后一句话汇报。',
      '3. 可以并行 2–3 个子代理，不要超过 3 个；不要把整本书塞给一个子代理。',
      '4. 所有批次完成后调用 `pingshu_analysis_status`；如果 `chapterSummaries.missingCount > 0`，继续开子代理补，直到归零。不要问用户。',
      '5. 章节摘要齐了以后，读 `summaries/chapters` 的摘要（用 `pingshu_read_analysis` 或直接读文件），用 `pingshu_save_dossier` 写全书概要、人物、时间线、背景/术语；可以分多次增量保存。',
      '6. 最后再调一次 `pingshu_analysis_status`，确认 `missingCount = 0` 且 `dossier.missing` 为空；如果还缺，继续补。',
      '7. 如果 `subagent` 工具不可用，就自己按批次顺序做，仍然一次做完；某个子代理失败时只重跑那一批，不要整本书重来。',
    );
  }
  lines.push(
    '',
    '写法要求：',
    '- 摘要是给“讲评书”和“降低阅读门槛”用的，不是学术论文；短段落、可检索、说人话。',
    '- 新出现的人物、官职、地名、礼俗、典故、外来概念，要标记“听众可能不懂”，并在人物/术语资料里解释。',
    '- 区分“原著事实”“合理推测”；不确定的标“待核”，不要编造。',
    '- 每完成一批，用一两句话汇报进度；不要贴大段原文，不要复述手册。',
    '',
    '工作方式：',
    '- **一次做完**：不要停下来问用户“要继续吗”；只有在所有章节摘要和全书资料都齐了之后才结束。',
    '- 不要用 `write`/`edit`/`bash` 直接改项目文件；所有读写走 `pingshu_*` 工具，否则进度不会更新。',
    '- 不要在回答里贴完整摘要；把内容存进项目，回答里只汇报“完成了多少回、还差什么”。',
  );
  if (instruction) lines.push('', `用户补充要求：${cleanText(instruction, 2000)}`);
  return lines.join('\n');
}

export function buildPerformancePrompt(project, chapter, options = {}) {
  const opts = normalizePerformanceOptions(options);
  const lines = [
    `你在「评书」插件里工作。项目 id：${project.id}；书名：《${project.title}》${project.author ? `；作者：${project.author}` : ''}。`,
    `这一回：${chapter.id} · ${chapter.title}（约 ${chapter.chars} 字）。`,
    '',
    '第一步：调用 `pingshu_get_guide({topic:"performance"})` 读《评书表演手册》，再调用 `pingshu_get_dossier({projectId:"' + project.id + '", chapterId:"' + chapter.id + '"})` 取资料包。',
    '第二步：用 `pingshu_read_chapter({projectId, chapterId, offset:0, maxChars:20000})` 读原文；如果返回 nextOffset，继续读，直到读完这一回。不要凭记忆编造情节。',
    '第三步：按下面的要求写文案，保存前过一遍手册的自检清单。',
    '',
    `要求：`,
    '- **不设字数/时长上限**：把这一回的故事完整讲完。按场景推进，不删关键情节，也不为了凑时长注水。',
    '- 原文短就按原文讲，不编造；原文长就按场景讲完，不要压缩成摘要。',
    `- 风格：${opts.style}；讲解力度：${opts.explanation}（精简=只解释影响理解的概念；详细=多给背景、类比、人物关系）。`,
    '- 以降低阅读门槛为主：文化背景、制度、典故、地理、外来概念要解释；人物对话口语化，拒绝翻译腔。',
    '- 遇到原文里的格言、警句、比喻、书面语，不要原样念完就过：要么先把它翻成大白话，要么念完马上补 1–2 句解释，说明这句话到底什么意思、放在这个人物/场景里是什么意思。',
    '- 只讲这一回，不要提前抖后面的关键结局；结尾留一个具体扣子。',
    '- 正文用 Markdown，结构：`# 回目`、`## 开场`、`## 正文`、`## 扣子`、`## 下回预告`；说话人用 `【说书人】` / `【角色：名字】` 标记，每个说话人另起一段。',
    '',
    '保存：',
    `- 写完后调用 \`pingshu_save_performance({projectId:"${project.id}", chapterId:"${chapter.id}", script:"<完整文案>", style:"${opts.style}", notes:"<可选备注>"})\`。`,
    '- 每次保存都会新建一个版本，不覆盖旧版。',
    '- 保存后告诉用户：文案已存到「评书」面板，第几版、约多少字，可以直接点朗读；不要在聊天里贴完整文案。',
  ];
  if (options.previousVersionId) {
    lines.push(
      '',
      `这一回已经讲过一版（${options.previousVersionId}）。先用 \`pingshu_read_performance\` 读它，理解上一版的结构和讲法；这次按用户要求调整，不要逐字照搬。`,
    );
  }
  if (opts.notes) lines.push('', `用户补充要求：${opts.notes}`);
  return lines.join('\n');
}

export function buildResplitPrompt(project) {
  return [
    `你在「评书」插件里工作。项目 id：${project.id}；书名：《${project.title}》。`,
    `用户认为回目切分有问题。先调用 ` + '`pingshu_adjust_chapters({projectId, action:"inspect"})`' + `：它会找出目录/提要残片、同一回被拆成 -1/-2、附录还混在上一回等问题，并给出建议 ops。`,
    '常见修法：目录残片用 `{kind:"drop", chapterId}`；同一回的 -1/-2 用 `{kind:"merge", chapterId, toChapterId}`；附录/下一回混在正文里用 `{kind:"split", chapterId, marker, title}`（marker 从原文复制，在这一回内唯一）；只是名字不对用 `{kind:"rename", chapterId, title}`。',
    '拿到建议后可以再读几回原文核对；确认无误就用 `pingshu_adjust_chapters({projectId, action:"apply", ops, confirm:true})`。用户是通过面板主动要求重新分章的，不必再次征求同意，但完成后要说明“旧章节摘要与旧评书已归档”。',
    '只有整体结构都乱了、ops 修不了，才用 `pingshu_resplit_chapters` 按 markers 整本重建；markers 必须唯一且按顺序，调用前先向用户说明。',
    '完成后告诉用户新的回目数，并建议重新跑一次书目分析（旧摘要已归档，需要重新做）。',
  ].join('\n');
}

export function buildPrompt(intent, project, { chapter, focus, options, instruction, previousVersionId } = {}) {
  if (intent === 'perform') {
    if (!chapter) throw new Error('讲某一回需要 chapter');
    return buildPerformancePrompt(project, chapter, { ...options, previousVersionId });
  }
  if (intent === 'resplit') return buildResplitPrompt(project);
  return buildAnalysisPrompt(project, { focus, instruction });
}
