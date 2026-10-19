import { INGEST_LIMIT, INGEST_RETRY } from './ingest-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 37;
export function capINGEST(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryINGEST(fn) {
  for (let i = 0; i < INGEST_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitINGEST() {
  return INGEST_LIMIT;
}