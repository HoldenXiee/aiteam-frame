import { JOBS_LIMIT, JOBS_RETRY } from './jobs-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 36;
export function capJOBS(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryJOBS(fn) {
  for (let i = 0; i < JOBS_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitJOBS() {
  return JOBS_LIMIT;
}