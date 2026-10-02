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

test("spec 面里未知字段 → 抛错并指出面与字段名（NOT_WIRED 清零后 SURFACE_KEYS 仍生效）", async () => {
  await assert.rejects(() => makeAgent({ tools: { custm: [] } } as never), /tools 里的未知字段「custm」/);
  await assert.rejects(() => makeAgent({ permissions: { onli: [] } } as never), /permissions 里的未知字段「onli」/);
});

test("同一事件上两个监听器都返回变换结果 → 报错拦下，不静默丢弃前一个", async () => {
  // 用 tool_call 而不是 context：pi 的 emitContext / emitToolResult 把 handler 抛的错吞进自己的
  // error listener（runner.js:1020 等），而 emitToolCall 不吞（runner.js:951-969）；且 agent 层会把
  // hook 抛的错转成 toolResult 文本。所以只有 tool_call 能把抛错暴露成可断言的证据。
  const a = await makeAgent();
  a.on("tool_call", () => ({ reason: "第一个变换" }));
  a.on("tool_call", () => ({ reason: "第二个变换" }));
  try {
    await a.io.prompt('[[tool:read]] [[args:{"path":"/nope"}]]');
    const results = (a.io.raw.messages as any[]).filter((m) => m.role === "toolResult");
    assert.equal(results.length, 1);
    const text = JSON.stringify(results[0].content);
    assert.match(text, /tool_call/);          // 错误信息要指名事件
    assert.match(text, /permissions\.gate/);  // 且说清出路
  } finally { a.dispose(); }
});

test("block 短路优先于双变换守卫：先变换、后 block → 不抛错且工具真被拦下", async () => {
  const a = await makeAgent();
  const order: string[] = [];
  a.on("tool_call", () => { order.push("transform"); return { reason: "变换" }; });
  a.on("tool_call", () => { order.push("block"); return { block: true, reason: "probe-blocked" }; });
  try {
    await a.io.prompt('[[tool:read]] [[args:{"path":"/nope"}]]');
    assert.deepEqual(order, ["transform", "block"]);
    const results = (a.io.raw.messages as any[]).filter((m) => m.role === "toolResult");
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0].content), /probe-blocked/);
  } finally { a.dispose(); }
});

test("context 上的钩子抛错 → 经 console.error 浮出来（pi 在这个事件上会吞异常）", async () => {
  // R17：pi 的 emitContext 把 handler 抛的错吞进 emitError，而 emitError 只投 errorListeners、
  // 没有 console 兜底。createAgent 注册的扩展错误监听器是这类异常唯一的可见出口。
  const a = await makeAgent();
  a.on("context", (e: any) => ({ messages: e.messages }));
  a.on("context", (e: any) => ({ messages: e.messages }));
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    await a.io.prompt("hi");
  } finally {
    console.error = original;
    a.dispose();
  }
  assert.ok(logged.length > 0, "console.error 应当被调用");
  assert.ok(logged.some((line) => line.includes("context")), `输出里应含事件名 context，实际：${logged.join(" | ")}`);
});

test("reload 之后 context 上的钩子异常仍然浮出来，且不重复打印（R18）", async () => {
  // 监听器挂在 extensionRunner **实例**上，而 session.reload() 会 new 一个新实例 —— 只挂一次的话
  // reload 之后钩子异常重新静默。io.raw 就是 session；T1 阶段这是公开面上唯一能走 reload 的路径
  // （任务 4/6 接线后走 bridge.reload()，它同样经过被包装的 session.reload()）。
  const a = await makeAgent();
  a.on("context", (e: any) => ({ messages: e.messages }));
  a.on("context", (e: any) => ({ messages: e.messages }));
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    await a.io.prompt("hi");
    assert.equal(logged.length, 1, `reload 前每轮只应浮出一条，实际：${logged.join(" | ")}`);
    assert.match(logged[0], /context/);

    await a.io.raw.reload();

    await a.io.prompt("hi again");
    assert.equal(logged.length, 2, `reload 后仍应浮出，且每轮一条（重挂不能重复注册），实际：${logged.join(" | ")}`);
    assert.match(logged[1], /context/);
  } finally {
    console.error = original;
    a.dispose();
  }
});

test("dispose 之后操作 → 抛错", async () => {
  const a = await makeAgent();
  a.dispose();
  assert.equal(a.status, "disposed");
  await assert.rejects(() => a.io.prompt("x"), /disposed/);
});
