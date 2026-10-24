// ★★★★★ PREREG 行内 provenance（`src/runlog.ts`，2026-10-21 从 hunt 私有副本并入）
//
// ══════════════════════════════════════════════════════════════════════════
// 这是库缺的一块真能力
//
//   它让每一行数据自带「我是拿哪份**冻结判据**算的」（preregSha / driverSha /
//   judgeSha），并给每行加一个 **seal**（seq / rowSha / prev / chainSha）。
//
//   ⇒ 于是可以回答两个以前答不了的问题：
//     ① 这一行还能不能反查到当初那份判据？（纪律⑦：判据跑前冻结）
//     ② 这份 jsonl 有没有被人**事后删行 / 等长改值 / 截尾 / 换序**？
//
//   ★★★ 这正好是我在本项目里**反复翻车**的那件事：报了一堆比率，
//     却答不出「这个数是拿哪个判据算的」。
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 纪律㉙：任何"通过/干净"的读数，必须先证明**它在该失败时会失败**。
//   所以下面每条"能检出"的断言，都配一条"干净时不误报"的对照。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openRunLog, verifyRunLog } from "../../src/runlog.ts";

function scratch(): { dir: string; prereg: string; driver: string } {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  const prereg = join(dir, "PREREG.md");
  const driver = join(dir, "driver.mjs");
  writeFileSync(prereg, "判据 v1：干净 ⇒ OK\n");
  writeFileSync(driver, "console.log('x')\n");
  return { dir, prereg, driver };
}

function make(opts: { dir: string; prereg: string; driver: string }, rows = 3) {
  const file = join(opts.dir, "runs.jsonl");
  const log = openRunLog({ file, experiment: "t", preregFile: opts.prereg, driverFile: opts.driver });
  for (let i = 0; i < rows; i++) log.append({ arm: "a", v: i });
  return { file, log };
}

describe("★★★★★ ① 干净数据 ⇒ OK（不误报）", () => {
  it("★★★★ 三行正常写入 ⇒ verify OK，且每行都带判据指纹", () => {
    const o = scratch();
    const { file } = make(o);
    const r = verifyRunLog(file);
    assert.equal(r.rows.length, 3);
    assert.equal(r.ok, true, `不该误报：${JSON.stringify(r.counts)}`);
    // ★ 每行必须自带 preregSha / driverSha（这就是"行内 provenance"）
    const first = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!);
    // ★ 指纹在 `criteria` 里（不是行顶层）—— 我第一版字段名写错了
    assert.ok(first.criteria?.preregSha, "★ 行内必须有判据指纹");
    assert.ok(first.criteria?.driverSha, "★ 行内必须有 driver 指纹");
    assert.ok(first.criteria?.criteriaSha, "★ 还要有合成指纹");
    assert.ok(first.seal?.chainSha, "★ 行内必须有链 seal");
  });
});

describe("★★★★★ ② 四种人造篡改都必须检出（纪律㉙）", () => {
  it("★★★★ 删一行 ⇒ 链断", () => {
    const o = scratch();
    const { file } = make(o);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n");
    assert.equal(verifyRunLog(file).ok, false, "★ 删行必须检出");
  });

  it("★★★★ 等长改值（改一个字符，长度不变）⇒ 行 sha 不符", () => {
    const o = scratch();
    const { file } = make(o);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    lines[1] = lines[1]!.replace('"v":1', '"v":7');
    assert.equal(lines[1]!.length, readFileSync(file, "utf8").split("\n")[1]!.length, "★ 长度要对得上才算'等长改值'");
    writeFileSync(file, lines.join("\n") + "\n");
    assert.equal(verifyRunLog(file).ok, false, "★ 等长改值必须检出");
  });

  it("★★★★ 截尾（删最后一行）⇒ head 对不上", () => {
    const o = scratch();
    const { file, log } = make(o);
    const headBefore = log.head();
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, lines.slice(0, 2).join("\n") + "\n");
    const r = verifyRunLog(file);
    assert.notEqual(r.head, headBefore, "★ head 必须变（这才是截尾的证据）");
  });

  it("★★★★ 换序（前两行互换）⇒ 链不符", () => {
    const o = scratch();
    const { file } = make(o);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, [lines[1], lines[0], lines[2]].join("\n") + "\n");
    assert.equal(verifyRunLog(file).ok, false, "★ 换序必须检出");
  });
});

describe("★★★★★ ③ 判据在跑中被改 ⇒ 必须当场响，不许静默", () => {
  it("★★★★ 改了 PREREG 再 append ⇒ 抛错（不是悄悄写进去）", () => {
    const o = scratch();
    const { log } = make(o, 1);
    writeFileSync(o.prereg, "判据 v2：偷偷改了\n");
    assert.throws(() => log.append({ arm: "a", v: 99 }), /PREREG|判据|改/i, "★ 跑中改判据必须抛");
  });

  it("★★★ 改了 driver 再 append ⇒ 抛错", () => {
    const o = scratch();
    const { log } = make(o, 1);
    writeFileSync(o.driver, "console.log('patched')\n");
    assert.throws(() => log.append({ arm: "a", v: 99 }), /driver|改/i);
  });
});

describe("★★★★ ④ 空文件 / 不存在 ⇒ 不炸且说清楚", () => {
  it("★★ 不存在的文件 ⇒ EMPTY，不是 OK", () => {
    const r = verifyRunLog(join(tmpdir(), "不存在的-runlog.jsonl"));
    assert.equal(r.verdict, "EMPTY");
    assert.equal(r.ok, false, "★ 没数据 ≠ 通过");
  });
});
