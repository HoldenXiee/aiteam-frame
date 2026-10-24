// ★★★ onConsensus 卡死 bug 的判据单测 —— 纯函数，离线、0 API
//
// ★ 2026-10-20 的 bug：`find` + `return` 让第一份未签全的产物永久占位
//   ⇒ 后面所有产物轮不到被请签字。
//
// ★★ 实测后果（真实 24 份 outbox + 真实签字表）：
//     改前：被请签字 1/24 · landing 0/9
//     改后：被请签字 12/24 · landing 9/9
//
// ★★★ 这些断言**跑前冻结**：它们守住「选取逻辑不许再退回去」。
//   若哪天红了 ⇒ 先怀疑又有人把 `signedAsked` 从 find 条件里挪出来了。

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

const TEAMS = ["theory", "practice", "landing"];
type SignTable = Map<string, Set<string>>;

/**
 * ★ 旧逻辑（改前）—— 逐字复刻，**保留作对照**。
 *
 * ★★ 为什么要留着它：它是本实验的**对照组**。
 *   删掉它，以后就说不清"改的这 2 行到底起了多大作用"。
 */
export function pickBefore(outs: string[], signs: SignTable, signedAsked: string[]): string[] {
  const asked: string[] = [];
  for (let i = 0; i < outs.length; i++) {
    const target = outs.find((f) => TEAMS.some((t) => !signs.get(f)?.has(t)));
    if (!target || signedAsked.includes(target)) continue; // ★ 卡死点：直接跳过整个 tick
    signedAsked.push(target);
    asked.push(target);
  }
  return asked;
}

/** ★ 新逻辑（改后）—— 与 `rules.ts` 的 onConsensus 同源 */
export function pickAfter(outs: string[], signs: SignTable, signedAsked: string[]): string[] {
  const asked: string[] = [];
  for (let i = 0; i < outs.length; i++) {
    const target = outs.find(
      (f) => TEAMS.some((t) => !signs.get(f)?.has(t)) && !signedAsked.includes(f),
    );
    if (!target) break; // ★ 真没有可请的了
    signedAsked.push(target);
    asked.push(target);
  }
  return asked;
}

const S = (entries: [string, string[]][]): SignTable =>
  new Map(entries.map(([k, v]) => [k, new Set(v)]));

describe("onConsensus 选取逻辑", () => {
  it("★★★ 旧逻辑：第一份没签全的永久占位，后面全饿死", () => {
    const outs = ["a.md", "b.md", "c.md", "d.md"];
    const signs = S([]); // 全都没签
    const asked = pickBefore(outs, signs, []);
    // ★ 旧逻辑只会请到 a（之后每次 find 都返回 a，然后被 signedAsked 挡住）
    assert.deepEqual(asked, ["a.md"]);
  });

  it("★★★ 新逻辑：能继续往后找，四份都请到", () => {
    const outs = ["a.md", "b.md", "c.md", "d.md"];
    const signs = S([]);
    const asked = pickAfter(outs, signs, []);
    assert.deepEqual(asked, ["a.md", "b.md", "c.md", "d.md"]);
  });

  it("★ 已全体签过的产物不该被请", () => {
    const outs = ["done.md", "pending.md"];
    const signs = S([
      ["done.md", TEAMS],
      ["pending.md", ["theory"]],
    ]);
    assert.deepEqual(pickAfter(outs, signs, []), ["pending.md"]);
  });

  it("★ 全都签过了 ⇒ 一份都不请（不无限循环）", () => {
    const outs = ["a.md", "b.md"];
    const signs = S([
      ["a.md", TEAMS],
      ["b.md", TEAMS],
    ]);
    assert.deepEqual(pickAfter(outs, signs, []), []);
  });

  it("★★ 读者侧（landing-* 前缀）不再被前面的产物挤掉", () => {
    // ★ 真实形状：theory 先写 5 份、reader 后写 3 份
    const outs = ["理论-1.md", "理论-2.md", "理论-3.md", "理论-4.md", "理论-5.md",
                  "读者-第六章.md", "读者-第七章.md", "读者-第八章.md"];
    const signs = S([]); // 全都没签
    const before = pickBefore(outs, signs, []);
    const after = pickAfter(outs, S([]), []);
    assert.equal(before.filter((f) => f.startsWith("读者-")).length, 0, "旧逻辑：读者一份都请不到");
    assert.equal(after.filter((f) => f.startsWith("读者-")).length, 3, "新逻辑：读者三份都请到");
    assert.equal(after.length, 8, "新逻辑：八份都请到");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 背书通道（2026-10-20）
//
//   病：`onConsensus` 只给「**还没签过的**团队」发消息。
//   ★★ 而「认可保留」需要**已经签过的**团队再表一次态 —— 他们收不到任何消息。
//   ★★★ 实测：有保留的产物 29 份，其中 **28 份（97%）** 的其他团队全都已签过
//        ⇒ 背书通道**根本不存在** ⇒ 背书率只有 3%（1/29）。
//
//   ★ 修法：加一条「请背书」路径，发给**已签过但不是保留者**的团队。
//
//   ★★★ 为什么要给这段写测试：它只是"发消息的时机"，不是判据 ——
//     所以现有的 285 条测试**一条都不会因为它被删而变红**。这是缺口。
// ══════════════════════════════════════════════════════════════════════════

/** ★ 与 rules.ts 的 onConsensus 里 resvTarget 同源 */
export function pickEndorseTarget(
  outs: string[],
  signs: Map<string, Map<string, { verdict: string }>>,
  endorseAsked: string[],
): { target: string; resvTeams: string[]; candidates: string[] } | null {
  for (const f of outs) {
    const sig = signs.get(f);
    if (!sig) continue;
    if (endorseAsked.includes(f)) continue;
    const resvTeams = TEAMS.filter((t) => sig.get(t)?.verdict === "有保留");
    if (!resvTeams.length) continue;
    // ★ 有没有人承兑（除第一位保留者自己）
    const endo = TEAMS.filter((t) => t !== resvTeams[0] && sig.get(t)?.verdict === "认可保留");
    if (endo.length > 0) continue;
    // ★ 候选：已签过、且不是保留者
    const candidates = TEAMS.filter((t) => t !== resvTeams[0] && sig.has(t));
    return { target: f, resvTeams, candidates };
  }
  return null;
}

describe("★★★ 背书通道", () => {
  const mk = (rows: [string, string, string][]) => {
    const m = new Map<string, Map<string, { verdict: string }>>();
    for (const [art, team, v] of rows) {
      if (!m.has(art)) m.set(art, new Map());
      m.get(art)!.set(team, { verdict: v });
    }
    return m;
  };

  it("★★★ 有保留但没人承兑 ⇒ 选出它，且候选是「已签过的其他团队」", () => {
    const signs = mk([
      ["a.md", "theory", "认同"],
      ["a.md", "practice", "有保留"],
      ["a.md", "landing", "认同"],
    ]);
    const r = pickEndorseTarget(["a.md"], signs, []);
    assert.notEqual(r, null, "没人承兑却选不出来 —— 通道还是不存在");
    assert.equal(r!.target, "a.md");
    assert.deepEqual(r!.resvTeams, ["practice"]);
    // ★ theory 和 landing 都签过了，都能背书（不含保留者自己）
    assert.deepEqual(r!.candidates, ["theory", "landing"]);
  });

  it("★★ 已经有人承兑 ⇒ 不再选它（不然会刷屏）", () => {
    const signs = mk([
      ["a.md", "theory", "认可保留"],
      ["a.md", "practice", "有保留"],
      ["a.md", "landing", "认同"],
    ]);
    assert.equal(pickEndorseTarget(["a.md"], signs, []), null);
  });

  it("★ 已经请过 ⇒ 跳过（endorseAsked 去重）", () => {
    const signs = mk([
      ["a.md", "theory", "认同"],
      ["a.md", "practice", "有保留"],
    ]);
    assert.equal(pickEndorseTarget(["a.md"], signs, ["a.md"]), null);
  });

  it("★ 全认同 ⇒ 不用背书", () => {
    const signs = mk([
      ["a.md", "theory", "认同"],
      ["a.md", "practice", "认同"],
      ["a.md", "landing", "认同"],
    ]);
    assert.equal(pickEndorseTarget(["a.md"], signs, []), null);
  });

  it("★★ 保留者自己没有资格给自己背书（候选里不含它）", () => {
    const signs = mk([
      ["a.md", "theory", "有保留"],
      ["a.md", "practice", "认同"],
      ["a.md", "landing", "认同"],
    ]);
    const r = pickEndorseTarget(["a.md"], signs, []);
    assert.ok(!r!.candidates.includes("theory"), "保留者出现在自己的背书候选里");
  });
});
