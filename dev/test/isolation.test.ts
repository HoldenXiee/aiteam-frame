// ★★★ 「散记」的可算代理量（2026-10-20）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么需要它
//
//   `missions.ts` 的 `forge.antiValue` 最重那句：
//     「★★ 一句话：**没长出新概念的内容，不算这本教科书的内容。**」
//   ★★ 实测 `grep "概念|定义|模型" rules.ts` ⇒ **12 条规则里 0 条提到**
//   ⇒ 零出口（纪律㉕）。
//
// ★★★ 但判"有没有新概念"是**内容判断**（硬规则①，我不能碰）。
//   ⇒ 只算一个可数的代理量：**这份产物引用了多少份别的产物**。
//   ⇒ 而它**只报数、不拦截**（零引用也可能是真的新方向）。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findIsolated, renderIsolation } from "../../research/clusters/forge/tools/isolation.ts";

const SBX = join(import.meta.dirname, "_sbx-isolation");

function setup(files: Record<string, string>): string {
  assert.ok(SBX.includes("_sbx"), "只许动沙箱");
  rmSync(SBX, { recursive: true, force: true });
  mkdirSync(SBX, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(SBX, name), text);
  return SBX;
}

// ★ 文件名前缀必须够长（≥8 字）才会被当成指称标记
const A = "理论-甲主题-很长很长很长的标题.md";
const B = "理论-乙主题-另一个很长的标题.md";
const C = "实践-丙主题-第三个很长的标题.md";

describe("★★★ 孤立产物（散记的可算代理量）", () => {
  it("★★★ 一份都不提别人 ⇒ 零引用", () => {
    const dir = setup({ [A]: "# 我自己说自己的\n", [B]: "# 我也不提别人\n" });
    const r = findIsolated(dir);
    assert.equal(r.all.length, 2);
    assert.equal(r.isolated.length, 2, "两份都没引用，应该都算孤立");
  });

  it("★★★ 提到了另一份的文件名 ⇒ 不算孤立（这是唯一的判据）", () => {
    const dir = setup({
      // ★ 判据是「文件名前 12 字」，所以正文里要出现那 12 字
      [A]: "# 甲\n\n参见 `理论-乙主题-另一个很长` 那一份。\n",
      [B]: "# 乙\n",
    });
    const r = findIsolated(dir);
    const a = r.all.find((x) => x.artifact === A)!;
    assert.equal(a.cites, 1, "应该数到 1 次引用");
    // ★★★ 2026-10-21 修：B 没提别人，但**A 提了它**
    //   ⇒ B 是「被依赖的源头」，**不是**散记（旧判据在这里错了）
    const b = r.all.find((x) => x.artifact === B)!;
    assert.equal(b.cites, 0);
    assert.equal(b.citedBy, 1);
    assert.equal(b.role, "source", "★ 被引用 ⇒ 源头，不是孤岛");
    assert.equal(r.isolated.length, 0, "★ 没有真孤岛（旧判据会报 1）");
  });

  it("★★ `_` 开头的汇总文件被跳过（它本来就是索引）", () => {
    const dir = setup({ [A]: "# 甲\n", "_决策表.md": `引 ${A} 是它的职责\n` });
    const r = findIsolated(dir);
    assert.equal(r.all.length, 1, "下划线文件不该进分布");
  });

  it("★★ 可以关掉跳过（明确要看全部）", () => {
    const dir = setup({ [A]: "# 甲\n", "_决策表.md": "x\n" });
    assert.equal(findIsolated(dir, { stripUnderscore: false }).all.length, 2);
  });

  it("★★★ 太短的标记不误命中（防止文件名前 12 字太泛）", () => {
    const dir = setup({ "短.md": "# 短\n", [A]: "短 这个词在正文里到处都是\n" });
    const r = findIsolated(dir);
    // "短" 只有 1 字 < 8 ⇒ 不算指称
    const a = r.all.find((x) => x.artifact === A)!;
    assert.equal(a.cites, 0, "短标记不该被当成引用");
  });

  it("★ 打印用的一行不炸", () => {
    const dir = setup({ [A]: "# 甲\n", [B]: "# 乙\n" });
    const s = renderIsolation(findIsolated(dir));
    // ★★★ 2026-10-21：措辞改成「真孤岛」，并且报四种角色
    assert.ok(s.includes("真孤岛"), `输出不对：${s}`);
    assert.ok(s.includes("份"), `输出不对：${s}`);
  });

  it("★ 空目录不炸", () => {
    const r = findIsolated(join(import.meta.dirname, "_not-exist-isolation"));
    assert.equal(r.all.length, 0);
    assert.equal(r.isolated.length, 0);
  });

  it("★ 排序：引用少的在前（孤立的最靠前）", () => {
    const dir = setup({
      [A]: `提到 ${"理论-乙主题"} 了\n`,
      [B]: "# 乙，谁也不提\n",
    });
    const r = findIsolated(dir);
    assert.equal(r.all[0]!.cites, 0, "零引用的应该排最前");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 防「刷指标」（2026-10-20）
//
//   我上一节刚把「零引用」变成可见的坏指标 ——
//   ★★ 这就等于告诉集群「塞一句文件名就能过关」。
//   ⇒ 所以同批上线质量判据：**「提到」和「说了什么关于它」是两件事**。
//
//   ★ 实测基线（62 份 / 124 次提及）：光秃秃 **0 次（0%）** —— 现在没被刷。
//   ★★ 以后这个比例涨上去，就是被刷了。
// ══════════════════════════════════════════════════════════════════════════

import { auditCitations, citationQuality } from "../../research/clusters/forge/tools/isolation.ts";

const O = "理论-乙主题-另一个很长的标题.md";

describe("★★★ 防刷指标：提到 ≠ 说了什么", () => {
  it("★★★ 光秃秃的引用（只有文件名）⇒ bare = true", () => {
    const r = auditCitations("参见 `理论-乙主题-另一个很长`。", A, [A, O]);
    assert.equal(r.total, 1);
    assert.equal(r.bare, 1, "「参见 x.md」应该被判成光秃秃");
  });

  it("★★★ 有主张的引用 ⇒ bare = false", () => {
    const r = auditCitations(
      "`理论-乙主题-另一个很长` 的 κ2<1 只证明了形状是前提，不是它落地的原因。",
      A,
      [A, O],
    );
    assert.equal(r.total, 1);
    assert.equal(r.bare, 0, "有实质内容的引用不该被判成光秃秃");
  });

  it("★★ 「另见 / 详见」这类连接词不算内容", () => {
    for (const s of ["另见 理论-乙主题-另一个很长", "详见 理论-乙主题-另一个很长", "同上 理论-乙主题-另一个很长"]) {
      const r = auditCitations(s + "。", A, [A, O]);
      assert.equal(r.bare, 1, `「${s}」应该算光秃秃`);
    }
  });

  it("★★ 一句话里提到两份，句子里有内容 ⇒ 两份都不算光秃", () => {
    const P = "实践-丙主题-第三个很长的标题.md";
    const t =
      "`理论-乙主题-另一个很长` 和 `实践-丙主题-第三个很长` 都犯同一个错：把形状当判据。";
    const r = auditCitations(t, A, [A, O, P]);
    assert.equal(r.total, 2);
    assert.equal(r.bare, 0);
  });

  it("★★ 自己不算自己的引用", () => {
    const r = auditCitations(`参见 ${"理论-甲主题-很长很长很长"}`, A, [A]);
    assert.equal(r.total, 0);
  });

  it("★ 全库质量读数不炸", () => {
    const q = citationQuality(join(import.meta.dirname, "_not-exist-cq"));
    assert.equal(q.total, 0);
    assert.equal(q.barePct, 0);
  });
});

// ★★★★★ 2026-10-21 · 四种角色：只有「两边都为零」才是散记
//
// ★★★ 这是第三次修我的量具（前两次：mtime、分母）：
//   我原来只数**出度**（它引用了谁），把 19 份判成散记。
//   ★ 实测：其中 8 份是**被别人大量引用的**（例：`实践-冗余买不到数` 被引 5 次）
//     ⇒ 那 8 份是「别的章的根据」，源头本来就不需要引用别人。
//   ★★ 真孤岛实测 **3 份**，我的旧判据夸大了 **6 倍**。
//   ★★★ 而且这个错数每轮都被递给集群 ⇒ 逼它去救 8 份本来就好的章。
describe("★★★★★ 四种角色（只有 island 是病）", () => {
  it("★★★★★ 两边都为零 ⇒ island（真散记）", () => {
    // ★ 两份都不提对方 ⇒ 两份都是岛
    const r = findIsolated(setup({ [A]: "# 甲 只讲自己", [B]: "# 乙 也只讲自己" }));
    assert.equal(r.isolated.length, 2, "★ 互相不提 ⇒ 都是岛");
    assert.equal(r.all.find((x) => x.artifact === A)!.role, "island");
  });

  it("★★★★ 互相提 ⇒ 都不是 island", () => {
    const d = setup({
      [A]: "# 甲 提乙 " + B.slice(0, 12),
      [B]: "# 乙 提甲 " + A.slice(0, 12),
    });
    assert.equal(findIsolated(d).isolated.length, 0);
  });

  it("★★★★ source（出 0 入 >0）= 被依赖的源头，**不算病**", () => {
    // A 提 B；B 谁都不提 ⇒ B 是 source
    const r = findIsolated(setup({ [A]: "# 甲\n\n见 " + B.slice(0, 12) + "\n", [B]: "# 乙\n" }));
    const b = r.all.find((x) => x.artifact === B)!;
    assert.equal(b.role, "source");
    assert.equal(r.isolated.length, 0, "★ 源头不该被算成散记");
  });

  it("★★★★ sink（出 >0 入 0）= 只引用别人，**不算病**", () => {
    const r = findIsolated(setup({ [A]: "# 甲\n\n见 " + B.slice(0, 12) + "\n", [B]: "# 乙\n\n只讲自己\n" }));
    const a = r.all.find((x) => x.artifact === A)!;
    assert.equal(a.role, "sink", "★ A 提了 B，但没人提 A ⇒ 综述型");
  });
});
