// ★★★★★ PREREG 断链：判据冻结了，数据反查不回去
//
// ★★★ 这个缺陷是**集群自己发现的**（`onInstrumentReview` 第一次真跑的产物）：
//
//   「`PREREG-*.md` 72 份 · `exp-*.ts` 75 个 · 101 批 · 1750 行
//    ★ 行里带 preregId/preregSha/criteriaSha/judgeSha：**0/1750**」
//
// ★★ 我只补一件事：**把它做成可复算的读数**，并**只报我能量准的部分**。
//
// ★★★ 本文最重要的一组测试是「**不报自己量错的数**」：
//   集群报 STALE 32/101（用 git 历史），我第一版用 mtime 得 9/101 —— 差 23。
//   mtime 回答"现在"不回答"当时"（纪律㉛）⇒ 所以我**删掉了 STALE**，只报结构性事实。

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  preregTraceability,
  renderPrereg,
  TRACE_FIELDS,
} from "../../research/clusters/hunt/topology/prereg-trace.ts";

const B = String.fromCharCode(10);

describe("★★★★★ ① 核心判据：有没有一行能反查回判据", () => {
  it("★★★★★ 一行都没有 ⇒ tracedRows=0（这就是实测的病）", () => {
    const files = ["PREREG-a.md", "exp-a.ts", "runs/a.jsonl"];
    const r = preregTraceability(files, () => ['{"arm":"A","p":0.01}', '{"arm":"B","p":0.2}']);
    assert.equal(r.rows, 2);
    assert.equal(r.tracedRows, 0, "★ 这就是 0/1750 的那个 0");
  });

  it("★★★ 带 preregSha ⇒ 算可追溯", () => {
    const r = preregTraceability(["runs/a.jsonl"], () => ['{"preregSha":"abc123","p":0.01}']);
    assert.equal(r.tracedRows, 1);
  });

  it("★★ 五个字段名任一都算（★ 不强求某一种命名）", () => {
    for (const f of TRACE_FIELDS) {
      const r = preregTraceability(["runs/a.jsonl"], () => [`{"${f}":"x"}`]);
      assert.equal(r.tracedRows, 1, `${f} 没被认出来`);
    }
  });

  it("★★ 空行不算行", () => {
    const r = preregTraceability(["runs/a.jsonl"], () => ["{}", "", "  "]);
    assert.equal(r.rows, 1);
  });
});

describe("★★★★ ② 结构上可恢复 = 有 driver + 有同名 PREREG", () => {
  it("★★★★ 三件齐 ⇒ 可恢复", () => {
    const r = preregTraceability(["PREREG-a.md", "exp-a.ts", "runs/a.jsonl"], () => ["{}"]);
    assert.equal(r.recoverable, 1);
    assert.equal(r.detail[0]!.prereg, "present");
  });

  it("★★★ 缺 PREREG ⇒ 不可恢复，且记为 none", () => {
    const r = preregTraceability(["exp-a.ts", "runs/a.jsonl"], () => ["{}"]);
    assert.equal(r.recoverable, 0);
    assert.equal(r.detail[0]!.prereg, "none");
  });

  it("★★★ 缺 driver ⇒ 不可恢复（★ 没有 driver 就不知道数是怎么算出来的）", () => {
    const r = preregTraceability(["PREREG-a.md", "runs/a.jsonl"], () => ["{}"]);
    assert.equal(r.recoverable, 0);
    assert.equal(r.detail[0]!.driver, undefined);
  });
});

describe("★★★★★ ③ 不报自己量错的数（纪律㉛）", () => {
  it("★★★★★ 读数里**不出现 STALE** —— 那需要 git，mtime 量不准", () => {
    const r = preregTraceability(["PREREG-a.md", "exp-a.ts", "runs/a.jsonl"], () => ["{}"]);
    const s = renderPrereg(r);
    assert.ok(!s.includes("STALE"), `不该报 STALE（mtime 回答不了"当时"）：${s}`);
    // ★ 结构性的那条要在
    assert.ok(s.includes("行级字段"), `缺核心读数（行级口径）：${s}`);
    assert.ok(s.includes("被封口"), `缺新口径（seal 覆盖）：${s}`);
  });
});

describe("★★ ④ 渲染要能一眼看出病", () => {
  it("★★ 0/1750 这种形状要看得出来", () => {
    const files = ["PREREG-a.md", "exp-a.ts", "runs/a.jsonl"];
    const r = preregTraceability(files, (b) => Array(10).fill('{"x":1}'));
    const s = renderPrereg(r);
    assert.ok(s.includes("0/10"), `应该显示 0/10：${s}`);
  });

  it("★ 空输入说清（不假装有数据）", () => {
    assert.ok(renderPrereg(preregTraceability([], () => [])).includes("还没有"));
  });
});

// ★★★★★ 2026-10-21 · 认 seal（集群自己设计的修法）
//
// ★★★ 这是**必须补的一条**，理由是差点犯的错：
//   集群的修法**不是**把 `preregSha` 写进每一行，而是在**批结束时**写一条 seal，
//   用**字节窗口**覆盖这一批的全部行。
//   ⇒ 我的读数如果只认"行里有字段"，那么**它修好了我也永远报 0/1750**
//     ⇒ 一个永远红的量具会逼它去做**无用功**（把 hash 重复写进 1750 行）。
//
// ★★ 判据必须是「**行级字段 或 seal 覆盖**」。
describe("★★★★★ 认 seal：量具要跟着修法变", () => {
  const seal = (batch: string, end: number) => ({ batch, startBytes: 0, endBytes: end, preregSha: "x" });

  it("★★★★★ seal 覆盖全部字节 ⇒ 这批算可追溯（即使行里一个字段都没有）", () => {
    const r = preregTraceability(["runs/a.jsonl"], () => ['{"arm":"A"}'], [seal("a", 100)], () => 100);
    assert.equal(r.tracedRows, 0, "行级字段确实没有");
    assert.equal(r.sealedBatches, 1, "★ 但 seal 覆盖了 ⇒ 要认");
    assert.equal(r.sealedRows, 1);
  });

  it("★★★★ seal 只覆盖一半 ⇒ **不算**（★ 被追加过行就是被污染过）", () => {
    const r = preregTraceability(["runs/a.jsonl"], () => ['{"arm":"A"}'], [seal("a", 50)], () => 100);
    assert.equal(r.sealedBatches, 0, "覆盖不全就不是封口");
  });

  it("★★★ seal 的 batch 名不匹配 ⇒ 不算", () => {
    const r = preregTraceability(["runs/a.jsonl"], () => ["{}"], [seal("other", 100)], () => 100);
    assert.equal(r.sealedBatches, 0);
  });

  it("★★ 没有 seal 也不炸（旧数据）", () => {
    const r = preregTraceability(["runs/a.jsonl"], () => ["{}"]);
    assert.equal(r.sealedBatches, 0);
    assert.equal(r.batches, 1);
  });

  it("★★★★ 读数里**两个口径都在**（行级 + 封口）", () => {
    const r = preregTraceability(["runs/a.jsonl"], () => ["{}"], [seal("a", 100)], () => 100);
    const s = renderPrereg(r);
    assert.ok(s.includes("行级字段"), `要有旧口径：${s}`);
    assert.ok(s.includes("被封口"), `要有新口径：${s}`);
  });
});

// ★★★★★ 2026-10-21 · **分母必须是「机制出生之后」**
//
// ★★★ 集群第二次纠正我（第一次是 mtime）：
//   「『96% 不经过』的分母是「全部历史数据」，而机制 06:33:59Z 才出生。
//     **98/109 批出生早于机制本身**；能走的 8 批走了 6 批」
//
// ★★ 我复核（按行内 `t` 轴）：出生前 101 · 出生后 8 · 已封口 6 —— **对上了**。
// ★ 真读数是「6/8 = 75% 已覆盖」，不是「96% 没覆盖」。
describe("★★★★★ 分母必须是「机制出生之后」", () => {
  const T0 = "2026-10-24T06:33:59.295Z";
  const BIRTH = Date.parse(T0);

  it("★★★★★ 出生前的批**不算进分母**（否则比例永远 <6%）", () => {
    const r = preregTraceability(
      ["runs/old.jsonl", "runs/new.jsonl"],
      (b) =>
        b === "old.jsonl"
          ? [JSON.stringify({ t: new Date(BIRTH - 3600_000).toISOString() })]
          : [JSON.stringify({ t: new Date(BIRTH + 60_000).toISOString() })],
      [{ batch: "new", startBytes: 0, endBytes: 999, t0: T0 }],
      () => 100,
    );
    assert.equal(r.sinceBirth.batches, 1, "★ 只有出生后那批进分母");
    assert.equal(r.sinceBirth.sealed, 1);
    assert.equal(r.sealedBatches, 1);
  });

  it("★★★★ 出生后没封口才算漏，出生前的不算", () => {
    const r = preregTraceability(
      ["runs/old.jsonl", "runs/new.jsonl"],
      (b) =>
        b === "old.jsonl"
          ? [JSON.stringify({ t: new Date(BIRTH - 3600_000).toISOString() })]
          : [JSON.stringify({ t: new Date(BIRTH + 60_000).toISOString() })],
      [{ batch: "old", startBytes: 0, endBytes: 999, t0: T0 }],
      () => 100,
    );
    assert.equal(r.sinceBirth.batches, 1);
    assert.equal(r.sinceBirth.sealed, 0, "★ 出生后这批没封口 ⇒ 这是真漏");
  });

  it("★★ 没有时间轴的批归不到出生后（不硬算进分母）", () => {
    const r = preregTraceability(["runs/x.jsonl"], () => ['{"arm":"A"}'], [{ batch: "x", t0: T0 }]);
    assert.equal(r.sinceBirth.batches, 0);
  });
});
