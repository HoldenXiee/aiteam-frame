import { HEALTH_LIMIT, HEALTH_RETRY } from './health-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 11;
export function capHEALTH(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryHEALTH(fn) {
  for (let i = 0; i < HEALTH_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitHEALTH() {
  return HEALTH_LIMIT;
}