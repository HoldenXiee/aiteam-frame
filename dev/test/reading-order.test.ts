// ★★★ 认知顺序（2026-10-20）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者原话（这一整个判据的设计依据）
//
//   「主要的就是违反了人的认知规律，在学习陌生知识，
//     **如果学过前置知识（或类似知识）就能轻松学会**，
//     反正要符合人的认知规律」
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 翻译成可算的量
//
//   前置知识律：**要懂 A，得先懂 A 依赖的东西。**
//   ⇒ 一份产物引用了排在它**后面**的东西 ⇒ 读者得"先读后面才能懂前面"
//     ⇒ 这叫**前置倒挂**。
//
//   ★ 合格的教科书：倒挂 = 0
//   ★★ 现在的 forge：倒挂 8/29 份，最远跨 27 份
//
// ★★★ 为什么不算是内容判断：
//   只问「提到了谁 + 谁排得晚」，不判断该不该引用、也不定该怎么重排。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { jargonIn, readingOrder, renderOrder, undefinedTerms } from "../../research/clusters/forge/tools/reading-order.ts";

const SBX = join(import.meta.dirname, "_sbx-order");
const SUB = "05-集群产出";
const NL = String.fromCharCode(10);

function book(files: Record<string, string>, order: string[]): string {
  assert.ok(SBX.includes("_sbx"), "只许动沙箱");
  rmSync(SBX, { recursive: true, force: true });
  mkdirSync(join(SBX, SUB), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(SBX, SUB, name), text);
  const summary = ["# 目录", "", ...order.map((n) => `- [${n}](${SUB}/${n})`), ""].join(NL);
  writeFileSync(join(SBX, "SUMMARY.md"), summary);
  return SBX;
}

// ★ 文件名前 12 字才是指称标记
// ★ 注意：文件名前 12 字必须**互不相同**，否则判据分不清（这是真实缺陷，见测试 §末）
const A = "理论-甲说-怎么落地.md";
const B = "理论-乙说-为什么落地.md";

describe("★★★ 前置倒挂：能不能顺着学", () => {
  it("★★★ 先说 A 后说 B，而 B 引用 A ⇒ **不算倒挂**（这是对的顺序）", () => {
    const src = book(
      { [A]: "# 甲" + NL, [B]: `# 乙${NL}参见 \`理论-甲说-怎么落地\` 那一份。${NL}` },
      [A, B],
    );
    const r = readingOrder({ bookSrc: src });
    assert.equal(r.forwardCount, 0, "正序引用被误判成倒挂");
    assert.equal(r.withForward, 0);
  });

  it("★★★ 实测的病：第 1 份引用第 2 份 ⇒ **倒挂**（读者得先读后面）", () => {
    const src = book(
      { [A]: `# 甲${NL}参见 \`理论-乙说-为什么落地\` 那一份。${NL}`, [B]: "# 乙" + NL },
      [A, B],
    );
    const r = readingOrder({ bookSrc: src });
    assert.equal(r.forwardCount, 1, "倒挂没被检出");
    assert.equal(r.withForward, 1);
    assert.deepEqual(r.worst[0]!.forward, [B]);
  });

  it("★★★ 「最远跨几份」要算出来（实测跨 27 份 = 读到第 1 份就要懂第 28 份）", () => {
    const mid = Array.from({ length: 10 }, (_, i) => `理论-中间第${i}号-标题很长很长.md`);
    const files: Record<string, string> = {};
    for (const m of mid) files[m] = "# 中间" + NL;
    files[A] = `# 甲${NL}参见 \`理论-乙说-为什么落地\` 那一份。${NL}`;
    files[B] = "# 乙" + NL;
    const src = book(files, [A, ...mid, B]);
    const r = readingOrder({ bookSrc: src });
    assert.equal(r.maxJump, 11, `最远跨度算错了：${r.maxJump}`);
  });

  it("★★ 按**目录顺序**算，不是文件名顺序", () => {
    // 文件名排序是 A < B，但目录里故意把 B 放前面
    const src = book(
      {
        [A]: `# 甲${NL}参见 \`理论-乙说-为什么落地\`。${NL}`,
        [B]: "# 乙" + NL,
      },
      [B, A], // ★ 目录里 B 在前
    );
    const r = readingOrder({ bookSrc: src });
    assert.equal(r.forwardCount, 0, "应该按目录顺序判（B 在前，A 引用 B 是正序）");
  });

  it("★ 一行读数不炸", () => {
    const src = book({ [A]: "# 甲" + NL }, [A]);
    const s = renderOrder(readingOrder({ bookSrc: src }));
    assert.ok(s.includes("前置倒挂"), s);
  });

  it("★ 空目录不炸", () => {
    const r = readingOrder({ bookSrc: join(import.meta.dirname, "_nope-order") });
    assert.equal(r.total, 0);
    assert.equal(renderOrder(r), "（没有可算的产物）");
  });
});

describe("★★★ 术语：黑话识别与定义覆盖", () => {
  it("★★ 实验批号算黑话（R7 / W8 / S1Q1）", () => {
    const j = jargonIn("R7 的 16 轮 + S1Q1 跑了 W8 那次");
    assert.ok(j.total >= 3, `只认出 ${j.total} 个`);
    assert.ok(j.kinds.includes("R7"));
  });

  it("★★★ 读数 `0×4` 不算黑话（修过一次误判）", () => {
    const j = jargonIn("表里 0×4 和 12×12 都是读数");
    assert.equal(j.total, 0, "把表格读数当成术语了 —— 会污染整个判据");
  });

  it("★★ `2x2` / `2×2` 算黑话（是实验设计名）", () => {
    assert.ok(jargonIn("2×2 的两个处方").total >= 1);
    assert.ok(jargonIn("2x2 的两个处方").total >= 1);
  });

  it("★★★ 定义页覆盖了的算「已定义」，没覆盖的算「未定义」", () => {
    const defPage = "00a-定义页-九个词与一次走完.md";
    const src = book(
      {
        [defPage]: `# 定义页${NL}R7 是第一批实验。${NL}`, // ★ 只定义了 R7
        [A]: `# 甲${NL}R7 和 W8 都跑过，PREREG 冻结了。${NL}`,
      },
      [defPage, A],
    );
    const u = undefinedTerms({ bookSrc: src });
    assert.ok(u.defined.includes("R7"), "定义页有的应该算已定义");
    assert.ok(u.undefined.includes("W8"), "定义页没有的应该算未定义");
    assert.ok(u.rate > 0 && u.rate < 1);
  });

  it("★★ 没有定义页 ⇒ 全部未定义（这本身就是个读数）", () => {
    const src = book({ [A]: "# 甲" + NL + "R7 和 W8" + NL }, [A]);
    const u = undefinedTerms({ bookSrc: src });
    assert.equal(u.defined.length, 0);
    assert.ok(u.undefined.length > 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★★ 一个我以为有的缺陷，实测**没有**（记下来，省得以后再猜）
//
//   我担心：两份文件名前 12 字相同 ⇒ 判据分不清谁引用谁。
//   ★★★ 实测：**不会** —— 代码里有 `if (g === f) continue`，自身被正确跳过。
//
//   ⇒ 前 12 字相同的两份，只是"互相看起来像提到了对方"，
//     而自身那一份被跳过，所以**不会**产生假的倒挂。
// ★ 这个假设作废，不需要修。
// ══════════════════════════════════════════════════════════════════════════
describe("★★ 以为的缺陷：前 12 字相同（实测不成立）", () => {
  const P = "理论-甲概念-很长的标题一.md";
  const Q = "理论-甲概念-很长的标题二.md";

  it("★★ 两份前 12 字相同 ⇒ 仍然不会产生假倒挂", () => {
    assert.equal(P.slice(0, 12), Q.slice(0, 12), "前提变了");
    const src = book({ [P]: "# 一" + NL, [Q]: "# 二" + NL }, [P, Q]);
    const r = readingOrder({ bookSrc: src });
    assert.equal(r.forwardCount, 0, "自身被跳过后不该有假倒挂");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★★★★★ 按「来路」分类（2026-10-21）
//
//   **集群推翻了我的判据**（`P24`：被研究对象抓装置缺陷）。原话：
//     「现役量具报的 **9 处**里，**0 处**是」
//     「★★★ **「提及」是「依赖」的必要条件，不是充分条件。**」
//
//   ★ 五种来路：承重 / 依据 / 上游 / 地图 / 地址 —— 只有承重造成"往回跳"。
//   ★★★ 判承重要做**删章测试**（懂内容）⇒ 不是我的活。
//     所以我只分**形式特征能分的**四类，剩下叫「待判」，交集群判。
// ══════════════════════════════════════════════════════════════════════════

import { classifyForward } from "../../research/clusters/forge/tools/reading-order.ts";

describe("★★★★★ 按来路分类前向引用", () => {
  const build = (body: string) =>
    book(
      {
        [A]: body,
        [B]: "# 乙" + NL,
      },
      [A, B], // ★ B 在后面 ⇒ A 引用 B 就是前向
    );

  it("★★★ 行首「依据」⇒ 归类为**依据**（不是承重，读者不用先读）", () => {
    const src = build(`# 甲${NL}依据：\`理论-乙说-为什么落地\` 那批跑出来的。${NL}`);
    const r = classifyForward({ bookSrc: src });
    assert.equal(r.counts["依据"], 1, `分错了：${JSON.stringify(r.counts)}`);
    assert.equal(r.candidates.length, 0, "依据不该进待判");
  });

  it("★★★ 含「详见」⇒ 也是依据类（查得到就行，不必先读）", () => {
    const src = build(`# 甲${NL}详见 \`理论-乙说-为什么落地\`。${NL}`);
    assert.equal(classifyForward({ bookSrc: src }).counts["依据"], 1);
  });

  it("★★★ `## 依据` 这一节里的 ⇒ 全是依据", () => {
    const src = build(`# 甲${NL}## 依据${NL}见 \`理论-乙说-为什么落地\`。${NL}`);
    assert.equal(classifyForward({ bookSrc: src }).counts["依据"], 1);
  });

  it("★★ `> 上游：` ⇒ 归类为上游（作者欠的债，不是读者的）", () => {
    const src = build(`# 甲${NL}> 上游：\`理论-乙说-为什么落地\` 的那些实验。${NL}`);
    assert.equal(classifyForward({ bookSrc: src }).counts["上游"], 1);
  });

  it("★★★ 没有任何形式标记 ⇒ **待判**（★ 这才是需要集群做删章测试的）", () => {
    const src = build(`# 甲${NL}7. 这条形状谓词的定义在 \`理论-乙说-为什么落地\` 里。${NL}`);
    const r = classifyForward({ bookSrc: src });
    assert.equal(r.counts["待判"], 1, `该进待判：${JSON.stringify(r.counts)}`);
    assert.equal(r.candidates.length, 1);
    assert.ok(r.candidates[0]!.line.length > 0, "待判的要留原文供复核");
  });

  it("★★★ 后向引用（引用的在前面）⇒ **不算前向**，不分来路", () => {
    const src = book({ [A]: "# 甲" + NL, [B]: `# 乙${NL}依据：\`理论-甲说-怎么落地\`${NL}` }, [A, B]);
    const r = classifyForward({ bookSrc: src });
    assert.equal(r.edges.length, 0, "后向引用不该进前向统计");
  });

  it("★★ 四类计数加起来等于总边数（不丢边）", () => {
    const src = build(
      `# 甲${NL}依据：\`理论-乙说-为什么落地\`${NL}> 上游：\`理论-乙说-为什么落地\`${NL}7. 定义在那份 \`理论-乙说-为什么落地\` 里${NL}`,
    );
    const r = classifyForward({ bookSrc: src });
    const sum = Object.values(r.counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, r.edges.length, "有边被漏掉了");
    assert.ok(r.edges.length >= 3);
  });
});
