// @ts-nocheck
// ★★★ 微实验：单因素，并行 —— 集群优化前的预实验
//
// ★ 靶子来自归因分析（`docs/实验/lab-3b表现-归因分析.md` §四"可单因素拨动的旋钮"）：
//   A · 触发粒度   —— 规则只在 `agent_settled` 看；长实验 112 轮 0 次 settle
//   B · 平台期判据 —— 常数 0，`onPlateau` 从未触发
//   C · 观察窗口   —— 只看 `outbox`，而它主要在 `work/` 干活
//
// ★★ 方法：**合成事件序列**（不是真研究员）—— 零模型成本、秒级、可重复。
//   先证明**规则**是对的，再花钱测**行为**（装置失败 ≠ 能力失败）。

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
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { runArm, resetOutbox, type Step, type MicroResult } from "./harness.ts";

// ══════════════════════════════════════════════════════════════
// 事件序列：三种真实形态（都取自它实际干过的事）
// ══════════════════════════════════════════════════════════════

/** 形态 1：长实验 —— 连续干活、settle 前不动 outbox（它跑 exp-frame 40 轮的形态） */
const LONG_EXPERIMENT: Step[] = [
  { kind: "produce", name: "P25.md" },      // 先交一份，建立基线
  { kind: "settle" },
  // ── 之后一头扎进长实验：settle 一次，但 outbox 不变 ──
  { kind: "work", n: 500 }, { kind: "work", n: 500 }, { kind: "work", n: 500 },
  { kind: "settle" },
  { kind: "work", n: 500 }, { kind: "work", n: 500 },
  { kind: "settle" },
  { kind: "work", n: 500 },
  { kind: "settle" },
  { kind: "work", n: 500 },
  { kind: "settle" },
];

/** 形态 2：真卡住 —— 既不产出、也不在 work 里动（停滞） */
const STALLED: Step[] = [
  { kind: "produce", name: "P25.md" },
  { kind: "settle" },
  { kind: "settle" }, { kind: "settle" }, { kind: "settle" }, { kind: "settle" }, { kind: "settle" },
];

/** 形态 3：健康推进 —— 每轮都有新产出（不该触发任何"救火"） */
const HEALTHY: Step[] = [
  { kind: "produce", name: "P25.md" }, { kind: "settle" },
  { kind: "produce", name: "P26.md" }, { kind: "settle" },
  { kind: "produce", name: "P27.md" }, { kind: "settle" },
  { kind: "produce", name: "P28.md" }, { kind: "settle" },
  { kind: "produce", name: "P29.md" }, { kind: "settle" },
];

// ══════════════════════════════════════════════════════════════
// 当前版本（对照组）
// ══════════════════════════════════════════════════════════════

type Arm = { name: string; steps: Step[] };

const ARMS: Arm[] = [
  { name: "对照·长实验", steps: LONG_EXPERIMENT },
  { name: "对照·真卡住", steps: STALLED },
  { name: "对照·健康推进", steps: HEALTHY },
];

// ══════════════════════════════════════════════════════════════
// 跑
// ══════════════════════════════════════════════════════════════

const results: MicroResult[] = [];
for (const a of ARMS) {
  resetOutbox();
  results.push(await runArm(a.name, {}, a.steps));
}

// ── 报告 ──
console.log("\n═══ 微实验：规则层（单因素基线）═══\n");
for (const r of results) {
  console.log(`【${r.arm}】`);
  console.log(`  规则被调用：${JSON.stringify(r.ruleCalls)}`);
  console.log(`  起了专家  ：${r.fired.length ? r.fired.join("、") : "（没有）"}`);
  console.log(`  最终 state：roundsSinceNew=${r.finalState.roundsSinceNew} auditedOutputs=${r.finalState.auditedOutputs}`);
  for (const [rule, details] of Object.entries(r.ruleDetail)) {
    console.log(`  ${rule} 的输入：`);
    for (const d of details.slice(-3)) console.log(`     ${d}`);
  }
  console.log();
}

// ★ 判定：三种形态**应当**有不同反应
console.log("═══ 诊断 ═══");
const long = results.find((r) => r.arm.includes("长实验"))!;
const stall = results.find((r) => r.arm.includes("真卡住"))!;
console.log(`· 长实验：起了 ${long.fired.length} 个专家 ${long.fired.length === 0 ? "← ★ 规则没反应（B1/B5 重现）" : ""}`);
console.log(`· 真卡住：起了 ${stall.fired.length} 个专家 ${stall.fired.length === 0 ? "← ★★ 真卡住也不救（B2 重现）" : ""}`);
const rs = new Set(results.flatMap((r) => Object.values(r.ruleDetail).flat()));
console.log(`· roundsSinceNew 出现过的值：${[...new Set(results.map((r) => r.finalState.roundsSinceNew))].join(", ")}`);
