import { GEO_LIMIT, GEO_RETRY } from './geo-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 13;
export function capGEO(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryGEO(fn) {
  for (let i = 0; i < GEO_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitGEO() {
  return GEO_LIMIT;
}