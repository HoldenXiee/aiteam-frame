// tools 面：运行期增删工具、工厂式工具拿得到 ctx.agent、tool_result 拦截。
//
// 运行期改声明面的机制是 **reload**：桥接是 pi 的一个常驻内联扩展，`session.reload() 会重跑扩展工厂**
// （agent-session.js:2867-2880 `_buildRuntime` → `_refreshToolRegistry` + `setActiveToolsByName`），
// 工厂把 `bridge.tools` 整体重新注册一遍 —— 所以加进去的工具在下一轮就对模型可见。
// 桥接自己的身份没变（还是同一个内联扩展），`pi.on` 那些事件钩子也靠这次重跑接回去。
import test from "node:test";
import assert from "node:assert/strict";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeAgent, sentTools, echoTool } from "./helpers.ts";

test("add 之后 reload：模型真的收到新工具的 schema", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());       // await：碰声明面 → reload
    await a.io.prompt("hi");
    assert.ok(sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});

test("加进来的工具真的能被模型调用，且工厂拿得到 ctx.agent", async () => {
  const a = await makeAgent();
  let seenBy: string | undefined;
  try {
    await a.tools.add((ctx) => defineTool({
      name: "probe_echo", label: "Echo", description: "回显",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      execute: async () => {
        seenBy = ctx.agent.id;
        return { content: [{ type: "text" as const, text: "ran" }], details: {} };
      },
    }));
    await a.io.prompt("[[tool:probe_echo]]");
    assert.equal(seenBy, a.id);
  } finally { a.dispose(); }
});

test("创建时给了白名单，add 进来的工具仍然要能用", async () => {
  const a = await makeAgent({ permissions: { only: ["read"] } });
  try {
    await a.tools.add(echoTool());
    await a.io.prompt("hi");
    assert.ok(sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});

test("list 反映注册与活跃状态", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    assert.deepEqual(a.tools.list().find((t) => t.name === "probe_echo"), { name: "probe_echo", active: true });
    // `active` 必须真的跟活跃集走，不能恒 true：摘掉之后同名项要变成 active:false（否则这个字段是装饰）
    a.io.raw.setActiveToolsByName(a.io.raw.getActiveToolNames().filter((n) => n !== "probe_echo"));
    assert.deepEqual(a.tools.list().find((t) => t.name === "probe_echo"), { name: "probe_echo", active: false });
  } finally { a.dispose(); }
});

test("remove 把名字从注册表与活跃集都摘干净", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    await a.tools.remove("probe_echo");
    assert.deepEqual(a.tools.list().map((t) => t.name), []);          // 表里没了
    assert.equal(a.io.raw.getToolDefinition("probe_echo"), undefined); // 注册表里也没了
    assert.deepEqual(a.tools.raw.getToolDefinition("probe_echo"), undefined);
    assert.ok(!a.io.raw.getActiveToolNames().includes("probe_echo"));   // 活跃集里也没了
  } finally { a.dispose(); }
});

test("运行中 remove 也抛错（与 add 共用同一个忙判据）", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    const p = a.io.prompt("[[sleep:400]] slow");
    await assert.rejects(() => a.tools.remove("probe_echo"), /空闲/);
    await p;
    // 抛错不能顺手把工具删了：声明面没变
    assert.deepEqual(a.tools.list().map((t) => t.name), ["probe_echo"]);
  } finally { a.dispose(); }
});

test("remove 之后从声明面消失，会话还能继续用", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    await a.tools.remove("probe_echo");
    await a.io.prompt("hi");
    assert.ok(!sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});

test("add 一个 defaultActive:false 的工具：显式 add 要让它真的 active", async () => {
  // reload 的隐式激活带 `defaultActive !== false` 过滤（agent-session.js:2829-2831），所以无白名单时
  // 不显式并入活跃集的话，add 会变成静默 no-op：表里有、list 显示 active:false、模型收不到。
  const a = await makeAgent();
  try {
    await a.tools.add((_ctx) => defineTool({
      name: "probe_lazy", label: "Lazy", description: "默认不活跃的工具",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      defaultActive: false,
      execute: async () => ({ content: [{ type: "text" as const, text: "lazy" }], details: {} }),
    }));
    assert.deepEqual(
      a.tools.list().find((t) => t.name === "probe_lazy"),
      { name: "probe_lazy", active: true },
    );
    await a.io.prompt("[[tool:probe_lazy]]");
    assert.ok(sentTools().includes("probe_lazy"));   // 声明面真的收到了
  } finally { a.dispose(); }
});

test("add 工厂式工具只调用工厂一次（R30b）", async () => {
  // 工厂有可观察副作用才能判别「存成品」与「存工厂」：存工厂的话 reload 会再调一次 → calls=2。
  const a = await makeAgent();
  let calls = 0;
  try {
    await a.tools.add(() => {
      calls += 1;
      return defineTool({
        name: "probe_once", label: "Once", description: "工厂只该被调一次",
        parameters: Type.Object({ text: Type.Optional(Type.String()) }),
        execute: async () => ({ content: [{ type: "text" as const, text: "once" }], details: {} }),
      });
    });
    assert.equal(calls, 1);
  } finally { a.dispose(); }
});

test("运行中 add → 抛错（idle 守卫）", async () => {
  const a = await makeAgent();
  try {
    const p = a.io.prompt("[[sleep:400]] slow");
    await assert.rejects(() => a.tools.add(echoTool()), /空闲/);
    await p;
  } finally { a.dispose(); }
});

test("忙时 add 工厂式工具：工厂一次都不该被调用（R36）", async () => {
  // 忙守卫必须排在工厂调用**之前**：一次注定被拒绝的 add 不该让设计者工厂的副作用先跑一遍。
  // 上面那条忙守卫用例 add 的是对象式工具，工厂副作用不可观察 —— 只有工厂式才判得出顺序。
  const a = await makeAgent();
  let calls = 0;
  try {
    const p = a.io.prompt("[[sleep:400]] slow");
    await assert.rejects(() => a.tools.add(() => { calls += 1; return echoTool() as ToolDefinition; }), /空闲/);
    assert.equal(calls, 0);
    await p;
  } finally { a.dispose(); }
});

test("排队中的 follow-up 也算忙：add 一样被拦下", async () => {
  // 这一项钉的是忙判据的**第二个分量**。follow-up 是唯一「isRunning 假、但一轮运行即将开始」的状态：
  // pi 把它排进 steering / follow-up 队列（agent-session.js:1824-1825），此刻 isStreaming 还是假。
  // 只看 io.isRunning 的话这里会放行 → reload 撞上马上就要跑的轮次，工具静默不生效。
  const a = await makeAgent();
  try {
    await a.io.raw.followUp("待会儿再说");
    assert.equal(a.io.isRunning, false);   // 前提：这一项确实不是 isRunning 能盖住的
    assert.equal(a.io.pending, 1);
    await assert.rejects(() => a.tools.add(echoTool()), /空闲/);
  } finally { a.dispose(); }
});

test("onResult 改工具返回给模型的内容", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    a.tools.onResult(() => ({ content: [{ type: "text", text: "被改过" }] }));
    const r = await a.io.prompt("[[tool:probe_echo]]");
    // 假服务在收到工具结果后会把它回显成文本 —— 所以最终文本能证明模型看到了被改过的结果
    assert.equal(r.text, "echo:被改过");
  } finally { a.dispose(); }
});

test("onResult 的退订函数生效", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    const off = a.tools.onResult(() => ({ content: [{ type: "text", text: "被改过" }] }));
    off();
    const r = await a.io.prompt("[[tool:probe_echo]]");
    assert.notEqual(r.text, "echo:被改过");
  } finally { a.dispose(); }
});
