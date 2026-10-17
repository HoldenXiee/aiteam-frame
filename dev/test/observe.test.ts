// 观测面（DESIGN「功能二：为分析研究提供材料」）—— agent.observe
//
// 存在的理由（研究过程中实测出来的）：
//   · A1：`context.override` 的判据写错，**生效 0 次**，跑完才发现 —— 缺「每次实参/返回值」
//   · P11：账本挂在消息尾部，**零效果**（26→26）—— 缺「模型到底收到了什么」
//   · 四次「静默失败」，三次没有任何报错
import test from "node:test";
import assert from "node:assert/strict";
import { makeAgent } from "./helpers.ts";

test("observe.wire 记录每一轮真正发给模型的 messages（含 system）", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("hi");
    const wire = a.observe.wire;
    assert.ok(wire.length >= 1, "至少采集到一轮");
    const t = wire[0]!;
    assert.ok(t.count >= 2, "至少 system + user");
    assert.equal(t.systemCount, 1, "system 恰好一条 —— 这是 history 看不到的");
    assert.equal(t.roles.user, 1);
    assert.ok(t.chars > 0);
    assert.ok(t.preview.length === t.count, "preview 与 count 对齐");
  } finally {
    a.dispose();
  }
});

test("observe.wire 逐轮累积（第二轮比第一轮多）", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("hi");
    await a.io.prompt("again");
    const w = a.observe.wire;
    assert.ok(w.length >= 2, `至少两轮，实际 ${w.length}`);
    assert.ok(w[w.length - 1]!.count > w[0]!.count, "后面的轮次消息更多");
  } finally {
    a.dispose();
  }
});

test("observe.injections 记录 override 的调用次数与是否真的改动", async () => {
  const a = await makeAgent();
  try {
    let calls = 0;
    a.context.override((m) => {
      calls++;
      return m; // ★ 原样返回 = 没生效
    });
    await a.io.prompt("hi");
    const stat = a.observe.injections["context.override"];
    assert.ok(stat, "override 这一笔被记下来了");
    assert.equal(stat.calls, calls, "调用次数与钩子内计数一致");
    assert.ok(stat.calls >= 1, "至少调用过一次");
    assert.equal(stat.changed, 0, "返回同一数组 = changed 为 0");
  } finally {
    a.dispose();
  }
});

test("observe.injections 记录 gate 的拦截（这是 P12 需要的读数）", async () => {
  const a = await makeAgent({ permissions: { only: ["ls"] } } as never);
  try {
    // 假服务的脚本约定：在最后一条 user 消息里写 [[tool:NAME]] 让它发起一次工具调用
    a.permissions.gate(async () => ({ block: true, reason: "测试拦截" }));
    await a.io.prompt("试着用个工具 [[tool:ls]]");
    const stat = a.observe.injections["permissions.gate"];
    assert.ok(stat, "gate 这一笔被记下来了");
    assert.ok(stat.calls >= 1, "门被调用过");
    assert.ok(stat.changed >= 1, "返回了 block = 生效过");
    assert.match(stat.lastReturn, /block/, "最后一次返回值里有 block");
  } finally {
    a.dispose();
  }
});

test("observe.clear 清空采集", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("hi");
    assert.ok(a.observe.wire.length >= 1);
    a.observe.clear();
    assert.equal(a.observe.wire.length, 0);
  } finally {
    a.dispose();
  }
});

test("observe.turns 记录每轮 token（O3 成本盲区的材料）", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("hi");
    await a.io.prompt("again");
    const t = a.observe.turns;
    assert.ok(t.length >= 2, `至少两轮用量，实际 ${t.length}`);
    assert.ok(t.every((x) => x.total > 0), "每轮都有 token");
    assert.equal(a.observe.totalTokens, t.reduce((s, x) => s + x.total, 0), "总和一致");
    // ★ 关键：按轮可拆 —— 这是全生命周期累计给不了的
    assert.ok(t[0]!.n === 1, "轮次从 1 起");
  } finally {
    a.dispose();
  }
});
