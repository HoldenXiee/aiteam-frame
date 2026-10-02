// 骨架与桥接：声明面基线、原始事件透传、退订、错误要喊出来、dispose 之后不许再用。
import test from "node:test";
import assert from "node:assert/strict";
import { makeAgent, sentMessages, sentTools } from "./helpers.ts";

test("默认 agent 的声明面 = pi 的四个内置工具（桥接不改变基线行为）", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("hi");
    assert.deepEqual(sentTools(), ["read", "bash", "edit", "write"]);
    assert.equal(sentMessages(), 2);
  } finally { a.dispose(); }
});

test("agent.on 收到 pi 的原始事件，ctx 里挂着 agent 与 runId", async () => {
  const a = await makeAgent();
  const seen: { type: string; cwd?: string; isIdle?: string; agent?: string; runId?: string }[] = [];
  const off = a.on("agent_settled", (e, ctx) => {
    seen.push({ type: e.type, cwd: ctx.cwd, isIdle: typeof ctx.isIdle, agent: ctx.agent.id, runId: ctx.runId });
  });
  try {
    await a.io.prompt("hi");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "agent_settled");
    assert.equal(seen[0].agent, a.id);
    assert.equal(seen[0].isIdle, "function");
    assert.equal(typeof seen[0].cwd, "string");
  } finally { a.dispose(); }
});

test("on 返回的退订函数生效", async () => {
  const a = await makeAgent();
  let count = 0;
  const off = a.on("agent_settled", () => { count += 1; });
  try {
    await a.io.prompt("one");
    assert.equal(count, 1);
    off();
    await a.io.prompt("two");
    assert.equal(count, 1);
  } finally { a.dispose(); }
});

test("事件名拼错 → 立刻抛错并列出可用事件名", async () => {
  const a = await makeAgent();
  try {
    assert.throws(() => a.on("tool_calls" as never, () => {}), /tool_calls/);
  } finally { a.dispose(); }
});

test("spec 未知字段 → 抛错并指出字段名", async () => {
  await assert.rejects(() => makeAgent({ permisions: {} } as never), /permisions/);
});

test("dispose 之后操作 → 抛错", async () => {
  const a = await makeAgent();
  a.dispose();
  assert.equal(a.status, "disposed");
  await assert.rejects(() => a.io.prompt("x"), /disposed/);
});
