// ★★★ 书的目录与章号一致性测试
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么有这个文件（三个真实踩到的坑，每个都静默算错）
//
//   坑① 只认阿拉伯数字
//     ⇒ 书里几乎全是「第十一章」这种中文数字 ⇒ 漏掉 240/241 次引用
//   坑② 「十」单独作捕获组
//     ⇒ `toNum("十")` 返回 NaN ⇒ 「第十章」整个漏掉
//   坑③ ★★★「一」这个键里混进了**不可见字符 U+3164**
//     ⇒ `CN_DIGITS["一"]` 是 undefined ⇒ `10 + 0 = 10`
//     ⇒ **「第十一章」被算成「第十章」**，两个章号合成一个
//     ⇒ 症状极难查：11 既不在 existing 也不在 dangling（它变成了 10）
//
//   ★★★ 三个坑的共同点：**不报错，只是算错**。
//     所以这里全部用「已知输入 → 已知输出」锁死。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { chapterDrift, syncSummary } from "../../research/clusters/forge/tools/summary.ts";

const SANDBOX = join(import.meta.dirname, "_sbx-summary");
const SUB = "05-集群产出";

/** ★ 造一个假书 */
function makeBook(files: Record<string, string>): string {
  assert.ok(SANDBOX.includes("_sbx"), "只许动沙箱");
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(join(SANDBOX, SUB), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(SANDBOX, SUB, name), text);
  return SANDBOX;
}

describe("★★★ 章号解析：三个坑各一条", () => {
  it("★ 坑①中文数字认得（第十一章 = 11，不是 1 也不是 0）", () => {
    const src = makeBook({
      "a.md": "# 无关标题\n\n见第十一章 和 第3章 和 第九章。",
    });
    const d = chapterDrift({ bookSrc: src });
    assert.equal(d.totalRefs, 3);
    // ★ 11 是中文、3 是阿拉伯、9 是中文 —— 三个都要进 dangling（书里没有它们）
    assert.deepEqual([...d.dangling.keys()].sort((a, b) => a - b), [3, 9, 11]);
  });

  it("★★ 坑②「第十章」不能被漏（十 单独作捕获组 = 10）", () => {
    const src = makeBook({ "a.md": "# 标题\n\n见第十章。" });
    const d = chapterDrift({ bookSrc: src });
    assert.equal(d.totalRefs, 1);
    assert.deepEqual([...d.dangling.keys()], [10]);
  });

  it("★★★ 坑③「十一」不能变成「十」（隐形字符会让 10+0=10）", () => {
    // ★ 这条专门守 U+3164 那个 bug：若 CN_DIGITS["一"] 丢失，
    //   「十一」会被算成 10 ⇒ 下面的 deepEqual 会失败
    const src = makeBook({ "a.md": "# 标题\n\n见第十一章 与 第十章。" });
    const d = chapterDrift({ bookSrc: src });
    const keys = [...d.dangling.keys()].sort((a, b) => a - b);
    assert.deepEqual(keys, [10, 11], "十一 和 十 必须是两个不同的章号");
  });

  it("★ 标题行不算引用（那是它的自称）", () => {
    const src = makeBook({ "a.md": "# 第九章 · 意图里那个数\n\n正文没有任何章引用。" });
    const d = chapterDrift({ bookSrc: src });
    assert.equal(d.totalRefs, 0);
    assert.deepEqual(d.existing, [9], "标题里的章号要进 existing");
  });
});

describe("★★★ existing 的判定", () => {
  it("★ 标题里有章号 ⇒ 算存在", () => {
    const src = makeBook({ "x.md": "# 第十章 · 判据定价\n\n正文。" });
    assert.deepEqual(chapterDrift({ bookSrc: src }).existing, [10]);
  });

  it("★ 文件名里有章号也算存在", () => {
    const src = makeBook({ "理论-第九章-某题.md": "# 某标题\n\n正文。" });
    assert.deepEqual(chapterDrift({ bookSrc: src }).existing, [9]);
  });

  it("★★ 存在的章不算悬空", () => {
    const src = makeBook({
      "x.md": "# 第五章 · 开头\n\n见第五章。",
      "y.md": "# 别的\n\n见第五章 和 第七章。",
    });
    const d = chapterDrift({ bookSrc: src });
    assert.deepEqual(d.existing, [5]);
    assert.deepEqual([...d.dangling.keys()], [7], "第 5 章存在，不该算悬空");
  });
});
describe("★★★ 目录一致性 syncSummary：只报数，不改结构", () => {
  /**
   * ★★★ 为什么这一组是「只报不改」
   *
   *   第一版 `syncSummary` **自动追加**缺的条目。实测后果（29 份产物）：
   *     · 原有那一节（手写、有分组）11 条
   *     · ★ 它自动新建 `## 05-集群产出` 一节，平铺 19 条
   *   ⇒ **目录分裂成两块**，读者看到两份目录。
   *
   *   ★★ 这正是 AGENTS §三 说的 forge 的病：「还在散记，只是写得更长」。
   *   ★ 而且"哪一份放哪一节"是**内容判断**（硬规则①：归集群，不归我）。
   *   ⇒ 现在它只把「读者点不到哪几份」算出来，**一个字都不写**。
   */

  const NL = String.fromCharCode(10);
  const summaryWith = (lines: string) =>
    ["# 摘要", "", "- [前言](前言.md)", "", "## 05-集群产出", "", lines, "", "## 其他", "", "- [x](x.md)", ""].join(NL);

  it("★★★ 报出读者点不到的那几份（但不写盘）", () => {
    const src = makeBook({ "a.md": "# a", "b.md": "# b", "c.md": "# c" });
    const before = summaryWith("- [a](05-集群产出/a.md)");
    writeFileSync(join(src, "SUMMARY.md"), before);

    const r = syncSummary({ bookSrc: src });
    assert.equal(r.total, 3);
    assert.deepEqual(r.added.sort(), ["b.md", "c.md"], "没报出读者点不到的");
    assert.equal(r.alreadyListed, 1);

    // ★★★ 关键：目录**一个字都不能变**
    assert.equal(readFileSync(join(src, "SUMMARY.md"), "utf8"), before, "它偷偷改了目录结构");
  });

  it("★★★ 绝不新建节（第一版就是新建了 `## 05-集群产出` 把目录搞分裂）", () => {
    const src = makeBook({ "a.md": "# a" });
    const before = ["# 摘要", "", "- [前言](前言.md)", ""].join(NL); // ★ 根本没有 05 这一节
    writeFileSync(join(src, "SUMMARY.md"), before);

    const r = syncSummary({ bookSrc: src });
    assert.deepEqual(r.added, ["a.md"]);
    assert.equal(readFileSync(join(src, "SUMMARY.md"), "utf8"), before, "新建了一节 —— 目录被它改写");
  });

  it("★ 全都在目录里 ⇒ 报 0 份点不到", () => {
    const src = makeBook({ "a.md": "# a", "b.md": "# b" });
    writeFileSync(
      join(src, "SUMMARY.md"),
      summaryWith(["- [a](05-集群产出/a.md)", "  - [b](05-集群产出/b.md)"].join(NL)),
    );
    const r = syncSummary({ bookSrc: src });
    assert.deepEqual(r.added, []);
    assert.equal(r.alreadyListed, 2);
  });

  it("★★ 目录里指向不存在的文件 ⇒ 报成悬空条目（读者点了 404）", () => {
    const src = makeBook({ "a.md": "# a" });
    writeFileSync(
      join(src, "SUMMARY.md"),
      summaryWith(["- [a](05-集群产出/a.md)", "  - [没了](05-集群产出/ghost.md)"].join(NL)),
    );
    const r = syncSummary({ bookSrc: src });
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.danglingEntries, ["ghost.md"], "悬空条目没报出来");
  });

  it("★ 幂等：跑两次结果一样（因为它不改盘）", () => {
    const src = makeBook({ "a.md": "# a", "b.md": "# b" });
    writeFileSync(join(src, "SUMMARY.md"), summaryWith("- [a](05-集群产出/a.md)"));
    const r1 = syncSummary({ bookSrc: src });
    const r2 = syncSummary({ bookSrc: src });
    assert.deepEqual(r1.added, r2.added);
    assert.deepEqual(r1.danglingEntries, r2.danglingEntries);
  });
});
