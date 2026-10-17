// permissions 面：审批门（可拦、可改参）+ 运行期工具集三档语义（only / allow / deny）。
//
// 门的接线：桥接的 `tool_call` 派发器在监听表**之前**跑 `bridge.gate`（R26 专属槽位），返回
// `{block:true, reason}` 时 pi 的 `_beforeToolCall` 把它变成一条 `isError` 的工具结果
// （agent-loop.js:507-517），reason 因此进到模型上下文里。
//
// 运行期三档语义是**一层机制**（R38）：改 pi 的硬过滤集合（白名单/排除集）→ `reload()`；
// reload 同时重建注册表与活跃集，所以不再调 `setActiveToolsByName`（async、要求 idle）。
import test from "node:test";
import assert from "node:assert/strict";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeAgent, sentTools, echoTool } from "./helpers.ts";

test("gate 拦下工具：工具不执行，reason 进上下文", async () => {
  const a = await makeAgent();
  let ran = false;
  try {
    await a.tools.add((ctx) => defineTool({
      name: "probe_echo", label: "Echo", description: "回显",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      execute: async () => { ran = true; return { content: [{ type: "text" as const, text: "ran" }], details: {} }; },
    }));
    a.permissions.gate(async () => ({ block: true, reason: "不许用" }));
    const r = await a.io.prompt("[[tool:probe_echo]]");
    assert.equal(ran, false);
    assert.match(r.text, /不许用/);
  } finally { a.dispose(); }
});

test("gate 原地改 event.input：工具收到改后的参数", async () => {
  const a = await makeAgent();
  let got: unknown;
  try {
    await a.tools.add((ctx) => defineTool({
      name: "probe_echo", label: "Echo", description: "回显",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      execute: async (_id, params) => { got = params; return { content: [{ type: "text" as const, text: "ran" }], details: {} }; },
    }));
    a.permissions.gate(async (call) => { (call.input as { text?: string }).text = "改过"; return undefined; });
    await a.io.prompt("[[call:probe_echo {\"text\":\"原值\"}]]");
    assert.equal((got as { text?: string }).text, "改过");
  } finally { a.dispose(); }
});

test("gate 拦住之后，用户的 on('tool_call') 不会被调用（pi 的短路语义）", async () => {
  const a = await makeAgent();
  let called = 0;
  try {
    await a.tools.add(echoTool());
    a.on("tool_call", () => { called += 1; });
    a.permissions.gate(async () => ({ block: true, reason: "拦" }));
    await a.io.prompt("[[tool:probe_echo]]");
    assert.equal(called, 0);
  } finally { a.dispose(); }
});

test("gate 不拦时，用户的 on('tool_call') 会被调用", async () => {
  const a = await makeAgent();
  let called = 0;
  try {
    await a.tools.add(echoTool());
    a.on("tool_call", () => { called += 1; });
    a.permissions.gate(async () => undefined);
    await a.io.prompt("[[tool:probe_echo]]");
    assert.equal(called, 1);
  } finally { a.dispose(); }
});

test("gate 内 throw → 变成拦截，异常文本进上下文", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    a.permissions.gate(async () => { throw new Error("门炸了"); });
    const r = await a.io.prompt("[[tool:probe_echo]]");
    assert.match(r.text, /门炸了/);
  } finally { a.dispose(); }
});

test("gate 内 throw 的拦截 reason 由库自己成型（String(err)，不是 pi 兜底）", async () => {
  // 去掉桥接那层 try/catch，pi 自己的 `prepareToolCall` 兜底会把 reason 变成 `err.message`
  // （agent-loop.js:533-539）—— 少了 "Error: " 前缀。这条是那层 catch 的唯一判别证据。
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    a.permissions.gate(async () => { throw new Error("门炸了"); });
    const r = await a.io.prompt("[[tool:probe_echo]]");
    assert.equal(r.text, "echo:Error: 门炸了");
  } finally { a.dispose(); }
});

test("only 精确设置工具集", async () => {
  const a = await makeAgent();
  try { await a.permissions.only(["read"]); await a.io.prompt("hi"); assert.deepEqual(sentTools(), ["read"]); }
  finally { a.dispose(); }
});

test("allow 是并集、deny 是移除", async () => {
  const a = await makeAgent();
  try {
    await a.permissions.only(["read"]);
    await a.permissions.allow(["bash"]);
    await a.io.prompt("1");
    assert.deepEqual([...sentTools()].sort(), ["bash", "read"]);
    await a.permissions.deny(["bash"]);
    await a.io.prompt("2");
    assert.deepEqual(sentTools(), ["read"]);
  } finally { a.dispose(); }
});

test("创建时 permissions.only 生效", async () => {
  const a = await makeAgent({ permissions: { only: ["read"] } });
  try { await a.io.prompt("hi"); assert.deepEqual(sentTools(), ["read"]); } finally { a.dispose(); }
});

test("创建时 permissions.deny 生效", async () => {
  const a = await makeAgent({ permissions: { deny: ["bash"] } });
  try {
    await a.io.prompt("hi");
    assert.ok(!sentTools().includes("bash"));
    assert.ok(sentTools().includes("read"));   // 前提：deny 只关点名的那个，别的照旧
  } finally { a.dispose(); }
});

test("创建时 permissions.gate 生效（与运行期是同一个槽位）", async () => {
  const a = await makeAgent({ permissions: { gate: async () => ({ block: true, reason: "创建期就拦" }) } });
  let ran = false;
  try {
    await a.tools.add((ctx) => defineTool({
      name: "probe_echo", label: "Echo", description: "回显",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      execute: async () => { ran = true; return { content: [{ type: "text" as const, text: "ran" }], details: {} }; },
    }));
    const r = await a.io.prompt("[[tool:probe_echo]]");
    assert.equal(ran, false);
    assert.match(r.text, /创建期就拦/);
  } finally { a.dispose(); }
});

// ─────────────── 三档语义必须扛过一次 reload ───────────────
// R38 之后 only/allow/deny 自身就 reload；这组用例钉的是**持久性**：硬过滤集合真的被改了 ——
// 只改活跃集的话，下一次 reload 重算活跃集（`agent-session.js:2741-2816`）时就没了。

test("R35：deny 之后经过一次声明面操作（reload），被 deny 的工具仍不在声明面", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    await a.io.prompt("warm");
    assert.ok(sentTools().includes("probe_echo"));      // 前提：deny 之前它确实在声明面里
    await a.permissions.deny(["probe_echo"]);
    await a.io.prompt("1");
    assert.ok(!sentTools().includes("probe_echo"));     // deny 自身 reload 之后就没了
    await a.tools.add(echoTool("probe_other"));         // 声明面操作 → reload
    await a.io.prompt("2");
    assert.ok(!sentTools().includes("probe_echo"));     // reload 之后仍被 deny
    assert.ok(sentTools().includes("probe_other"));     // 前提：这次 reload 确实发生了
  } finally { a.dispose(); }
});

test("R35：有白名单时 deny 也要扛过 reload", async () => {
  const a = await makeAgent({ permissions: { only: ["read"] } });
  try {
    await a.tools.add(echoTool());
    await a.io.prompt("warm");
    assert.ok(sentTools().includes("probe_echo"));
    await a.permissions.deny(["probe_echo"]);
    await a.io.prompt("1");
    assert.ok(!sentTools().includes("probe_echo"));
    await a.tools.add(echoTool("probe_other"));         // reload：白名单那条分支会推回白名单里的名字
    await a.io.prompt("2");
    assert.ok(!sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});

test("R35：allow 在 reload 之后仍然有效（有白名单时不能只进活跃集）", async () => {
  // 创建期白名单下，bash 压根儿没进过注册表（`_refreshToolRegistry` 用白名单硬过滤）——
  // R38 之后 `allow` 自己 reload：白名单跟着长 + 注册表重建，两边一次到位（天花板不再存在）。
  const a = await makeAgent({ permissions: { only: ["read"] } });
  try {
    await a.permissions.allow(["bash"]);
    await a.tools.add(echoTool("probe_other"));          // reload
    await a.io.prompt("1");
    assert.deepEqual([...sentTools()].sort(), ["bash", "probe_other", "read"]);
  } finally { a.dispose(); }
});

test("R35：only 真的排除别的工具，且 reload 之后没回来", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    await a.io.prompt("warm");
    assert.ok(sentTools().includes("probe_echo"));
    await a.permissions.only(["read"]);
    await a.io.prompt("1");
    assert.deepEqual(sentTools(), ["read"]);             // only 自身 reload 之后就排除了
    await a.tools.add(echoTool("probe_other"));          // reload
    await a.io.prompt("2");
    assert.deepEqual([...sentTools()].sort(), ["probe_other", "read"]);  // 白名单之外的没回来
  } finally { a.dispose(); }
});

test("R38：忙时三档操作抛错，且不留半应用（硬过滤集合没被改）", async () => {
  // 守卫必须排在改集合**之前**：否则改完才在 reload 里撞忙，会留下「集合改了、注册表没重建」的
  // 半应用状态 —— 下一次别人触发的 reload 才突然生效（又一次不可见的部分 no-op）。
  const a = await makeAgent();
  try {
    await a.io.prompt("warm");
    assert.ok(sentTools().includes("bash"));
    const p = a.io.prompt("[[sleep:400]] slow");
    await assert.rejects(() => a.permissions.only(["read"]), /空闲/);
    await assert.rejects(() => a.permissions.allow(["bash"]), /空闲/);
    await assert.rejects(() => a.permissions.deny(["bash"]), /空闲/);
    await p;
    await a.tools.add(echoTool("probe_other"));   // 强制一次 reload：半应用会在这里露出来
    await a.io.prompt("after");
    assert.ok(sentTools().includes("bash"));      // only 的半应用若留下白名单，bash 会在这里永久消失
    assert.ok(sentTools().includes("read"));
  } finally { a.dispose(); }
});

test("R37：显式 tools.add 解除同名的 deny（否则工具停在 active:false，调了 add 却没生效）", async () => {
  const a = await makeAgent();
  try {
    await a.permissions.deny(["probe_echo"]);     // 无白名单 → 名字进排除集（`_excludedToolNames`）
    await a.tools.add(echoTool());
    assert.equal(a.tools.list().find((t) => t.name === "probe_echo")?.active, true);
    await a.io.prompt("hi");
    assert.ok(sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});

test("allow 能推翻创建期的 deny（后一次显式动作覆盖前一次声明）", async () => {
  const a = await makeAgent({ permissions: { deny: ["bash"] } });
  try {
    await a.io.prompt("1");
    assert.ok(!sentTools().includes("bash"));     // 前提：创建期 deny 生效
    await a.permissions.allow(["bash"]);
    await a.io.prompt("2");
    assert.ok(sentTools().includes("bash"));
  } finally { a.dispose(); }
});
