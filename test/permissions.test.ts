// permissions 面：审批门（可拦、可改参）+ 运行期工具集三档语义（only / allow / deny）。
//
// 门的接线：桥接的 `tool_call` 派发器在监听表**之前**跑 `bridge.gate`（R26 专属槽位），返回
// `{block:true, reason}` 时 pi 的 `_beforeToolCall` 把它变成一条 `isError` 的工具结果
// （agent-loop.js:507-517），reason 因此进到模型上下文里。
//
// 运行期三档语义要**两层**都动（R35）：白名单/排除集（扛 reload） + 活跃集（立即生效）。
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
  try { a.permissions.only(["read"]); await a.io.prompt("hi"); assert.deepEqual(sentTools(), ["read"]); }
  finally { a.dispose(); }
});

test("allow 是并集、deny 是移除", async () => {
  const a = await makeAgent();
  try {
    a.permissions.only(["read"]);
    a.permissions.allow(["bash"]);
    await a.io.prompt("1");
    assert.deepEqual([...sentTools()].sort(), ["bash", "read"]);
    a.permissions.deny(["bash"]);
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

// ─────────────── R35：三档语义必须扛过一次 reload ───────────────
// 只改活跃集是不够的：reload 会 `_buildRuntime({activeToolNames: getActiveToolNames(), includeAllExtensionTools: true})`
// 重算活跃集（agent-session.js:2741-2816）—— 无白名单时扩展工具会被 `defaultActive !== false` 那条分支推回来。

test("R35：deny 之后经过一次声明面操作（reload），被 deny 的工具仍不在声明面", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    await a.io.prompt("warm");
    assert.ok(sentTools().includes("probe_echo"));      // 前提：deny 之前它确实在声明面里
    a.permissions.deny(["probe_echo"]);
    await a.io.prompt("1");
    assert.ok(!sentTools().includes("probe_echo"));     // 立即生效
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
    a.permissions.deny(["probe_echo"]);
    await a.io.prompt("1");
    assert.ok(!sentTools().includes("probe_echo"));
    await a.tools.add(echoTool("probe_other"));         // reload：白名单那条分支会推回白名单里的名字
    await a.io.prompt("2");
    assert.ok(!sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});

test("R35：allow 在 reload 之后仍然有效（有白名单时不能只进活跃集）", async () => {
  // 创建期白名单下，bash 压根儿没进过注册表（`_refreshToolRegistry` 用白名单硬过滤），
  // 所以 `allow` 的**立即**生效对它是做不到的（`setActiveToolsByName` 只在注册表里找）。
  // 能做到的是保证下一次 reload 之后它在：白名单层必须跟着长。
  const a = await makeAgent({ permissions: { only: ["read"] } });
  try {
    a.permissions.allow(["bash"]);
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
    a.permissions.only(["read"]);
    await a.io.prompt("1");
    assert.deepEqual(sentTools(), ["read"]);             // 立即排除
    await a.tools.add(echoTool("probe_other"));          // reload
    await a.io.prompt("2");
    assert.deepEqual([...sentTools()].sort(), ["probe_other", "read"]);  // 白名单之外的没回来
  } finally { a.dispose(); }
});
