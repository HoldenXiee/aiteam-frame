// ★★★ 微实验 D · 观察者效应（单因素 · 回归）—— 测**生产代码**，不重写逻辑
//
// ★ 这是**实测抓到的真 bug**（不是推想）：
//   真实运行 `rule:tick ... 活动=true roundsSinceNew=0` —— **永远为 0**。
//
// ★★★ 两个叠加的根因（都由本实验查明）：
//
//   ① **集群自己的文件**：规则每跑一次就写 `work/_topology.log`，
//      而"有没有活动"去看 `work/` 的 mtime ⇒ **自己给自己续命**。
//
//   ② ★ **跨时钟域比较**（更隐蔽）：原来用 `mtimeAt > Date.now()` 判"刚动过"。
//      实测 `statSync(f).mtimeMs - Date.now()` 在 **-17ms ~ +4ms** 之间跳 ——
//      **文件系统时间戳能走在挂钟前面** ⇒ 早就存在的文件也会被判成"新活动"。
//      ⇒ 正确做法：**mtime 自己跟自己比**（同源，不跨时钟域）。
//
// ★★ 本实验直接调 `tick()`（生产代码），不重写判据 ——
//    ★ 否则测的是"我以为的逻辑"，不是"跑起来的逻辑"。

import { join } from "node:path";
import { LAB } from "../paths.ts";
import { assertSandbox } from "./harness.ts";
import { mkdirSync, writeFileSync, readdirSync, existsSync, unlinkSync, statSync, appendFileSync } from "node:fs";
import { makeRules, newState, tick, CLUSTER_OWN_FILES } from "../topology/rules.ts";

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

type Arm = { shape: string; roundsSinceNew: number; plateauFired: boolean; firedCount: number };

/**
 * ★ 跑一个形态。**调的是生产代码 `tick()`**。
 *
 * @param shape `真卡住` = outbox 不动 + 它不写 work/
 *              `在干活` = outbox 不动但**它自己**写 work/
 */
async function probe(shape: "真卡住" | "在干活"): Promise<Arm> {
  reset();
  const fired: string[] = [];
  let plateauFired = false;
  const state = newState();

  // 建立基线：交付一次（这会 settle）
  writeFileSync(join(LAB, "outbox", "_d.md"), "x");

  const rules = makeRules({
    state,
    fire: async (role) => { fired.push(role); if (role === "inspirer") plateauFired = true; return "VERDICT: CONTINUE"; },
    trace: () => { /* */ },
  });
  const ctx = { fire: async (r: never) => { fired.push(r); if (r === "inspirer") plateauFired = true; return "VERDICT: CONTINUE"; }, state, trace: () => { /* */ }, rules };

  for (let i = 0; i < 8; i++) {
    // ★ 集群自己的动作：每次 tick 都会 log 一行（= 写 work/_topology.log）
    appendFileSync(join(LAB, "work", "_topology.log"), `tick ${i}\n`);

    // ★ 研究员自己的动作（只在"在干活"形态）
    if (shape === "在干活") writeFileSync(join(LAB, "work", `它写的-${i}.md`), "x");

    await new Promise((r) => setTimeout(r, 5));
    await tick(ctx);
  }
  return { shape, roundsSinceNew: state.roundsSinceNew, plateauFired, firedCount: fired.length };
}

console.log("═══ 微实验 D · 观察者效应（回归，测生产代码 tick()）═══");
console.log(`集群自己的文件（会被排除）：${[...CLUSTER_OWN_FILES].join("、")}\n`);
console.log("两种形态都**不产 outbox**；区别是研究员自己有没有在 work/ 里干活\n");

const arms: Arm[] = [];
for (const s of ["真卡住", "在干活"] as const) arms.push(await probe(s));

console.log("形态      roundsSinceNew   触发换视角   起了几个专家");
console.log("─".repeat(58));
for (const a of arms) {
  console.log(`${a.shape.padEnd(10)}${String(a.roundsSinceNew).padEnd(17)}${(a.plateauFired ? "✓ 触发" : "✗ 没触发").padEnd(13)}${a.firedCount}`);
}

console.log("\n═══ 判定（这两个形态**必须**被分开）═══");
const stuck = arms[0]!, working = arms[1]!;
const ok1 = stuck.plateauFired === true;
const ok2 = working.plateauFired === false;
console.log(`· 「真卡住」该触发：${ok1 ? "✓ 对了" : "✗ 错 —— 卡住了却没人管"}`);
console.log(`· 「在干活」不该触发：${ok2 ? "✓ 对了" : "✗ 错 —— 把努力误判成卡住（微实验 C 原本要治的误报）"}`);
console.log(ok1 && ok2 ? "\n★★ 两个形态分开了 —— 观察者效应被治好，微实验 C 的修复真正生效" : "\n⚠ 仍有问题");
