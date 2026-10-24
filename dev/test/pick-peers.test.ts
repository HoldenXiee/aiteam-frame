// ★★★★★ 辩证该送给哪几位 —— 轮转，不是永远取前几位（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 这是同一类 bug 的**第二次**
//
//   ① `pickAnglesN`：`ANGLES.slice(0, employees)` ⇒ 切掉 `hands-on`
//   ② 这里：`peers.slice(0, 2)` ⇒ **`hands-on` 永远收不到挑战**
//
//   两次都是「**集合按序截断，而排在最后的那个最不能少**」。
//
// ★★ 实测（runner.ts 里早有一条注释，但当时归因错了）：
//    「`hands-on` 整个窗口只收到 **5 次**挑战，另两位 **24/25** 次」
//    —— 我当时归因成"它几乎从不空闲 ⇒ 挑战被排在它自己的输出后面"，
//      还据此把 `queue` 改成了 `steer`（这个改动本身是对的，但**没有治到病**）。
//    ★★★ 真因更简单：**它根本不在收件名单里**。
// ══════════════════════════════════════════════════════════════════════════
//
// ★ 判据（纯函数，可离线重判 —— 纪律⑦）：
//   每次从 `offset` 开始取连续 n 位，`offset` 每次 +n ⇒ **每个人都会被轮到**。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { pickPeers } from "../../research/clusters/hunt/topology/rules.ts";

const P = ["falsifier", "instrument-skeptic", "hands-on"];

describe("★★★★★ ① 每个人都必须轮到", () => {
  it("★★★★★ 三轮之后 hands-on 一定出现过（这是事故的反面）", () => {
    const got = new Set<string>();
    for (let i = 0; i < 3; i++) for (const k of pickPeers(P, 2, i * 2)) got.add(k);
    assert.equal(got.has("hands-on"), true, `★ 三轮必轮到：${[...got]}`);
  });

  it("★★★★★ 老写法 `slice(0,2)` 三次都只有那两位 —— 事故本身", () => {
    const got = new Set<string>();
    for (let i = 0; i < 3; i++) for (const k of P.slice(0, 2)) got.add(k);
    assert.equal(got.has("hands-on"), false, "★ 老写法永远轮不到第三位");
    // 新写法能轮到
    assert.equal(pickPeers(P, 2, 2).includes("hands-on"), true);
  });

  it("★★★ offset 环绕（不越界、不漏）", () => {
    assert.deepEqual(pickPeers(P, 2, 0), ["falsifier", "instrument-skeptic"]);
    assert.deepEqual(pickPeers(P, 2, 2), ["hands-on", "falsifier"]);
    assert.deepEqual(pickPeers(P, 2, 4), ["instrument-skeptic", "hands-on"]);
    assert.deepEqual(pickPeers(P, 2, 6), ["falsifier", "instrument-skeptic"], "★ 6 回到 0");
  });

  it("★★★★ 大 offset 也不炸（负数也能回绕）", () => {
    // ★ 100 % 3 = 1 ⇒ instrument-skeptic（我第一版写成 falsifier，是算错了）
    assert.deepEqual(pickPeers(P, 1, 100), ["instrument-skeptic"]);
    assert.deepEqual(pickPeers(P, 1, 99), ["falsifier"], "★ 99 是 3 的倍数");
    assert.deepEqual(pickPeers(P, 1, -1), ["hands-on"], "★ 负数回绕到末位");
  });
});

describe("★★★★ ② 边界", () => {
  it("★★ n 比人数多 ⇒ 只给全员（不重复）", () => {
    assert.deepEqual(pickPeers(P, 5, 0), ["falsifier", "instrument-skeptic", "hands-on"]);
  });

  it("★★ n = 0 或负 ⇒ 空", () => {
    assert.deepEqual(pickPeers(P, 0, 0), []);
    assert.deepEqual(pickPeers(P, -2, 0), []);
  });

  it("★★ 没同事 ⇒ 空（单角度跑）", () => {
    assert.deepEqual(pickPeers([], 2, 0), []);
  });

  it("★★ 只有一位 ⇒ 永远是他（不炸）", () => {
    assert.deepEqual(pickPeers(["solo"], 2, 7), ["solo"]);
  });
});

describe("★★★★★ ③ 覆盖性：n=2 时每 3 次全轮到", () => {
  it("★★★★★ 一位不漏，且每人都至少被轮到一次", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      for (const k of pickPeers(P, 2, i * 2)) counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const k of P) assert.ok((counts[k] ?? 0) > 0, `★ ${k} 必须被轮到：${JSON.stringify(counts)}`);
  });
});
