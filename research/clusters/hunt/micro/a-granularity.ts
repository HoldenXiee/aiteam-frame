// @ts-nocheck
// ★★★ 微实验 · 单因素并行 —— 每个臂**只拨一个旋钮**，其余全同
//
// ★ 修正后的靶子（微装置基线推翻了原来的判断）：
//   原以为 B2「平台期判据恒为 0」是独立的病 —— ★ **微实验证明判据没问题**。
//   ★★★ 真因只有一条：**`agent_settled` 在长实验里从不发生** ⇒ 规则连被调用的机会都没有。
//   ⇒ 所以旋钮 A（触发粒度）是**根因**，B/C 都是它的派生。
//
// ★★ 装置：合成事件序列（零模型成本、秒级、可重复）。
//   ★ 这个装置本身要跑**对照臂**：给它"真实长实验形态"，看旧规则是不是真的 0 反应。

// ══════════════════════════════════════════════════════════════════════════
// ⚠⚠⚠ `@ts-nocheck`（2026-10-20）—— 这是**历史实验装置**，不是运行时
//
//   ★ 为什么加：`tsconfig.json` 的 include 原来**没有 `research/clusters/`**，
//     所以整个集群目录从来没被 `tsc` 检查过（本文件就是那 16 个隐藏错误之一）。
//     把目录加进 include 后它们全部暴露。
//
//   ★★ 为什么**不修**而是加 nocheck：
//     这些错是**判据换代留下的 API 漂移**，不是笔误：
//       · `State.roundsSinceNew` → 已改名为 `roundsSinceProgress`
//         （判据从"有没有动作"换成"有没有进展"，`rules.ts:153`）
//       · `CLUSTER_OWN_FILES` / `ExpertName` 导出已变
//     修它们必须**回到当年那次实验的意图**去判断 —— 那是**内容判断**，
//     不该由我猜（硬规则①）。★★ 而且这些脚本**不参与集群运行**，不影响任何读数。
//
//   ★★★ 留着它们的理由（纪律⑩）：它们是**当年读数的证据**。
//     以后真要重跑那些微实验，应该**按现在的判据重写**，而不是把旧脚本改到能编译。
// ══════════════════════════════════════════════════════════════════════════

import { join } from "node:path";
import { LAB } from "../paths.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { runArm, resetOutbox, type Step, type MicroResult } from "./harness.ts";

// ══════════════════════════════════════════════════════════════
// ★ 真实形态：**研究员一头扎进长实验**（它实际跑 exp-frame 40 轮的形态）
//
//   关键：`settle` 一次都没有 —— 因为一个实验 40 轮不结束，pi 就不会发 `agent_settled`。
//   ★ 这就是"饿死拓扑"的**精确形态**：不是 settle 了但没产出，是**根本不 settle**。
// ══════════════════════════════════════════════════════════════
const LONG_NO_SETTLE: Step[] = [
  { kind: "produce", name: "P25.md" },
  { kind: "settle" },                       // 交付了一次（会 settle）
  // ── 之后开长实验：**全程不 settle**，只在 work/ 里干活 ──
  { kind: "work", n: 800 }, { kind: "work", n: 800 }, { kind: "work", n: 800 },
  { kind: "work", n: 800 }, { kind: "work", n: 800 }, { kind: "work", n: 800 },
];

// ══════════════════════════════════════════════════════════════
// 输出
// ══════════════════════════════════════════════════════════════

function report(label: string, r: MicroResult): void {
  console.log(`\n【${label}】`);
  console.log(`  规则被调用：${JSON.stringify(r.ruleCalls)}`);
  console.log(`  起了专家  ：${r.fired.length ? r.fired.join("、") : "（★ 没有）"}`);
}

const results: MicroResult[] = [];
for (const [label, steps] of [
  ["长实验（不 settle）", LONG_NO_SETTLE],
] as [string, Step[]][]) {
  resetOutbox();
  const r = await runArm(label, {}, steps);
  results.push(r);
  report(label, r);
}

console.log("\n═══ 这一臂说明了什么 ═══");
const r = results[0]!;
const calls = Object.values(r.ruleCalls).reduce((s, v) => s + v, 0);
console.log(`· 规则总共被调用 ${calls} 次`);
console.log(`· 起了 ${r.fired.length} 个专家`);
console.log(
  r.fired.length === 0
    ? "★ 结论：**长实验里规则完全没有机会跑** —— 这确认了归因分析 B1/B5，\n" +
        "  并且说明：**旋钮 A（触发粒度）是根因**，平台期/观察窗口都是它的派生。"
    : "★ 规则有反应 —— 需要再看判据细节。",
);
