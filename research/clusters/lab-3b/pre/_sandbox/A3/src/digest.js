import { DIGEST_LIMIT, DIGEST_RETRY } from './digest-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 34;
export function capDIGEST(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryDIGEST(fn) {
  for (let i = 0; i < DIGEST_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitDIGEST() {
  return DIGEST_LIMIT;
}