/**
 * 项目账量具的测试（纪律㉙：证明它在该失败时会失败）
 *
 * ★ 要防的四件事：
 *   ① 没这一列被当成 false（纪律㉜）
 *   ② 对照那一格写"比现状好"也算数（那是话，不是读数）
 *   ③ 按位置取列（"谁最后写谁算"）
 *   ④ 没账被报成 0（那是"未声明"）
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  controlFilled,
  generalizableText,
  isSelfObject,
  filled,
  isComplete,
  parseProjects,
  projectStats,
  readProjects,
  renderProjects,
  type ProjectRow,
} from "../../research/clusters/hunt/topology/projects.ts";

const NL = String.fromCharCode(10);

describe("filled / controlFilled：占位符不算填了", () => {
  it("空、-、?、未声明、n/a 都不算", () => {
    for (const v of ["", "-", "—", "?", "未声明", "n/a", "NA"]) assert.equal(filled(v), false, v);
  });
  it("有内容就算", () => assert.equal(filled("判 X 与 Y 同一（未验证）"), true));
  it("★★ 对照必须带数字 —— 「比现状好」是话，不是读数", () => {
    assert.equal(controlFilled("比现状好"), false);
    assert.equal(controlFilled("比现状好：误报 31→3 行"), true);
  });
});

describe("parseProjects：按列名取，不按位置", () => {
  const t = [
    "| 代号 | 一句话猜想（未验证） | 版本 | 接口 | 对照读数 | 链深 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| PRJ-1 | 用代码保上下文质量（未验证） | v3 | work/a.mjs | 误报 31→3 | 3 |",
    "| PRJ-2 | 另一条（未验证） | v1 | work/b.mjs | 比现状好 | 1 |",
  ].join(NL);

  it("行数、三段判对", () => {
    const rows = parseProjects(t);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.hasConjecture, true);
    assert.equal(rows[0]!.hasInterface, true);
    assert.equal(rows[0]!.hasControl, true);
    assert.equal(rows[0]!.chainDepth, 3);
  });
  it("★★ 对照没数字 ⇒ hasControl=false（不是 true）", () => {
    const rows = parseProjects(t);
    assert.equal(rows[1]!.hasControl, false);
  });
  it("★ 表头没有那一列 ⇒ null（未声明），不是 false", () => {
    const t2 = ["| 代号 | 一句话猜想 |", "| --- | --- |", "| PRJ-3 | 某想法 |"].join(NL);
    const r = parseProjects(t2)[0]!;
    assert.equal(r.hasInterface, null);
    assert.equal(r.hasControl, null);
    assert.equal(r.chainDepth, null);
  });
  it("不是项目表（没有代号列）⇒ 不解析", () => {
    const t3 = ["| 席位 | 文件 |", "| --- | --- |", "| hands-on | x.md |"].join(NL);
    assert.equal(parseProjects(t3).length, 0);
  });
});

describe("isComplete / projectStats：三段齐必须三段都为真", () => {
  const row = (c: boolean | null, i: boolean | null, o: boolean | null, d: number | null): ProjectRow => ({
    id: "x",
    conjecture: "",
    version: "",
    hasConjecture: c,
    hasInterface: i,
    hasControl: o,
    chainDepth: d,
    object: "",
    objectExternal: null,
    generalizable: null,
  });

  it("三段 true 才算齐", () => {
    assert.equal(isComplete(row(true, true, true, 1)), true);
    assert.equal(isComplete(row(true, true, false, 1)), false);
    assert.equal(isComplete(row(true, true, null, 1)), false); // ★ null 不算
  });
  it("统计对", () => {
    const s = projectStats([row(true, true, true, 5), row(true, false, true, 1), row(true, true, null, 3)]);
    assert.equal(s.total, 3);
    assert.equal(s.complete, 1);
    assert.equal(s.deep, 2); // 链深 5 和 3
    assert.equal(s.withConjecture, 3);
    assert.equal(s.external, 0);
  });
  it("空表不炸", () => {
    const s = projectStats([]);
    assert.equal(s.total, 0);
    assert.equal(s.complete, 0);
  });
  it("★★ 表里没声明对象 ⇒ declaredObject=0（渲染会写「未声明」而不是 0）", () => {
    const s = projectStats([row(true, true, true, 1)]);
    assert.equal(s.declaredObject, 0);
    assert.equal(s.external, 0);
  });
});

describe("★★★ 对象：自指不算（真因分析 §5.1）", () => {
  it("isSelfObject 认得出本 lab 的读数", () => {
    for (const v of ["outbox/EXPERIMENTS.md", "本 lab 的量具", "EXPERIMENTS-hands-on.md", "量具自己"])
      assert.equal(isSelfObject(v), true, v);
  });
  it("外部对象不算自指", () => {
    for (const v of ["work/PRJ-1/lab.ts", "research/clusters/forge", "https://arxiv.org/abs/1"])
      assert.equal(isSelfObject(v), false, v);
  });
  it("表里有「对象」列 ⇒ 判出来", () => {
    const t = [
      "| 代号 | 一句话猜想 | 对象 | 接口 | 对照读数 |",
      "| --- | --- | --- | --- | --- |",
      "| A | 某想法 | work/A/lab.ts | work/a.mjs | 1→3 |",
      "| B | 某想法2 | outbox/EXPERIMENTS.md | work/b.mjs | 1→3 |",
    ].join(NL);
    const rows = parseProjects(t);
    assert.equal(rows[0]!.objectExternal, true);
    assert.equal(rows[1]!.objectExternal, false);
  });
});

describe("★★★ 可推广 + 边界：两句都要（只有可推广是口号）", () => {
  it("两句都有 ⇒ true", () => {
    const t = ["可推广：多座位并行时，判决要按写入顺序定", "边界：单座位时这条不成立"].join(NL);
    assert.equal(generalizableText(t), true);
  });
  it("★ 只有「可推广」 ⇒ false", () => {
    assert.equal(generalizableText("可推广：多座位并行时更好"), false);
  });
  it("空文本 ⇒ false", () => assert.equal(generalizableText(""), false));
});

describe("renderProjects：没有账 = 未声明，不是 0", () => {
  it("mode=none 时明确说未声明", () => {
    const txt = renderProjects(
      { total: 0, complete: 0, deep: 0, declared: 0, withConjecture: 0, external: 0, selfReferential: 0, generalizable: 0, declaredObject: 0, declaredGeneral: 0 },
      "none",
    );
    assert.ok(txt.includes("未声明"), txt);
    assert.ok(!/三段齐 0/.test(txt), txt);
  });
  it("有账时报三个数", () => {
    const txt = renderProjects({ total: 4, complete: 1, deep: 2, declared: 1, withConjecture: 3, external: 3, selfReferential: 1, generalizable: 2, declaredObject: 4, declaredGeneral: 4 }, "table");
    assert.ok(txt.includes("三段齐 1"), txt);
    assert.ok(txt.includes("链深≥3 的 2"), txt);
  });
});

describe("readProjects：传错根要抛错", () => {
  it("给 outbox 路径 ⇒ 抛", () => {
    assert.throws(() => readProjects("research/labfirst/hunt/outbox"), /集群空间根/);
  });
  // ★ 不能用真 lab 当"没有账"的样本 —— 它现在已经建了 PROJECTS.md（活状态会变）。
  //   用仓库里一个确定没有 outbox/PROJECTS.md 的目录。
  it("没有 PROJECTS.md ⇒ mode=none（不是报错）", () => {
    const r = readProjects("dev");
    assert.equal(r.mode, "none");
    assert.equal(r.rows.length, 0);
  });
});
