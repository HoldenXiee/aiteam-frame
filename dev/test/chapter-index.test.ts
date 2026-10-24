// ★★★ 猜想 D 的判据单测 —— 纯函数，离线、0 API
//
// ★ 纪律⑦：判据纯函数、可离线重判、跑前冻结。
//   这里冻结的是 `extractChapterRefs` / `definedChapter` 的**边界**：
//   什么算章引用、什么不算 —— 这条一旦放宽，悬空引用就会被"解释掉"。

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { chapterNum, definedChapter, extractChapterRefs, scanBook } from "../../research/clusters/forge/micro/checkChapterIndex.ts";

describe("猜想 D · 章号归一", () => {
  it("中文数字与阿拉伯数字都认", () => {
    assert.equal(chapterNum("九"), 9);
    assert.equal(chapterNum("十一"), 11);
    assert.equal(chapterNum("3"), 3);
  });
});

describe("猜想 D · 什么算章引用", () => {
  it("★ 正文里的「第X章」算引用", () => {
    assert.deepEqual(extractChapterRefs("见第九章的处方"), [9]);
  });

  it("★★ 标题行里的「第X章」不算引用（那是定义）", () => {
    assert.deepEqual(extractChapterRefs("# 第九章 · 意图里那个数"), []);
  });

  it("★★★ 代码块里的「第X章」不算引用（那是引用别人的文本）", () => {
    assert.deepEqual(extractChapterRefs("```\n见第九章\n```"), []);
  });

  it("「第X节」不算章引用", () => {
    assert.deepEqual(extractChapterRefs("见第9节"), []);
  });

  it("多个引用去重且排序", () => {
    assert.deepEqual(extractChapterRefs("见第七章与第二章，还有第七章"), [2, 7]);
  });
});

describe("猜想 D · 章号定义", () => {
  it("标题里写第X章 = 定义了它", () => {
    assert.equal(definedChapter("# 第九章 · 意图里那个数\n\n正文"), 9);
  });

  it("标题没写章号 = 没定义章号", () => {
    assert.equal(definedChapter("# 产物的三重身份\n\n正文"), undefined);
  });
});

describe("★★★ 猜想 D · 真实书数据的判据（跑前冻结）", () => {
  // ★ 这些断言是**当前现状的快照**。它红了有两种可能：
  //   ① 书变好了（悬空引用被修掉）—— 那是好事，把断言改小
  //   ② 判据坏了 —— 那要先怀疑判据（纪律⑫）
  const r = scanBook();

  it("书里确实存在章号（否则下面几条没意义）", () => {
    assert.ok(r.existing.length > 0, "一份章号都没有 → 这不是书，是散记");
  });

  it("★★★ 悬空引用确实存在（猜想 D 成立的证据）", () => {
    // 2026-10-20 实测：8 个章号被引用但书里没有（第1-4、6-8、11 章）
    assert.ok(
      r.dangling.length >= 1,
      "悬空引用为 0 ⇒ 猜想 D 不成立，这条规则不必做",
    );
  });

  it("悬空引用总数不超过书里实际章数的 3 倍（若超了说明彻底没结构）", () => {
    assert.ok(r.dangling.length <= r.existing.length * 3 + 1);
  });
});
