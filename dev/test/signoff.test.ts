// ★★★ 共识门（`sign_off`）的回归测试
//
// ══════════════════════════════════════════════════════════════════
// ★ 为什么这个门要有测试：
//   它是**硬的**（有人反对/没表态 ⇒ 不许写进 book）。
//   ★ 门一旦悄悄放行，整本书的可信度就成了「模型自己说它对」。
//   而这类 bug **在正文里看不出来** —— 只有测试能抓住。
//
// ★★ 判据是纯函数（`gateVerdict`）⇒ 可离线重判（工作纪律⑦）。
// ══════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateVerdict, renderSignOff, agreedArtifacts, type SignOffRecord, type Verdict } from "../../research/clusters/hunt/tools/signoff.ts";

const T = ["theory", "practice", "landing"] as const;

function sign(by: string, verdict: Verdict, reason = "核对过 runs/x.jsonl 的 12 行", dislodge?: string): SignOffRecord {
  return { at: "2026-10-19T00:00:00Z", artifact: "a.md", by, verdict, reason, ...(dislodge ? { dislodge } : {}) };
}

function table(...recs: SignOffRecord[]) {
  return new Map(recs.map((r) => [r.by, r]));
}

describe("共识门 gateVerdict", () => {
  it("全体认同 → 开门", () => {
    const m = gateVerdict(table(sign("theory", "认同"), sign("practice", "认同"), sign("landing", "认同")), T);
    assert.equal(m.ok, true);
    assert.deepEqual(m.blocked, []);
    assert.deepEqual(m.missing, []);
  });

  it("★ 一人反对 → 关门（反对必须给出名字与理由）", () => {
    const m = gateVerdict(
      table(sign("theory", "认同"), sign("practice", "反对", "缺安慰剂臂"), sign("landing", "认同")),
      T,
    );
    assert.equal(m.ok, false);
    assert.equal(m.blocked.length, 1);
    assert.match(m.blocked[0]!, /practice/);
    assert.match(m.blocked[0]!, /安慰剂/);
  });

  it("★★ 有人没表态 → 关门（沉默不是认同 —— 治 B8）", () => {
    const m = gateVerdict(table(sign("theory", "认同"), sign("practice", "认同")), T);
    assert.equal(m.ok, false);
    assert.deepEqual(m.missing, ["landing"]);
  });

  it("★ 有保留 + **给了解除条件** → 开门，保留与解除条件都要能读出来", () => {
    const m = gateVerdict(
      table(
        sign("theory", "认同"),
        sign("practice", "有保留", "只在单模型上验过", "补一批跨模型读数 N=3"),
        sign("landing", "认同"),
      ),
      T,
    );
    assert.equal(m.ok, true);
    assert.equal(m.reservations.length, 1);
    assert.match(m.reservations[0]!, /单模型/);
    assert.match(m.reservations[0]!, /解除条件.*跨模型/);
  });

  it("★★★ 有保留但**没给解除条件** → 视为没表态（夜间实测：23 张有保留 0 张反对 ⇒ 门形同虚设）", () => {
    const m = gateVerdict(
      table(sign("theory", "认同"), sign("practice", "有保留", "我觉得还不够扎实"), sign("landing", "认同")),
      T,
    );
    assert.equal(m.ok, false, "没给解除条件的保留不该放行");
    assert.equal(m.missing.length, 1);
    assert.match(m.missing[0]!, /practice/);
    assert.match(m.missing[0]!, /解除条件/);
  });

  it("空表 → 关门（没签字不等于默认通过）", () => {
    assert.equal(gateVerdict(undefined, T).ok, false);
    assert.equal(gateVerdict(new Map(), T).ok, false);
  });

  it("只有一部分团队存在时，一个都不许漏", () => {
    const m = gateVerdict(table(sign("theory", "认同")), T);
    assert.deepEqual(m.missing.sort(), ["landing", "practice"]);
  });
});

describe("共识门 汇总", () => {
  it("agreedArtifacts 只返回全票通过的", () => {
    const t = new Map<string, Map<string, SignOffRecord>>();
    t.set("全票.md", table(sign("theory", "认同"), sign("practice", "认同"), sign("landing", "认同")));
    t.set("被反对.md", table(sign("theory", "认同"), sign("practice", "反对"), sign("landing", "认同")));
    t.set("没表全.md", table(sign("theory", "认同")));
    assert.deepEqual(agreedArtifacts(t, T), ["全票.md"]);
  });

  it("renderSignOff 把每个人的判定与理由都写出来（保留意见随产物走）", () => {
    const md = renderSignOff("x.md", table(sign("theory", "认同", "复算了 16 轮"), sign("practice", "反对", "判据可被绕过")));
    assert.match(md, /theory.*认同.*复算了 16 轮/);
    assert.match(md, /practice.*反对.*判据可被绕过/);
  });

  it("没有签字时渲染为空（不要凭空造一个'共识'段）", () => {
    assert.equal(renderSignOff("x.md", undefined), "");
    assert.equal(renderSignOff("x.md", new Map()), "");
  });
});
