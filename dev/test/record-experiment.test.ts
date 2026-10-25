import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rmSync } from "node:fs";
import {
  appendStructured,
  insideLabDir,
  readStructured,
  renderSeven,
  sevenStats,
  validateExperiment,
} from "../../research/clusters/hunt/tools/record-experiment.ts";

const base = {
  project: "X2",
  claim: "路径护栏把文本当落点",
  killCondition: "若 12 条探针全部判决正确 ⇒ 假设错",
  source: "https://bazel.build/basics/hermeticity",
  carriers: [{ dir: "work/lab-A", cmd: "node probe.mjs" }],
  phenomenon: "实测 8 条判错，我预期 0 条",
  phenomenonAbsent: "",
  model: "护栏做前缀比较，不做真实落点归一化",
  outcome: "活",
  projectIds: ["X2"],
};

describe("validateExperiment：★ 缺格就拒收（这是它代替「要求」的地方）", () => {
  it("齐全 ⇒ 通过", () => assert.deepEqual(validateExperiment(base), []));

  it("★ 结局=活 却没 model ⇒ 拒（没有机制的活只是巧合）", () => {
    const errs = validateExperiment({ ...base, model: "" });
    assert.ok(errs.some((e) => e.includes("只是一次巧合")), errs.join());
  });

  it("★ 现象空着且不解释 ⇒ 拒（这一格不许静默空）", () => {
    const errs = validateExperiment({ ...base, phenomenon: "", phenomenonAbsent: "" });
    assert.ok(errs.some((e) => e.includes("没有意外")), errs.join());
  });

  it("现象空但答了「没有意外」⇒ 通过（允许没有意外）", () => {
    assert.deepEqual(validateExperiment({ ...base, phenomenon: "", phenomenonAbsent: "没有意外" }), []);
  });

  it("★★ source 必填且认 URL/arXiv/DOI/本仓 —— 外部出处是实验的属性", () => {
    assert.ok(validateExperiment({ ...base, source: "" }).some((e) => e.includes("source")));
    assert.ok(validateExperiment({ ...base, source: "我记得看过一篇" }).some((e) => e.includes("source")));
    assert.deepEqual(validateExperiment({ ...base, source: "arxiv:2508.17536" }), []);
    assert.deepEqual(validateExperiment({ ...base, source: "本仓:research/book" }), []);
  });

  it("★★ project 不在 PROJECTS.md 里 ⇒ 拒（链深靠这个键）", () => {
    const errs = validateExperiment({ ...base, project: "X9", projectIds: ["X1", "X2"] });
    assert.ok(errs.some((e) => e.includes("链深")), errs.join());
  });

  it("判死条件太短 ⇒ 拒", () => {
    assert.ok(validateExperiment({ ...base, killCondition: "看情况" }).some((e) => e.includes("判死")));
  });

  it("载体没有命令 ⇒ 拒（「装置」必须能跑）", () => {
    const errs = validateExperiment({ ...base, carriers: [{ dir: "work/A", cmd: "  " }] });
    assert.ok(errs.some((e) => e.includes("一条能跑的命令")), errs.join());
  });
});

describe("sevenStats：★ 「发现型」= 跨载体 + 现象 + 模型", () => {
  const row = (over: Partial<Parameters<typeof sevenStats>[0][number]>) =>
    ({
      at: "t", by: "a", project: "X2", claim: "c", killCondition: "k", source: "u",
      carriers: [{ dir: "work/A", cmd: "x", exit: 0, head: "" }, { dir: "work/B", cmd: "x", exit: 0, head: "" }],
      phenomenon: "意外", phenomenonAbsent: "", model: "机制", conjecture: "", outcome: "活",
      ...over,
    }) as Parameters<typeof sevenStats>[0][number];

  it("两个载体都 0 且有现象有模型 ⇒ 发现型", () => {
    assert.equal(sevenStats([row({})]).discovery, 1);
  });
  it("★ 单载体 ⇒ 不算跨载体，也不算发现型（跑过一次不等于可推广）", () => {
    const s = sevenStats([row({ carriers: [{ dir: "work/A", cmd: "x", exit: 0, head: "" }] })]);
    assert.equal(s.portable, 0);
    assert.equal(s.discovery, 0);
  });
  it("★ 一个有现象无模型 ⇒ 不算发现型（裁决不是发现）", () => {
    assert.equal(sevenStats([row({ model: "" })]).discovery, 0);
  });
  it("★★ 结局=死 有现象有模型 ⇒ 算「反例型」，不算「发现型」（集群 r11 抓到的口径错）", () => {
    const s = sevenStats([row({ outcome: "死" })]);
    assert.equal(s.discovery, 0);
    assert.equal(s.refuting, 1);
  });
  it("空账渲染「0 条」并指向 record_experiment，不报未声明假象", () => {
    assert.ok(renderSeven(sevenStats([])).includes("0 条"));
  });
});

describe("insideLabDir / 落账", () => {
  const lab = "dev/test/_sandbox-recexp";
  it("lab 外一律拒（写边界不变）", () => {
    assert.equal(insideLabDir(lab, "dev/test/x"), false);
    assert.equal(insideLabDir(lab, `${lab}/work/A`), true);
  });
  it("append + read 往返", () => {
    rmSync(`${lab}/work`, { recursive: true, force: true });
    appendStructured(lab, {
      at: "t", by: "a", project: "X2", claim: "c", killCondition: "k", source: "u",
      carriers: [], phenomenon: "", phenomenonAbsent: "没有意外", model: "", conjecture: "", outcome: "活",
    });
    assert.equal(readStructured(lab).length, 1);
  });
});
