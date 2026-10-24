// ★★★ 发布门（`publish.ts`）的回归测试
//
// ══════════════════════════════════════════════════════════════════
// ★ 为什么这段必须有测试：
//   它是 `research/book/` 的**唯一写入口** ——
//   ★ 写错了 = 没签字的东西进了书 = 整本书的可信度归零。
//   而这类 bug **在正文档里看不出来**（书里不会写着"我是被放进来的"）。
// ══════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishToBook } from "../../research/clusters/forge/tools/publish.ts";

const T = ["theory", "practice", "landing"] as const;

/** ★ 造一个临时环境：outbox + signoffs + book/src */
function setup(signs: object[]): { outboxDir: string; signoffsPath: string; bookSrc: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "pub-"));
  const outboxDir = join(root, "outbox");
  mkdirSync(outboxDir, { recursive: true });
  const bookSrc = join(root, "book", "src");
  mkdirSync(bookSrc, { recursive: true });
  const signoffsPath = join(root, "signoffs.jsonl");
  writeFileSync(signoffsPath, signs.map((s) => JSON.stringify(s)).join("\n") + "\n");
  return { outboxDir, signoffsPath, bookSrc, root };
}

function sign(artifact: string, by: string, verdict: string, dislodge?: string) {
  return { at: "2026-10-20T00:00:00Z", artifact, by, verdict, reason: "核对过 runs/x.jsonl", ...(dislodge ? { dislodge } : {}) };
}

describe("发布门 publishToBook", () => {
  it("★★★ 全票认同 → 真的写进 book/src", () => {
    const env = setup([
      sign("a.md", "theory", "认同"),
      sign("a.md", "practice", "认同"),
      sign("a.md", "landing", "认同"),
    ]);
    writeFileSync(join(env.outboxDir, "a.md"), "# 一份真产物\n");
    const r = publishToBook({ ...env, allTeams: T });
    assert.deepEqual(r.published, ["a.md"]);
    const dest = join(env.bookSrc, "05-集群产出", "a.md");
    assert.ok(existsSync(dest), "应该真的落盘");
  });

  it("★★★ 有人反对 → **不写盘**（这是这条门存在的全部理由）", () => {
    const env = setup([
      sign("bad.md", "theory", "认同"),
      sign("bad.md", "practice", "反对"),
      sign("bad.md", "landing", "认同"),
    ]);
    writeFileSync(join(env.outboxDir, "bad.md"), "# 不该进书\n");
    const r = publishToBook({ ...env, allTeams: T });
    assert.deepEqual(r.published, []);
    assert.equal(r.rejected.length, 1);
    assert.ok(!existsSync(join(env.bookSrc, "05-集群产出", "bad.md")), "⛔ 反对的东西不能落盘");
  });

  it("★★ 有团队没表态 → 不写盘", () => {
    const env = setup([sign("x.md", "theory", "认同"), sign("x.md", "practice", "认同")]);
    writeFileSync(join(env.outboxDir, "x.md"), "x");
    const r = publishToBook({ ...env, allTeams: T });
    assert.deepEqual(r.published, []);
    assert.match(r.rejected[0]!.why.join(" "), /未表态|landing/);
  });

  it("★★ 有保留但没解除条件 → 不写盘", () => {
    const env = setup([
      sign("y.md", "theory", "认同"),
      sign("y.md", "practice", "有保留"),
      sign("y.md", "landing", "认同"),
    ]);
    writeFileSync(join(env.outboxDir, "y.md"), "y");
    const r = publishToBook({ ...env, allTeams: T });
    assert.deepEqual(r.published, []);
  });

  it("★ 有保留 + 解除条件 → 写盘，且**保留意见附在文末**", () => {
    // ★★★ 2026-10-20：光给解除条件不够了，还要有同事「认可保留」
    const env = setup([
      sign("z.md", "theory", "认同"),
      sign("z.md", "practice", "有保留", "补一批跨模型读数 N=3"),
      sign("z.md", "landing", "认可保留"),
    ]);
    writeFileSync(join(env.outboxDir, "z.md"), "# 正文\n");
    const r = publishToBook({ ...env, allTeams: T });
    assert.deepEqual(r.published, ["z.md"]);
    assert.equal(r.withReservations.length, 1);
    const body = readFileSync(join(env.bookSrc, "05-集群产出", "z.md"), "utf8");
    assert.match(body, /共识状态/, "产物里要能看到共识状态");
    assert.match(body, /跨模型/, "★ 保留意见必须随产物走");
  });

  it("★ dryRun 只算不写", () => {
    const env = setup([
      sign("d.md", "theory", "认同"),
      sign("d.md", "practice", "认同"),
      sign("d.md", "landing", "认同"),
    ]);
    writeFileSync(join(env.outboxDir, "d.md"), "d");
    const r = publishToBook({ ...env, allTeams: T, dryRun: true });
    assert.deepEqual(r.published, ["d.md"]);
    assert.ok(!existsSync(join(env.bookSrc, "05-集群产出", "d.md")), "dryRun 不许落盘");
  });

  it("★ 完全没签字的产物 → 一律拒绝（沉默 ≠ 认同）", () => {
    const env = setup([]);
    writeFileSync(join(env.outboxDir, "none.md"), "none");
    const r = publishToBook({ ...env, allTeams: T });
    assert.deepEqual(r.published, []);
    assert.equal(r.rejected.length, 1);
  });

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 第二道门：能不能照做（2026-10-20）
//
//   设计者裁定：「可以**用作「工具」**」。
//   实测：79% 的份带 20+ 处 work/ 实验路径，newcomer 原话
//   「它现在是一份给同行看的实验报告，不是给新人的说明书」。
//
//   ★ 干跑代价（42 份真实签字）：只看签字门 35 份 → 接上可用门 29 份（挡 14%）。
// ══════════════════════════════════════════════════════════════════════════
describe("★★★ 第二道门：能不能照做", () => {
  const allAgree = (a: string) => [
    sign(a, "theory", "认同"),
    sign(a, "practice", "认同"),
    sign(a, "landing", "认同"),
  ];

  it("★★★ 签字全过但【不可用】⇒ 不进书（这才是第二道门的全部意义）", () => {
    const env = setup(allAgree("x.md"));
    writeFileSync(join(env.outboxDir, "x.md"), "# x" + String.fromCharCode(10));
    const r = publishToBook({
      ...env,
      allTeams: T,
      usableCheck: () => ({ usable: false, why: "newcomer 说：没见过从头走到尾的例子" }),
    });
    assert.deepEqual(r.published, [], "不可用却发了 —— 第二道门没生效");
    assert.equal(r.rejected.length, 1);
    assert.ok(r.rejected[0]!.why.join("").includes("照不了做"));
  });

  it("★★ 签字全过 + 可用 ⇒ 正常进书", () => {
    const env = setup(allAgree("x.md"));
    writeFileSync(join(env.outboxDir, "x.md"), "# x" + String.fromCharCode(10));
    const r = publishToBook({ ...env, allTeams: T, usableCheck: () => ({ usable: true, why: "ok" }) });
    assert.deepEqual(r.published, ["x.md"]);
  });

  it("★★★ 不传 usableCheck ⇒ 行为与旧版完全一致（便于对照实验）", () => {
    const env = setup(allAgree("x.md"));
    writeFileSync(join(env.outboxDir, "x.md"), "# x" + String.fromCharCode(10));
    const r = publishToBook({ ...env, allTeams: T });
    assert.deepEqual(r.published, ["x.md"], "不传判据时不该有任何额外拦截");
  });

  it("★★ 两个门是【并列】—— 签字没过时，可用也没用", () => {
    const env = setup([sign("x.md", "theory", "反对")]);
    writeFileSync(join(env.outboxDir, "x.md"), "# x" + String.fromCharCode(10));
    const r = publishToBook({ ...env, allTeams: T, usableCheck: () => ({ usable: true, why: "ok" }) });
    assert.deepEqual(r.published, [], "签字门没过却发了");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 撤下「以前发过、现在过不了门」的产物（2026-10-20）
//
//   病（实测）：书里 38 份，发布账说"被拒 30 份"，
//   ★★ 其中 **5 份同时存在** —— 门现在会拒它们，但它们早就进书了。
//
//   ★ `publishToBook` 原来只做 `copyFileSync` **新增，从不删**
//   ⇒ 门拦得住"新东西进不进"，拦不住"已经进书的坏东西"。
//   ★★★ 违反纪律⑩：书的现状必须对应一次确定的门判定。
// ══════════════════════════════════════════════════════════════════════════
describe("★★★ 撤下：门要能往回拦", () => {
  it("★★★ 书里已有、这次被拒 ⇒ **从书里删掉**", () => {
    const env = setup([sign("x.md", "theory", "反对")]);   // 这次会被拒
    writeFileSync(join(env.outboxDir, "x.md"), "# x" + String.fromCharCode(10));
    // 假装它以前发过
    mkdirSync(join(env.bookSrc, "05-集群产出"), { recursive: true });
    writeFileSync(join(env.bookSrc, "05-集群产出", "x.md"), "# 旧版本" + String.fromCharCode(10));

    const r = publishToBook({ ...env, allTeams: T });
    assert.deepEqual(r.removed, ["x.md"], "被拒了却没撤下 —— 书里会留着坏东西");
    assert.ok(!existsSync(join(env.bookSrc, "05-集群产出", "x.md")), "文件还在");
  });

  it("★★ 从没发过的被拒 ⇒ removed 里没有它（没东西可撤）", () => {
    const env = setup([sign("y.md", "theory", "反对")]);
    writeFileSync(join(env.outboxDir, "y.md"), "# y" + String.fromCharCode(10));
    const r = publishToBook({ ...env, allTeams: T });
    assert.deepEqual(r.removed, []);
  });

  it("★★★ 正常发布的不会被误删", () => {
    const env = setup([
      sign("z.md", "theory", "认同"),
      sign("z.md", "practice", "认同"),
      sign("z.md", "landing", "认同"),
    ]);
    writeFileSync(join(env.outboxDir, "z.md"), "# z" + String.fromCharCode(10));
    const r = publishToBook({ ...env, allTeams: T });
    assert.deepEqual(r.removed, [], "正常发布被当成撤下了");
    assert.ok(existsSync(join(env.bookSrc, "05-集群产出", "z.md")));
  });

  it("★★ 干跑时只报告会撤谁，不真删", () => {
    const env = setup([sign("w.md", "theory", "反对")]);
    writeFileSync(join(env.outboxDir, "w.md"), "# w" + String.fromCharCode(10));
    mkdirSync(join(env.bookSrc, "05-集群产出"), { recursive: true });
    writeFileSync(join(env.bookSrc, "05-集群产出", "w.md"), "# 旧" + String.fromCharCode(10));
    const r = publishToBook({ ...env, allTeams: T, dryRun: true });
    assert.deepEqual(r.removed, ["w.md"], "干跑应该报告会撤谁");
    assert.ok(existsSync(join(env.bookSrc, "05-集群产出", "w.md")), "干跑不该真删");
  });
});
});
