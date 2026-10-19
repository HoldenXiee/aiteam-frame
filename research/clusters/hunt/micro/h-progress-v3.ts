// ★★★ 微实验 H · 平台期判据 v3（第三次定义）
//
// ══════════════════════════════════════════════════════════════════
// ★ 三次定义，两次被实测推翻（完整历史）
// ══════════════════════════════════════════════════════════════════
//
// 【v1】"有没有动作"（`work/` 有 mtime 变化 或 outbox 变多）
//   ✗ 实测：`roundsSinceNew` 到过 2 **从未到 3** ⇒ `inspirer` 从不触发
//     （它几乎一直在动 ⇒ "连续 15 分钟什么都不动"几乎不可能）
//
// 【v2】"有没有进展"（outbox 变多 或 CONVERGED 更新）
//   ✗ ★★ **研究员自己抓到**：`outbox/装置缺陷-平台期判据只数outbox不数work造成假阳性.md`
//     在**它最忙的时候**误判"原地打转"，连发专家
//     反证：触发窗口内 `work/runs/line-input.jsonl` 在逐轮追加、
//     `exp-line-input/*/corpus/` 批量落盘（新建文件数以千计）
//     ★ 它的归因：「**这里「活动信号」也从 outbox 逃出观测**」（与 O6/O8 同族）
//
// 【v3】产出 **或** 体量（`work/` 里这段时间新出的**文件数**）
//   ★ 用**体量**区分"健康的动"与"原地打转的动"：
//     跑实验 → 大批量（几十上百个文件）；原地打转 → 零星几个
//
// ══════════════════════════════════════════════════════════════════
// ★ 本实验要把**三种真实形态**分开（前两版各只能分开两种）
// ══════════════════════════════════════════════════════════════════

import { join } from "node:path";
import { writeFileSync, readdirSync } from "node:fs";
import { resetSandbox, SANDBOX_OUTBOX, SANDBOX_WORK } from "./harness.ts";
import { FRESH_FILES_THRESHOLD, PLATEAU_ROUNDS } from "../topology/rules.ts";
import { countFreshFiles } from "../topology/progress.ts";

type Arm = { shape: string; fired: boolean; lastFresh: number };

/** ★ 复刻 v3 判据（`rules.ts` 的 LAB 是模块常量，改不了；判据逻辑逐字同源） */
async function probe(
  shape: string,
  rounds: { freshFiles: number; newOutbox: boolean }[],
): Promise<Arm> {
  resetSandbox();
  let roundsSinceProgress = 0;
  let fired = false;
  let lastFresh = 0;
  let seenOutbox = 0;
  let lastConv = 0;

  for (const r of rounds) {
    // ① 产出信号
    if (r.newOutbox) writeFileSync(join(SANDBOX_OUTBOX, `p${Math.random()}.md`), "x");
    // ② 体量信号：写 N 个新文件（模拟跑实验 / 改脚本）
    for (let i = 0; i < r.freshFiles; i++) {
      writeFileSync(join(SANDBOX_WORK, `w-${Math.random()}-${i}.dat`), "x");
    }
    await new Promise((res) => setTimeout(res, 3));

    const since = Date.now() - 60; // ★ 这一"窗口"
    const fresh = countFreshFiles(SANDBOX_WORK, since);
    lastFresh = fresh;
    const outs = countOutbox();
    const convM = 0;
    const produced = outs > seenOutbox || convM > lastConv;
    const busy = fresh >= FRESH_FILES_THRESHOLD;
    const progressed = produced || busy;
    if (produced && outs > seenOutbox) seenOutbox = outs;
    if (progressed) roundsSinceProgress = 0;
    else roundsSinceProgress++;
    if (roundsSinceProgress >= PLATEAU_ROUNDS) { fired = true; roundsSinceProgress = 0; }
  }
  return { shape, fired, lastFresh };
}

function countOutbox(): number {
  return readdirSync(SANDBOX_OUTBOX).filter((f) => f.endsWith(".md")).length;
}

console.log("═══ 微实验 H · 平台期判据 v3 ═══");
console.log(`阈值：PLATEAU_ROUNDS=${PLATEAU_ROUNDS} · FRESH_FILES_THRESHOLD=${FRESH_FILES_THRESHOLD}\n`);

const arms: Arm[] = [];
// ★ 形态①：跑实验（大批量文件、暂时没交成果）⇒ **不该**触发（v2 的病）
arms.push(await probe("跑实验（大批量无成果）", Array.from({ length: 6 }, () => ({ freshFiles: 50, newOutbox: false }))));
// ★ 形态②：原地打转（零星几个文件、无成果）⇒ **该**触发（v1 的病）
arms.push(await probe("原地打转（零星无成果）", Array.from({ length: 6 }, () => ({ freshFiles: 2, newOutbox: false }))));
// ★ 形态③：健康推进（有成果）⇒ **不该**触发
arms.push(await probe("健康推进（有成果）", Array.from({ length: 6 }, () => ({ freshFiles: 3, newOutbox: true }))));
// ★ 形态④：真停滞（什么都不做）⇒ **该**触发
arms.push(await probe("真停滞（无动作无成果）", Array.from({ length: 6 }, () => ({ freshFiles: 0, newOutbox: false }))));

const want = [false, true, false, true];
console.log("形态                        期望    实际      判定");
console.log("─".repeat(62));
arms.forEach((a, i) => {
  const ok = a.fired === want[i];
  console.log(
    `${a.shape.padEnd(28)}${(want[i] ? "触发" : "不触发").padEnd(8)}${(a.fired ? "触发" : "不触发").padEnd(10)}${ok ? "✓" : "✗"}`,
  );
});

console.log("\n═══ 判定 ═══");
const allOk = arms.every((a, i) => a.fired === want[i]);
console.log(allOk ? "★★★ 四种形态全部分开（v1 只能分②④，v2 只能分①③）" : "⚠ 有形态没分开");
console.log("★ 形态①是 v2 的病（跑实验被判卡住），形态②是 v1 的病（原地打转被判健康）");
