// ★★★ 平台期判据 v4（2026-10-20）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么改（实测，forge 63 份产物的一轮）
//
//   ```
//   onPlateau outbox=63 新文件=373 产出=false 在干活=true roundsSinceProgress=0/3
//   onPlateau outbox=63 新文件=211 产出=false 在干活=true roundsSinceProgress=0/3
//   ```
//   ★★★ **`work/` 里新出 373 / 211 个文件，而 outbox 一份没出**，
//     判据说"健康" ⇒ 计数**永远清零** ⇒ 整轮只到过 1/3 ⇒ **从未触发**。
//
//   ★ 后果：集群在 `work/` 里忙 5 小时，**书一份没增加**，
//     而"换视角 + 重审目标"一次没响。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★ 前三次为什么都没对（记下来，别走第四遍）
//
//   v1 判据「有没有动作」        ⇒ 跑同一条线的第 20 轮 = "健康的动"（错）
//   v2 判据「只看产出」          ⇒ 跑实验时被判卡住（研究员自己抓到的，错）
//   v3 判据「产出 or 在干活」    ⇒ ★★★ 在 `work/` 里无限写实验也算健康（这一版要治的）
//
//   ★ v4：**`busy` 只延缓，不清零**。
//     · 有产出           ⇒ 清零
//     · 没产出但在干活   ⇒ 递增，但每 2 轮才 +1（延缓一倍）
//     · 没产出也不在干活 ⇒ 正常递增
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

/** ★ 与 `rules.ts` 的 onPlateau 同源（v4） */
export function plateauStep(
  st: { roundsSinceProgress: number; busyStreak: number },
  produced: boolean,
  busy: boolean,
): { roundsSinceProgress: number; busyStreak: number } {
  if (produced) return { roundsSinceProgress: 0, busyStreak: 0 };
  if (busy) {
    const s = st.busyStreak + 1;
    return { roundsSinceProgress: st.roundsSinceProgress + (s % 2 === 0 ? 1 : 0), busyStreak: s };
  }
  return { roundsSinceProgress: st.roundsSinceProgress + 1, busyStreak: 0 };
}

describe("★★★ 平台期判据 v4", () => {
  it("★★★ 有产出 ⇒ 清零（真进展）", () => {
    const r = plateauStep({ roundsSinceProgress: 2, busyStreak: 3 }, true, true);
    assert.equal(r.roundsSinceProgress, 0);
    assert.equal(r.busyStreak, 0);
  });

  it("★★★ 实测的病：work/ 一直在忙、outbox 不动 ⇒ **最终必须被判成平台期**", () => {
    // 复刻实测：8 轮都是 产出=false 在干活=true
    let st = { roundsSinceProgress: 0, busyStreak: 0 };
    for (let i = 0; i < 8; i++) st = plateauStep(st, false, true);
    assert.ok(
      st.roundsSinceProgress >= 3,
      `8 轮「在忙但没产出」应该判到平台期（≥3），实际 ${st.roundsSinceProgress} —— v3 的病还在`,
    );
  });

  it("★★★ v2 的病不能回来：偶尔跑一轮大实验后马上交产出 ⇒ 不算卡住", () => {
    let st = { roundsSinceProgress: 0, busyStreak: 0 };
    // 连续 3 轮在忙（跑实验）
    for (let i = 0; i < 3; i++) st = plateauStep(st, false, true);
    // 然后交了产出
    st = plateauStep(st, true, true);
    assert.equal(st.roundsSinceProgress, 0, "跑完实验交产出还被判卡住 —— v2 的病回来了");
  });

  it("★★ 在忙时确实被延缓（比纯空转慢一倍）", () => {
    let a = { roundsSinceProgress: 0, busyStreak: 0 };
    let b = { roundsSinceProgress: 0, busyStreak: 0 };
    for (let i = 0; i < 4; i++) {
      a = plateauStep(a, false, true); // 在忙
      b = plateauStep(b, false, false); // 空转
    }
    assert.equal(a.roundsSinceProgress, 2, "在忙应该是 2（每 2 轮 +1）");
    assert.equal(b.roundsSinceProgress, 4, "空转应该是 4（每轮 +1）");
  });

  it("★ 空转照旧每轮 +1（v1 那部分没被破坏）", () => {
    let st = { roundsSinceProgress: 0, busyStreak: 0 };
    for (let i = 0; i < 3; i++) st = plateauStep(st, false, false);
    assert.equal(st.roundsSinceProgress, 3);
  });

  it("★★ busyStreak 在产出后归零（不会跨段累积）", () => {
    let st = { roundsSinceProgress: 1, busyStreak: 5 };
    st = plateauStep(st, true, false);
    assert.equal(st.busyStreak, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★★★ v5：产出 = 文件集合变了 **或** 内容变了（2026-10-20）
//
//   实测：一轮里 `git diff --stat` 是 **15 files changed, +592/-195**，
//   而判据说 `产出=false`（份数只从 64 变 65）⇒ 平台期被误判。
//
//   ★ 这和 v3 的病是**同一类错误的两个方向**：
//     v3 把 `work/` 的动静当进展（太松）
//     v4 把「改已有产物」当没进展（太严）
// ══════════════════════════════════════════════════════════════════════════

/** ★ 与 rules.ts 的 produced 判据同源（v5） */
export function isProduced(
  prev: { count: number; hash: string | undefined },
  now: { count: number; hash: string },
  convChanged = false,
): boolean {
  const contentChanged = prev.hash !== undefined && prev.hash !== now.hash;
  return now.count > prev.count || contentChanged || convChanged;
}

describe("★★★ 产出判据 v5：改内容也算产出", () => {
  it("★★★ 实测的病：份数没变但内容改了 ⇒ **必须算产出**", () => {
    const prev = { count: 64, hash: "a.md:1000:1|b.md:2000:1" };
    const now = { count: 64, hash: "a.md:1200:2|b.md:2000:1" }; // a.md 改了
    assert.equal(isProduced(prev, now), true, "改了 15 份却判没产出 —— v5 没生效");
  });

  it("★★ 份数变多 ⇒ 算产出（v1~v4 的老行为不能丢）", () => {
    assert.equal(isProduced({ count: 64, hash: "x" }, { count: 65, hash: "x" }), true);
  });

  it("★★ CONVERGED.md 更新 ⇒ 算产出", () => {
    assert.equal(isProduced({ count: 64, hash: "x" }, { count: 64, hash: "x" }, true), true);
  });

  it("★★★ 什么都没变 ⇒ 不算产出（否则平台期永远不触发）", () => {
    assert.equal(isProduced({ count: 64, hash: "x" }, { count: 64, hash: "x" }), false);
  });

  it("★ 首次（hash 未定）⇒ 不当成内容变化（否则第一 tick 误报）", () => {
    assert.equal(
      isProduced({ count: 64, hash: undefined }, { count: 64, hash: "x" }),
      false,
      "首次运行就误报产出",
    );
  });
});
