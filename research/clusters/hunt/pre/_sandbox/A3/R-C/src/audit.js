import { AUDIT_LIMIT, AUDIT_RETRY } from './audit-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 8;
export function capAUDIT(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryAUDIT(fn) {
  for (let i = 0; i < AUDIT_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitAUDIT() {
  return AUDIT_LIMIT;
}