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
  });
  it("空表不炸", () => {
    const s = projectStats([]);
    assert.equal(s.total, 0);
    assert.equal(s.complete, 0);
  });
});

describe("renderProjects：没有账 = 未声明，不是 0", () => {
  it("mode=none 时明确说未声明", () => {
    const txt = renderProjects(
      { total: 0, complete: 0, deep: 0, declared: 0, withConjecture: 0 },
      "none",
    );
    assert.ok(txt.includes("未声明"), txt);
    assert.ok(!/三段齐 0/.test(txt), txt);
  });
  it("有账时报三个数", () => {
    const txt = renderProjects({ total: 4, complete: 1, deep: 2, declared: 1, withConjecture: 3 }, "table");
    assert.ok(txt.includes("三段齐 1"), txt);
    assert.ok(txt.includes("链深≥3 的 2"), txt);
  });
});

describe("readProjects：传错根要抛错", () => {
  it("给 outbox 路径 ⇒ 抛", () => {
    assert.throws(() => readProjects("research/labfirst/hunt/outbox"), /集群空间根/);
  });
  it("没有 PROJECTS.md ⇒ mode=none（不是报错）", () => {
    const r = readProjects("research/labfirst/hunt");
    assert.equal(r.mode, "none");
    assert.equal(r.rows.length, 0);
  });
});
