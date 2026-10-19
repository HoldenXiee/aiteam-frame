import { COUPON_LIMIT, COUPON_RETRY } from './coupon-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 1;
export function capCOUPON(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryCOUPON(fn) {
  for (let i = 0; i < COUPON_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitCOUPON() {
  return COUPON_LIMIT;
}