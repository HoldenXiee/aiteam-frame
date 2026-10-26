import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rmSync } from "node:fs";
import {
  applyReview,
  preregAlreadyUsed,
  deepProjects,
  externalUrlShare,
  projectChains,
  appendStructured,
  insideLabDir,
  readStructured,
  renderSeven,
  sevenStats,
  validateExperiment,
} from "../../research/clusters/hunt/tools/record-experiment.ts";
import { expectedTrace, renderExpectedTrace } from "../../research/clusters/hunt/topology/experiments.ts";

const base = {
  project: "X2",
  claim: "路径护栏把文本当落点",
  killCondition: "若 12 条探针全部判决正确 ⇒ 假设错",
  source: "https://bazel.build/basics/hermeticity",
  prereg: "work/x-PREREG.md",
    expected: "跑之前写死的预期句",
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
      at: "t", id: "E1", by: "a", project: "X2", claim: "c", killCondition: "k", source: "u", prereg: "p",
    expected: "跑之前写死的预期句", preregMtime: 0, preregBeforeRun: true,
      carriers: [{ dir: "work/A", cmd: "x", exit: 0, head: "" }, { dir: "work/B", cmd: "x", exit: 0, head: "" }],
      phenomenon: "意外", phenomenonAbsent: "", model: "机制", conjecture: "", outcome: "活",
      phenomenonVerdict: "未审", reviewedBy: "", reviewNote: "",
      ...over,
    }) as Parameters<typeof sevenStats>[0][number];

  // ★★★ 2026-10-25 **口径变更**（不是放宽）：`discovery` 现在还要求**被别人独立审过**。
  //   理由：填了 ≠ 真意外（实测被审的现象里 58% 判"补的"）。
  it("两个载体都 0、有现象有模型、且被独立审过 ⇒ 发现型", () => {
    assert.equal(sevenStats([row({ reviewedBy: "b", phenomenonVerdict: "真意外" })]).discovery, 1);
  });
  it("★★ 同样齐全但**没被别人审** ⇒ 不算发现型（第 18 次「写好了没接上」的守门测试）", () => {
    assert.equal(sevenStats([row({})]).discovery, 0);
  });
  it("★★ 被别人判「补的」⇒ 不算发现型", () => {
    assert.equal(sevenStats([row({ reviewedBy: "b", phenomenonVerdict: "补的" })]).discovery, 0);
  });
  it("★ 单载体 ⇒ 不算跨载体，也不算发现型（跑过一次不等于可推广）", () => {
    const s = sevenStats([row({ carriers: [{ dir: "work/A", cmd: "x", exit: 0, head: "" }] })]);
    assert.equal(s.portable, 0);
    assert.equal(s.discovery, 0);
  });
  it("★ 一个有现象无模型 ⇒ 不算发现型（裁决不是发现）", () => {
    assert.equal(sevenStats([row({ model: "" })]).discovery, 0);
  });
  it("★★ 结局=死 有现象有模型且被审过 ⇒ 算「反例型」，不算「发现型」（集群 r11 抓到的口径错）", () => {
    const s = sevenStats([row({ outcome: "死", reviewedBy: "b", phenomenonVerdict: "真意外" })]);
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
      at: "t", id: "E1", by: "a", project: "X2", claim: "c", killCondition: "k", source: "u", prereg: "p",
    expected: "跑之前写死的预期句", preregMtime: 0, preregBeforeRun: true,
      carriers: [], phenomenon: "", phenomenonAbsent: "没有意外", model: "", conjecture: "", outcome: "活",
      phenomenonVerdict: "未审", reviewedBy: "", reviewNote: "",
    });
    assert.equal(readStructured(lab).length, 1);
  });
});

describe("★★★★ 大改：链深聚合 / 真外部 URL / 现象必须被别人审", () => {
  const mk = (over: Record<string, unknown>) =>
    ({
      at: "t", id: "E1", by: "a", project: "X2", claim: "c", killCondition: "k",
      source: "https://bazel.build/x", prereg: "p",
    expected: "跑之前写死的预期句", preregMtime: 0, preregBeforeRun: true,
      carriers: [{ dir: "work/A", cmd: "x", exit: 0, head: "" }, { dir: "work/B", cmd: "x", exit: 0, head: "" }],
      phenomenon: "意外", phenomenonAbsent: "", model: "机制", conjecture: "", outcome: "活",
      phenomenonVerdict: "未审", reviewedBy: "", reviewNote: "",
      ...over,
    }) as never;

  it("★ 按 project 聚合：链深 = 该项目的实验行数（不靠人肉写版本号）", () => {
    const rows = [mk({ id: "E1", project: "X2" }), mk({ id: "E2", project: "X2" }), mk({ id: "E3", project: "X3" })];
    const c = projectChains(rows);
    assert.equal(c[0].project, "X2");
    assert.equal(c[0].rows, 2);
    assert.equal(deepProjects(rows, 3), 0);
    assert.equal(deepProjects([...rows, mk({ id: "E4", project: "X2" })], 3), 1);
  });

  it("★★ 真外部 URL 与 `本仓:` 分开数（一等判据，不许混）", () => {
    const rows = [mk({ source: "https://x.org/a" }), mk({ source: "本仓:src/index.ts" })];
    const e = externalUrlShare(rows);
    assert.equal(e.n, 1);
    assert.equal(e.share, 0.5);
  });

  it("★★★ 现象被独立审过才算（自己审自己不计）", () => {
    const self = sevenStats([mk({ reviewedBy: "a" })]); // 作者也是 a
    assert.equal(self.reviewed, 0);
    const other = sevenStats([mk({ reviewedBy: "b", phenomenonVerdict: "真意外" })]);
    assert.equal(other.reviewed, 1);
  });

  it("★★ 判「补的」单独计数", () => {
    assert.equal(sevenStats([mk({ reviewedBy: "b", phenomenonVerdict: "补的" })]).calledFake, 1);
  });
});

describe("applyReview：★ 自签会被拒（与 forge 的作者自签同一个病）", () => {
  const lab = "dev/test/_sandbox-review";
  const row = {
    at: "t", id: "E7", by: "me", project: "X2", claim: "c", killCondition: "k", source: "u", prereg: "p",
    expected: "跑之前写死的预期句", preregMtime: 0, preregBeforeRun: true,
    carriers: [], phenomenon: "意外", phenomenonAbsent: "", model: "m", conjecture: "", outcome: "活",
    phenomenonVerdict: "未审", reviewedBy: "", reviewNote: "",
  } as never;

  it("自己审自己 ⇒ 拒", () => {
    rmSync(`${lab}/work`, { recursive: true, force: true });
    appendStructured(lab, row);
    const r = applyReview(lab, "E7", { by: "me", verdict: "真意外", note: "我核过" });
    assert.equal(r.ok, false);
    assert.ok((r.reason ?? "").includes("自签"));
  });

  it("别人审 + 有 note ⇒ 通过并落盘", () => {
    const r = applyReview(lab, "E7", { by: "other", verdict: "补的", note: "PREREG 里没有预期，只有事后读数" });
    assert.equal(r.ok, true);
    assert.equal(readStructured(lab)[0]!.phenomenonVerdict, "补的");
    assert.equal(readStructured(lab)[0]!.reviewedBy, "other");
  });

  it("没 note ⇒ 拒（不许写「看起来像」）", () => {
    assert.equal(applyReview(lab, "E7", { by: "other2", verdict: "真意外", note: "  " }).ok, false);
  });

  it("没有这一行 ⇒ 拒并列出已有行号", () => {
    const r = applyReview(lab, "E99", { by: "other", verdict: "真意外", note: "x" });
    assert.equal(r.ok, false);
    assert.ok((r.reason ?? "").includes("E7"));
  });
});

describe("★★★ 一份 PREREG 只能服务一个实验", () => {
  const lab = "dev/test/_sandbox-prereg-once";
  const row = (id: string, prereg: string) =>
    ({
      at: "t", id, by: "a", project: "X2", claim: "c", killCondition: "k", source: "u",
      prereg, preregMtime: 0, preregBeforeRun: true, carriers: [],
      phenomenon: "意外", phenomenonAbsent: "", model: "m", conjecture: "", outcome: "活",
      phenomenonVerdict: "未审", reviewedBy: "", reviewNote: "",
    }) as never;

  it("★ 同路径用过 ⇒ 能查出来（工具据此拒收）", () => {
    rmSync(`${lab}/work`, { recursive: true, force: true });
    appendStructured(lab, row("E1", "work/a-PREREG.md"));
    assert.equal(preregAlreadyUsed(lab, "work/a-PREREG.md")?.id, "E1");
  });
  it("路径归一化：反斜杠 / 大小写都算同一份", () => {
    assert.equal(preregAlreadyUsed(lab, "WORK\\A-prereg.md")?.id, "E1");
  });
  it("没用过 ⇒ undefined", () => {
    assert.equal(preregAlreadyUsed(lab, "work/b-PREREG.md"), undefined);
  });
});

// ══════════════════════════════════════════════════════════════
// ★★★★★ 2026-10-26 · 「预期是不是跑前就写在那儿」必须机械可查
//
//   以前只能靠另一位凭印象判 ⇒ 37% 被判"补的"且四段持平。
//   现在两条同时成立才算：① `expected` 逐字在 PREREG 里 ② PREREG 早于执行。
// ══════════════════════════════════════════════════════════════

it("expected 必填：没有它，「现象」只能靠别人凭印象判", () => {
  const errs = validateExperiment({ ...base, expected: "   " });
  assert.ok(errs.some((e) => e.includes("expected 必填")));
});

it("expectedTrace 三分类：成立 / 不成立 / 未声明（旧行不许算失败）", () => {
  const t = expectedTrace([
    { expected: "预期 A", expectedAtLine: 3, preregBeforeRun: true } as never,
    { expected: "预期 B", expectedAtLine: 0, preregBeforeRun: true } as never, // 逐字不在
    { expected: "预期 C", expectedAtLine: 5, preregBeforeRun: false } as never, // PREREG 晚了
    { prereg: "work/x.md" } as never, // 旧行：没有 expected 这一格
  ]);
  assert.equal(t.ok, 1);
  assert.equal(t.bad, 2);
  assert.equal(t.undeclared, 1);
  assert.match(renderExpectedTrace(t), /1\/3/);
  assert.match(renderExpectedTrace(t), /旧行未声明 1 条/);
});
