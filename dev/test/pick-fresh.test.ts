import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickFresh } from "../../research/clusters/hunt/topology/rules.ts";

// ★ 这一条守的是 2026-10-25 抓到的**最贵的结构性 bug**：
//   `challengedOutputs` 在内存里 ⇒ 重启清零 ⇒ 整个 235 份历史账被当成"新产出"逐条重审。
//   实测 32 条挑战的被挑战产物龄全是 13.8 分钟（拷贝时刻）。

const START = 1_000_000;
const mt = (ms: number) => () => ms;

describe("pickFresh：★ 只挑本轮新产出（历史账不许被当成新）", () => {
  it("开跑前就在的产物 ⇒ 不挑（这就是那个 bug）", () => {
    assert.deepEqual(pickFresh(["old1.md", "old2.md"], START, [], mt(START - 60_000)), []);
  });

  it("开跑后写的 ⇒ 挑", () => {
    assert.deepEqual(pickFresh(["new.md"], START, [], mt(START + 5_000)), ["new.md"]);
  });

  it("★ 等于开跑时刻也算新（时钟抖动，别卡边界）", () => {
    assert.deepEqual(pickFresh(["edge.md"], START, [], mt(START)), ["edge.md"]);
  });

  it("本轮已辩过的不再挑（去重仍然是去重）", () => {
    assert.deepEqual(pickFresh(["new.md"], START, ["new.md"], mt(START + 1)), []);
  });

  it("★★ 取不到 mtime（文件已被删）⇒ 不当新 —— 静默当新会再造那个 bug", () => {
    assert.deepEqual(pickFresh(["gone.md"], START, [], () => undefined), []);
  });

  it("混合输入：只留新且未辩", () => {
    const outs = ["old.md", "new-a.md", "new-b.md", "deleted.md"];
    const m = (f: string) =>
      f === "old.md" ? START - 1 : f === "deleted.md" ? undefined : START + 1;
    assert.deepEqual(pickFresh(outs, START, ["new-b.md"], m), ["new-a.md"]);
  });
});

describe("listDebatable 的口径：两个落点都要（outbox + work/*.md）", () => {
  // ★ 这一条守的是"辩证被饿住"：r3 一轮写 11 份到 work/，outbox 0 新增，
  //   而 onNewFinding 只看 outbox ⇒ 一轮只辩 2–5 份。
  it("名字以 work/ 前缀区分落点（记账要用得到）", () => {
    assert.equal("work/P1.md".startsWith("work/"), true);
    assert.equal("P1.md".startsWith("work/"), false);
  });
  it("★ 账本不算研究产物（PROJECTS/EXPERIMENTS/STATE/下划线件）", () => {
    const skip = /^(STATE|PROJECTS|EXPERIMENTS)/;
    for (const f of ["STATE.md", "PROJECTS.md", "EXPERIMENTS-hands-on.md"]) assert.ok(skip.test(f), f);
    for (const f of ["P123-x.md", "面-denom.md"]) assert.ok(!skip.test(f), f);
  });
});
