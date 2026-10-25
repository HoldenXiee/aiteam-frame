import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  convergenceDebt,
  convergedGate,
  parseConverged,
  renderDebt,
  renderGate,
  writeDebtFile,
} from "../../research/clusters/hunt/topology/converged-gate.ts";

const row = (over: Record<string, unknown>) =>
  ({
    at: "t", id: "E1", by: "a", project: "X2", claim: "c", killCondition: "k", source: "u",
    prereg: "p", preregMtime: 0, preregBeforeRun: true,
    carriers: [], phenomenon: "意外", phenomenonAbsent: "", model: "m", conjecture: "", outcome: "活",
    phenomenonVerdict: "未审", reviewedBy: "", reviewNote: "",
    ...over,
  }) as never;

describe("parseConverged：只认「证据 id」那一列里的 E 编号", () => {
  const txt = [
    "| claim（一句话） | 证据 id | 状态 |",
    "|---|---|---|",
    "| 代价线掉完整性 | `P25` | 被 P26 取代 |",
    "| 现象 X | `E3`、`E7` | 当前 |",
  ].join(String.fromCharCode(10));

  it("取出 E 编号并去重排序", () => {
    assert.deepEqual(parseConverged(txt + String.fromCharCode(10) + "| y | `E7` | 当前 |").cited, ["E3", "E7"]);
  });
  it("旧账引用单独计数（用来对照，不判错）", () => {
    assert.equal(parseConverged(txt).legacyRefs, 1);
  });
});

describe("convergedGate：★★★★★ 「我收敛了」必须经过新门", () => {
  const lab = "dev/test/_sandbox-conv";
  const write = (t: string) => {
    rmSync(`${lab}/outbox`, { recursive: true, force: true });
    mkdirSync(`${lab}/outbox`, { recursive: true });
    writeFileSync(`${lab}/outbox/CONVERGED.md`, t, "utf8");
  };

  it("★ 状态表只引旧账 ⇒ 不通过（这就是现在的真实现状）", () => {
    write(["| claim | 证据 id | 状态 |", "|---|---|---|", "| a | `P25` | 当前 |"].join(String.fromCharCode(10)));
    const g = convergedGate(lab, [row({})]);
    assert.equal(g.pass, false);
    assert.ok(g.verdict.includes("一条结构化实验都没有"), g.verdict);
  });

  it("★ 引了 E* 但那条未审 ⇒ 不通过", () => {
    write(["| claim | 证据 id | 状态 |", "|---|---|---|", "| a | `E1` | 当前 |"].join(String.fromCharCode(10)));
    const g = convergedGate(lab, [row({})]);
    assert.equal(g.pass, false);
    assert.deepEqual(g.unreviewed, ["E1"]);
  });

  it("★★ 引了 E* 且被判「补的」⇒ 不通过（最要紧的一条）", () => {
    write(["| claim | 证据 id | 状态 |", "|---|---|---|", "| a | `E1` | 当前 |"].join(String.fromCharCode(10)));
    const g = convergedGate(lab, [row({ reviewedBy: "b", phenomenonVerdict: "补的" })]);
    assert.equal(g.pass, false);
    assert.deepEqual(g.fabricated, ["E1"]);
  });

  it("★ 引了 E* 且独立审过、真意外 ⇒ 通过", () => {
    write(["| claim | 证据 id | 状态 |", "|---|---|---|", "| a | `E1` | 当前 |"].join(String.fromCharCode(10)));
    const g = convergedGate(lab, [row({ reviewedBy: "b", phenomenonVerdict: "真意外" })]);
    assert.equal(g.pass, true, g.verdict);
  });

  it("★★ 引用了一条账上根本没有的 E ⇒ 当未审（不许凭空引）", () => {
    write(["| claim | 证据 id | 状态 |", "|---|---|---|", "| a | `E9` | 当前 |"].join(String.fromCharCode(10)));
    assert.deepEqual(convergedGate(lab, [row({})]).unreviewed, ["E9"]);
  });

  it("没有 CONVERGED.md ⇒ 未声明（不当作通过，也不当作失败）", () => {
    rmSync(`${lab}/outbox`, { recursive: true, force: true });
    const g = convergedGate(lab, []);
    assert.equal(g.pass, false);
    assert.ok(renderGate(g).includes("未声明"));
  });

  it("自己审自己不算审（reviewedBy === by）", () => {
    write(["| claim | 证据 id | 状态 |", "|---|---|---|", "| a | `E1` | 当前 |"].join(String.fromCharCode(10)));
    const g = convergedGate(lab, [row({ by: "a", reviewedBy: "a", phenomenonVerdict: "真意外" })]);
    assert.deepEqual(g.unreviewed, ["E1"]);
  });
});

describe("★★★★ 收敛欠账：列清单递上去（照 closure.ts 验过的手法）", () => {
  const lab = "dev/test/_sandbox-debt";
  const write = (t: string) => {
    rmSync(`${lab}/outbox`, { recursive: true, force: true });
    mkdirSync(`${lab}/outbox`, { recursive: true });
    writeFileSync(`${lab}/outbox/CONVERGED.md`, t, "utf8");
  };
  const r = (id: string, reviewed: boolean) =>
    ({
      at: "t", id, by: "a", project: "X2", claim: `claim-${id}`, killCondition: "k", source: "u",
      prereg: "p", preregMtime: 0, preregBeforeRun: true, carriers: [],
      phenomenon: "意外", phenomenonAbsent: "", model: "m", conjecture: "", outcome: "活",
      phenomenonVerdict: reviewed ? "真意外" : "未审", reviewedBy: reviewed ? "b" : "", reviewNote: "",
    }) as never;

  it("★ 账上有 3 条、状态表只引 1 条 ⇒ 欠 2 条", () => {
    write(["| claim | 证据 id | 状态 |", "|---|---|---|", "| a | `E1` | 当前 |"].join(String.fromCharCode(10)));
    const d = convergenceDebt(lab, [r("E1", true), r("E2", false), r("E3", true)]);
    assert.equal(d.total, 3);
    assert.equal(d.cited, 1);
    assert.deepEqual(d.uncited.map((u) => u.id), ["E2", "E3"]);
  });

  it("★ 欠账里标出哪条还没被审（未审的引不进状态表）", () => {
    write(["| claim | 证据 id | 状态 |", "|---|---|---|"].join(String.fromCharCode(10)));
    const d = convergenceDebt(lab, [r("E1", false), r("E2", true)]);
    assert.equal(d.uncited.find((u) => u.id === "E1")!.reviewed, false);
  });

  it("★★ 落盘后下一轮能算「上一轮列的清掉了几条」", () => {
    write(["| claim | 证据 id | 状态 |", "|---|---|---|"].join(String.fromCharCode(10)));
    const before = convergenceDebt(lab, [r("E1", true), r("E2", true)]);
    writeDebtFile(lab, before, "round-1");
    // 下一轮：E1 进了状态表
    write(["| claim | 证据 id | 状态 |", "|---|---|---|", "| a | `E1` | 当前 |"].join(String.fromCharCode(10)));
    const after = convergenceDebt(lab, [r("E1", true), r("E2", true)]);
    assert.equal(after.lastListed, 2);
    assert.equal(after.clearedFromLast, 1);
    assert.ok(renderDebt(after).includes("清掉"));
  });

  it("★ 空账 ⇒ 未声明（不报 0）", () => {
    rmSync(`${lab}/work`, { recursive: true, force: true });
    assert.ok(renderDebt(convergenceDebt(lab, [])).includes("未声明"));
  });
});
