import { BACKUP_LIMIT, BACKUP_RETRY } from './backup-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 29;
export function capBACKUP(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryBACKUP(fn) {
  for (let i = 0; i < BACKUP_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitBACKUP() {
  return BACKUP_LIMIT;
}