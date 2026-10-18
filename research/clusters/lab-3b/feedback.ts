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
export function deliverToResearcher(
  researcher: Agent,
  role: string,
  why: string,
  text: string,
  onError: (msg: string) => void,
): void {
  if (!text.trim()) return;
  const msg = letterhead(role, why) + text;
  void researcher.io.queue(msg).catch((e) => onError(`回流 ${role} 失败：${(e as Error).message}`));
}

/** `consult` 那条路**不需要**这个 —— execute 的返回值自动回流。把这个区别写下来免得又忘 */
export const NOTE_CONSULT_ALREADY_FLOWS =
  "★ consult 走的是 defineTool.execute 的返回值 —— 它天然回流，别在这里重复投递（会变成两份）。";
