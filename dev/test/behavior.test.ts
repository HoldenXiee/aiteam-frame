// ★★★★ 行为失衡检测：谁在反复做同一件事
//
// ★★★ 这个文件守的判据：**比例失衡 ⇒ 有人在反复做同一件事**。
//   而"该不该治"是集群自己判（我只给可数的证据）。

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { renderBehavior, teamBehavior } from "../../research/clusters/forge/tools/behavior.ts";

const B = String.fromCharCode(10);

/** 造签字行 */
function sig(by: string, verdict: string): string {
  return JSON.stringify({ by, verdict, artifact: "x" });
}

describe("★★★★ ① 算得准（比例失衡 = 有人在反复做同一件事）", () => {
  it("★★★★ landing 47% vs 另两队 24% ⇒ 报 outlier", () => {
    const lines = [
      ...Array(56).fill(sig("landing", "有保留")),
      ...Array(64).fill(sig("landing", "认同")),
      ...Array(22).fill(sig("theory", "有保留")),
      ...Array(69).fill(sig("theory", "认同")),
      ...Array(24).fill(sig("practice", "有保留")),
      ...Array(71).fill(sig("practice", "认同")),
    ];
    const r = teamBehavior(lines);
    assert.equal(r.n, 306);
    const landing = r.teams.find((t) => t.team === "landing")!;
    assert.equal(landing.reserved, 56);
    assert.equal(Math.round(landing.reservedRate * 100), 47);
    // ★★★ 必须报出来 —— 否则集群看不见"谁在反复"
    assert.equal(r.outlier?.team, "landing");
    assert.ok(r.outlier!.vsOthers > 0.15);
  });

  it("★★ 三队比例差不多 ⇒ 不报 outlier（没有谁特别）", () => {
    const lines = [
      ...Array(30).fill(sig("a", "有保留")),
      ...Array(70).fill(sig("a", "认同")),
      ...Array(30).fill(sig("b", "有保留")),
      ...Array(70).fill(sig("b", "认同")),
      ...Array(30).fill(sig("c", "有保留")),
      ...Array(70).fill(sig("c", "认同")),
    ];
    assert.equal(teamBehavior(lines).outlier, undefined);
  });

  it("★★★ 差距不够大（10 个百分点）⇒ 不报（避免把噪声当信号）", () => {
    const lines = [
      ...Array(30).fill(sig("a", "有保留")),
      ...Array(70).fill(sig("a", "认同")),
      ...Array(20).fill(sig("b", "有保留")),
      ...Array(80).fill(sig("b", "认同")),
    ];
    assert.equal(teamBehavior(lines).outlier, undefined);
  });
});

describe("★★★★ ② 样本太少不许下结论", () => {
  it("★★★ 某一队只有 5 次签字 ⇒ 不算 outlier（比例不可信）", () => {
    const lines = [
      ...Array(5).fill(sig("tiny", "有保留")), // 100% 但样本太小
      ...Array(30).fill(sig("big", "有保留")),
      ...Array(100).fill(sig("big", "认同")),
    ];
    const r = teamBehavior(lines, 30);
    assert.notEqual(r.outlier?.team, "tiny", "样本太小的时候不该报（100% 是假象）");
  });

  it("★★ 空输入不炸", () => {
    const r = teamBehavior([]);
    assert.equal(r.teams.length, 0);
    assert.equal(r.n, 0);
  });

  it("★ 坏行跳过，不炸", () => {
    const r = teamBehavior(["不是 json", "", sig("a", "有保留")]);
    assert.equal(r.teams.length, 1);
  });
});

describe("★★ ③ 渲染（要能一眼看出谁失衡）", () => {
  it("★★ 报比例 + 差距", () => {
    const lines = [
      ...Array(56).fill(sig("landing", "有保留")),
      ...Array(64).fill(sig("landing", "认同")),
      ...Array(22).fill(sig("theory", "有保留")),
      ...Array(69).fill(sig("theory", "认同")),
      ...Array(24).fill(sig("practice", "有保留")),
      ...Array(71).fill(sig("practice", "认同")),
    ];
    const s = renderBehavior(teamBehavior(lines));
    assert.ok(s.includes("landing 56/120=47%"), `实际：${s}`);
    assert.ok(s.includes("个百分点"));
  });

  it("★★ 空的时候说清（不假装有数据）", () => {
    assert.ok(renderBehavior({ teams: [], n: 0 }).includes("还没有"));
  });
});
