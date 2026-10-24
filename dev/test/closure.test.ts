// ★★★★★ 缺陷结账 —— 为什么 hunt 的自审停不下来（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// 真读数（实测 `outbox/CONVERGED.md`，53 条 O 行）
//
//     ⚠ 新增（只登记，无处置）  23  (43%)
//     未做/未修              22  (41%)
//     ★ 可核已结                1  (2%)
//     已声明但核不了             5  (9%)
//
//   ⇒ **53 开 / 1 关** —— 一个**开环系统**。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★★ 这解释了我的修法为什么失败
//
//   最近 24h：57 份产物里 36 份自审、**P* 研究结论 0 份**。
//
//   ★ 我的诊断：「`onInstrumentReview` 正反馈」—— 只对一半。
//   ★★ 我的修法：「自审占比 ≥ 50% 就停规则」—— **治错了地方**。
//      实测：规则停了，产出仍 63% 自审。
//   ★★★ 真因：**每审一条开 2–3 条、关 0–1 条** ⇒ 停"开工"没用，
//      **存量本身就是工作来源**（45+ 条未结缺陷摆在那儿）。
//
//   ⇒ 正确判据是「**未结账存量**」（WIP），不是「产出占比」。
//     与 Kanban 同源：开工上限管不住，存量上限才管得住。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  canOpenNewAudit,
  classifyDisposition,
  closure,
  extractCites,
  renderClosure,
} from "../../research/clusters/hunt/topology/closure.ts";

const row = (id: number, disposition: string) => `| O${id} | 某个缺陷 | \`someone\` | ${disposition} |`;

describe("★★★★★ ① 处置分类（只看形式，不看理由）", () => {
  it("★★★★ 只登记（`⚠ 新增`）⇒ unsaid（实测 23 条都是这个）", () => {
    assert.equal(classifyDisposition("⚠ **新增（登记他人挑战，非我的判决）**"), "unsaid");
    assert.equal(classifyDisposition("⚠ **新增**"), "unsaid");
  });

  it("★★★★ `未做` ⇒ open", () => {
    assert.equal(classifyDisposition("**未做**"), "open");
    assert.equal(classifyDisposition("未修，等下轮"), "open");
  });

  it("★★★★ `已修` ⇒ closed", () => {
    assert.equal(classifyDisposition("已修（见 `work/runs/x.txt`）"), "closed");
  });

  it("★★★★★ 说清「这是边界不是缺陷」也算结账（★ 拦的同时给路 —— 纪律⑳）", () => {
    assert.equal(classifyDisposition("**BACKUP 类不可通用，降级为声明式**"), "boundary");
    assert.equal(classifyDisposition("这不是缺陷，是装置的边界"), "boundary");
  });

  it("★★★ 说清「修不了 / 卡在哪」也算结账", () => {
    assert.equal(classifyDisposition("修不了：依赖外部 provider 报账"), "blocked");
  });

  it("★★ 空 / 没写 ⇒ unsaid", () => {
    assert.equal(classifyDisposition(""), "unsaid");
    assert.equal(classifyDisposition("   "), "unsaid");
  });
});

describe("★★★★★ ② 抽证据路径（★ 我第一版这里错了两次）", () => {
  it("★★★★★ `P92/P67/P95b` 是**列举产物**，不是路径 —— 不许当成证据", () => {
    // ★ 第一版认"含斜杠" ⇒ 把顿号当路径 ⇒ 报出 5 条假结账（冤枉了它）
    assert.deepEqual(extractCites("`P92/P67/P95b/P96` 早前已补"), []);
  });

  it("★★★★★ 真路径要认出来", () => {
    assert.ok(extractCites("见 `work/runs/denom-ut.txt`").includes("work/runs/denom-ut.txt"));
    assert.ok(extractCites("改了 `lib/aiteam/runlog.ts`").includes("lib/aiteam/runlog.ts"));
  });

  it("★★ 只给文件名（无目录）也认", () => {
    assert.ok(extractCites("依据 `CONVERGED.md`").includes("CONVERGED.md"));
  });
});

describe("★★★★★ ③ 三分类：可核已结 / 声明但核不了 / 未结（纪律㉜）", () => {
  const exists = (p: string) => p === "work/runs/ok.txt";

  it("★★★★★ 说「修了」且路径在盘上 ⇒ 可核已结", () => {
    const c = closure([row(1, "已修，见 `work/runs/ok.txt`")].join("\n"), exists);
    assert.equal(c.closed, 1);
    assert.equal(c.open, 0);
  });

  it("★★★★★ 说「修了」但路径不在 ⇒ **不是已结，也不是「假」**，是「我核不了」", () => {
    const c = closure([row(2, "已修，见 `work/runs/nope.txt`")].join("\n"), exists);
    assert.equal(c.closed, 0, "★ 不能算已结（我核不了）");
    assert.deepEqual(c.unverifiable, ["O2"]);
    assert.equal(c.open, 0, "★ 但也不该算未结 —— 它毕竟说了修了");
  });

  it("★★★★ 说自己「修了」却**一条证据都不引** ⇒ 也算核不了（不冤枉成「假」）", () => {
    const c = closure([row(3, "已修")].join("\n"), exists);
    assert.deepEqual(c.unverifiable, ["O3"]);
  });

  it("★★★★ 边界 / 修不了 ⇒ 算已结（纪律⑳ 给路）", () => {
    const c = closure([row(4, "这是装置的边界，不修"), row(5, "修不了：卡在外部依赖")].join("\n"), exists);
    assert.equal(c.closed, 2);
  });

  it("★★★ 实测形状：1 可核 + 5 核不了 + 47 未结", () => {
    const lines = [
      row(1, "这是边界"),
      ...Array.from({ length: 5 }, (_, i) => row(10 + i, `已修，见 \`outbox/P${i}.md\``)),
      ...Array.from({ length: 21 }, (_, i) => row(20 + i, "**未做**")),
      ...Array.from({ length: 26 }, (_, i) => row(50 + i, "⚠ **新增**")),
    ];
    const c = closure(lines.join("\n"), exists);
    assert.equal(c.total, 53);
    assert.equal(c.closed, 1);
    assert.equal(c.unverifiable.length, 5);
    assert.equal(c.open, 47);
    assert.equal(Math.round(c.rate * 100), 2);
  });
});

describe("★★★★★ ④ WIP 上限（替代「产出占比」配额）", () => {
  it("★★★★★ 实测：未结 47 > 上限 ⇒ 不许开新的", () => {
    const r = canOpenNewAudit(47);
    assert.equal(r.allowed, false);
    assert.ok(r.reason.includes("先把存量关掉"), r.reason);
  });

  it("★★★★ 未结少于上限 ⇒ 可以开", () => {
    assert.equal(canOpenNewAudit(3).allowed, true);
  });

  it("★★★★★ 为什么这个判据比「占比」强：它**有明确分母**（已登记的行）", () => {
    // ★ "自审占 63%" 喂不进它的决策（它不知道"该占多少"）
    // ★ "你还欠 47 条没结账" 是具体数字，能直接变成任务
    const r = canOpenNewAudit(47, 8);
    assert.ok(/47/.test(r.reason), "★ 原因里必须带具体数字");
  });
});

describe("★★★ ⑤ 渲染：核不了的不许写成「假的」", () => {
  it("★★★★ 措辞必须是「我核不了」，不许是「假结账」", () => {
    const c = closure([row(1, "已修，见 `outbox/x.md`")].join("\n"), () => false);
    const s = renderClosure(c);
    assert.ok(s.includes("核不了"), s);
    // ★ 只禁「假结账」这个判决；「不判真假」这种免责说明是**必须留的**
    assert.ok(!s.includes("假结账"), `★ 不许下「假结账」这种判决：${s}`);
  });

  it("★★ 没有 O 行 ⇒ 明确说没有", () => {
    assert.ok(renderClosure(closure("", () => true)).includes("没有 O 行"));
  });
});
