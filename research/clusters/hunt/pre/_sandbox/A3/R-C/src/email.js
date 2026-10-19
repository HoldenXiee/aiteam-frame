import { EMAIL_LIMIT, EMAIL_RETRY } from './email-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 13;
export function capEMAIL(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryEMAIL(fn) {
  for (let i = 0; i < EMAIL_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitEMAIL() {
  return EMAIL_LIMIT;
}