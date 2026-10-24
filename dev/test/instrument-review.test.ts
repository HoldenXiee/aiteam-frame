// ★★★★★ 第 5 条规则：回头看**自己用的手段**（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者原话（这条规则的唯一来源）：
//
//   「按照道理来说，hunt 集群**应该可以自己发现**没用 skill，或重审目标，获取灵感时，
//     **应该能发现比 skill 更适合 agent 集群的东西**。
//     因为 hunt 集群**本身就是探索**，而且还有**修改底层库的权限**，
//     但是**为什么运行这么多次 hunt 后，非要到我提醒，才做这件事**」
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 我查到的根因（不是"它懒"，是**结构上没人问过它**）
//
//   hunt 原来的 4 条规则分别治：
//     onSettled        新产物要审
//     onCapabilityGap  能力缺口要报
//     onPlateau        平台期要换路
//     onNewFinding     产物要辩
//
//   ★★★ **没有一条问「你手上反复用的那件东西，还好用吗」。**
//
//   ★ 它每次都在**用**手段（跑实验、写脚本、改库），
//     但**从来没有一个时刻**被要求**退一步看这些手段本身**。
//
//   ★★ 而且项目里早写下过这条结论（`missions.ts` 引用的 `C7`）：
//      「**它判不了自己的盲区**」
//      ⇒ 那条结论只被用来**分工**，**没被变成一条规则**。
//      ★★★ 这正是 AGENTS.md §二说的病：**结论写了，但没接上**。
//
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { COOLDOWN_MS, REVIEW_EVERY_MS } from "../../research/clusters/hunt/topology/rules.ts";

describe("★★★★★ ① 规则存在，而且阈值合理", () => {
  it("★★★ REVIEW_EVERY_MS 必须存在（它是这条规则的判据）", () => {
    assert.equal(typeof REVIEW_EVERY_MS, "number");
    assert.ok(REVIEW_EVERY_MS > 0);
  });

  it("★★★★ 一轮（60~120 分钟）里最多问一次 —— 太长就等于没有", () => {
    // ★ 下界：不能短到把长跑专家的成本翻倍
    assert.ok(REVIEW_EVERY_MS >= 60 * 60_000, `太短（${REVIEW_EVERY_MS / 60000} 分钟）会把成本翻倍`);
    // ★★ 上界：不能长到一轮都不问
    assert.ok(REVIEW_EVERY_MS <= 120 * 60_000, `太长（${REVIEW_EVERY_MS / 60000} 分钟）一轮都不会问`);
  });

  it("★★ 冷却必须比审视间隔短（否则永远轮不到）", () => {
    assert.ok(COOLDOWN_MS < REVIEW_EVERY_MS, "冷却 ≥ 间隔 ⇒ 这条规则永远不会真的触发");
  });
});

describe("★★★★★ ② 该触发时触发（判据可离线重判）", () => {
  /** ★ 复刻规则里的三个条件（★ 纯函数，纪律⑦） */
  function shouldFire(s: {
    now: number;
    lastReview: number;
    lastActive: number;
    lastInspirer: number;
  }): { fire: boolean; why: string } {
    const elapsed = s.now - s.lastReview;
    if (elapsed < REVIEW_EVERY_MS) return { fire: false, why: "周期没到" };
    if (s.lastActive === 0 || s.now - s.lastActive > REVIEW_EVERY_MS)
      return { fire: false, why: "这段时间没干活（该问的是 onPlateau）" };
    if (s.now - s.lastInspirer < COOLDOWN_MS) return { fire: false, why: "冷却" };
    return { fire: true, why: "到期且在干活" };
  }

  const H = 60 * 60_000;

  it("★★★★★ 从来没过审 + 一直在干活 ⇒ **必须触发**", () => {
    const r = shouldFire({ now: 100 * H, lastReview: 0, lastActive: 99 * H, lastInspirer: 0 });
    assert.equal(r.fire, true, `实际情况：${r.why}`);
  });

  it("★★ 刚审过 ⇒ 不触发", () => {
    const r = shouldFire({ now: 100 * H, lastReview: 100 * H - 10 * 60_000, lastActive: 99 * H, lastInspirer: 0 });
    assert.equal(r.fire, false);
  });

  it("★★★★ **这段时间没干活 ⇒ 不触发**（那时该问的该不该退休，不是手段好不好）", () => {
    const r = shouldFire({ now: 100 * H, lastReview: 0, lastActive: 50 * H, lastInspirer: 0 });
    assert.equal(r.fire, false);
    assert.ok(r.why.includes("没干活"));
  });

  it("★★ 冷却期内 ⇒ 不触发（避免和 inspirer 同时起两个长跑专家）", () => {
    const r = shouldFire({ now: 100 * H, lastReview: 0, lastActive: 99 * H, lastInspirer: 100 * H - 60_000 });
    assert.equal(r.fire, false);
    assert.equal(r.why, "冷却");
  });

  it("★★★★ 上界：一轮 120 分钟里至少能问一次", () => {
    // 从第 0 分钟开跑，一直干活
    let fired = 0;
    for (let m = 0; m <= 120; m += 5) {
      const r = shouldFire({ now: m * 60_000, lastReview: fired > 0 ? 0 : 0, lastActive: m * 60_000 + 1, lastInspirer: 0 });
      if (r.fire) fired++;
    }
    assert.ok(fired >= 1, "一轮 120 分钟里一次都不问 —— 这规则等于没有");
  });
});
