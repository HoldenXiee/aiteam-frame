// ★★★ 「能不能照做」的硬门槛（2026-10-20）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么需要它（实测出来的病）
//
//   设计者对第二集群的裁定：「可以**用作「工具」**」。
//   ★★★ 实测（34 份书稿）：
//     · 含 ≥20 处 `work/` 实验路径：**27/34 = 79%**
//     · 观众达成 90% 共识：**0/24**
//     · newcomer 没投票：**15/24 = 62%**
//   ★ newcomer 自己说（逐字）：
//     「『说服我它是对的』和『说服我能照做』是**两件事**，我卡在后者」
//
//   ★★ 为什么不动 BOOK_THRESHOLD=0.9：
//     它回答「该写哪一方的说法」（三队选一个），不是「这份能不能用」。
//     四观点并存时 90% **结构上达不到** ⇒ 那是另一个门的事。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { usabilityGate, usabilitySummary, type Vote } from "../../research/clusters/forge/tools/judge.ts";

const Q = "`x.md` 这份东西该不该进书，哪一方的说法最站得住？";

const v = (by: string, choice: Vote["choice"], missing?: string): Vote => ({
  at: "2026-10-20T00:00:00.000Z",
  by,
  question: Q,
  choice,
  reason: `${by} 的理由`,
  ...(missing ? { missing } : {}),
});

describe("★★★ 可用性门槛：核心三条", () => {
  it("★★★ newcomer 说「都不够」⇒ 卡住（定义推出来的，不是我拍的数）", () => {
    const r = usabilityGate({
      question: Q,
      votes: [v("newcomer", "都不够", "没见过一个从头走到尾的真例子"), v("skeptic", "landing")],
    });
    assert.equal(r.usable, false, "newcomer 说不够用却不卡 —— 门槛失效了");
    assert.equal(r.blockers.length, 1);
    assert.equal(r.blockers[0]!.by, "newcomer");
    assert.ok(r.blockers[0]!.missing.includes("真例子"));
  });

  it("★★★ newcomer 从没被问过 ⇒ 也不算通过（沉默 ≠ 认同）", () => {
    const r = usabilityGate({
      question: Q,
      votes: [v("skeptic", "landing"), v("operator", "landing"), v("builder", "landing")],
    });
    assert.equal(r.usable, false, "没人问过 newcomer 却通过了 —— 沉默被当成认同了");
    assert.equal(r.blockers.length, 0);
    assert.ok(r.why.includes("从没被问过"));
    // ★ silent 要点名 newcomer
    assert.ok(r.silent.includes("newcomer"));
  });

  it("★★ newcomer 说够用 + 其他没人反对 ⇒ 通过", () => {
    const r = usabilityGate({
      question: Q,
      votes: [v("newcomer", "landing"), v("skeptic", "landing"), v("operator", "practice")],
    });
    assert.equal(r.usable, true);
    assert.equal(r.blockers.length, 0);
  });
});

describe("★★ 其他观众的异议", () => {
  it("★★ 两位其他观众说「都不够」⇒ 也算卡（不能当偶然）", () => {
    const r = usabilityGate({
      question: Q,
      votes: [
        v("newcomer", "landing"),
        v("skeptic", "都不够", "证据不够"),
        v("operator", "都不够", "不能照做"),
      ],
    });
    assert.equal(r.usable, false);
    assert.equal(r.blockers.length, 2);
  });

  it("★ 只有一位其他观众说不够 ⇒ newcomer 认可就够了（单点异议不卡）", () => {
    const r = usabilityGate({
      question: Q,
      votes: [v("newcomer", "landing"), v("skeptic", "都不够", "证据不够")],
    });
    assert.equal(r.usable, true, "单个异议不该挡住 —— 那是 sign_off 门的事");
  });

  it("★★ 阈值可调（othersNeeded=1 时一个异议就卡）", () => {
    const r = usabilityGate(
      { question: Q, votes: [v("newcomer", "landing"), v("skeptic", "都不够", "x")] },
      { othersNeeded: 1 },
    );
    assert.equal(r.usable, false);
  });
});

describe("★★ 只算本题目的票", () => {
  it("★★ 别的题目的票不串味", () => {
    const other = "`y.md` 该不该进书？";
    const r = usabilityGate({
      question: Q,
      votes: [v("newcomer", "landing"), { ...v("skeptic", "都不够", "x"), question: other }],
    });
    assert.equal(r.usable, true, "把别的题目的反对票算进来了");
  });
});

describe("★★★ 汇总：这批产物里几份能用", () => {
  it("★★★ 能分出「没人问过」和「问了说不行」（★ 这是最要紧的区分）", () => {
    const q2 = "`b.md` 该不该进书？";
    const votes: Vote[] = [
      // a: newcomer 说够用
      v("newcomer", "landing"),
      v("skeptic", "landing"),
      // b: 没人问过 newcomer
      { ...v("skeptic", "practice"), question: q2 },
      { ...v("operator", "practice"), question: q2 },
    ];
    const s = usabilitySummary(votes);
    assert.equal(s.total, 2);
    assert.equal(s.usable, 1);
    assert.equal(s.blocked, 1);
    assert.equal(s.neverAsked, 1, "没把『没人问过』和『问了说不行』分开");
  });

  it("★ 空输入不炸", () => {
    const s = usabilitySummary([]);
    assert.equal(s.total, 0);
    assert.equal(s.usable, 0);
  });

  it("★ 计数谁在挡", () => {
    const s = usabilitySummary([v("newcomer", "都不够", "x"), v("skeptic", "都不够", "y")]);
    assert.ok(s.blockers.newcomer >= 1);
  });
});

describe("★★★ 与 BOOK_THRESHOLD 并存（不是替换）", () => {
  it("★★ 四观点各占 1/4 时，90% 门槛达不到 —— 这正是观众机制 0/24 的原因", () => {
    // ★ 这个断言记录的是**病的形状**，不是"应该这样"
    const votes = [v("operator", "landing"), v("skeptic", "practice"), v("builder", "theory"), v("newcomer", "都不够")];
    const support: Record<string, number> = {};
    for (const x of votes) support[x.choice] = (support[x.choice] ?? 0) + 1 / 4;
    assert.ok(Math.max(...Object.values(support)) < 0.9, "四观点并存时不该达到 90%");
    // ★ 而可用性门槛照样能判死
    assert.equal(usabilityGate({ question: Q, votes }).usable, false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 题目归一化（2026-10-20）
//
//   病：规则里写的题目**带反引号**，观众存下来的**没有**：
//     规则：`x.md` 这份东西该不该进书…
//     落盘：x.md 这份东西该不该进书…
//   ⇒ 精确比较**永远不匹配** ⇒ `voteCoverage` 一直算出 0
//   ⇒ 实测后果：**同一批 3 份被无限重推**（日志里连着三次一模一样）。
//
//   ★★ 纪律⑪：判据与指令必须同源。
// ══════════════════════════════════════════════════════════════════════════

import { normQuestion } from "../../research/clusters/forge/tools/judge.ts";

describe("★★★ 题目归一化", () => {
  it("★★★ 带反引号和不带，算同一道题", () => {
    const a = "`x.md` 这份东西该不该进书，哪一方的说法最站得住？";
    const b = "x.md 这份东西该不该进书，哪一方的说法最站得住？";
    assert.equal(normQuestion(a), normQuestion(b), "反引号没被归一化 —— 会无限重推");
  });

  it("★★ 多余空白 / 换行也归一化", () => {
    assert.equal(normQuestion("  x   这份  "), "x 这份");
  });

  it("★★★ 归一化后 usabilityGate 能匹配上（这才是真效果）", () => {
    const gateQ = "`x.md` 这份东西该不该进书，哪一方的说法最站得住？";
    const storedQ = "x.md 这份东西该不该进书，哪一方的说法最站得住？";
    const r = usabilityGate({
      question: gateQ,
      votes: [{ at: "", by: "newcomer", question: storedQ, choice: "landing", reason: "r" }],
    });
    assert.equal(r.usable, true, "带了反引号的规则题匹配不上观众存的题");
  });
});
