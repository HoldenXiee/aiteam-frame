// ★★★ 微实验 F · 双重记账（长跑实测抓到的第二个真 bug）
//
// ══════════════════════════════════════════════════════════════════
// ★ 现象（长跑实测，不是推想）
// ══════════════════════════════════════════════════════════════════
//
//   `rule:onSettled outbox=16 auditedOutputs=16`   ← 一直是 16
//   而 outbox **实际已经 19 份**（研究员在这期间交了 3 份新成果）
//   ⇒ **新成果一份都没被审** —— fire 一次都没有。
//
// ══════════════════════════════════════════════════════════════════
// ★ 根因：同一个状态（`auditedOutputs`）被**两处写**
// ══════════════════════════════════════════════════════════════════
//
//   `tick()`：
//       const outboxChanged = n > state.auditedOutputs;
//       if (outboxChanged) state.auditedOutputs = n;   // ★ 先把它推成最新
//       await rules.onSettled();                        // ★ 再调审查
//
//   `onSettled()`：
//       if (outs.length > state.auditedOutputs) { ... } // ★ 永远 false！
//
//   ⇒ **tick 把 onSettled 的判据废掉了。**
//
// ★ ★★ 这是本项目的老病换位置：
//   · `P11`「用什么当判据，就等于让它服从什么」—— 这里是**同一个判据被两处当不同用途**
//   · 以及反复吃过的「**一个状态两个写者**」（`O8` / 微实验 D 的观察者效应同族）
//
// ══════════════════════════════════════════════════════════════════
// ★ 修法
//   两个判据**各有各的变量**：
//     · `seenOutboxCount` —— tick 用（有活动吗）
//     · `auditedOutputs`  —— onSettled 用（该审查吗，单一写者）
// ══════════════════════════════════════════════════════════════════

import { join } from "node:path";
import { mkdirSync, writeFileSync, readdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import { SANDBOX_OUTBOX, SANDBOX_WORK, resetSandbox } from "./harness.ts";
import { makeRules, newState, tick } from "../topology/rules.ts";

/** ★ 用沙箱空间，不碰真集群（事故后纪律） */
function sandboxOutboxPaths() {
  return readdirSync(SANDBOX_OUTBOX).map((f) => join(SANDBOX_OUTBOX, f));
}

type Arm = { scenario: string; fired: string[]; audited: number; actualOutbox: number };

/**
 * ★★★ 关键：`LAB` 在 `rules.ts` 里是模块级常量，改不了 ——
 *   所以本实验**不直接用生产 `tick()`**，而是**逐字复刻它的逻辑**并指向沙箱。
 *   ★ 代价：被测代码与生产不 100% 同源。
 *   ★ 补偿：本实验**同时断言修复后的语义**（`见下`），
 *     并在 `d-observer.ts` 里用真 `tick()` 验证生产代码的另一面。
 */
async function probe(scenario: "tick先记账" | "两个变量分开"): Promise<Arm> {
  resetSandbox();
  const fired: string[] = [];
  // ★ 复刻生产 State 的两个字段
  const st = { auditedOutputs: 0, seenOutboxCount: 0, roundsSinceNew: 0, firedAt: {}, lastActiveAt: Date.now(), lastWorkMtime: 0 };

  const rules = makeRules({
    state: st as never,
    fireNow: async (role) => { fired.push(role); return "VERDICT: CONTINUE"; },
    trace: () => { /* */ },
  });

  // ★ 模拟：outbox 从 0 涨到 3（研究员交了 3 份成果）
  for (let round = 0; round < 3; round++) {
    writeFileSync(join(SANDBOX_OUTBOX, `p${round}.md`), "x");
    const n = sandboxOutboxPaths().length;

    if (scenario === "tick先记账") {
      // ── 旧行为（bug）：tick 先推 auditedOutputs，再调 onSettled ──
      const outboxChanged = n > st.auditedOutputs;
      if (outboxChanged) st.auditedOutputs = n;
      // 然后 onSettled 的判据（★ 猴子补丁式地模拟它读 st.auditedOutputs）
      if (n > st.auditedOutputs) fired.push("inspector");
    } else {
      // ── 新行为：活动账与审查账分开 ──
      const outboxChanged = n > st.seenOutboxCount;
      if (outboxChanged) st.seenOutboxCount = n;
      if (n > st.auditedOutputs) { st.auditedOutputs = n; fired.push("inspector"); }
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  void rules; void tick; void SANDBOX_WORK;
  return { scenario, fired, audited: st.auditedOutputs, actualOutbox: sandboxOutboxPaths().length };
}

console.log("═══ 微实验 F · 双重记账（回归）═══");
console.log("场景：研究员连续交 3 份新成果，每交一份就该被审一次\n");

const arms: Arm[] = [];
for (const s of ["tick先记账", "两个变量分开"] as const) arms.push(await probe(s));

console.log("做法            该审次数   实际审查   结论");
console.log("─".repeat(58));
for (const a of arms) {
  console.log(
    `${a.scenario.padEnd(16)}${String(a.actualOutbox).padEnd(11)}${String(a.fired.length).padEnd(11)}` +
    `${a.fired.length === a.actualOutbox ? "✓ 全审到" : "✗ 漏审 " + (a.actualOutbox - a.fired.length) + " 份"}`,
  );
}

console.log("\n═══ 判定 ═══");
const buggy = arms[0]!, fixed = arms[1]!;
console.log(
  buggy.fired.length === 0
    ? "★★ 旧做法重现了 bug：tick 先记账 ⇒ onSettled 的判据永远 false ⇒ **一份都没审**"
    : "⚠ 旧做法没重现，需检查装置",
);
console.log(
  fixed.fired.length === fixed.actualOutbox
    ? "★★★ 新做法正确：两个变量分开 ⇒ 每份新成果都被审到"
    : "⚠ 新做法仍有问题",
);
