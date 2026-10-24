/**
 * 实验账量具的测试（纪律㉙：证明「它在该失败时会失败」）
 *
 * ★ 这个模块测的不是"能不能算"，是**三个会让读数说谎的地方**：
 *   ① 缺数据被写成 0（纪律㉜）
 *   ② 相对成长被当成路径（纪律㉞）
 *   ③ 语气被当成结局（只能认明写的结局栏）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyOutcome,
  deliveryDriven,
  deviceRefs,
  experimentStats,
  hasAnchor,
  inferRows,
  parseLedger,
  readExperiments,
  renderExperiments,
  sourceMix,
  type Artifact,
  type Row,
} from "../../research/clusters/hunt/topology/experiments.ts";

const NL = String.fromCharCode(10);
const art = (file: string, text: string, mtimeMs = 0): Artifact => ({ file, text, mtimeMs });

describe("hasAnchor：只认可核锚", () => {
  it("数字算", () => assert.equal(hasAnchor("0/24 全错"), true));
  it("反引号里的算", () => assert.equal(hasAnchor("见 `judge2` 那条"), true));
  it("带扩展名的路径算", () => assert.equal(hasAnchor("work/mapper/runs/task2b.jsonl"), true));
  it("★ 相对成长（无扩展名）不算 —— 这就是当初误报 5 条「假结账」的原因", () => {
    assert.equal(hasAnchor("lib/aiteam"), false);
    assert.equal(hasAnchor("outbox/"), false);
  });
  it("空串不算", () => assert.equal(hasAnchor(""), false));
});

describe("classifyOutcome：认不出就 unsaid，绝不猜", () => {
  it("认得出四种", () => {
    assert.equal(classifyOutcome("死：谓词 arity 不可切"), "dead");
    assert.equal(classifyOutcome("活：下一步换载体"), "active");
    assert.equal(classifyOutcome("挂起：等 forge 的结论"), "parked");
    assert.equal(classifyOutcome("移交 forge 写成章"), "handoff");
  });
  it("★★ 没有结局栏 ⇒ unsaid（不是 active）", () => {
    assert.equal(classifyOutcome(""), "unsaid");
    assert.equal(classifyOutcome("   "), "unsaid");
  });
  it("★★ 读不懂的话也归 unsaid —— 不许把「有话说」当成「有结局」", () => {
    assert.equal(classifyOutcome("这条挺有意思的"), "unsaid");
  });
});

describe("parseLedger：末格当结局", () => {
  const table = [
    "| 编号 | 谓词 | 装置 | 结局 |",
    "| --- | --- | --- | --- |",
    "| P58 | 判 A 与 B 同一 | work/x.mjs | 活：下一步跑 C |",
    "| P59 | 判 C 能否切 | work/y.mjs | 死：arity 不可切，`judge2` 返回 2 |",
  ].join(NL);

  it("跳过表头与分隔行", () => {
    const rows = parseLedger(table);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.id, "P58");
  });
  it("结局取最后一格，且锚判对", () => {
    const rows = parseLedger(table);
    assert.equal(rows[0]!.outcome, "active");
    assert.equal(rows[1]!.outcome, "dead");
    assert.equal(rows[1]!.anchored, true);
  });
  it("没有 | 的行不算行", () => assert.equal(parseLedger("随便一句话").length, 0));
});

describe("inferRows：推断模式只认编号，不瞎认", () => {
  const arts = [
    art("P58-判同一性.md", "结局：死：不可切"),
    art("P59-第二个.md", "没有结局栏"),
    art("手段XVI-装置审查.md", "结局：活"),
    art("台账-11份处置.md", "结局：活"),
  ];
  it("只认 P 前缀", () => {
    const rows = inferRows(arts);
    assert.deepEqual(rows.map((r) => r.id), ["P58-判同一性.md", "P59-第二个.md"]);
  });
  it("★ 有结局栏才判，没有就 unsaid", () => {
    const rows = inferRows(arts);
    assert.equal(rows[0]!.outcome, "dead");
    assert.equal(rows[1]!.outcome, "unsaid");
  });
});

describe("deviceRefs：只认带扩展名的可跑装置", () => {
  it("认 mjs/ts/jsonl", () => {
    const r = deviceRefs("跑了 work/mapper/exp.ts 和 runs/task2b.jsonl");
    assert.equal(r.length, 2);
  });
  it("�� 无扩展名的目录不算装置", () => {
    assert.deepEqual(deviceRefs("改的是 lib/aiteam 和 outbox/"), []);
  });
});

describe("deliveryDriven：只扫开头 30 行（反向指标）", () => {
  it("开头明写「回答上级」⇒ 算", () => {
    const a = [art("a.md", "回答上级的问题：……")];
    assert.equal(deliveryDriven(a).deliveryDriven, 1);
  });
  it("★★ 第 40 行才提到 ⇒ 不算（正文引用上级是正常的）", () => {
    const body = Array(40).fill("正文").join(NL) + NL + "这是回答上级的";
    assert.equal(deliveryDriven([art("b.md", body)]).deliveryDriven, 0);
  });
  it("比例的分母是全部产物；空集给 null 不是 0", () => {
    assert.equal(deliveryDriven([]).share, null);
    assert.equal(deliveryDriven([art("c.md", "普通")]).share, 0);
  });
});

describe("sourceMix：三条灵感通道分开数", () => {
  it("URL 算外部，学科词算跨学科，明写出处算 declared", () => {
    const m = sourceMix([
      art("a.md", "见 https://arxiv.org/abs/1234 的说法"),
      art("b.md", "借的是信息论的熵"),
      art("c.md", "出处：某篇论文"),
      art("d.md", "啥都没有"),
    ]);
    assert.equal(m.external, 1);
    assert.equal(m.interdisciplinary, 1);
    assert.equal(m.declared, 1);
    assert.equal(m.total, 4);
  });
});

describe("experimentStats：三态与 null", () => {
  const rows: Row[] = [
    { id: "P1", outcome: "active", cause: "", anchored: false },
    { id: "P2", outcome: "dead", cause: "死：`judge2` 返回 2", anchored: true },
    { id: "P3", outcome: "unsaid", cause: "", anchored: false },
  ];
  const stats = experimentStats(
    rows,
    { refsFor: () => [], exists: () => false },
    { now: 10_000, mtimeOf: () => undefined },
    "ledger",
  );

  it("分状态数对", () => {
    assert.equal(stats.total, 3);
    assert.equal(stats.byOutcome.active, 1);
    assert.equal(stats.byOutcome.unsaid, 1);
  });
  it("★ 死因可判死率按 dead+parked 算分母", () => assert.equal(stats.deadCauseJudgeable, 1));
  it("★★ 一条都没死 ⇒ null（不是 0，也不是 100%）", () => {
    const s = experimentStats(
      [{ id: "P1", outcome: "active", cause: "", anchored: false }],
      { refsFor: () => [], exists: () => false },
      { now: 0, mtimeOf: () => undefined },
      "ledger",
    );
    assert.equal(s.deadCauseJudgeable, null);
    // ★ 一条实验、零条装置引用 ⇒ **不算覆盖**（没装置就不是实验），不是 null
    assert.equal(s.deviceCoverage, 0);
    assert.equal(experimentStats([], { refsFor: () => [], exists: () => false }, { now: 0, mtimeOf: () => undefined }, "ledger").deviceCoverage, null);
  });
  it("mtime 只用来判「新不新」", () => {
    const s = experimentStats(
      [{ id: "P1", outcome: "active", cause: "", anchored: false }],
      { refsFor: () => [], exists: () => false },
      { now: 10 * 86_400_000, mtimeOf: () => 10 * 86_400_000 - 1000 },
      "ledger",
    );
    assert.equal(s.newLast24h, 1);
  });
});

describe("deviceCoverage：按行算，不许跨行借（纪律㉞）", () => {
  it("★ A 行引用了在盘装置，B 行没引用 ⇒ B 行仍算未覆盖", () => {
    const rows: Row[] = [
      { id: "P1", outcome: "active", cause: "", anchored: false },
      { id: "P2", outcome: "active", cause: "", anchored: false },
    ];
    const s = experimentStats(
      rows,
      { refsFor: (id) => (id === "P1" ? ["work/a.mjs"] : []), exists: () => true },
      { now: 0, mtimeOf: () => undefined },
      "ledger",
    );
    assert.equal(s.deviceCoverage, 0.5);
  });
});

describe("renderExperiments：缺数据必须写成「未声明」", () => {
  const s = experimentStats(
    [],
    { refsFor: () => [], exists: () => false },
    { now: 0, mtimeOf: () => undefined },
    "inferred",
  );
  const txt = renderExperiments(s, deliveryDriven([]), sourceMix([]));

  it("不出现「0%」这种假读数", () => {
    assert.ok(txt.includes("未声明"), txt);
    assert.ok(!/死因可判死：0%/.test(txt), txt);
  });
  it("★ 推断模式必须自报偏差", () => assert.ok(txt.includes("系统偏差"), txt));
  it("投递驱动比标成反向指标", () => assert.ok(txt.includes("反向指标"), txt));
});

describe("readExperiments：传错根要抛错，不静默", () => {
  it("给 outbox 路径 ⇒ 抛", () => {
    assert.throws(() => readExperiments("research/labfirst/hunt/outbox"), /集群空间根/);
  });
  it("给 work 路径 ⇒ 抛", () => {
    assert.throws(() => readExperiments("research/labfirst/hunt/work"), /集群空间根/);
  });
});
