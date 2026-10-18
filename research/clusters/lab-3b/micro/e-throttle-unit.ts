// ★★★ 微实验 E · 节流的**单位**错了吗（回归测试）
//
// ★ 长跑实测发现（这是本实验要固化的东西）：
//   · 长跑 25 分钟：`rule:tick` **1 次**，而 `work/` 里改了 **1589 个文件**、跑了 **23 轮实验**
//   · 根因：它跑实验是 `bash` 里执行 `npx tsx exp-cross.ts`，
//     **一次调用内部跑 20+ 轮，平均每轮 273 秒、最长 602 秒**
//     ⇒ **一次工具调用 = 1~3 小时**
//   ⇒ 「每 15 次工具调用」在实验形态下 = **几小时** ⇒ 规则仍被饿死
//
// ★★★ 教训：**节流必须用"会流走的东西"做单位。**
//   工具调用次数**不会因为等待而增加**；**时间会流走**。
//
// ★ 本实验：模拟"一次工具调用跑很久"的真实形态，比较三种节流。
//   ★★ 零模型成本 —— 只模拟**调用计数**与**时间流逝**，不发真请求。

import { join } from "node:path";
import { LAB } from "../paths.ts";
import { assertSandbox } from "./harness.ts";
import { mkdirSync, writeFileSync, readdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import { THROTTLE_N, THROTTLE_MS } from "../topology/rules.ts";

function reset() {
  assertSandbox(LAB); // ★★★ 安全阀：只动沙箱（2026-10-19 事故后加）
  for (const d of [join(LAB, "outbox"), join(LAB, "work")]) {
    mkdirSync(d, { recursive: true });
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      try { if (statSync(p).isFile()) unlinkSync(p); } catch { /* 目录 */ }
    }
  }
}

type Arm = { name: string; ticks: number; maxGapMs: number };

/**
 * 模拟"一次工具调用跑很久"。
 *
 * @param lane 用哪一路节流
 * @param callMs 每次工具调用持续多久（真实：273 秒；★ 这里压缩成 50ms 以便快跑）
 * @param calls 总共几次工具调用
 */
async function probe(lane: "count" | "count+time", callMs: number, calls: number): Promise<Arm> {
  reset();
  writeFileSync(join(LAB, "outbox", "_e.md"), "x");

  let ticks = 0;
  let lastTickAt = Date.now();
  let maxGapMs = 0;
  let sinceCount = 0;
  let timer: NodeJS.Timeout | null = null;

  const doTick = () => {
    const now = Date.now();
    // ★ 只统计"没有活动"的情形下"多久才被看一次"（这才是被饿死的度量）
    maxGapMs = Math.max(maxGapMs, now - lastTickAt);
    lastTickAt = now;
    ticks++;
    // ★ 真实形态：实验**内部**在写文件 ⇒ work/ 会动 ⇒ 判为有活动
    writeFileSync(join(LAB, "work", `_e-${ticks}.md`), "x");
  };

  if (lane === "count+time") timer = setInterval(doTick, Math.max(10, Math.floor(THROTTLE_MS / 6000)));

  for (let c = 0; c < calls; c++) {
    // ★ 一次工具调用：期间**没有新的工具调用事件**，但在写文件（= 跑实验）
    const steps = Math.max(1, Math.floor(callMs / 10));
    for (let i = 0; i < steps; i++) {
      writeFileSync(join(LAB, "work", `_inner-${c}-${i}.md`), "x");
      await new Promise((r) => setTimeout(r, 10));
    }
    // ★ 调用结束 —— 这才是计数路能看到的时刻
    sinceCount++;
    if (lane === "count" || lane === "count+time") {
      if (sinceCount >= THROTTLE_N) { sinceCount = 0; doTick(); }
    }
  }
  if (timer) clearInterval(timer);
  return { name: lane, ticks, maxGapMs };
}

// ★ 把真实比例压缩：真实 273s/调用 → 这里 300ms/调用（压缩 910 倍）
const CALL_MS = 300;
const CALLS = 20;    // 真实场景：一晚跑很多轮
const REAL_CALL_SEC = 273;

console.log("═══ 微实验 E · 节流单位（回归）═══");
console.log(`模拟：每次工具调用 ${CALL_MS}ms（真实 ${REAL_CALL_SEC}s，压缩 ${Math.round(REAL_CALL_SEC*1000/CALL_MS)} 倍）`);
console.log(`     共 ${CALLS} 次调用 = 真实约 ${Math.round(CALLS*REAL_CALL_SEC/60)} 分钟`);
console.log(`节流参数：每次数 THROTTLE_N=${THROTTLE_N} · 时间 THROTTLE_MS=${THROTTLE_MS/60000} 分钟（压缩后 ${Math.floor(THROTTLE_MS/6000)}ms）\n`);

const arms: Arm[] = [];
for (const lane of ["count", "count+time"] as const) arms.push(await probe(lane, CALL_MS, CALLS));

const toReal = (ms: number) => `真实约 ${Math.round((ms * REAL_CALL_SEC * 1000 / CALL_MS) / 60000)} 分钟`;
console.log("节流方式        tick 次数    最长未检查间隔");
console.log("─".repeat(62));
for (const a of arms) {
  console.log(`${a.name.padEnd(15)}${String(a.ticks).padEnd(13)}${a.maxGapMs}ms（${toReal(a.maxGapMs)}）`);
}

console.log("\n═══ 判定 ═══");
const countOnly = arms[0]!, both = arms[1]!;
console.log(`· 只用计数：${countOnly.ticks} 次 —— ${countOnly.ticks === 0 ? "★★ 全程一次都没看（规则被饿死）" : "看了"}`);
console.log(`· 加时间路：${both.ticks} 次`);
console.log(both.ticks > countOnly.ticks
  ? `★★ 结论：**加时间路后，实验形态下也能被看见**（${countOnly.ticks} → ${both.ticks} 次）`
  : "⚠ 没差别，需检查装置");
