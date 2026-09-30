import test from "node:test";
import assert from "node:assert/strict";
import { createAgent, createAgentHost, type AgentHost, type ControlledAgent } from "../src/index.ts";
import { FAUX_MODEL_REF } from "./faux-models.ts";
import { runTool, textOf } from "./helpers.ts";

async function makeLead(): Promise<{ host: AgentHost; lead: ControlledAgent }> {
  const host = createAgentHost({ members: { reviewer: { description: "审查员" } } });
  const lead = await createAgent(
    { model: FAUX_MODEL_REF, tools: ["spawn_agent", "send_message"] },
    { host },
  );
  return { host, lead };
}

async function spawnOne(host: AgentHost, lead: ControlledAgent, task = "第一轮"): Promise<ControlledAgent> {
  const out = await runTool("spawn_agent", { member: "reviewer", task }, { host, agent: lead });
  const id = (out.details as any).agentId as string;
  const child = host.get(id);
  assert.ok(child, "spawn 之后应当能在宿主里找到分身");
  return child!;
}

test("可以给自己的后代分身投递", async () => {
  const { host, lead } = await makeLead();
  const child = await spawnOne(host, lead);

  const out = await runTool("send_message", { agentId: child.id, message: "再改一版" }, { host, agent: lead });
  assert.match(textOf(out), /已投递/);
  assert.equal((out.details as any).delivered, "ran");

  await child.waitForIdle();
  assert.match(child.lastResult!.text, /再改一版/, "后代应当真的跑了这一轮");
});

test("可以投递给后代的再后代（隔一层也行）", async () => {
  const { host, lead } = await makeLead();
  const child = await spawnOne(host, lead);
  const grandchild = await spawnOne(host, child, "孙辈");

  const out = await runTool("send_message", { agentId: grandchild.id, message: "加深一层" }, { host, agent: lead });
  assert.equal((out.details as any).delivered, "ran");
  await grandchild.waitForIdle();
  assert.match(grandchild.lastResult!.text, /加深一层/);
});

test("给非后代（兄弟）投递被拒", async () => {
  const { host, lead } = await makeLead();
  const childA = await spawnOne(host, lead, "A");
  const childB = await spawnOne(host, lead, "B");

  const out = await runTool("send_message", { agentId: childB.id, message: "x" }, { host, agent: childA });
  assert.match(textOf(out), /后代|descendant/);
});

test("给祖先投递被拒", async () => {
  const { host, lead } = await makeLead();
  const child = await spawnOne(host, lead);

  const out = await runTool("send_message", { agentId: lead.id, message: "x" }, { host, agent: child });
  assert.match(textOf(out), /后代|descendant/);
});

test("给已 dispose 的分身投递返回错误文本", async () => {
  const { host, lead } = await makeLead();
  const child = await spawnOne(host, lead);
  child.dispose();

  const out = await runTool("send_message", { agentId: child.id, message: "x" }, { host, agent: lead });
  assert.match(textOf(out), /没有|不存在|回收/);
});

test("给不存在的 agentId 投递返回错误文本", async () => {
  const { host, lead } = await makeLead();
  const out = await runTool("send_message", { agentId: "a-does-not-exist", message: "x" }, { host, agent: lead });
  assert.match(textOf(out), /a-does-not-exist/);
});

test("模型真的能通过 prompt 发起 send_message", async () => {
  const { host, lead } = await makeLead();
  const child = await spawnOne(host, lead);
  await lead.prompt(`[[tool:send_message]] [[args:{"agentId":"${child.id}","message":"再改一版"}]]`);
  await child.waitForIdle();
  assert.match(child.lastResult!.text, /再改一版/);
});
