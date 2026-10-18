// ★★★ 微实验 B · 节流阈值（单因素：THROTTLE_N）
//
// ★ A 只证明了"更密看得见"（0 → 2 个专家），但**没证明"多密才合适"** —— 15 是我拍的。
//
// ★★★ 要同时看两个方向（本项目的老教训：指标会互相拉扯）：
//   · **太稀** ⇒ 发现得晚（长实验跑到一半才被提醒）
//   · **太密** ⇒ ★ **打断它**（每 5 次工具调用就被叫起来审查一次，它没法干活）
//   ⇒ 所以主读数不是"发现得快"，而是 **"发现得早 且 干预次数不多"**。
//
// ★ 判据（跑前冻结）：
//   · `callsPerFire` = 每次 fire 之间隔了多少次工具调用 ⇒ 越大越不打扰
//   · `detectedAfter` = 从"开始卡"到"被发现"隔了多少次工具调用 ⇒ 越小越安全
//   · ★ 合格线：`detectedAfter ≤ 60`（一段长实验的 1/3）**且** `callsPerFire ≥ 30`

import { join } from "node:path";
import { LAB } from "../paths.ts";
import { assertSandbox } from "./harness.ts";
import { mkdirSync, writeFileSync, readdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import { makeRules, newState, listOutbox } from "../topology/rules.ts";

/** 一段长实验 = 30 次工具调用；6 段 = 180 次（与微实验 A 逐字同源） */
const SEGMENT = 30;
const SEGMENTS = 6;

type Arm = { n: number; ruleCalls: number; fires: number; detectedAfter: number | null; perFire: number };

async function probe(throttle: number): Promise<Arm> {
  const fired: string[] = [];
  let ruleCalls = 0;
  let toolCalls = 0;
  let detectedAfter: number | null = null;
  const state = newState();

  const rules = makeRules({
    state,
    fire: async (role) => {
      fired.push(role);
      if ((role === "inspirer" || role === "archivist") && detectedAfter === null) detectedAfter = toolCalls;
      return "VERDICT: CONTINUE";
    },
    trace: () => { ruleCalls++; },
  });

  const tick = async () => {
    const n = listOutbox().length;
    if (n > state.auditedOutputs) { state.auditedOutputs = n; state.roundsSinceNew = 0; }
    else state.roundsSinceNew++;
    await rules.onSettled();
    await rules.onCapabilityGap();
    await rules.onPlateau();
  };

  // 交付一次（会 settle），然后一头扎进长实验
  writeFileSync(join(LAB, "outbox", "_b.md"), "x");
  await tick();
  for (let seg = 0; seg < SEGMENTS; seg++) {
    for (let i = 0; i < SEGMENT; i++) {
      toolCalls++;
      if (toolCalls % throttle === 0) await tick();
    }
  }
  return { n: throttle, ruleCalls, fires: fired.length, detectedAfter, perFire: fired.length ? Math.round(toolCalls / fired.length) : Infinity };
}

function reset() {
  assertSandbox(LAB); // ★★★ 安全阀：只动沙箱（2026-10-19 事故后加）
  const d = join(LAB, "outbox");
  mkdirSync(d, { recursive: true });
  if (!existsSync(d)) return;
  for (const f of readdirSync(d)) { try { if (statSync(join(d, f)).isFile()) unlinkSync(join(d, f)); } catch { /* */ } }
}

console.log("═══ 微实验 B · 节流阈值（单因素）═══");
console.log(`事件序列：交付 1 次 → ${SEGMENTS} 段长实验 × ${SEGMENT} 次工具调用 = ${SEGMENTS * SEGMENT} 次\n`);

const arms: Arm[] = [];
for (const n of [5, 10, 15, 30, 60, 120]) {
  reset();
  arms.push(await probe(n));
}

console.log("阈值  规则调用  fire次数  隔多久一次  发现卡住的时刻");
console.log("─".repeat(62));
for (const a of arms) {
  const per = a.perFire === Infinity ? "—" : `${a.perFire} 次`;
  const det = a.detectedAfter === null ? "★ 没发现" : `${a.detectedAfter} 次`;
  console.log(`${String(a.n).padEnd(5)} ${String(a.ruleCalls).padEnd(9)} ${String(a.fires).padEnd(9)} ${per.padEnd(11)} ${det}`);
}

console.log("\n═══ 判定（判据跑前冻结：detectedAfter ≤ 60 且 perFire ≥ 30）═══");
for (const a of arms) {
  const ok = a.fires > 0 && a.detectedAfter !== null && a.detectedAfter <= 60 && a.perFire >= 30;
  console.log(`· 阈值 ${String(a.n).padEnd(4)} ${ok ? "✓ 合格" : "✗ 不合格"}  ${a.fires === 0 ? "（看不见）" : a.perFire < 30 ? `（太吵：每 ${a.perFire} 次就 fire）` : "（合理）"}`);
}
