// ★★★★★ 起哪几个角度 —— 按角色选，不按序号（2026-10-21 事故的修法）
//
// ══════════════════════════════════════════════════════════════════════════
// 事故（真实数据）
//
//   `ANGLES` 的顺序是：
//     ① falsifier           先证伪
//     ② instrument-skeptic  先怀疑量具
//     ③ hands-on            先动手做     ← ★★★ 唯一建设性的
//
//   而代码是 `ANGLES.slice(0, employees)` ⇒ **任何截断都先切掉 ③**。
//
//   ★★ 实测：最近 80 条提交 = falsifier 35 · instrument-skeptic 18 · **hands-on 0**
//   ★★★ 而我当时把这个现象诊断成「集群变成了审计员」——
//      它只是**只拿到了审计员**。两个角度都是对抗性的：
//      一个在证伪，一个在怀疑量具，**没有一个在往前推进新东西**。
//
//   ★★★★ 改回 3 个角度跑**一轮**，它就产出了
//     `面-denom-比率分母审计-五态接口-6条人造答案-三类跨载体`
//     —— 正是我断言它做不到的那一步。
// ══════════════════════════════════════════════════════════════════════════
//
// ★ 教训（纪律⑬）：**它的行为变了，先排除"我给的东西变了"。**
//   这里的"给的东西"不是提示词，是**启动参数** —— 它从来没进过日志，
//   所以这个错静默了很久。现在启动时会打一行 `seat ★ 广探索度：…`。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { pickAnglesN } from "../../research/clusters/hunt/runner.ts";

const A = [
  { key: "falsifier" },
  { key: "instrument-skeptic" },
  { key: "hands-on" },
];

describe("★★★★★ ① hands-on 不许被切掉", () => {
  it("★★★★★ 1 个角度 ⇒ 必须是 hands-on（不是序号第一个 falsifier）", () => {
    const got = pickAnglesN(1, A);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.key, "hands-on", "★ 唯一建设性的角度不能省");
  });

  it("★★★★★ 2 个角度 ⇒ hands-on + falsifier（不再是原来那两个对手）", () => {
    const got = pickAnglesN(2, A);
    assert.deepEqual(got.map((x) => x.key), ["hands-on", "falsifier"]);
  });

  it("★★★ 3 个角度 ⇒ 三个齐全（顺序不影响集合）", () => {
    const got = pickAnglesN(3, A);
    assert.equal(got.length, 3);
    assert.deepEqual(new Set(got.map((x) => x.key)), new Set(["hands-on", "falsifier", "instrument-skeptic"]));
  });

  it("★★ 要 5 个但只有 3 个 ⇒ 给 3 个（不炸）", () => {
    assert.equal(pickAnglesN(5, A).length, 3);
  });

  it("★★ 0 或负数 ⇒ 至少给 1 个", () => {
    assert.equal(pickAnglesN(0, A).length, 1);
    assert.equal(pickAnglesN(-3, A).length, 1);
  });
});

describe("★★★★★ ② 回归：老写法会怎么错（留作对照）", () => {
  it("★★★★★ slice(0,2) 恰好切掉 hands-on —— 这就是事故本身", () => {
    const old = A.slice(0, 2).map((x) => x.key);
    assert.equal(old.includes("hands-on"), false, "★ 老写法 2 个角度时没有建设性角度");
    assert.equal(pickAnglesN(2, A).some((x) => x.key === "hands-on"), true, "新写法有");
  });

  it("★★★★★ slice(0,1) 只剩证伪 —— 产出必然全是对抗", () => {
    assert.deepEqual(A.slice(0, 1).map((x) => x.key), ["falsifier"]);
    assert.equal(pickAnglesN(1, A)[0]!.key, "hands-on");
  });
});

describe("★★★ ③ 空表/无 hands-on 时不炸", () => {
  it("★★ 空表 ⇒ 空结果", () => {
    assert.deepEqual(pickAnglesN(2, []), []);
  });

  it("★★ 没有 hands-on 的名单 ⇒ 按原顺序取（不报错）", () => {
    const noHands = [{ key: "a" }, { key: "b" }];
    assert.deepEqual(pickAnglesN(1, noHands).map((x) => x.key), ["a"]);
  });
});
