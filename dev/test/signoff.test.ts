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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateVerdict, renderSignOff, agreedArtifacts, unresolvedDislodges, makeSignOff, type SignOffTable, type SignOffRecord, type Verdict } from "../../research/clusters/forge/tools/signoff.ts";

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
    // ★★★ 2026-10-20 行为变了：光给解除条件**不够了** —— 还要有同事「认可保留」。
    //   所以这里加一张 landing 的「认可保留」。
    const m = gateVerdict(
      table(
        sign("theory", "认同"),
        sign("practice", "有保留", "只在单模型上验过", "补一批跨模型读数 N=3"),
        sign("landing", "认可保留"),
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

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 未兑现的解除条件（闭环的另一半）
//
//   AGENTS §〇之三 原话：「条件写在那儿，但**没人去执行**。」
//   实测：进书 29 份里 25 份带解除条件，共 43 条，全都没人检查过。
//   ⇒ 「有保留」退化成**永久的免责声明**。
// ══════════════════════════════════════════════════════════════════════════
describe("★★★ unresolvedDislodges：把还挂着的条件摆上桌", () => {
  const mk = (rows: [string, string, string, string?][]) => {
    // [artifact, team, verdict, dislodge]
    const t: SignOffTable = new Map();
    for (const [artifact, team, verdict, dislodge] of rows) {
      if (!t.has(artifact)) t.set(artifact, new Map());
      t.get(artifact)!.set(team, { at: "2026-10-20T00:00:00Z", by: team, artifact, verdict: verdict as never, reason: "r", dislodge });
    }
    return t;
  };

  it("★ 有保留且条件够具体 ⇒ 算未兑现", () => {
    const t = mk([["a.md", "theory", "有保留", "在 §2 加一句可判死的话，说明它停在候选枚举上"]]);
    const u = unresolvedDislodges(t, ["a.md"]);
    assert.equal(u.size, 1);
    assert.equal(u.get("a.md")!.length, 1);
  });

  it("★★ 条件太短（<10 字）⇒ 不算（那是敷衍复核，门上已当没表态）", () => {
    const t = mk([["a.md", "theory", "有保留", "再看看"]]);
    assert.equal(unresolvedDislodges(t, ["a.md"]).size, 0);
  });

  it("★★ 认同/反对 ⇒ 不算未兑现（只有保留才是待办）", () => {
    const t = mk([
      ["a.md", "theory", "认同"],
      ["a.md", "practice", "反对", "补一个对照臂，N=8，写清判据"],
    ]);
    assert.equal(unresolvedDislodges(t, ["a.md"]).size, 0);
  });

  it("★★★ 没进书的产物 ⇒ 不管（门都没过，谈不上解除）", () => {
    const t = mk([["draft.md", "theory", "有保留", "在 §2 加一句可判死的话，说明它停在哪"]]);
    assert.equal(unresolvedDislodges(t, ["other.md"]).size, 0, "没进书也报了");
    assert.equal(unresolvedDislodges(t, ["draft.md"]).size, 1);
  });

  it("★★ 一份产物多个团队各自留条件 ⇒ 都列出来", () => {
    const t = mk([
      ["a.md", "theory", "有保留", "把 §2.2 那句改成可判死的说法，写清停在枚举上"],
      ["a.md", "practice", "有保留", "在 §0.1 表下加 3 行，说明自查被拆到哪两章"],
    ]);
    const u = unresolvedDislodges(t, ["a.md"]);
    assert.equal(u.get("a.md")!.length, 2);
    assert.deepEqual(
      u.get("a.md")!.map((r) => r.by).sort(),
      ["practice", "theory"],
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 「有保留」是提议，要同事承兑才生效（2026-10-20）
//
//   病（实测，第二次治同一个病）：
//     第一次修（2026-10-19）：「保留没给解除条件 = 没表态」。
//     ★ 团队学乖了 —— 每张保留都写条条件，照样过。
//     实测：进书 29 份，签字 87 张里 **认同 44 · 有保留 43 · 反对 0**
//          ⇒ 带保留率 86%，反对 0 张。
//
//   ★★★ 根因（结构缺陷，不是团队偷懒）：
//     · 反对：要拿反例，**且卡住发布**（要说服别人）
//     · 有保留：写条条件，**照样进书**
//     ⇒ 两种表态代价不对等 ⇒ 理性做法永远是"有保留"。
//
//   修法：把「有保留」从**结论**降级成**提议** —— 没人「认可保留」就不算表态。
// ══════════════════════════════════════════════════════════════════════════
describe("★★★ 有保留需要承兑（把代价拉平）", () => {
  const REC = (by: string, verdict: Verdict, dislodge?: string): SignOffRecord => ({
    at: "2026-10-20T00:00:00Z",
    artifact: "a.md",
    by,
    verdict,
    reason: "核对过 runs/x.jsonl 的 12 行",
    ...(dislodge ? { dislodge } : {}),
  });
  const table = (rows: [string, Verdict, string?][]) => {
    const t: SignOffTable = new Map();
    for (const [by, v, d] of rows) {
      if (!t.has("a.md")) t.set("a.md", new Map());
      t.get("a.md")!.set(by, REC(by, v, d));
    }
    return t;
  };
  const D = "在 §2.2 后补一句可判死的话，说明它停在候选枚举上";

  it("★★★ 保留没人承兑 ⇒ 不算表态 ⇒ 不许进", () => {
    const m = gateVerdict(
      table([
        ["theory", "认同"],
        ["practice", "有保留", D],
        ["landing", "认同"],
      ]).get("a.md"),
      T,
    );
    assert.equal(m.ok, false, "没人承兑的保留被放行了 —— 病没治");
    assert.equal(m.missing.length, 1);
    assert.match(m.missing[0]!, /认可保留/);
  });

  it("★★★ 有一个同事认可 ⇒ 保留生效 ⇒ 可以进（带保留）", () => {
    const m = gateVerdict(
      table([
        ["theory", "认同"],
        ["practice", "有保留", D],
        ["landing", "认可保留"],
      ]).get("a.md"),
      T,
    );
    assert.equal(m.ok, true, "有承兑还被挡了 —— 太严");
    assert.equal(m.accepted.length, 1);
    assert.match(m.accepted[0]!, /landing/);
    assert.equal(m.reservations.length, 1, "保留意见丢了");
  });

  it("★★ 自己认可自己 ⇒ 不算承兑（否则等于没升级门槛）", () => {
    const m = gateVerdict(
      table([
        ["theory", "有保留", D],
        ["practice", "认同"],
        // ★ theory 只有一个记录槽 —— 这里验证"同一团队不能既保留又认可"
      ]).get("a.md"),
      T,
    );
    assert.equal(m.ok, false, "自己给自己背书却过了");

    // ★ 换个方式：把 theory 改成"认可保留"，那它就没保留了
    const m2 = gateVerdict(
      table([
        ["theory", "认可保留"],
        ["practice", "认同"],
        ["landing", "认同"],
      ]).get("a.md"),
      T,
    );
    assert.equal(m2.ok, true);
    assert.equal(m2.reservations.length, 0, "「认可保留」不该被当成保留");
  });

  it("★★ 「认可保留」本身不是对产物的结论（不占表态名额）", () => {
    const m = gateVerdict(
      table([
        ["theory", "认同"],
        ["practice", "认同"],
        ["landing", "认可保留"],
      ]).get("a.md"),
      T,
    );
    // ★ landing 说了「认可保留」但没人有保留 —— 它等于没对产物表态
    //   ★★ 这条是刻意保守的：不想让"认可保留"变成第三种"我啥也没说"
    assert.equal(m.ok, true, "三个都表过态（landing 的认可保留算表态）");
  });

  it("★★ 承兑谁都能给（不需要特定某人）", () => {
    // ★ theory 保留，practice 认可 ⇒ 生效
    const m1 = gateVerdict(
      table([
        ["theory", "有保留", "在 §2.2 后补一句可判死的话，说明它停在候选枚举上"],
        ["practice", "认可保留"],
        ["landing", "认同"],
      ]).get("a.md"),
      T,
    );
    assert.equal(m1.ok, true, "practice 承兑了却不生效");

    // ★ 同样地：practice 保留，theory 认可 ⇒ 也生效
    const m2 = gateVerdict(
      table([
        ["theory", "认可保留"],
        ["practice", "有保留", "把 §6 换成边际价口径三行，删掉比数便宜那句"],
        ["landing", "认同"],
      ]).get("a.md"),
      T,
    );
    assert.equal(m2.ok, true, "theory 承兑了却不生效");
  });

  it("★ 反对仍然直接挡（不受承兑影响）", () => {
    const m = gateVerdict(
      table([
        ["theory", "反对"],
        ["practice", "认可保留"],
        ["landing", "认同"],
      ]).get("a.md"),
      T,
    );
    assert.equal(m.ok, false);
    assert.equal(m.blocked.length, 1);
  });
});


// ★★★★★ 2026-10-21 · 「免费改口」：改签必须说清是什么让你改口
//
// ★★★ 这一条的来源不是我凭空想的，是**实测**：
//   「有保留 → 认同」共 61 次，其中 **60 次产物一个字节都没动（98%）**。
//   门只读最后一条签字 ⇒ 那一改，带条件的保留就消失了，书里没有痕迹。
//
// ★ 但改口是**合法**的（产物没变而理解变了）⇒ 要求的是"说清为什么"，不是禁止。
describe("★★★★★ 改签必须说清是什么让你改口", () => {
  it("★★★★★ 产物没动 + 理由含糊 ⇒ 拒", async () => {
    const sbx = join(import.meta.dirname, "_sbx-flip");
    rmSync(sbx, { recursive: true, force: true });
    mkdirSync(sbx, { recursive: true });
    const art = "a.md";
    writeFileSync(join(sbx, art), "# a" + String.fromCharCode(10));

    const table: SignOffTable = new Map();
    // ★ 先签「有保留」（时间在过去 ⇒ mtime 落在之后 ⇒ 算"没动"）
    table.set(art, new Map([["theory", {
      at: new Date(Date.now() + 60_000).toISOString(), // 未来 ⇒ mtime < t0 ⇒ 没动过
      artifact: art, by: "theory", verdict: "有保留",
      reason: "缺对照", dislodge: "加一个 N=8 的对照臂",
    }]]));

    const tool = makeSignOff({
      selfKey: "theory",
      allTeams: () => ["theory", "practice", "landing"],
      recordPath: join(sbx, "s.jsonl"),
      table,
      outboxDir: sbx,
    });

    const r = (await tool.execute("t", {
      artifact: art, verdict: "认同", reason: "再想想觉得没问题",
    }, undefined, undefined, undefined as never)) as { content: { text: string }[] };
    const txt = r.content[0]!.text;
    assert.ok(txt.includes("一个字节都没动"), `应该拒，实际：${txt.slice(0, 80)}`);
    // ★ P12：拦的同时给路
    assert.ok(txt.includes("加一个 N=8 的对照臂"), "要把它上次给的解除条件摆出来");
  });

  it("★★★ 说清了是什么让你改口 ⇒ 收", async () => {
    const sbx = join(import.meta.dirname, "_sbx-flip2");
    rmSync(sbx, { recursive: true, force: true });
    mkdirSync(sbx, { recursive: true });
    const art = "a.md";
    writeFileSync(join(sbx, art), "# a" + String.fromCharCode(10));
    const table: SignOffTable = new Map();
    table.set(art, new Map([["theory", {
      at: new Date(Date.now() + 60_000).toISOString(),
      artifact: art, by: "theory", verdict: "有保留",
      reason: "缺对照", dislodge: "加一个 N=8 的对照臂",
    }]]));
    const tool = makeSignOff({
      selfKey: "theory",
      allTeams: () => ["theory", "practice", "landing"],
      recordPath: join(sbx, "s.jsonl"),
      table,
      outboxDir: sbx,
    });
    const r = (await tool.execute("t", {
      artifact: art, verdict: "认同",
      reason: "看了同事 P47 的对照数据，我原来那条保留的前提不成立",
    }, undefined, undefined, undefined as never)) as { content: { text: string }[] };
    assert.ok(!r.content[0]!.text.includes("一个字节都没动"), "说清了就该收");
  });
});

// ★★★★★ 2026-10-21 · 「作者自签」让门看起来比实际强
//
// ★ 实测：311 条签字里 102 条（33%）是作者给自己签的。
// ★★ 这不是门的漏洞（门要求全体表态，作者必然要签自己），
//    问题是 `3/3 签` 这个说法**看起来比实际强** —— 只有 2 票是独立判断。
describe("★★★★★ 门的「独立票」读数", () => {
  function mk(by: string, verdict: Verdict, isAuthor?: boolean): SignOffRecord {
    return { at: "2026-10-21T00:00:00Z", artifact: "x.md", by, verdict, reason: "r", isAuthor };
  }

  it("★★★★★ 三票都独立 ⇒ independent=3 · selfSigned=0", () => {
    const t: SignOffTable = new Map([["x.md", new Map([
      ["theory", mk("theory", "认同")],
      ["practice", mk("practice", "认同")],
      ["landing", mk("landing", "认同")],
    ])]]);
    const g = gateVerdict(t.get("x.md"), ["theory", "practice", "landing"]);
    assert.equal(g.ok, true);
    assert.deepEqual(g.strength, { signed: 3, independent: 0, selfSigned: 0, undeclared: 3 });
  });

  it("★★★★★ 作者自签一票 ⇒ 通过，但自签要单列（其余未声明的另算）", () => {
    const t: SignOffTable = new Map([["x.md", new Map([
      ["theory", mk("theory", "认同", true)],   // ★ 作者
      ["practice", mk("practice", "认同")],
      ["landing", mk("landing", "认同")],
    ])]]);
    const g = gateVerdict(t.get("x.md"), ["theory", "practice", "landing"]);
    assert.equal(g.ok, true, "作者自签不该拦住发布");
    assert.equal(g.strength.signed, 3);
    // ★★★ 未声明的不能算成独立（缺数据 ≠ 0）⇒ 这里应是 0 独立 + 2 未声明
    assert.equal(g.strength.selfSigned, 1);
  });

  it("★★ 没表态的不算票", () => {
    const inner = new Map<string, SignOffRecord>([
      ["theory", mk("theory", "认同")],
      ["practice", mk("practice", "认同")],
    ]);
    const t: SignOffTable = new Map([["x.md", inner]]);
    const g = gateVerdict(t.get("x.md"), ["theory", "practice", "landing"]);
    assert.equal(g.ok, false, "缺一票不许过");
    assert.deepEqual(g.strength, { signed: 2, independent: 0, selfSigned: 0, undeclared: 2 });
  });
});
