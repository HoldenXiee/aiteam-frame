// ★★★ 观众裁决（`judge`）的回归测试
//
// ══════════════════════════════════════════════════════════════════
// ★ 为什么这段逻辑必须有测试：
//   它是**结束争辩**的唯一开关。写错了有两种坏后果，方向相反：
//     · 太松 ⇒ 一方 3 票里拿 2 票就"通过" ⇒ 书里写进**没人真被说服**的东西
//     · 太严 ⇒ 永远不通过 ⇒ 争辩永不收敛（正是设计者担心的事）
//   ★★ 两个方向都要测。
// ══════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveVotes, type Vote, type Choice } from "../../research/clusters/forge/tools/judge.ts";
import { AUDIENCES, BOOK_THRESHOLD } from "../../research/clusters/forge/prompts/lines.ts";

const Q = "落地失败的根因是哪一段";

function v(by: string, choice: Choice, question = Q, missing?: string): Vote {
  return { at: "2026-10-19T00:00:00Z", by, question, choice, reason: "按我的标准核对过 runs/x.jsonl", ...(missing ? { missing } : {}) };
}

/** ★ 全体观众各投一票（按给定顺序填） */
function votesFor(...choices: Choice[]): Vote[] {
  return AUDIENCES.map((a, i) => v(a.key, choices[i] ?? "都不够"));
}

describe("观众裁决 resolveVotes", () => {
  it("★ 全体观众一致 → 结束争辩", () => {
    const r = resolveVotes(votesFor("practice", "practice", "practice", "practice"), Q);
    assert.equal(r.decided, true);
    assert.equal(r.winner, "practice");
    assert.equal(r.support["practice"], 1);
  });

  it("★★ 达到 9 成（4 人投 4 票即 100%；门槛就是 0.9）", () => {
    assert.equal(BOOK_THRESHOLD, 0.9);
    // ★ 4 位观众时，3/4 = 75% < 90% ⇒ 不通过
    const r = resolveVotes(votesFor("theory", "theory", "theory", "practice"), Q);
    assert.equal(r.winner, "theory");
    assert.equal(r.decided, false, "75% 不该通过");
  });

  it("★★ 有人没表态 → 不算通过（沉默不是支持）", () => {
    const r = resolveVotes([v(AUDIENCES[0]!.key, "theory"), v(AUDIENCES[1]!.key, "theory")], Q);
    assert.equal(r.decided, false);
    assert.equal(r.silent.length, AUDIENCES.length - 2);
  });

  it("★ 分歧不足门槛时，仍要报出「目前最被说服的是谁」", () => {
    const r = resolveVotes(votesFor("theory", "practice", "landing", "theory"), Q);
    assert.equal(r.decided, false);
    assert.equal(r.winner, "theory");
    assert.equal(r.support["theory"], 0.5);
  });

  it("★★★「都不够」也能赢 —— 若观众压倒性认为没人说服他们，就写不成书", () => {
    const r = resolveVotes(votesFor("都不够", "都不够", "都不够", "都不够"), Q);
    assert.equal(r.decided, true);
    assert.equal(r.winner, "都不够");
  });

  it("★ 不同问题的票不混在一起（只统计同一个问题）", () => {
    const mixed = [...votesFor("practice", "practice", "practice", "practice"), ...votesFor("theory", "theory", "theory", "theory").map((x) => ({ ...x, question: "另一个问题" }))];
    const r = resolveVotes(mixed, Q);
    assert.equal(r.winner, "practice");
  });

  it("没票 → 不通过、也不崩", () => {
    const r = resolveVotes([], Q);
    assert.equal(r.decided, false);
    assert.equal(r.winner, undefined);
    assert.equal(r.silent.length, AUDIENCES.length);
  });

  it("★ 反对者名单要准确（用于把保留意见附进书）", () => {
    const r = resolveVotes(votesFor("theory", "theory", "theory", "theory"), Q);
    assert.deepEqual(r.dissenters, []);
    const r2 = resolveVotes(votesFor("theory", "theory", "theory", "practice"), Q);
    assert.deepEqual(r2.dissenters, [AUDIENCES[3]!.key]);
  });
});

describe("★ 观众各有自己的想法（设计者要求）", () => {
  it("四个观众的 key / 身份 / 偏好 / 要求都不同", () => {
    assert.equal(AUDIENCES.length, 4);
    assert.equal(new Set(AUDIENCES.map((a) => a.key)).size, 4);
    assert.equal(new Set(AUDIENCES.map((a) => a.who)).size, 4);
    assert.equal(new Set(AUDIENCES.map((a) => a.bias)).size, 4);
    assert.equal(new Set(AUDIENCES.map((a) => a.demands)).size, 4);
  });

  it("★★ 至少有一个观众会天然反对「深刻但判不了死活」的说法（skeptic）", () => {
    const s = AUDIENCES.find((a) => a.key === "skeptic");
    assert.ok(s);
    assert.match(s.bias + s.demands, /判不了死活|不成立|边界/);
  });

  it("★★ 观众的偏好不全都指向同一个团队（否则'最被说服'没意义）", () => {
    const all = AUDIENCES.map((a) => a.bias).join(" ");
    assert.match(all, /practice/);
    assert.match(all, /landing/);
  });
});
