import test from "node:test";
import assert from "node:assert/strict";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent } from "../src/index.ts";
import { FAUX_MODEL_REF } from "./faux-models.ts";
import { echoTool, seenTools } from "./helpers.ts";

test("prompt 返回文本与本次用量", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const run = await agent.prompt("hi");
  assert.match(run.text, /echo:hi/);
  assert.ok(run.usage.totalTokens > 0);
});

test("模型报错时 RunResult.error 被填充且不 reject", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const run = await agent.prompt("[[fail]]");
  assert.ok(run.error, "应当有 error");
});

test("RunResult.usage 是本次，agent.usage 是累计", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const first = await agent.prompt("一");
  const second = await agent.prompt("二");
  assert.equal(agent.usage.totalTokens, first.usage.totalTokens + second.usage.totalTokens);
});

test("dispose 后 status 为 disposed，再调 prompt 抛明确错误", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  agent.dispose();
  assert.equal(agent.status, "disposed");
  await assert.rejects(() => agent.prompt("x"), /disposed/);
});

test("未提供 tools 时 customTools 自动生效", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF, customTools: [echoTool] });
  await agent.prompt("[[tool:probe_echo]]");
  assert.ok(seenTools().includes("probe_echo"));
});

test("提供了 tools 白名单时 customTools 仍被并入（规格 §4.1 / 决策 #4）", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF, customTools: [echoTool], tools: ["read"] });
  await agent.prompt("[[tool:probe_echo]]");
  const names = seenTools();
  assert.ok(names.includes("probe_echo"), JSON.stringify(names));
  // 白名单本身仍然生效：没列进去的内置工具不该出现
  assert.ok(names.includes("read"), JSON.stringify(names));
  assert.ok(!names.includes("bash"), JSON.stringify(names));
});

test("onToolCall 返回 block 时工具不执行", async () => {
  let ran = false;
  const blocked = defineTool({
    name: "blocked_probe",
    label: "Blocked",
    description: "不该被执行",
    parameters: Type.Object({}),
    execute: async () => {
      ran = true;
      return { content: [{ type: "text" as const, text: "ran" }], details: {} };
    },
  });
  const agent = await createAgent({
    model: FAUX_MODEL_REF,
    customTools: [blocked],
    onToolCall: async () => ({ block: true, reason: "设计者拒绝了" }),
  });
  await agent.prompt("[[tool:blocked_probe]]");
  assert.equal(ran, false);
});

test("on() 能收到 text / tool_end / done", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF, customTools: [echoTool] });
  const got: string[] = [];
  agent.on("text", (p) => got.push(`text:${p.delta}`));
  agent.on("tool_end", (p) => got.push(`tool_end:${p.toolName}`));
  agent.on("done", (p) => got.push(`done:${p.usage.totalTokens > 0}`));
  await agent.prompt("[[tool:probe_echo]]");
  assert.ok(got.some((g) => g.startsWith("text:")), JSON.stringify(got));
  assert.ok(got.includes("tool_end:probe_echo"), JSON.stringify(got));
  assert.ok(got.includes("done:true"), JSON.stringify(got));
});
