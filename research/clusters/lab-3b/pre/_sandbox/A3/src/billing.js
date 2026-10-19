import { BILLING_LIMIT, BILLING_RETRY } from './billing-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 30;
export function capBILLING(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryBILLING(fn) {
  for (let i = 0; i < BILLING_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitBILLING() {
  return BILLING_LIMIT;
}