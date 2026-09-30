// 真模型共用：只用 opencode-go/deepseek-v4.1-flash，累计花费。
export const LIVE_MODEL = "opencode-go/deepseek-v4.1-flash";
export const liveCost = { total: 0, tokens: 0, calls: 0 };
export function acc(a: any): void {
  liveCost.total += a.usage?.cost?.total ?? 0;
  liveCost.tokens += a.usage?.totalTokens ?? 0;
  liveCost.calls += 1;
}
export function reportCost(tag: string): void {
  console.log(`\n【${tag} 花费】$${liveCost.total.toFixed(6)} / ${liveCost.tokens} tokens / ${liveCost.calls} 次 agent 调用`);
}
