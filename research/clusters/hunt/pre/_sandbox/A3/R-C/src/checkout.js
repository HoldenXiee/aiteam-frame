import { CHECKOUT_LIMIT, CHECKOUT_RETRY } from './checkout-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 27;
export function capCHECKOUT(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryCHECKOUT(fn) {
  for (let i = 0; i < CHECKOUT_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitCHECKOUT() {
  return CHECKOUT_LIMIT;
}