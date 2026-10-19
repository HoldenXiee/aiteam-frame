import { INVENTORY_LIMIT, INVENTORY_RETRY } from './inventory-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 28;
export function capINVENTORY(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryINVENTORY(fn) {
  for (let i = 0; i < INVENTORY_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitINVENTORY() {
  return INVENTORY_LIMIT;
}