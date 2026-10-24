/**
 * forge → hunt 交接口的测试
 *
 * ★ 要防的三个错（都是我会犯的）：
 *   ① 读不到就写 0（纪律㉜）—— 发布账读不到必须是 null
 *   ② 「没装置」被写成"我觉得没验证"（那变成内容判断）
 *   ③ 把处境写成任务清单
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeBook,
  hasDevice,
  parsePending,
  parsePublished,
  renderBookState,
} from "../../research/clusters/hunt/topology/forge-state.ts";

describe("hasDevice：只认带扩展名的可跑路径", () => {
  it("mjs/ts/jsonl 都算", () => {
    assert.equal(hasDevice("见 work/a.mjs"), true);
    assert.equal(hasDevice("读数在 research/x/runs/b.jsonl"), true);
  });
  it("★ 目录名不算（`lib/aiteam` 没有扩展名）", () => {
    assert.equal(hasDevice("改的是 lib/aiteam 和 outbox"), false);
  });
  it("空串不算", () => assert.equal(hasDevice(""), false));
});

describe("parsePublished：读不到给 null，不猜 0", () => {
  it("认「已发布 N 份」", () => assert.equal(parsePublished("## ✔ 已发布 36 份"), 36));
  it("★ 没有这句话 ⇒ null", () => assert.equal(parsePublished("随便写点"), null));
});

describe("parsePending：取最大 N", () => {
  it("多个取最大", () => {
    assert.equal(parsePending(["PENDING-9.md", "PENDING-43.md", "PENDING-2.md"]), 43);
  });
  it("★ 一个都没有 ⇒ null（不是 0）", () => assert.equal(parsePending(["a.md", "b.md"]), null));
});

describe("analyzeBook：装置缺口", () => {
  const files = [
    { name: "短-无装置.md", text: "只有话，没有任何路径" },
    { name: "长-无装置.md", text: "另一个".repeat(100) },
    { name: "有装置.md", text: "读数在 work/a.jsonl" },
  ];
  const s = analyzeBook(files, 36, 43);

  it("数对", () => {
    assert.equal(s.chapters, 3);
    assert.equal(s.deviceFree, 2);
    assert.equal(s.published, 36);
    assert.equal(s.pendingConditions, 43);
  });
  it("★ 样本按短到长（短的先补）", () => {
    assert.equal(s.deviceFreeSample[0]!.name, "短-无装置.md");
  });
  it("空书不炸且 published=null 保持 null", () => {
    const e = analyzeBook([], null, null);
    assert.equal(e.chapters, 0);
    assert.equal(e.deviceFree, 0);
    assert.equal(e.published, null);
  });
});

describe("renderBookState：是处境，不是任务清单", () => {
  const txt = renderBookState(
    analyzeBook([{ name: "a.md", text: "无装置" }], 36, 43),
  );
  it("报未兑现条件与装置缺口", () => {
    assert.ok(txt.includes("43"), txt);
    assert.ok(txt.includes("1 章"), txt);
  });
  it("★★ 不许出现祈使句（你去 / 请你 / 必须去）—— 那是任务清单", () => {
    assert.ok(!/你去|请你|必须去|你需要做/.test(txt), txt);
  });
  it("★ 读不到发布账时说「未声明」，不说 0", () => {
    const t2 = renderBookState(analyzeBook([], null, null));
    assert.ok(t2.includes("未声明"), t2);
  });
});
