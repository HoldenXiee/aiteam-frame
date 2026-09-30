import test from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgent, createAgentHost, type AgentHost, type ControlledAgent, type MemberSpec } from "../src/index.ts";
import { createSpawnAgentTool } from "../src/tools/spawn-agent.ts";
import { FAUX_MODEL_REF } from "./faux-models.ts";
import { runTool, textOf } from "./helpers.ts";

async function makeLead(
  members: Record<string, MemberSpec>,
  opts: { maxAgents?: number; maxDepth?: number; budgetTokens?: number } = {},
): Promise<{ host: AgentHost; lead: ControlledAgent }> {
  const host = createAgentHost({ members, ...opts });
  const lead = await createAgent({ model: FAUX_MODEL_REF, tools: ["spawn_agent"] }, { host });
  return { host, lead };
}

function memberEnum(tool: ToolDefinition): string[] {
  const member = (tool.parameters as any).properties.member;
  return (member.anyOf ?? []).map((s: any) => s.const);
}

test("工具描述列出花名册全部成员及其职责", async () => {
  const { host, lead } = await makeLead({
    reviewer: { description: "负责挑刺与代码审查" },
    writer: { description: "负责写文档" },
  });
  const tool = createSpawnAgentTool({ agent: lead, host });
  assert.match(tool.description, /reviewer/);
  assert.match(tool.description, /负责挑刺与代码审查/);
  assert.match(tool.description, /writer/);
  assert.match(tool.description, /负责写文档/);
});

test("member 参数是花名册成员名的字面量联合", async () => {
  const { host, lead } = await makeLead({ reviewer: {}, writer: {} });
  const tool = createSpawnAgentTool({ agent: lead, host });
  assert.deepEqual(memberEnum(tool).sort(), ["reviewer", "writer"]);
});

test("spawn 后分身留在宿主里，parentId 与 member 正确", async () => {
  const { host, lead } = await makeLead({ reviewer: { tools: ["read"] } });
  const out = await runTool("spawn_agent", { member: "reviewer", task: "审查 src/foo.ts" }, { host, agent: lead });

  const child = host.list().find((a) => a.member === "reviewer");
  assert.ok(child, "分身应当留在宿主里");
  assert.equal(child.parentId, lead.id);
  assert.match(textOf(out), new RegExp(child.id));
  assert.deepEqual((out.details as any).agentId, child.id);
});

test("模型真的能通过 prompt 发起 spawn_agent", async () => {
  const { host, lead } = await makeLead({ reviewer: { description: "审查员" } });
  await lead.prompt(`[[tool:spawn_agent]] [[args:{"member":"reviewer","task":"写一句话"}]]`);
  const child = host.list().find((a) => a.member === "reviewer");
  assert.ok(child, "分身应当已经跑完并留在宿主里");
  assert.equal(child.parentId, lead.id);
});

test("同一成员两次 spawn 得到两个独立分身", async () => {
  const { host, lead } = await makeLead({ reviewer: {} });
  await runTool("spawn_agent", { member: "reviewer", task: "第一件" }, { host, agent: lead });
  await runTool("spawn_agent", { member: "reviewer", task: "第二件" }, { host, agent: lead });

  const children = host.list().filter((a) => a.member === "reviewer");
  assert.equal(children.length, 2);
  assert.notEqual(children[0].id, children[1].id);
  assert.equal(children[0].usage.totalTokens > 0, true);
});

test("护栏：maxAgents 触发时返回错误文本而不是抛异常", async () => {
  const { host, lead } = await makeLead({ reviewer: {} }, { maxAgents: 1 });
  const out = await runTool("spawn_agent", { member: "reviewer", task: "x" }, { host, agent: lead });
  assert.match(textOf(out), /maxAgents/);
  assert.equal(host.list().length, 1, "不该真的建出分身");
});

test("护栏：maxDepth 触发时返回错误文本", async () => {
  const { host, lead } = await makeLead({ reviewer: {} }, { maxDepth: 0 });
  const out = await runTool("spawn_agent", { member: "reviewer", task: "x" }, { host, agent: lead });
  assert.match(textOf(out), /maxDepth|深度/);
  assert.equal(host.list().length, 1);
});

test("护栏：预算耗尽时返回错误文本", async () => {
  const { host, lead } = await makeLead({ reviewer: {} }, { budgetTokens: 1 });
  await lead.prompt("先烧掉一点预算");
  const out = await runTool("spawn_agent", { member: "reviewer", task: "x" }, { host, agent: lead });
  assert.match(textOf(out), /budget|预算/);
  assert.equal(host.list().length, 1);
});

test("运行时传不存在的成员名返回错误文本，不崩", async () => {
  const { host, lead } = await makeLead({ reviewer: {} });
  const out = await runTool("spawn_agent", { member: "nope", task: "x" }, { host, agent: lead });
  assert.match(textOf(out), /nope/);
  assert.equal(host.list().length, 1);
});
