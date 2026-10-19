/**
 * 校验宿主 METHODS ↔ 客户端 REMOTE_METHODS ↔ PingshuGateway 方法面一致。
 * 运行：node scripts/verify-wire.mjs
 */
import { readFile } from 'node:fs/promises';
import { METHODS } from '../lib/wire.js';
import { PingshuGateway } from '../lib/index.js';

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const block = /const REMOTE_METHODS = \[([\s\S]*?)\n    \];/u.exec(clientSource);
if (!block) {
  console.error('FAIL: client.js 里找不到 REMOTE_METHODS 数组');
  process.exit(1);
}
const clientEntries = [...block[1].matchAll(/\[\s*'([^']+)'\s*,\s*(true|false)\s*\]/gu)].map((match) => ({
  method: match[1],
  hasPayload: match[2] === 'true',
}));

const hostEntries = METHODS.map((entry) => ({ method: entry.method, hasPayload: entry.payload !== undefined }));
const failures = [];
const hostMap = new Map(hostEntries.map((entry) => [entry.method, entry]));
const clientMap = new Map(clientEntries.map((entry) => [entry.method, entry]));
for (const entry of hostEntries) {
  const client = clientMap.get(entry.method);
  if (!client) failures.push(`客户端缺少方法：${entry.method}`);
  else if (client.hasPayload !== entry.hasPayload) failures.push(`payload 标记不一致：${entry.method}（host=${entry.hasPayload}, client=${client.hasPayload}）`);
}
for (const entry of clientEntries) {
  if (!hostMap.has(entry.method)) failures.push(`客户端多出方法：${entry.method}`);
}
const proto = Object.getOwnPropertyNames(PingshuGateway.prototype);
for (const entry of hostEntries) {
  if (!proto.includes(entry.method)) failures.push(`PingshuGateway 缺少方法：${entry.method}`);
}
if (failures.length > 0) {
  console.error('FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`PASS: ${hostEntries.length} 个远程方法在 host/client/gateway 三边一致。`);
