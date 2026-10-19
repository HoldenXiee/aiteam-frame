import { LEDGER_LIMIT, LEDGER_RETRY } from './ledger-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 36;
export function capLEDGER(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryLEDGER(fn) {
  for (let i = 0; i < LEDGER_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitLEDGER() {
  return LEDGER_LIMIT;
}