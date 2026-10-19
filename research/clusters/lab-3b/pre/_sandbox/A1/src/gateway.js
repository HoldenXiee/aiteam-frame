import { GATEWAY_LIMIT, GATEWAY_RETRY } from './gateway-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 41;
export function capGATEWAY(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryGATEWAY(fn) {
  for (let i = 0; i < GATEWAY_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitGATEWAY() {
  return GATEWAY_LIMIT;
}