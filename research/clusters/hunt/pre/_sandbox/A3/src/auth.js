import { AUTH_LIMIT, AUTH_RETRY } from './auth-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 11;
export function capAUTH(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryAUTH(fn) {
  for (let i = 0; i < AUTH_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitAUTH() {
  return AUTH_LIMIT;
}