// ★★★ 微实验 C · 观察窗口（单因素：看哪里 / 怎么看"有活动"）
//
// ★ 问题（归因分析 C）：规则只看 `outbox`，而研究员**大部分时间在 `work/` 里干活**。
//   ⇒ 「真卡住」与「在努力干活」在旧判据下**长得一样**（都是 outbox 不动）。
//
// ★★ 判据（跑前冻结）—— 这个实验要能把两种形态**分开**：
//   形态①「在干活」：outbox 不动，但 work/ 一直在变   ⇒ **不该**触发换视角
//   形态②「真卡住」：outbox 不动，work/ 也不动       ⇒ **应该**触发换视角
//
// ★ 旧判据（只看 outbox）：两种形态**都会**触发 ⇒ **误报**
//   新判据（work/ 也算活动）：①不触发、②触发 ⇒ 分开了
//
// ★★ 注意：这里拨的是**判据**，不是"观察点密度"（那是 A）—— 单因素，不混。

import { join } from "node:path";
import { LAB } from "../paths.ts";
import { assertSandbox } from "./harness.ts";
import { mkdirSync, writeFileSync, readdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import { makeRules, newState, listOutbox } from "../topology/rules.ts";

type Window = "outbox-only" | "work-too";

/** work/ 里"最近有没有动过"—— 新判据的输入 */
function workChangedSince(t: number): boolean {
  const d = join(LAB, "work");
  if (!existsSync(d)) return false;
  for (const f of readdirSync(d)) {
    try { if (statSync(join(d, f)).mtimeMs > t) return true; } catch { /* */ }
  }
  return false;
}

type Arm = {
  window: Window;
  shape: "在干活" | "真卡住";
  fired: string[];
  /** ★ 该触发吗（地面真值） */
  shouldFire: boolean;
};

async function probe(window: Window, shape: "在干活" | "真卡住"): Promise<Arm> {
  const fired: string[] = [];
  const state = newState();
  let lastActivity = Date.now();     // ★ "上次看见活动"的时刻

  const rules = makeRules({
    state,
    fire: async (role) => { fired.push(role); return "VERDICT: CONTINUE"; },
    trace: () => { /* */ },
  });

  const tick = async () => {
    const outs = listOutbox();
    // ── 旧的"有活动"判据：只看 outbox ──
    // ── 新的：work/ 也算 ──
    const active =
      window === "outbox-only"
        ? outs.length > state.auditedOutputs
        : outs.length > state.auditedOutputs || workChangedSince(lastActivity);

    if (active) { state.auditedOutputs = outs.length; state.roundsSinceNew = 0; lastActivity = Date.now(); }
    else state.roundsSinceNew++;
    await rules.onSettled();
    await rules.onCapabilityGap();
    await rules.onPlateau();
  };

  // 交付一次，建立基线
  writeFileSync(join(LAB, "outbox", "_c.md"), "x");
  await tick();
  await new Promise((r) => setTimeout(r, 5));   // 让 mtime 有区分度

  // 之后 6 个"结算点"
  for (let i = 0; i < 6; i++) {
    if (shape === "在干活") {
      writeFileSync(join(LAB, "work", `_c-${i}.md`), "x");    // ★ work/ 在动
      await new Promise((r) => setTimeout(r, 5));
    }
    await tick();
  }

  return { window, shape, fired, shouldFire: shape === "真卡住" };
}

function reset() {
  assertSandbox(LAB); // ★★★ 安全阀：只动沙箱（2026-10-19 事故后加）
  for (const d of [join(LAB, "outbox"), join(LAB, "work")]) {
    mkdirSync(d, { recursive: true });
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      try { if (statSync(p).isFile()) unlinkSync(p); } catch { /* 目录跳过 */ }
    }
  }
}

console.log("═══ 微实验 C · 观察窗口（单因素）═══");
console.log("形态①「在干活」= outbox 不动但 work/ 一直在变 → 期望**不**触发");
console.log("形态②「真卡住」= outbox 不动、work/ 也不动   → 期望**要**触发\n");

const arms: Arm[] = [];
for (const w of ["outbox-only", "work-too"] as Window[]) {
  for (const s of ["在干活", "真卡住"] as const) {
    reset();
    arms.push(await probe(w, s));
  }
}

console.log("窗口          形态     起了专家                     应当触发  判定");
console.log("─".repeat(78));
for (const a of arms) {
  const did = a.fired.length > 0;
  const correct = did === a.shouldFire;
  console.log(
    `${a.window.padEnd(14)}${a.shape.padEnd(9)}${(a.fired.length ? a.fired.join("、") : "（没有）").padEnd(29)}` +
    `${(a.shouldFire ? "是" : "否").padEnd(10)}${correct ? "✓ 对" : "✗ 错"}`,
  );
}

console.log("\n═══ 判定 ═══");
const score = (w: Window) => arms.filter((a) => a.window === w && (a.fired.length > 0) === a.shouldFire).length;
console.log(`· outbox-only：${score("outbox-only")}/2 判对`);
console.log(`· work-too   ：${score("work-too")}/2 判对`);
console.log(
  score("work-too") > score("outbox-only")
    ? "★ 结论：**把 work/ 也算活动 ⇒ 能分开「在干活」与「真卡住」**"
    : "★ 结论：拨动没效果",
);
