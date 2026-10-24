// ★★★ 「渐进的书」审查基准（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者裁定（逐字）
//
//   「因为这个 book 是**渐进式**的，是**随着 hunt 集群的推进来不断完善的**，
//    我害怕强制要求：从目录第一份出发，每份指向的"下一站"能不能接上，
//    形成不断裂的链路，**会导致后续的不断完善会有问题**，
//    建议 forge 的**审查板块要设计成这种情景下运行**」
//
//   · 基准：**按「当前这本」判，不按「理想那本」**
//   · 未完成：**显式标记「待补」就不算缺陷**
//   · 过时：**过时就算缺陷，必须更新**（审查就是让产出符合目标）
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 这个文件要防的两种反向错误
//
//   ① 拿"理想的书"当尺子 ⇒ 判"缺第 1-4 章"、"链路不闭合"
//      ⇒ 集群被迫先补骨架，而不是补内容
//   ② 拿"怎样都行"当尺子 ⇒ 半成品不标、过时不改 ⇒ 书越长越烂
//
//   ★ 分界线只有一条：**有没有诚实地标出来**。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pendingMarks, selfConsistency, staleBySource } from "../../research/clusters/forge/tools/progressive.ts";

const SBX = join(import.meta.dirname, "_sbx-progressive");
const SUB = "05-集群产出";
const NL = String.fromCharCode(10);

function setup(files: Record<string, string>): string {
  assert.ok(SBX.includes("_sbx"), "只许动沙箱");
  rmSync(SBX, { recursive: true, force: true });
  mkdirSync(join(SBX, SUB), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(SBX, SUB, name), text);
  return SBX;
}

describe("★★★ ① 待补标记", () => {
  it("★★★ 认标准写法（这几种才算）", () => {
    for (const s of ["待补：第 6 章会讲合并", "本节待补", "本章待补", "待写：后面再补", "【待补】"]) {
      assert.equal(pendingMarks(s).length, 1, `「${s}」没被认出来`);
    }
  });

  it("★★★ 不认随便的说法（否则查不全 = 等于没标记）", () => {
    for (const s of ["以后再说", "TODO", "未完成", "后面会讲"]) {
      assert.equal(pendingMarks(s).length, 0, `「${s}」不该被当成标准标记`);
    }
  });

  it("★ 报出行号（便于人复核）", () => {
    const m = pendingMarks(`# 标题${NL}正文${NL}待补：第 6 章`);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.line, 3);
  });
});

describe("★★★ ② 按「当前这本」判：不要求完整", () => {
  it("★★★ 缺第 1-4 章**不算缺陷**（这本书在长）", () => {
    // ★ 只有第 5 章和第 9 章 —— 中间缺一大堆
    const src = setup({
      "理论-第五章-开篇-标题很长.md": `# 第五章 · 开篇${NL}`,
      "理论-第九章-收尾-标题很长.md": `# 第九章 · 收尾${NL}`,
    });
    const r = selfConsistency({ bookSrc: src });
    assert.equal(r.files, 2);
    // ★ 只要没人**引用**缺失的章，就没有缺陷
    assert.equal(r.danglingChapters.length, 0, "缺章本身不该算缺陷");
  });

  it("★★★ 引用「第 6 章」而书里没有 ⇒ **算缺陷**（读者会去找）", () => {
    const src = setup({
      "理论-第五章-开篇-标题很长.md": `# 第五章 · 开篇${NL}详见 第6章 的合并判定。${NL}`,
    });
    const r = selfConsistency({ bookSrc: src });
    assert.equal(r.danglingChapters.length, 1);
    assert.equal(r.danglingChapters[0]!.chapter, 6);
  });

  it("★★★ 但标了「待补」⇒ **不算缺陷**（这就是渐进的书该有的样子）", () => {
    const src = setup({
      "理论-第五章-开篇-标题很长.md": `# 第五章 · 开篇${NL}待补：第6章 会讲合并判定。${NL}`,
    });
    const r = selfConsistency({ bookSrc: src });
    assert.equal(r.danglingChapters.length, 0, "标了待补还被判缺陷 —— 会逼它先补骨架");
    assert.ok(r.excusedDangling > 0, "豁免数没记");
  });

  it("★★ 引用了书里已有的章 ⇒ 当然不算", () => {
    const src = setup({
      "理论-第五章-开篇-标题很长.md": `# 第五章 · 开篇${NL}见 第9章。${NL}`,
      "理论-第九章-收尾-标题很长.md": `# 第九章 · 收尾${NL}`,
    });
    assert.equal(selfConsistency({ bookSrc: src }).danglingChapters.length, 0);
  });
});

describe("★★★ ③ 过时：必须更新（没有「待补」折扣）", () => {
  it("★★★ 章节提到的原料比它新 ⇒ **报出来**", () => {
    const srcDir = join(SBX, "source");
    const src = setup({
      "理论-第五章-开篇-标题很长.md": `# 第五章${NL}依据：\`原料-甲乙丙-很长的标题\` 的读数。${NL}`,
    });
    rmSync(srcDir, { recursive: true, force: true });
    mkdirSync(srcDir, { recursive: true });
    const sf = join(srcDir, "原料-甲乙丙-很长的标题.md");
    writeFileSync(sf, "# 原料" + NL);
    // ★ 让原料比章节新
    const future = Date.now() / 1000 + 3600;
    utimesSync(sf, future, future);

    const r = staleBySource({ bookSrc: src, subdir: SUB, sourceDir: srcDir });
    assert.equal(r.length, 1, "过时没被检出");
    assert.ok(r[0]!.newer.length > 0);
  });

  it("★★ 原料比章节旧 ⇒ 不算过时", () => {
    const srcDir = join(SBX, "source2");
    const src = setup({
      "理论-第五章-开篇-标题很长.md": `# 第五章${NL}依据：\`原料-甲乙丙-很长的标题\`${NL}`,
    });
    rmSync(srcDir, { recursive: true, force: true });
    mkdirSync(srcDir, { recursive: true });
    const sf = join(srcDir, "原料-甲乙丙-很长的标题.md");
    writeFileSync(sf, "# 原料" + NL);
    const past = Date.now() / 1000 - 7200;
    utimesSync(sf, past, past);
    assert.equal(staleBySource({ bookSrc: src, subdir: SUB, sourceDir: srcDir }).length, 0);
  });

  it("★ 没有 source 目录 ⇒ 不炸，返回空", () => {
    const src = setup({ "理论-第五章-开篇-标题很长.md": "# 五" + NL });
    const r = staleBySource({ bookSrc: src, subdir: SUB, sourceDir: join(SBX, "_nope") });
    assert.deepEqual(r, []);
  });
});
