// ★★★ 微实验 G · 平台期判据（"有没有动作" → "有没有进展"）
//
// ══════════════════════════════════════════════════════════════════
// ★ 现象（长跑实测读出，不是推想）
// ══════════════════════════════════════════════════════════════════
//
//   18:28  rule:onPlateau roundsSinceNew=1 need=3
//   18:33  rule:onPlateau roundsSinceNew=2 need=3
//   18:34  rule:onPlateau roundsSinceNew=0 need=3   ← ★ 它又开始干活了
//   ⇒ **到过 2，从未到 3** ⇒ `inspirer`（换视角）**从未触发**
//
// ══════════════════════════════════════════════════════════════════
// ★ 根因：不是判据坏了，是**定义错了**
// ══════════════════════════════════════════════════════════════════
//
//   ★ 旧定义：\"有没有动作\"（`work/` 或 `outbox` 动没动）
//     ⇒ 它**几乎一直在动**（跑实验、改分析脚本）
//     ⇒ \"连续 15 分钟什么都没动\"**几乎不可能**
//
//   ★★★ 更根本：旧定义**漏了一整类真实的卡住** ——
//     · 在跑同一实验的第 20 轮（原地打转）⇒ work/ 在动 ⇒ **判为健康**（错）
//     · 在反复改分析脚本（没结论）      ⇒ work/ 在动 ⇒ **判为健康**（错）
//     ★ 证据：它一晚跑了同一条线的 **8 个实验**
//       （cross-pilot/2/3/hard/k/grep/off-small/off-kdose）
//       —— **这在旧定义下永远不是卡住**。
//
// ══════════════════════════════════════════════════════════════════
// ★ 新定义：**进展** = 交了新成果 **或** 更新了 `CONVERGED.md`
//   ★ 两者都是**它自己写的、语义明确的\"我推进了\"信号**（不是我们替它判）
// ══════════════════════════════════════════════════════════════════

import { join } from "node:path";
import { writeFileSync, readdirSync, statSync } from "node:fs";
import { resetSandbox, SANDBOX_OUTBOX, SANDBOX_WORK } from "./harness.ts";
import { PLATEAU_ROUNDS } from "../topology/rules.ts";

type Arm = { shape: string; roundsSinceProgress: number; fired: boolean };

/**
 * ★ 用沙箱复刻新判据的**推进逻辑**（`rules.ts` 的 LAB 是模块常量，改不了）。
 * ★★ 判据本身（哪些信号算进展）与生产代码**逐字一致**。
 */
async function probe(shape: string, steps: { work: boolean; outbox: boolean; converged?: boolean }[]): Promise<Arm> {
  resetSandbox();
  let roundsSinceProgress = 0;
  let fired = false;
  let seenOutbox = 0;
  let lastConv = 0;

  for (const st of steps) {
    // ── 它\"在动\"（旧判据会看这个）──
    if (st.work) writeFileSync(join(SANDBOX_WORK, `w${Math.abs(roundsSinceProgress)}-${Math.random()}.ts`), "x");
    // ── 它\"有进展\"（新判据看这个）──
    if (st.outbox) writeFileSync(join(SANDBOX_OUTBOX, `p${Math.random()}.md`), "x");
    if (st.converged) writeFileSync(join(SANDBOX_OUTBOX, "CONVERGED.md"), `v${Math.random()}`);

    // ── 新判据（与生产逐字同源）──
    const outs = readdirSync(SANDBOX_OUTBOX).filter((f) => f.endsWith(".md")).length;
    const convM = (() => { try { return statSync(join(SANDBOX_OUTBOX, "CONVERGED.md")).mtimeMs; } catch { return 0; } })();
    const progress = outs > seenOutbox || convM > lastConv;
    if (progress) {
      roundsSinceProgress = 0;
      if (outs > seenOutbox) seenOutbox = outs;
      if (convM > lastConv) lastConv = convM;
    } else {
      roundsSinceProgress++;
    }
    if (roundsSinceProgress >= PLATEAU_ROUNDS) { fired = true; roundsSinceProgress = 0; }
    await new Promise((r) => setTimeout(r, 3));
  }
  return { shape, roundsSinceProgress, fired };
}

console.log("═══ 微实验 G · 平台期判据（进度 vs 动作）═══");
console.log(`阈值 PLATEAU_ROUNDS = ${PLATEAU_ROUNDS}\n`);

const arms: Arm[] = [];
// ① 真实形态：一直在动（跑实验/改脚本），但**没有新成果**
arms.push(await probe("原地打转（有动作无进展）", Array.from({ length: 6 }, () => ({ work: true, outbox: false }))));
// ② 真健康：每轮都有新成果
arms.push(await probe("健康推进（有成果）", Array.from({ length: 6 }, () => ({ work: true, outbox: true }))));
// ③ 真停滞：什么都不做
arms.push(await probe("真停滞（无动作无进展）", Array.from({ length: 6 }, () => ({ work: false, outbox: false }))));

console.log("形态                        触发换视角");
console.log("─".repeat(46));
for (const a of arms) console.log(`${a.shape.padEnd(28)}${a.fired ? "✓ 触发" : "✗ 没触发"}`);

console.log("\n═══ 判定 ═══");
const [spinning, healthy, stalled] = arms as [Arm, Arm, Arm];
console.log(`· ① \"原地打转\"该触发：${spinning.fired ? "✓ 对了" : "✗ 错"}  ← ★ 这就是旧判据漏掉的那一类`);
console.log(`· ② \"健康推进\"不该触发：${healthy.fired ? "✗ 错（打扰）" : "✓ 对了"}`);
console.log(`· ③ \"真停滞\"该触发：${stalled.fired ? "✓ 对了" : "✗ 错"}`);
console.log(
  spinning.fired && !healthy.fired && stalled.fired
    ? "\n★★★ 新判据能分开这三种形态 —— 而旧判据把①③和②混在一起"
    : "\n⚠ 有形态没分开",
);
