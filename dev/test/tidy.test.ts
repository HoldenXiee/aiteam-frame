// tidy 的判据测试（★ 纪律⑦：纯函数、可离线重判）
//
// ★ 这一组测试要证明的是「**它在该拒收时会拒收**」（纪律㉙）——
//   清理是不可逆动作，量具必须双向验：能清的时候清、不该清的时候拦得住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTidy, candidates, dirStat, guard, purgeTrash, referencedIn, report, TIDY } from "../../research/clusters/hunt/topology/tidy.ts";

function mkLab(): string {
  const lab = mkdtempSync(join(tmpdir(), "tidy-"));
  for (const d of ["outbox", "inbox", "lib", "work/runs", "work/bigdir", "work/small"]) mkdirSync(join(lab, d), { recursive: true });
  writeFileSync(join(lab, "work/bigdir/a.txt"), "x".repeat(100));
  writeFileSync(join(lab, "work/small/b.txt"), "y");
  writeFileSync(join(lab, "outbox/P1.md"), "结论");
  return lab;
}

test("guard：成果/账本/日志/锁 一律不许清", () => {
  const lab = mkLab();
  try {
    for (const p of ["outbox", "inbox", "lib", "work/runs", "work/experiments.jsonl", "work/_topology.log", "work/_cluster.lock"]) {
      assert.ok(guard(lab, p) !== null, `${p} 应该被拒`);
    }
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }
});

test("guard：越界一律拒（绝对路径 / .. / 空间根 / work 根）", () => {
  const lab = mkLab();
  try {
    assert.ok(guard(lab, "../x") !== null);
    assert.ok(guard(lab, "D:/somewhere") !== null);
    assert.ok(guard(lab, "") !== null);
    assert.ok(guard(lab, "work") !== null);
    assert.ok(guard(lab, "outbox/.git") !== null);
    // ★ 该放行的：普通 scratch 目录
    assert.equal(guard(lab, "work/bigdir"), null);
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }
});

test("guard：单文件不許清（一份产物就是一个结论）", () => {
  const lab = mkLab();
  try {
    assert.match(String(guard(lab, "outbox/P1.md")), /受保护/);
    writeFileSync(join(lab, "work/loose.md"), "x");
    assert.match(String(guard(lab, "work/loose.md")), /只许清目录/);
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }
});

test("referencedIn：账本里提过的目录不许清", () => {
  const lab = mkLab();
  try {
    assert.equal(referencedIn(lab, "work/bigdir"), null);
    writeFileSync(join(lab, "work/experiments.jsonl"), JSON.stringify({ id: "E1", carriers: ["work/bigdir/x.jsonl"] }) + "\n");
    assert.match(String(referencedIn(lab, "work/bigdir")), /experiments\.jsonl/);
    const res = applyTidy(lab, { paths: ["work/bigdir"], why: "测" });
    assert.equal(res.ok, false);
    assert.equal(res.moved.length, 0);
    assert.match(res.refused[0]!.reason, /被账本引用/);
    assert.ok(existsSync(join(lab, "work/bigdir")), "被引用的目录必须原地不动");
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }
});

test("applyTidy：放行的目录移进 _trash，并落一行账", () => {
  const lab = mkLab();
  try {
    const res = applyTidy(lab, { paths: ["work/bigdir"], why: "拷进来的环境", kind: "copied-env" });
    assert.equal(res.ok, true);
    assert.equal(res.moved.length, 1);
    assert.equal(res.moved[0]!.files, 1);
    assert.ok(!existsSync(join(lab, "work/bigdir")), "原位置应消失");
    assert.ok(existsSync(join(lab, "work/_trash")), "应移进 _trash（可回退，不是真删）");
    const log = readFileSync(join(lab, "work/_tidy.jsonl"), "utf8");
    assert.match(log, /tidy:moved\s+work\/bigdir/);
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }
});

test("applyTidy：一次超过配额 ⇒ 整批拒（不许一口气清掉证据）", () => {
  const lab = mkLab();
  try {
    const many = Array.from({ length: TIDY.maxPathsPerCall + 1 }, (_, i) => `work/d${i}`);
    const res = applyTidy(lab, { paths: many, why: "测配额" });
    assert.equal(res.ok, false);
    assert.match(res.refused[0]!.reason, /最多清/);
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }
});

test("purgeTrash：保留期内不动，过期才真删", () => {
  const lab = mkLab();
  try {
    const now = new Date("2026-10-27T10:00:00Z");
    applyTidy(lab, { paths: ["work/bigdir"], why: "测" }, now);
    // 保留期内
    assert.equal(purgeTrash(lab, new Date(now.getTime() + 60_000)).length, 0);
    const trashBefore = readTrashDirs(lab);
    assert.equal(trashBefore, 1);
    // 过了 TTL
    const later = new Date(now.getTime() + TIDY.trashTtlMs + 60_000);
    const purged = purgeTrash(lab, later);
    assert.equal(purged.length, 1);
    assert.equal(readTrashDirs(lab), 0, "过期批次应真删（留痕不能长期占地方）");
    assert.match(readFileSync(join(lab, "work/_tidy.jsonl"), "utf8"), /tidy:purged/);
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }
});

test("candidates：只看形状（node_modules / 文件数 / 体积），不判内容", () => {
  const lab = mkLab();
  try {
    assert.equal(candidates(lab).length, 0, "干净的空间不该有候选");
    // ① 拷进来的环境
    mkdirSync(join(lab, "work/probe/node_modules/x"), { recursive: true });
    writeFileSync(join(lab, "work/probe/node_modules/x/a.js"), "x");
    // ② 碎文件洪水
    mkdirSync(join(lab, "work/flood"), { recursive: true });
    for (let i = 0; i < TIDY.manyFiles + 5; i++) writeFileSync(join(lab, "work/flood", `${i}.txt`), "");
    const c = candidates(lab);
    const names = c.map((x: { rel: string }) => x.rel);
    assert.ok(names.includes("work/probe"), "有 node_modules ⇒ 候选");
    assert.ok(names.includes("work/flood"), `文件数 > ${TIDY.manyFiles} ⇒ 候选`);
    assert.ok(!names.includes("work/small"), "小 scratch 不算候选（不打扰人）");
    assert.ok(!names.includes("work/runs"), "runs/ 是轮转日志，不算");
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }
});

test("dirStat：深度与文件数有封顶（不许再出现全树扫把事件循环冻住）", () => {
  const lab = mkLab();
  try {
    let d = join(lab, "work/deep");
    for (let i = 0; i < 12; i++) d = join(d, `l${i}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "a.txt"), "x");
    const st = dirStat(lab, "work/deep");
    assert.equal(st.files, 0, "深度 6 层以后的文件不数（封顶）");
    const capped = dirStat(lab, "work/flood", 10);
    assert.ok(capped.files <= 10, "文件数封顶生效");
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }
});

test("report：读数能回答「清了多少 / 还剩多少」", () => {
  const lab = mkLab();
  try {
    const now = new Date();
    applyTidy(lab, { paths: ["work/bigdir"], why: "测" }, now);
    const r = report(lab);
    assert.equal(r.moved.length, 1);
    assert.equal(r.moved[0]!.rel, "work/bigdir");
    assert.equal(typeof r.totalBytes, "number");
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }
});

function readTrashDirs(lab: string): number {
  const p = join(lab, "work/_trash");
  if (!existsSync(p)) return 0;
  return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}
