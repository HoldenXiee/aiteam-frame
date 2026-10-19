import { EXPORT_LIMIT, EXPORT_RETRY } from './export-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 43;
export function capEXPORT(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryEXPORT(fn) {
  for (let i = 0; i < EXPORT_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitEXPORT() {
  return EXPORT_LIMIT;
}