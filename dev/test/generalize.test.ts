// ★★★★★ 第 6 条规则：提炼（把「观察」推一步到「接口」）
//
// ══════════════════════════════════════════════════════════════════════════
// 这条规则要治的病（实测，2026-10-21）
//
//   hunt 有 **58 份 P\*（研究结论）**，其中至少 5 份是**治理机制级**的：
//
//     P70 同一条错规则：执行时 0/24 反对，被要求「审这条规则」时 12/12 逮住
//     P63 池子自己长出的技能：白名单挡得住广告，挡不住读取
//     P72 共享材料池：广告面建 agent 时冻结，能力面当场 live
//     P69 错了但明确的核验规则会被忠实执行 —— 勤奋不保护
//     P98 先果后因 pilot：goal-only 与给规则等价
//
//   ★★★ 而 58 份里只有 **5 份（8%）**提到过「别人能不能用」。
//
// ★★★★ 这就是它造不出 MCP / skill 那一级创新的原因 —— 不是没有原料，
//   是**缺"把观察变成接口"这一步**。
//   MCP 与 skill 都不是发现，是**把「每个 agent 都在手工重做的同一件事」提成了一个面**。
//
//   ★ 而本项目里那些面（enforce/correct/grant/write_skill）**是上级造的**，
//     不是它提炼的 ⇒ 流水线断在中间：**它观察 → 上级抽象 → 上级发**。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { generalizeDue } from "../../research/clusters/hunt/topology/rules.ts";

describe("★★★★★ ① 节拍判据（不判内容，只看攒了几份）", () => {
  it("★★★★ 攒够 3 份 ⇒ 该提炼", () => {
    const g = generalizeDue(["P1-a.md", "P2-b.md", "P3-c.md"], 0);
    assert.equal(g.due, true, g.reason);
    assert.equal(g.fresh, 3);
  });

  it("★★★ 只攒了 2 份 ⇒ 再等等（不然每份都要问一遍，成本爆炸）", () => {
    const g = generalizeDue(["P1-a.md", "P2-b.md"], 0);
    assert.equal(g.due, false);
    assert.ok(g.reason.includes("再攒攒"), g.reason);
  });

  it("★★★★★ 关键是「新增」不是「总数」：已提炼过 55 份 ⇒ 新的 3 份到点", () => {
    const all = Array.from({ length: 58 }, (_, i) => `P${i}-x.md`);
    assert.equal(generalizeDue(all, 55).due, true, "★ 新增 3 = 节拍");
    assert.equal(generalizeDue(all, 56).due, false, "★ 新增 2 < 节拍");
    assert.equal(generalizeDue(all, 58).due, false, "★ 没有新增");
  });

  it("★★ 从没提炼过（since=0）⇒ 攒够就触发", () => {
    const g = generalizeDue(["P1-a.md", "P2-b.md", "P3-c.md"], 0);
    assert.equal(g.fresh, 3);
  });
});

describe("★★★★ ② 分母只数研究结论（P<数字>）", () => {
  it("★★★ 自审类不算「进账」（否则审得越多越该提炼，方向反了）", () => {
    const products = ["手段A.md", "手段B.md", "INSPIR-1.md", "手段C.md"];
    assert.equal(generalizeDue(products, 0).due, false, "★ 只审装置不产出研究 ⇒ 不该触发提炼");
    assert.equal(generalizeDue(products, 0).research, 0);
  });

  it("★★ 别的类型也不算", () => {
    const g = generalizeDue(["对账-甲.md", "装置缺陷-乙.md", "P9-丙.md"], 0);
    assert.equal(g.research, 1);
    assert.equal(g.due, false);
  });
});

describe("★★★★ ③ 读数要能解释（纪律㉔）", () => {
  it("★★ 两种结论都要说清「新增几份 / 节拍几份」", () => {
    const no = generalizeDue(["P1-a.md"], 0);
    assert.ok(/新增研究结论 1 份/.test(no.reason), no.reason);
    const yes = generalizeDue(["P1-a.md", "P2-b.md", "P3-c.md"], 0);
    assert.ok(/新增研究结论 3 份/.test(yes.reason), yes.reason);
  });
});
