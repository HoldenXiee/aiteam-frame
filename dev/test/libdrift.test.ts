// ★★★★★ 三份 lib 的漂移 —— 集群改出来的东西有没有回到 src/
//
// ══════════════════════════════════════════════════════════════════════════
// 实测（2026-10-21）
//
//   `hunt/lib`  vs `src/`        4+ 个文件不同
//   `hunt/lib`  vs `forge/lib`   **14 个文件不同**（两份副本已经漂移）
//   最近 3 天改 lib 的          **只有 hunt**（forge 的 `libsmith` 是闲的）
//
// ⇒ 后果：**集群在一份会漂的分支上开发能力，而仓库本体永远拿不到。**
//   我在 `hunt跑一轮-改了9个库文件` 里记过，然后**没有下一步**。
//
// ★ 为什么这是**我的**活：集群不能改 `src/`（AGENTS 边界），
//   所以"该不该合"只能我判断并执行。而我一直没做 ⇒ 这笔账从来没人算。
// ★★ 这个读具不判"该不该合"（内容判断，硬规则①），只把**欠账清单**摆出来。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseDrift, renderDrift } from "../../research/clusters/libdrift.ts";

const L = "labfirst/hunt/lib";
const R = "src";

describe("★★★★★ ① 认三种 diff 行（两种写法都收）", () => {
  it("★★★★ 改过的文件 ⇒ differ（取相对左根的名字）", () => {
    const { drift } = parseDrift([`Files ${L}/aiteam/agent/lab.ts and ${R}/aiteam/agent/lab.ts differ`], L, R);
    assert.equal(drift.differ.length, 1);
    assert.equal(drift.differ[0]!.file, "aiteam/agent/lab.ts");
    assert.equal(drift.total, 1);
  });

  it("★★★★ 只在左 ⇒ onlyLeft（★ 集群自己长出来的）", () => {
    const { drift } = parseDrift([`Only in ${L}/aiteam/agent: env-revision.ts`], L, R);
    assert.equal(drift.onlyLeft.length, 1);
    assert.equal(drift.onlyLeft[0]!.file, "aiteam/agent/env-revision.ts");
  });

  it("★★★★ 只在右 ⇒ onlyRight（★ 集群缺的）", () => {
    const { drift } = parseDrift([`Only in ${R}/aiteam: foo.ts`], L, R);
    assert.equal(drift.onlyRight.length, 1);
  });

  it("★★ Windows 反斜杠路径也认", () => {
    const { drift } = parseDrift([`Files ${L}\\x.ts and ${R}\\x.ts differ`], L, R);
    assert.equal(drift.differ[0]!.file, "x.ts");
  });
});

describe("★★★★★ ② 不认的行不许静默丢（失败要响）", () => {
  it("★★★★★ 未知格式进 ignore，看得见", () => {
    const r = parseDrift(["Binary files a and b differ", "garbage line"], L, R);
    assert.equal(r.ignore.length, 2, "★ 不认的行必须留下来");
    assert.equal(r.drift.total, 0);
  });

  it("★★ 空行/空白行不算未知", () => {
    const r = parseDrift(["", "   ", `Files ${L}/a.ts and ${R}/a.ts differ`], L, R);
    assert.equal(r.ignore.length, 0);
    assert.equal(r.drift.total, 1);
  });
});

describe("★★★★ ③ 渲染：先看得见「有多少」，再谈「该不该合」", () => {
  it("★★★ 一致时明确说一致", () => {
    const { drift } = parseDrift([], L, R);
    assert.ok(renderDrift(drift).includes("完全一致"));
  });

  it("★★★★ 不一致时报三栏数 + 点名（★ 要点到具体文件）", () => {
    const { drift } = parseDrift(
      [
        `Files ${L}/a.ts and ${R}/a.ts differ`,
        `Only in ${L}: b.ts`,
        `Only in ${R}: c.ts`,
      ],
      L,
      R,
    );
    const s = renderDrift(drift);
    assert.ok(s.includes("3 处不同"), s);
    assert.ok(s.includes("改过 1"), s);
    assert.ok(s.includes("a.ts"), s);
    assert.ok(s.includes("b.ts"), s);
    assert.ok(s.includes("c.ts"), s);
  });

  it("★★ 超过 12 个改过的文件 ⇒ 截断并说明还剩多少", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Files ${L}/f${i}.ts and ${R}/f${i}.ts differ`);
    const s = renderDrift(parseDrift(lines, L, R).drift);
    assert.ok(s.includes("还有 8 个"), s);
  });
});
