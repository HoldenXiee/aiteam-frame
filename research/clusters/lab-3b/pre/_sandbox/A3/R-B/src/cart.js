import { CART_LIMIT, CART_RETRY } from './cart-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 20;
export function capCART(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryCART(fn) {
  for (let i = 0; i < CART_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitCART() {
  return CART_LIMIT;
}