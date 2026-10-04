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

test("queue 空闲路径起的运行失败经 console.error 浮出来，且输出里有 runId", async () => {
  // 这条路径没有返回值也没有 promise 给调用者 —— 失败不上报就是静默失效（R20）
  const a = await makeAgent();
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await a.io.queue("[[fail]] 故意失败");
    await a.io.waitIdle();                       // 别用死 sleep 猜：等库自己的在飞运行收尾
  } finally {
    console.error = original;
    a.dispose();
  }
  const reported = lines.find((line) => line.includes("[aiteam]"));
  assert.ok(reported, `没有 [aiteam] 前缀的失败上报：${JSON.stringify(lines)}`);
  assert.match(reported, /runId=r\d+/);
  assert.match(reported, /faux-provider-boom/);   // 原始错误信息要在
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

test("interrupt：在飞那轮被中断，新输入立即投递并拿到它的 RunResult", async () => {
  const a = await makeAgent();
  try {
    const slow = a.io.prompt("[[sleep:2000]] 慢").catch(() => {});
    await a.io.interrupt("换成这句");            // 不抛错 = 它真的中断了，而 prompt 在忙时会拒绝
    const r = await a.io.prompt("下一句");        // 中断之后可以正常继续
    assert.equal(r.text, "echo:下一句");
    await slow;
    assert.notEqual(a.status, "running");
  } finally { a.dispose(); }
});

test("interrupt：启动窗口里调用也要中断（pi 的 isStreaming 还没翻真）", async () => {
  const a = await makeAgent();
  try {
    const slow = a.io.prompt("[[sleep:800]] 慢").catch(() => {});
    const r = await a.io.interrupt("窗口里插队");   // 紧跟同步调用，不给 setTimeout
    assert.match(r.text, /窗口里插队/);
    await slow;
  } finally { a.dispose(); }
});

test("interrupt 空闲时 = prompt", async () => {
  const a = await makeAgent();
  try {
    const r = await a.io.interrupt("直接说");     // 没有在飞轮次，不该抛错
    assert.equal(r.text, "echo:直接说");
  } finally { a.dispose(); }
});

test("interrupt 不吞掉已排队的 queue 消息（queue 的承诺不被违背）", async () => {
  const a = await makeAgent();
  try {
    const slow = a.io.prompt("[[sleep:800]] 慢").catch(() => {});
    await a.io.queue("排队的话");
    const r = await a.io.interrupt("打断");
    const userText = r.messages
      .filter((m) => m.role === "user")
      .map((m) => JSON.stringify(m.content))
      .join("|");
    assert.ok(userText.includes("排队的话"), `排队的消息应当在这一轮里被投递：${userText}`);
    await slow;
  } finally { a.dispose(); }
});

test("dispose 之后 interrupt 抛错（R48）", async () => {
  const a = await makeAgent();
  a.dispose();
  await assert.rejects(() => a.io.interrupt("x"), /disposed/);
});
