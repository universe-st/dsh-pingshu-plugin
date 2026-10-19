/**
 * pingshu 远程服务的 wire 协议。
 *
 * 约定与游戏素材大师一致：每个方法最多一个 `payload` 对象参数；这一份描述
 * 同时被宿主 typert 网关和浏览器半区复用。客户端 REMOTE_METHODS 必须与本文件
 * 的 METHODS 一一对应，scripts/verify-wire.mjs 会检查。
 */
import { z } from 'zod';

const jsonObject = z.record(z.string(), z.unknown());
const projectIdSchema = z.object({ projectId: z.string() });
const getProjectSchema = z.object({ projectId: z.string(), scan: z.boolean().optional() });
const createProjectSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  filename: z.string(),
});
const renameProjectSchema = z.object({ projectId: z.string(), title: z.string() });
const chapterSchema = z.object({ projectId: z.string(), chapterId: z.string() });
const getChapterSchema = z.object({
  projectId: z.string(),
  chapterId: z.string(),
  offset: z.number().optional(),
  maxChars: z.number().optional(),
});
const getAnalysisSchema = z.object({
  projectId: z.string(),
  kind: z.enum(['book', 'chapter', 'character', 'timeline', 'glossary', 'context', 'chapter-index']),
  chapterId: z.string().optional(),
  name: z.string().optional(),
});
const saveChapterSummarySchema = z.object({
  projectId: z.string(),
  chapterId: z.string(),
  summary: z.string(),
  characters: z.array(z.string()).optional(),
  terms: z.array(z.string()).optional(),
  events: z.array(z.object({
    when: z.string().optional(),
    event: z.string(),
    chapter: z.string().optional(),
  })).optional(),
});
const saveDossierSchema = z.object({
  projectId: z.string(),
  bookSummary: z.string().optional(),
  characters: z.array(jsonObject).optional(),
  timeline: z.union([z.string(), z.array(jsonObject)]).optional(),
  glossary: z.array(jsonObject).optional(),
  context: z.string().optional(),
});
const analysisStatusSchema = z.object({ projectId: z.string(), limit: z.number().optional() });
const analysisBatchesSchema = z.object({ projectId: z.string(), batchSize: z.number().optional(), limit: z.number().optional() });
const getDossierSchema = z.object({ projectId: z.string(), chapterId: z.string().optional() });
const savePerformanceSchema = z.object({
  projectId: z.string(),
  chapterId: z.string(),
  script: z.string(),
  title: z.string().optional(),
  style: z.string().optional(),
  durationMinutes: z.number().optional(),
  notes: z.string().optional(),
});
const listPerformancesSchema = z.object({ projectId: z.string(), chapterId: z.string().optional() });
const getPerformanceSchema = z.object({
  projectId: z.string(),
  chapterId: z.string(),
  versionId: z.string().optional(),
});
const deletePerformanceSchema = z.object({
  projectId: z.string(),
  chapterId: z.string(),
  versionId: z.string(),
});
const resplitSchema = z.object({
  projectId: z.string(),
  markers: z.array(z.object({
    title: z.string(),
    start: z.string().optional(),
    marker: z.string().optional(),
    source: z.string().optional(),
  })),
  confirm: z.boolean().optional(),
});
const resolveSchema = z.object({ query: z.string(), limit: z.number().optional() });
const startConversationSchema = z.object({
  projectId: z.string(),
  intent: z.enum(['analyze', 'perform', 'resplit']),
  chapterId: z.string().optional(),
  focus: z.enum(['chapters', 'book', 'characters', 'timeline', 'glossary', 'context']).optional(),
  options: jsonObject.optional(),
  instruction: z.string().optional(),
  previousVersionId: z.string().optional(),
});
const getGuideSchema = z.object({ topic: z.enum(['performance', 'analysis', 'all']).optional() });
const ttsProviderSchema = z.enum(['browser', 'moss', 'volcengine', 'siliconflow']);
const saveTtsConfigSchema = z.object({ provider: ttsProviderSchema.optional(), moss: jsonObject.optional(), volcengine: jsonObject.optional(), siliconflow: jsonObject.optional() });
const uploadTtsRefSchema = z.object({ kind: z.enum(['narrator', 'character']), name: z.string().optional(), data: z.string() });
const ttsTestSchema = z.object({ endpoint: z.string().optional() });
const siliconTestSchema = z.object({
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  voice: z.string().optional(),
  sampleRate: z.number().optional(),
});
const volcTestSchema = z.object({
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  resourceId: z.string().optional(),
  speaker: z.string().optional(),
  sampleRate: z.number().optional(),
});
const ttsStartSchema = z.object({
  projectId: z.string(),
  chapterId: z.string(),
  versionId: z.string().optional(),
  provider: ttsProviderSchema.optional(),
});
const ttsJobSchema = z.object({ jobId: z.string() });

export const PACKAGE_NAME = 'dsh-pingshu';
export const SERVICE_NAME = 'pingshu';

export const METHODS = [
  { method: 'listProjects', result: jsonObject },
  { method: 'getProject', payload: getProjectSchema, result: jsonObject },
  { method: 'repairProject', payload: projectIdSchema, result: jsonObject },
  { method: 'createProject', payload: createProjectSchema, result: jsonObject },
  { method: 'reissueUpload', payload: projectIdSchema, result: jsonObject },
  { method: 'startImport', payload: projectIdSchema, result: jsonObject },
  { method: 'deleteProject', payload: projectIdSchema, result: jsonObject },
  { method: 'renameProject', payload: renameProjectSchema, result: jsonObject },
  { method: 'getChapter', payload: getChapterSchema, result: jsonObject },
  { method: 'getAnalysis', payload: getAnalysisSchema, result: jsonObject },
  { method: 'saveChapterSummary', payload: saveChapterSummarySchema, result: jsonObject },
  { method: 'saveDossier', payload: saveDossierSchema, result: jsonObject },
  { method: 'analysisStatus', payload: analysisStatusSchema, result: jsonObject },
  { method: 'analysisBatches', payload: analysisBatchesSchema, result: jsonObject },
  { method: 'getDossier', payload: getDossierSchema, result: jsonObject },
  { method: 'savePerformance', payload: savePerformanceSchema, result: jsonObject },
  { method: 'listPerformances', payload: listPerformancesSchema, result: jsonObject },
  { method: 'getPerformance', payload: getPerformanceSchema, result: jsonObject },
  { method: 'deletePerformance', payload: deletePerformanceSchema, result: jsonObject },
  { method: 'resplitChapters', payload: resplitSchema, result: jsonObject },
  { method: 'resolve', payload: resolveSchema, result: jsonObject },
  { method: 'startConversation', payload: startConversationSchema, result: jsonObject },
  { method: 'getGuide', payload: getGuideSchema, result: jsonObject },
  { method: 'getTtsConfig', result: jsonObject },
  { method: 'saveTtsConfig', payload: saveTtsConfigSchema, result: jsonObject },
  { method: 'uploadTtsReference', payload: uploadTtsRefSchema, result: jsonObject },
  { method: 'ttsTest', payload: ttsTestSchema, result: jsonObject },
  { method: 'volcTest', payload: volcTestSchema, result: jsonObject },
  { method: 'siliconTest', payload: siliconTestSchema, result: jsonObject },
  { method: 'ttsStart', payload: ttsStartSchema, result: jsonObject },
  { method: 'ttsJob', payload: ttsJobSchema, result: jsonObject },
  { method: 'ttsCancel', payload: ttsJobSchema, result: jsonObject },
];

/** Agent 工具面允许调用的方法；startConversation 不在其中（避免 AI 递归开对话）。 */
export const TOOL_METHODS = METHODS
  .map((entry) => entry.method)
  .filter((method) => method !== 'startConversation');

function strictCodec(typeSymbol, schema) {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => schema,
  };
}

export const MANIFEST = {
  package: PACKAGE_NAME,
  face: 'host',
  schemas: [],
  invocations: METHODS.map((spec) => ({
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/${spec.method}`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: spec.method,
    invocation: { kind: 'direct' },
    parameters: spec.payload === undefined
      ? []
      : [{
          name: 'payload',
          wire: 'payload',
          source: 'json',
          codec: strictCodec(`${PACKAGE_NAME}#${spec.method}Payload`, spec.payload),
        }],
    result: strictCodec(`${PACKAGE_NAME}#${spec.method}Result`, spec.result),
  })),
  model: { services: [], events: [], objects: [] },
};
