import { FLAGS_LIMIT, FLAGS_RETRY } from './flags-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 35;
export function capFLAGS(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryFLAGS(fn) {
  for (let i = 0; i < FLAGS_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitFLAGS() {
  return FLAGS_LIMIT;
}