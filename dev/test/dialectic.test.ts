import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendFileSync, rmSync } from "node:fs";
import {
  appendChallenge,
  claimKey,
  dialecticStats,
  readChallenges,
  renderDialectic,
} from "../../research/clusters/hunt/topology/dialectic.ts";

describe("claimKey：判「是不是同一条」必须归一化，但只做形式处理", () => {
  it("空白/标点/大小写不影响", () => {
    assert.equal(claimKey("S1 的 0 是口径错"), claimKey("s1的0是口径错。"));
  });
  it("★ 换一种说法认不出 —— 归一化只低估重复，不高估（局限要写清）", () => {
    assert.notEqual(claimKey("S1 的 0 是口径错"), claimKey("那条 0 其实量错了"));
  });
  it("截断到 80 字，防止长段落让 key 恒不等", () => {
    assert.equal(claimKey("x".repeat(200)).length, 80);
  });
});

describe("appendChallenge / readChallenges：★ 投递失败也必须留下证据", () => {
  const lab = "dev/test/_sandbox-dialectic";
  it("落盘一行，字段齐", () => {
    rmSync(`${lab}/work`, { recursive: true, force: true });
    appendChallenge(lab, { by: "falsifier", to: "hands-on", artifact: "outbox/P1.md", claim: "S1 的 0 是口径错", verdict: "缺陷" });
    const rows = readChallenges(lab);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].by, "falsifier");
    assert.ok(rows[0].claimKey.length > 0);
  });
  it("缺 claim 的行不静默混进来", () => {
    const p = `${lab}/work/challenges.jsonl`;
    appendFileSync(p, JSON.stringify({ by: "x" }) + "\n");
    appendFileSync(p, "{半行\n");
    assert.equal(readChallenges(lab).length, 1);
  });
});

describe("dialecticStats：★ 被挑战 ≥2 次 = 环在转的直接证据", () => {
  const rows = [
    { at: "t", by: "a", to: "b", artifact: "P1", claim: "同一条 claim", claimKey: claimKey("同一条 claim"), verdict: "缺陷" },
    { at: "t", by: "c", to: "b", artifact: "P1", claim: "同一条 claim", claimKey: claimKey("同一条 claim"), verdict: "反例" },
    { at: "t", by: "a", to: "c", artifact: "P2", claim: "另一条", claimKey: claimKey("另一条"), verdict: "我同意" },
  ];
  const s = dialecticStats(rows);
  it("不同 claim 数按 claimKey 去重", () => assert.equal(s.claims, 2));
  it("同一条被审两次 ⇒ revisited=1（环在转）", () => assert.equal(s.revisited, 1));
  it("worst 按次数降序", () => assert.equal(s.worst[0].times, 2));
  it("按 verdict / 挑战者 / 被挑战者都数得出来", () => {
    assert.equal(s.byVerdict["缺陷"], 1);
    assert.equal(s.byChallenger["a"], 2);
    assert.equal(s.byTarget["b"], 2);
  });
  it("空账渲染「没有记录」，不是 0（纪律㉜）", () => {
    assert.ok(renderDialectic(dialecticStats([])).includes("没有记录"));
  });
  it("非空时带「被挑战 ≥2 次」这个数", () => {
    assert.ok(renderDialectic(s).includes("≥2 次的 1 条"));
  });
});
