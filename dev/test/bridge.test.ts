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

// R47：pi 的派发用真值判据，而它的每个事件都只解构对象式变换结果。像
// `(e) => arr.push(e)` 这种极常见写法返回的是**数组长度**（真值），会被当成变换结果，
// 后果是 payload 被整体替换 ⇒ 空回复 + 长时间重试 + **无任何报错**（任务 8 探针实测 14 秒）。
// 所以非对象真值要当场抛错，把人钉在误用上而不是让人去猜为什么这一轮什么都没说。
test("R47：监听器返回非对象真值（如 push 的长度）当场抛错", async () => {
  const a = await makeAgent();
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    // 判别点：`push` 的返回值是真值但不是对象。若守卫缺席，这一行不会报任何错，
    // 而且不会立刻暴露——要等到整轮跑完才以「空文本」的形式现身（任务 8 探针实测 14 秒）。
    a.on("before_provider_request", ((e: any) => arr.push(e.type)) as never);
    await a.io.prompt("[[tool:read]] 触发一次出网请求");
    // 注意：这里**不能**断言「prompt 抛错」。pi 把扩展钩子的错误交给 onError 通路
    // （`emitError`），异常不会穿出 prompt —— 本库的 R17 把它转成 `[aiteam]` 前缀的 console.error。
    // 所以判别的读法是「有具名、点出误用的错误」，而不是「异常穿出来」。
    // 若把这层守卫删掉，这条必然红：logs 会空，而现象变成空文本 + 静默重试。
    const hit = logs.find((l) => l.includes("before_provider_request") && l.includes("number"));
    assert.ok(
      hit,
      `push 的返回值该被当场拦下并报出误用；实际日志：${JSON.stringify(logs)}`,
    );
    assert.match(hit!, /块体/, "错误文案该直接给出正确写法");
  } finally {
    console.error = orig;
    a.dispose();
  }
});
const arr: string[] = [];

test("R47 对照：块体写法（什么都不返回）不受影响", async () => {
  const a = await makeAgent();
  try {
    const arr: string[] = [];
    a.on("before_provider_request", (e: any) => {
      arr.push(e.type);
    });
    const r = await a.io.prompt("[[tool:read]] 走完一轮");
    assert.equal(r.error, undefined, `块体监听器不该干扰运行：${JSON.stringify(r)}`);
    assert.ok(arr.length > 0, "监听器确实被调到了");
  } finally {
    a.dispose();
  }
});

// R48：dispose 之后**七个面一律不可再用**。
// 原先只有 io / context / model 三个面有 dispose 用例，另四个面（tools / permissions /
// extensions / skills）的实现里有 assertAlive 却没人钉；而 io 自己还漏了 pending / isRunning / raw
// 三个成员——正是这类「七分之六遵守」的隐形不对称，只有把七个面放进**同一张表**里扫一遍才看得见。
// 表驱动的意义：新增一个面成员时，忘记守卫会让它在这里红，而不是等使用者踩到。
test("R48：dispose 之后七个面的每个成员都拒绝使用（唯一的例外是 io.waitIdle）", async () => {
  const a = await makeAgent();
  a.dispose();
  const probes: Record<string, () => unknown> = {
    "io.pending": () => a.io.pending,
    "io.isRunning": () => a.io.isRunning,
    "io.raw": () => a.io.raw,
    "io.prompt": () => a.io.prompt("x"),
    "io.queue": () => a.io.queue("x"),
    "io.steer": () => a.io.steer("x"),
    "io.abort": () => a.io.abort(),
    "context.history": () => a.context.history,
    "context.usage": () => a.context.usage,
    "context.override": () => a.context.override(() => []),
    "context.compact": () => a.context.compact(),
    "context.raw": () => a.context.raw,
    "tools.list": () => a.tools.list(),
    "tools.add": () => a.tools.add({ name: "x", description: "x", parameters: {}, execute: async () => ({}) } as never),
    "tools.remove": () => a.tools.remove("x"),
    "tools.onResult": () => a.tools.onResult(() => undefined),
    "tools.raw": () => a.tools.raw,
    "permissions.gate": () => a.permissions.gate(async () => undefined),
    "permissions.only": () => a.permissions.only(["read"]),
    "permissions.allow": () => a.permissions.allow(["read"]),
    "permissions.deny": () => a.permissions.deny(["read"]),
    "extensions.list": () => a.extensions.list(),
    "extensions.errors": () => a.extensions.errors(),
    "extensions.add": () => a.extensions.add({ path: "x", factory: () => {} } as never),
    "extensions.remove": () => a.extensions.remove("x"),
    "extensions.raw": () => a.extensions.raw,
    "skills.list": () => a.skills.list(),
    "skills.add": () => a.skills.add("/nope"),
    "skills.remove": () => a.skills.remove("/nope"),
    "skills.raw": () => a.skills.raw,
    "model.current": () => a.model.current,
    "model.thinking": () => a.model.thinking,
    "model.available": () => a.model.available,
    "model.set": () => a.model.set("faux/echo"),
    "model.setThinking": () => a.model.setThinking("off"),
    "model.raw": () => a.model.raw,
    "agent.on": () => a.on("turn_start", () => {}),
  };
  // 表里刻意**没有** permissions.raw 与 agent.session：契约里根本没有这两个成员
  // （`PermissionsSurface` 只有 gate/allow/deny/only；`Agent` 只有 session，且它是构造期就定下的引用，
  //  不是面成员）。第一次跑这张表时它们报「仍可用」——那是我的用例把契约记错了，
  //  **不是**实现漏了守卫。这条也说明表驱动扫描的价值：它把「我以为的成员」和「契约里的成员」对齐。
  const leaked: string[] = [];
  for (const [label, probe] of Object.entries(probes)) {
    try {
      await probe();
      leaked.push(label);      // 没抛 = 这个成员在 dispose 后还能用
    } catch {
      /* 预期：拒绝 */
    }
  }
  assert.deepEqual(leaked, [], `dispose 之后仍然可用的成员（应当都拒绝）：${JSON.stringify(leaked)}`);
  // 有注释的那个例外：已回收的 agent 永远「已静下来」，不抛、直接 resolve（v1 决策 #21）
  await a.io.waitIdle();
});

