// io 面：驱动（prompt / queue / steer / abort / waitIdle）与**调用绑定的结算**。
// v1 的病是「排干共享消息池取最后一条」——重叠投递时结果串台；这里全部用「本次运行的消息区间」。
import test from "node:test";
import assert from "node:assert/strict";
import { makeAgent } from "./helpers.ts";

test("prompt 返回与本次运行绑定的 RunResult", async () => {
  const a = await makeAgent();
  try {
    const r = await a.io.prompt("hello");
    assert.equal(r.text, "echo:hello");
    assert.equal(r.usage.totalTokens, 18);
    assert.equal(r.usage.cost.total, 0);
    assert.match(r.runId, /^r\d+$/);
    assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant"]);
  } finally { a.dispose(); }
});

test("连续两次 prompt 不串台（v1 的排干式 bug 的回归）", async () => {
  const a = await makeAgent();
  try {
    const r1 = await a.io.prompt("aaa");
    const r2 = await a.io.prompt("bbb");
    assert.equal(r1.text, "echo:aaa");
    assert.equal(r2.text, "echo:bbb");
    assert.notEqual(r1.runId, r2.runId);
    assert.equal(r1.messages.length, 2);          // 只含本次
  } finally { a.dispose(); }
});

test("agent.usage 是累计值", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("one"); await a.io.prompt("two");
    assert.equal(a.usage.totalTokens, 36);
  } finally { a.dispose(); }
});

test("忙时 queue：返回 {queued:true}，消息被并进同一次运行", async () => {
  const a = await makeAgent();
  try {
    const p = a.io.prompt("[[sleep:400]] slow");
    const q = await a.io.queue("追加");
    assert.deepEqual(q, { queued: true });
    const r = await p;
    assert.equal(r.messages.filter((m) => m.role === "user").length, 2);   // 明说它属于同一次
  } finally { a.dispose(); }
});

test("空闲时 queue 也返回 {queued:true}，不谎报 ran", async () => {
  const a = await makeAgent();
  try {
    assert.deepEqual(await a.io.queue("hi"), { queued: true });
    await a.io.waitIdle();
    assert.equal(a.usage.totalTokens, 18);
  } finally { a.dispose(); }
});

test("忙时 prompt → 抛错并指向 queue", async () => {
  const a = await makeAgent();
  try {
    const p = a.io.prompt("[[sleep:400]] slow");
    await assert.rejects(() => a.io.prompt("x"), /io\.queue/);
    await p;
  } finally { a.dispose(); }
});

test("abort 之后能静下来", async () => {
  const a = await makeAgent();
  try {
    const p = a.io.prompt("[[sleep:800]] slow").catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    await a.io.abort();
    await a.io.waitIdle();
    assert.notEqual(a.status, "running");
  } finally { a.dispose(); }
});

test("waitIdle 在 dispose 之后直接 resolve，不抛错（v1 决策 #21）", async () => {
  const a = await makeAgent();
  a.dispose();
  await a.io.waitIdle();
  assert.equal(a.status, "disposed");
});

test("pending / isRunning 反映真实状态（含启动窗口）", async () => {
  const a = await makeAgent();
  try {
    assert.equal(a.io.isRunning, false);
    assert.equal(a.io.pending, 0);
    const p = a.io.prompt("[[sleep:400]] slow");
    // 启动窗口：pi 的 isStreaming 还没翻真，但库自己的计数已经知道它跑起来了
    assert.equal(a.io.isRunning, true);
    await a.io.queue("追加");
    assert.equal(a.io.pending, 1);
    await p;
    await a.io.waitIdle();
    assert.equal(a.io.isRunning, false);
    assert.equal(a.io.pending, 0);
  } finally { a.dispose(); }
});

test("运行中失败不 reject，但 RunResult.error 要显式暴露", async () => {
  // pi 对「接下了但跑挂了」不 reject，只把错误写进 assistant 消息 —— 不读出来就是静默失败
  const a = await makeAgent();
  try {
    const r = await a.io.prompt("[[fail]] boom");
    assert.match(r.error ?? "", /faux-provider-boom/);
    assert.equal(r.text, "");
  } finally { a.dispose(); }
});
