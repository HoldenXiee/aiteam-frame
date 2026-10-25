import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rmSync } from "node:fs";
import {
  appendPort,
  insideLab,
  portStats,
  readPort,
  renderPort,
} from "../../research/clusters/hunt/tools/port-run.ts";

const lab = "dev/test/_sandbox-port";

describe("insideLab：★ 载体必须在 lab 里面（写边界不变）", () => {
  it("lab 自己、lab 下面都行", () => {
    assert.equal(insideLab(lab, `${lab}/work/lab-A`), true);
    assert.equal(insideLab(lab, lab), true);
  });
  it("★ 外面一律不行 —— 否则等于给了一个绕过写边界的入口", () => {
    assert.equal(insideLab(lab, "dev/test"), false);
    assert.equal(insideLab(lab, `${lab}-evil/work`), false);
    assert.equal(insideLab(lab, "D:/space/aiteam/test/src"), false);
  });
});

describe("portStats：★★ 可推广成立的唯一判据 = ≥2 个载体都 exit 0", () => {
  const rows = [
    { at: "t", by: "a", claim: "C1", carrier: "work/lab-A", cmd: "x", exit: 0, ms: 1, head: "" },
    { at: "t", by: "a", claim: "C1", carrier: "work/lab-B", cmd: "x", exit: 0, ms: 1, head: "" },
    { at: "t", by: "b", claim: "C2", carrier: "work/lab-A", cmd: "y", exit: 0, ms: 1, head: "" },
    { at: "t", by: "b", claim: "C3", carrier: "work/lab-A", cmd: "z", exit: 0, ms: 1, head: "" },
    { at: "t", by: "b", claim: "C3", carrier: "work/lab-B", cmd: "z", exit: 2, ms: 1, head: "boom" },
  ];
  const s = portStats(rows);
  it("C1 两个载体都 0 ⇒ 算成立", () => assert.deepEqual(s.portableClaims, ["C1"]));
  it("★ C2 只在一个载体跑过 ⇒ 不算（跑过一次不等于可推广）", () => {
    assert.equal(s.portableClaims.includes("C2"), false);
  });
  it("★ C3 第二个载体 exit 2 ⇒ 不算，且计入 failing", () => {
    assert.equal(s.portableClaims.includes("C3"), false);
    assert.equal(s.failing, 1);
  });
  it("载体去重", () => assert.equal(s.carriers.length, 2));
});

describe("renderPort：空账报「未声明」而不是 0（纪律㉜）", () => {
  it("没有 port.jsonl ⇒ 未声明", () => {
    assert.ok(renderPort(portStats([])).includes("未声明"));
  });
  it("有账时报条数与判据", () => {
    rmSync(`${lab}/work`, { recursive: true, force: true });
    appendPort(lab, { at: "t", by: "a", claim: "C1", carrier: "work/A", cmd: "x", exit: 0, ms: 1, head: "" });
    const txt = renderPort(portStats(readPort(lab)));
    assert.ok(txt.includes("跨载体成立：0 条"), txt);
  });
});
