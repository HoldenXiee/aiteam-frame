import { APPROVAL_LIMIT, APPROVAL_RETRY } from './approval-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 25;
export function capAPPROVAL(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryAPPROVAL(fn) {
  for (let i = 0; i < APPROVAL_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitAPPROVAL() {
  return APPROVAL_LIMIT;
}