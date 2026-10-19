import { KYC_LIMIT, KYC_RETRY } from './kyc-config.js';
// 组装最大容量（上限来自本模块配置）
const HARD_LIMIT = 10;
export function capKYC(items) {
  return items.slice(0, HARD_LIMIT);
}
export function retryKYC(fn) {
  for (let i = 0; i < KYC_RETRY; i++) {
    try { return fn(); } catch {}
  }
  return undefined;
}
export function limitKYC() {
  return KYC_LIMIT;
}