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
import { publishToBook } from "../../research/clusters/hunt/tools/publish.ts";

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
    const env = setup([
      sign("z.md", "theory", "认同"),
      sign("z.md", "practice", "有保留", "补一批跨模型读数 N=3"),
      sign("z.md", "landing", "认同"),
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
});
