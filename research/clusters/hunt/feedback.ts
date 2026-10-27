// ★★★ 回流：把专家的结论**投给研究员**
//
// ★★★ 为什么需要这个（设计疏漏，2026-10-18 修）：
//
//   **"代码触发"这条路上，`fire()` 的返回值没有天然的"回流入口"。**
//
//   | | agent 触发（`consult`） | 代码触发（`fire`） |
//   |---|---|---|
//   | 谁发起 | 模型调工具 | 我的规则 |
//   | 结果怎么回去 | ★★ `execute` 的返回值自动进父上下文 | ★ 没这个机制 —— 得我自己投 |
//
//   ★ 原来只做"落盘"，而**落盘 ≠ 它读得到** —— 实测验证：
//     起一个专家写 `DEFECT: …`，然后问 researcher「你收到过审查意见吗」，
//     它答：**「没有。我没收到过任何审查意见，也没收到过 DEFECT。」**（而且它去磁盘上查了一遍）
//   ★★ ⇒ **等于没审。**

import type { Agent } from "../../../src/index.ts";

/** 回流时给研究员的信头 —— 让它一眼知道这是谁说的、为什么说 */
function letterhead(role: string, why: string): string {
  return (
    `## 📮 ${role} 给你的意见\n\n` +
    `**为什么它被叫来**：${why}\n\n` +
    `---\n\n`
  );
}

/**
 * 把一段专家结论投给研究员。
 *
 * ★ 用 `io.queue`（不是 `io.prompt`）——
 *   它忙 → 排进当前这次运行；它闲 → 起一次运行。两条路都不会打断它的在飞那一轮。
 * ★★ 不 await（回流不该阻塞规则链）—— 但**必须接住异常**，
 *    否则回流失败会静默消失（本项目的老毛病）。
 */
/**
 * ★★★★★ 2026-10-27 · **回流的欠账必须能等**（纪律㊷ 的第三次复发）
 *
 * ★ 实测（设计者那轮 3h43m 的收尾日志）：
 *   ```
 *   error  回流 inspector 失败：agent L3-researcher-hands-on-… 已 dispose（disposed）
 *   error  回流 libsmith  失败：agent … 已 dispose
 *   ```
 *   两条都是**在收尾之后**才落地的 —— 因为 `void io.queue(...)` 不 await，
 *   而收尾把 agent 都 dispose 了 ⇒ **那两条结论直接丢了**。
 * ★★ 判据：收尾顺序必须是「先回流，后停人」；而"先"意味着**要等它们落地**。
 *   所以这里把在飞的回流 promise 记下来，收尾时 `drainFeedback()` 等一次（有上限）。
 */
const inflight = new Set<Promise<unknown>>();

/**
 * ★★★ 2026-10-27 · **收尾之后不再投递**（把"丢了一条"说清楚，而不是报一堆"已 dispose"）
 *
 * ★ 实测：收尾把 agent dispose 之后，仍有几张回流的 promise 在路上 ⇒
 *   `error 回流 libsmith 失败：agent … 已 dispose` —— 一行一个，看着像故障，
 *   其实是"人已经停了，信还没送到"。**这两件事必须分开说**（纪律㉔）。
 * ★★ 所以收尾进拆除段时 `seal(true)`：之后不再 queue，只累计丢了几条，
 *   由 runner 统一打一行「收尾中丢掉 N 条回流（人已停）」。
 */
let sealed = false;
let sealedDropped = 0;
export function sealFeedback(on = true): void {
  sealed = on;
}
export function sealedDroppedCount(): number {
  return sealedDropped;
}

/** 现在还有几条回流没落地（收尾日志里报出来，别让它静默）*/
export function pendingFeedback(): number {
  return inflight.size;
}

/**
 * 收尾等回流落地。★ 有上限：回流是"投递"，不是"研究"，
 * 一个已经在 dispose 的 agent 不值得无限等。
 */
export async function drainFeedback(timeoutMs = 20_000): Promise<{ settled: number; left: number }> {
  const start = Date.now();
  const snapshot = [...inflight];
  if (snapshot.length === 0) return { settled: 0, left: 0 };
  await Promise.race([
    Promise.allSettled(snapshot),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  void start;
  return { settled: snapshot.length - inflight.size, left: inflight.size };
}

export function deliverToResearcher(
  researcher: Agent,
  role: string,
  why: string,
  text: string,
  onError: (msg: string) => void,
): void {
  if (!text.trim()) return;
  if (sealed) {
    // ★ 人已停：不 queue（会以"已 dispose"报错），而是记账，由收尾统一报一行
    sealedDropped++;
    return;
  }
  const msg = letterhead(role, why) + text;
  const p = researcher.io
    .queue(msg)
    .catch((e) => onError(`回流 ${role} 失败：${(e as Error).message}`))
    .finally(() => inflight.delete(p));
  inflight.add(p as Promise<unknown>);
}

/**
 * ★★★ `consult` 那条路**不需要** `deliverToResearcher` —— `execute` 的返回值自动回流。
 *
 * ★ 这个常量原来**只写了警告、没有落地**（全仓库零引用）—— 研究员集群抓到了它的代价：
 *   `fire()` 无条件投递 ⇒ consult 的结论进了研究员上下文**两份**。
 * ★★ 现在它是**活的判据**：`fire(..., { echoed: true })` 就是这条常量的落地（见 runner.ts）。
 *   `runner.ts` 引用它，`dev/test` 的断言也认它 —— 不再是注释。
 */
export const NOTE_CONSULT_ALREADY_FLOWS =
  "★ consult 走的是 defineTool.execute 的返回值 —— 它天然回流，别在这里重复投递（会变成两份）。" +
  "⇒ 调用 fire 时必须传 { echoed: true }（已落地为 runner.ts 的那个箭头）。";
