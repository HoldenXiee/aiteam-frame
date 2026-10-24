// ★★★★★ 自审的配额 —— 修我自己造成的洞（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// 实测（真实数据）：
//
//   最近 80 条提交 —— falsifier 35 · instrument-skeptic 18 · **hands-on 0**
//   最近 24h 产物 —— 54 份里 **34 份是自审**（62%）
//
// ★★★ 两处根因（都是我的）：
//   ① 我一直用 `--employees=2`，而 `ANGLES` 顺序是
//      [falsifier(先证伪), instrument-skeptic(先怀疑量具), hands-on(先动手做)]
//      ⇒ `slice(0,2)` **把唯一建设性的角度切掉了**。
//      ★ 所以我当时"集群变成审计员"的诊断是错的 —— **它只拿到了审计员**。
//   ② `onInstrumentReview` 没有配额 ⇒ 审装置 → 产出 → 活动 → 又能审装置（正反馈）
//
// ★ 判据（第二版）：**自审类产物不得占到一半以上**。
//
//   ★ 为什么不是第一版的「自审 < 研究结论」：
//     ① 「研究结论」我原来只数 `P<数字>` ⇒ **把 `面-denom` 这类真研究漏掉了**
//        （它是这一轮最有价值的产物，却不计数）⇒ 纪律㉞：口径太窄。
//     ② 拿两类相比会随"另一类攒了多少"漂移。
//   ★★ 占比量的正是那个病：**自审有没有吃掉一切**。
//
//   ★ 为什么上限是一半：三个角度里 `先怀疑量具` 占 **1/3**，
//     再留余量给"顺手发现装置缺陷" ⇒ 50% 宽裕。实测生病时 62%。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { auditQuota } from "../../research/clusters/hunt/topology/rules.ts";

describe("★★★★★ ① 占比判据：自审不许吃掉一半", () => {
  it("★★★★★ 实测生病形状：34/54 = 63% ⇒ 停", () => {
    const products = [
      ...Array.from({ length: 34 }, (_, i) => `手段VII-${i}.md`),
      ...Array.from({ length: 20 }, (_, i) => `P${100 + i}-研究.md`),
    ];
    const q = auditQuota(products);
    assert.equal(q.allowed, false, "★ 62% ⇒ 停");
    assert.equal(q.selfAudit, 34);
    assert.equal(q.total, 54);
    assert.ok(q.reason.includes("63%"), q.reason); // ★ 34/54 = 62.96% 四舍五入
  });

  it("★★★★ 正好一半 ⇒ 停（不是 > 才停）", () => {
    const q = auditQuota(["手段A.md", "手段B.md", "面-denom.md", "P1-甲.md"]);
    assert.equal(q.allowed, false, "★ 50% 已到顶");
  });

  it("★★★ 1/3（三角度正常比例）⇒ 放行", () => {
    const q = auditQuota(["手段A.md", "P1-甲.md", "面-denom.md"]);
    assert.equal(q.allowed, true, q.reason);
  });

  it("★★★★★ 我第一版的口径把 `面-denom` 漏掉了 —— 它必须被算作**非自审**", () => {
    // ★ 旧口径只数 P<数字> 当"研究" ⇒ 3 份产物里 1 手段 / 1 P / 1 面
    //   旧：研究=1，自审=1 ⇒ 拦住（错，实际只占 1/3）
    const q = auditQuota(["手段A.md", "P1-甲.md", "面-denom-比率分母审计.md"]);
    assert.equal(q.allowed, true, "★ 面 是真研究，不该被当成「没有研究」");
  });

  it("★★ 空 ⇒ 不许（先干活）", () => {
    const q = auditQuota([]);
    assert.equal(q.allowed, false);
    assert.ok(q.reason.includes("没有产物") || q.reason.includes("先干活"), q.reason);
  });
});

describe("★★★★★ ② 分类：哪三类算「自审」", () => {
  it("★★★ INSPIR* / 手段* / 装置缺陷*", () => {
    const q = auditQuota([
      "INSPIR-7-x.md",
      "手段V-y.md",
      "装置缺陷-write工具不可用.md",
      "P1-甲.md",
      "面-denom.md",
      "回应-falsifier.md",
    ]);
    assert.equal(q.selfAudit, 3, "★ 三类自审都算");
    assert.equal(q.total, 6);
    assert.equal(q.allowed, false, "★ 3/6 = 50% 到顶");
  });

  it("★★ 研究/回应/面 都不算自审", () => {
    const q = auditQuota(["P70-a.md", "面-denom.md", "回应-falsifier.md", "方法-甲.md", "手段X.md"]);
    assert.equal(q.selfAudit, 1);
    assert.equal(q.total, 5);
    assert.equal(q.allowed, true);
  });
});

describe("★★★★★ ③ 「最近」窗口 —— 为什么必须按最近算", () => {
  it("★★★★★ 累计口径永远反不过来", () => {
    // ★ 累计：自审少、研究多（老账）⇒ 永远"还有余量"，看不见最近偏了
    const all = [
      ...Array.from({ length: 34 }, (_, i) => `手段-${i}.md`),
      ...Array.from({ length: 100 }, (_, i) => `P${i}-老研究.md`),
    ];
    assert.equal(auditQuota(all).allowed, true, "★ 累计说还有余量（看不见最近偏了）");

    const recentSet = new Set(all.slice(0, 34).concat(all.slice(100, 120)));
    assert.equal(
      auditQuota(all, (f) => recentSet.has(f)).allowed,
      false,
      "★★ 按最近算才看得出 34/54 偏了",
    );
  });

  it("★★★ isRecent 过滤真的生效", () => {
    const q = auditQuota(["手段A.md", "手段B.md", "P1-甲.md"], (f) => f.startsWith("P"));
    assert.equal(q.selfAudit, 0);
    assert.equal(q.total, 1);
    assert.equal(q.allowed, true);
  });
});
