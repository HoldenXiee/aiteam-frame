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
  artifactMix,
  conjectures,
  itemGap,
  renderItemGap,
  generalizability,
  ledgerColumns,
  renderGeneralizability,
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
  it("结局按列名取（不是最后一格）", () => {
    const rows = parseLedger(table);
    assert.equal(rows[0]!.outcome, "active");
    assert.equal(rows[1]!.outcome, "dead");
  });
  it("★★ 没有「死因」列 ⇒ 不计死因（拿结局格当死因会造出假锚）", () => {
    const rows = parseLedger(table);
    assert.equal(rows[1]!.cause, "");
    assert.equal(rows[1]!.anchored, false);
  });
  it("★★ 有「死因」列 ⇒ 从那一列取，锚判对", () => {
    const t2 = [
      "| 编号 | 装置 | 结局 | 死因 |",
      "| --- | --- | --- | --- |",
      "| P59 | work/y.mjs | 死 | arity 不可切，`judge2` 返回 2 |",
    ].join(NL);
    const rows = parseLedger(t2);
    assert.equal(rows[0]!.outcome, "dead");
    assert.equal(rows[0]!.anchored, true);
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
  it("★★ 宽松口径由调用方给（正文有四态词），默认 0 —— 不偷算", () => {
    assert.equal(stats.looseOutcome, 0);
    const s2 = experimentStats(
      rows,
      { refsFor: () => [], exists: () => false },
      { now: 0, mtimeOf: () => undefined },
      "ledger",
      32,
    );
    assert.equal(s2.looseOutcome, 32);
  });
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

describe("ledgerColumns：把「账有哪些列」打出来（DESIGN §1 缺口可见）", () => {
  it("只读表头，去重", () => {
    const t2 = [
      "| 编号 | 谓词 | 装置 | 结局 |",
      "| --- | --- | --- | --- |",
      "| P1 | x | work/a.mjs | 活 |",
    ].join(NL);
    assert.deepEqual(ledgerColumns(t2), ["编号", "谓词", "装置", "结局"]);
  });
  it("不是实验表的表头不算", () => {
    assert.deepEqual(ledgerColumns("| 席位 | 文件 | 字节 |"), []);
  });
  it("★★ 有「判死句 / 死因」列 ⇒ 认出来（那是死因的唯一合法来源）", () => {
    // ★ 集群的账用「四态」当列名 —— 而 OUT_HEAD 原来不认它 ⇒ 整张表读不到（真 bug）
    const t2 = ["| 编号 | 装置 | 四态 | 判死句 / 死因（要可核） |", "| --- | --- | --- | --- |"].join(NL);
    assert.ok(ledgerColumns(t2).some((c) => c.includes("死因")));
  });
});

describe("★★★ generalizability：可推广 vs 地方志（这一阶段的主判据）", () => {
  const arts = [
    art("P28-编排写进代码稳且省-模型自写编排贵且不稳.md", ""),
    art("P30-服从由完成成本门控-通道只是它的代理.md", ""),
    art("手段VII-seal的字节窗口会把别人写的行签成自己.md", ""),
    art("回应-falsifier-三处接受-量具读数不可复算.md", ""),
    art("随便什么.md", ""),
  ];
  const g = generalizability(arts);

  it("只含通用概念 ⇒ 可推广", () => {
    assert.equal(g.generalizable, 2);
  });
  it("★ 只含本 lab 专有名词 ⇒ 地方志（不算可推广）", () => {
    assert.equal(g.local, 2); // 手段VII(seal/量具?) 与 回应(量具/读数)
  });
  it("都不是的进 neither，不硬塞", () => {
    assert.equal(g.neither, 1);
  });
  it("比例的分母是全部；空集 null 不是 0", () => {
    assert.equal(g.share, 2 / 5);
    assert.equal(generalizability([]).share, null);
    assert.equal(generalizability([]).looseShare, null);
  });
  it("★★ 宽口径 = 不是地方志（含 neither）—— 两个口径都报，真值在中间", () => {
    // 5 份里 local=2, both=0 ⇒ loose = (5-2-0)/5
    assert.equal(g.looseShare, 3 / 5);
    assert.ok(g.looseShare! > g.share!);
  });
  it("渲染里带「可推广」和口径说明", () => {
    const txt = renderGeneralizability(g);
    assert.ok(txt.includes("可推广"), txt);
    assert.ok(txt.includes("地方志"), txt);
  });
});

describe("artifactMix：装置链 vs 实验（核心读数）", () => {
  const arts = [
    art("P58-a.md", ""),
    art("P59-b.md", ""),
    art("手段V-x.md", ""),
    art("手段VI-y.md", ""),
    art("手段VII-z.md", ""),
    art("回应-falsifier-a.md", ""),
    art("随便写点什么.md", ""),
  ];
  const m = artifactMix(arts);

  it("编号实验与装置类分开数", () => {
    assert.equal(m.experiments, 2);
    assert.equal(m.apparatus, 4); // 手段×3 + 回应×1
    assert.equal(m.total, 7);
  });
  it("★ 最长自审链 = 手段 3 条（链深的样子）", () => {
    assert.deepEqual(m.longestChain, { prefix: "手段", n: 3 });
  });
  it("★ 归不进的进「(其它)」，不硬塞进任何一类", () => {
    assert.equal(m.byPrefix["(其它)"], 1);
  });
  it("空集不炸", () => {
    const e = artifactMix([]);
    assert.equal(e.total, 0);
    assert.equal(e.longestChain, null);
  });
});

describe("readExperiments：传错根要抛错，不静默", () => {
  it("给 outbox 路径 ⇒ 抛", () => {
    assert.throws(() => readExperiments("research/labfirst/hunt/outbox"), /集群空间根/);
  });
  it("给 work 路径 ⇒ 抛", () => {
    assert.throws(() => readExperiments("research/labfirst/hunt/work"), /集群空间根/);
  });
});

describe("★★ 七项缺口（itemGap）：只判列在不在，不判写得对不对", () => {
  const ledger = [
    "| 编号 | 谓词 | 装置 | 结局 |",
    "|---|---|---|---|",
    "| P1 | x | y | 活 |",
  ].join(String.fromCharCode(10));

  it("★ 实测形状：有假设·装置·读数·结局，缺现象·模型·猜想", () => {
    const g = itemGap(ledger);
    assert.ok(g.present.includes("装置"), g.present.join());
    assert.ok(g.missing.includes("现象"), g.missing.join());
    assert.ok(g.missing.includes("模型"));
    assert.ok(g.missing.includes("猜想"));
  });

  it("加了现象/模型/猜想三列 ⇒ 不再缺", () => {
    const full = [
      "| 编号 | 谓词 | 装置 | 读数 | 现象 | 模型 | 猜想 | 结局 |",
      "|---|---|---|---|---|---|---|---|",
      "| P1 | x | y | 1 | 意外 | 机制A | 猜想B | 活 |",
    ].join(String.fromCharCode(10));
    const g = itemGap(full);
    assert.deepEqual(g.missing, []);
  });

  it("读不到列 ⇒ 报未声明，不报 0（纪律㉜）", () => {
    assert.ok(renderItemGap(itemGap("随便一句话")).includes("未声明"));
  });
});

describe("★★★★ 猜想的口径：它写在 PROJECTS.md 的表列里，不在正文", () => {
  const projects = [
    "# PROJECTS",
    "| 代号 | 一句话猜想（未验证） | 版本 | 对象 |",
    "|---|---|---|---|",
    "| `X1` | 加一行入口能把可跑率抬一个量级 | v1 | 外 |",
    "| `X2` | 装置覆盖是 ≥5 层 | v2 | 外 |",
  ].join(String.fromCharCode(10));

  it("★ 原来只扫正文标记 ⇒ 报 0 条；现在认表 ⇒ 2 条（这是我的口径错，不是它没做）", () => {
    const c = conjectures([{ file: "PROJECTS.md", text: projects, mtimeMs: 1 }]);
    assert.equal(c.total, 2);
  });
  it("★ 表头声明「未验证」⇒ 单独标出来（行内一个字都没有也算）", () => {
    const c = conjectures([{ file: "PROJECTS.md", text: projects, mtimeMs: 1 }]);
    assert.equal(c.unverified, 0); // 行内明写
    assert.equal(c.headerDeclared, true); // 但列定义层面标过
  });
  it("正文里明写「猜想：」仍然算（两种写法都认）", () => {
    const c = conjectures([{ file: "P9.md", text: "猜想：门控其实是成本代理", mtimeMs: 1 }]);
    assert.equal(c.total, 1);
  });
});
