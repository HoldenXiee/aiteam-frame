// ★★★ 书本身的可读性判据（2026-10-20）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么需要这个文件
//
//   在它之前，所有读数都是**门视角**：已发几份 / 被拒几份 / 带保留几份。
//   ★★ 这些回答不了最要紧的那个问题：
//     **门砍掉 86% 之后，剩下的是"精华"还是"侥幸过关的少数"？**
//
//   ★ 所以这里只算**结构量**（可数、可离线重判），不判内容对错 ——
//     "14 份理论是不是太多" 是内容判断，归集群（硬规则①）。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bookReport, renderBookReport } from "../../research/clusters/forge/tools/bookreport.ts";

const SANDBOX = join(import.meta.dirname, "_sbx-bookreport");
const SUB = "05-集群产出";
const NL = String.fromCharCode(10);

/** ★ 造一本假书（★ 只动沙箱）*/
function makeBook(files: Record<string, string>, summary?: string): string {
  assert.ok(SANDBOX.includes("_sbx"), "只许动沙箱");
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(join(SANDBOX, SUB), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(SANDBOX, SUB, name), text);
  writeFileSync(join(SANDBOX, "SUMMARY.md"), summary ?? "");
  return SANDBOX;
}

const links = (...names: string[]) =>
  ["# 摘要", "", ...names.map((n) => `- [${n}](${SUB}/${n})`), ""].join(NL);

describe("★★★ 书本身：目录可达性", () => {
  it("★★ 书里有但目录没列 ⇒ 报「读者点不到」", () => {
    const src = makeBook(
      { "a.md": "# a", "b.md": "# b", "c.md": "# c" },
      links("a.md"),
    );
    const r = bookReport({ bookSrc: src });
    assert.equal(r.files, 3);
    assert.equal(r.listed, 1);
    assert.equal(r.unreachable, 2, "没算对点不到的份数");
  });

  it("★★ 目录列全了 ⇒ 点不到 0", () => {
    const src = makeBook({ "a.md": "# a", "b.md": "# b" }, links("a.md", "b.md"));
    assert.equal(bookReport({ bookSrc: src }).unreachable, 0);
  });

  it("★★★ 目录指向不存在的文件 ⇒ 悬空条目（读者点了 404）", () => {
    const src = makeBook({ "a.md": "# a" }, links("a.md", "ghost.md"));
    const r = bookReport({ bookSrc: src });
    assert.equal(r.danglingEntries, 1);
  });
});

describe("★★★ 书本身：章号引用", () => {
  it("★★ 存在 + 悬空分开算", () => {
    const src = makeBook(
      {
        "x.md": "# 第五章 · 开头" + NL + NL + "见第七章 和 第九章。",
      },
      links("x.md"),
    );
    const r = bookReport({ bookSrc: src });
    assert.deepEqual(r.chapters.existing, [5]);
    assert.deepEqual(r.chapters.dangling, [7, 9]);
    assert.equal(r.chapters.refs, 2);
    assert.equal(r.chapters.lost, 2);
  });

  it("★★★ 中文数字不能算错（第十一章 ≠ 第十章）", () => {
    const src = makeBook({ "x.md": "# 标题" + NL + NL + "见第十一章 与 第十章。" }, links("x.md"));
    const r = bookReport({ bookSrc: src });
    assert.deepEqual(r.chapters.dangling, [10, 11], "十一 和 十 被合并了");
  });

  it("★ 全部落空 ⇒ lost = refs", () => {
    const src = makeBook({ "x.md": "# t" + NL + NL + "第一章 第二章" }, links("x.md"));
    const r = bookReport({ bookSrc: src });
    assert.equal(r.chapters.lost, r.chapters.refs);
  });
});

describe("★★★ 书本身：主题聚类", () => {
  it("★★★ 同前缀的份数要能数出来（读者要读这一块得读几份）", () => {
    const src = makeBook(
      {
        "理论-甲.md": "# a",
        "理论-乙.md": "# b",
        "理论-丙.md": "# c",
        "实践-丁.md": "# d",
      },
      links("理论-甲.md", "理论-乙.md", "理论-丙.md", "实践-丁.md"),
    );
    const r = bookReport({ bookSrc: src });
    assert.equal(r.clusters[0]!.prefix, "理论");
    assert.equal(r.clusters[0]!.count, 3);
    assert.equal(r.clusters[0]!.names.length, 3);
    // ★ 按份数降序
    assert.equal(r.clusters[1]!.prefix, "实践");
  });

  it("★ 无前缀的文件归到一个桶（不丢）", () => {
    const src = makeBook({ "孤零零.md": "# a" }, links("孤零零.md"));
    const r = bookReport({ bookSrc: src });
    assert.equal(r.clusters.length, 1);
    assert.equal(r.clusters[0]!.prefix, "（无前缀）");
  });
});

describe("★★★ 书本身：研究痕迹占比", () => {
  it("★★ 修订记录 / work 路径 / jsonl 算痕迹", () => {
    const body = [
      "# 标题",
      "正文第一段。",
      "## 修订记录 v4",
      "| 1 | 旧 | 新 | 凭什么 |",
      "见 `work/architect/runs/x.jsonl` 的 12 行",
      "复算了一遍。",
    ].join(NL);
    const src = makeBook({ "a.md": body }, links("a.md"));
    const r = bookReport({ bookSrc: src });
    assert.ok(r.traces.lines >= 4, `痕迹只算了 ${r.traces.lines} 行`);
    assert.ok(r.traces.ratio > 0.5, "占比算错了");
  });

  it("★ 纯正文 ⇒ 痕迹 0", () => {
    const body = ["# 标题", "", "这是正文。", "这是第二句。"].join(NL);
    const src = makeBook({ "a.md": body }, links("a.md"));
    assert.equal(bookReport({ bookSrc: src }).traces.lines, 0);
  });
});

describe("★★★ 空书不炸", () => {
  it("★ 目录不存在 ⇒ 全 0，不抛错", () => {
    const r = bookReport({ bookSrc: join(import.meta.dirname, "_not-exist-xyz") });
    assert.equal(r.files, 0);
    assert.equal(r.unreachable, 0);
  });

  it("★ renderBookReport 不抛错", () => {
    const src = makeBook({ "a.md": "# a" }, links("a.md"));
    const s = renderBookReport(bookReport({ bookSrc: src }));
    assert.ok(s.includes("书 1 份"));
  });
});
