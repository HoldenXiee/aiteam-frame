import test from "node:test";
import assert from "node:assert/strict";
import { createAgent, createAgentHost } from "../src/index.ts";
import { FAUX_MODEL_REF } from "./faux-models.ts";
import { sleep } from "./faux-server.ts";
import { echoTool, seenTools } from "./helpers.ts";

test("宿主事件在正确时机各触发一次（已回收的再 dispose 不再触发）", async () => {
  const host = createAgentHost({});
  const events: string[] = [];
  host.on("agent_created", (p) => events.push(`created:${p.agent.id}:${p.member ?? "-"}:${p.parent?.id ?? "-"}`));
  host.on("round_completed", (p) => events.push(`round:${p.agent.id}:${p.result.usage.totalTokens > 0}`));
  host.on("agent_disposed", (p) => events.push(`disposed:${p.agent.id}`));

  const a = await createAgent({ id: "host-events-a", model: FAUX_MODEL_REF }, { host });
  await a.prompt("hi");
  a.dispose();
  a.dispose();

  assert.deepEqual(events, ["created:host-events-a:-:-", "round:host-events-a:true", "disposed:host-events-a"]);
});

test("重复 id 创建时抛错", async () => {
  const host = createAgentHost({});
  await createAgent({ id: "dup", model: FAUX_MODEL_REF }, { host });
  await assert.rejects(() => createAgent({ id: "dup", model: FAUX_MODEL_REF }, { host }), /dup/);
  assert.equal(host.list().length, 1);
});

test("maxAgents: 0 表示一个都不许", async () => {
  const host = createAgentHost({ maxAgents: 0 });
  await assert.rejects(() => createAgent({ model: FAUX_MODEL_REF }, { host }), /maxAgents|0/);
});

test("maxAgents 是终身累计上限", async () => {
  const host = createAgentHost({ maxAgents: 1 });
  const a = await createAgent({ model: FAUX_MODEL_REF }, { host });
  a.dispose();
  await assert.rejects(() => createAgent({ model: FAUX_MODEL_REF }, { host }), /maxAgents/);
});

test("maxDepth: 0 表示顶层 agent 可以有，但不许它有分身", async () => {
  const host = createAgentHost({ maxDepth: 0 });
  const top = await createAgent({ model: FAUX_MODEL_REF }, { host });
  await assert.rejects(
    () => createAgent({ model: FAUX_MODEL_REF }, { host, parent: top }),
    /maxDepth|深度/,
  );
});

test("maxDepth 边界：深度 1 的可以，深度 2 的不行", async () => {
  const host = createAgentHost({ maxDepth: 1 });
  const top = await createAgent({ model: FAUX_MODEL_REF }, { host });
  const child = await createAgent({ model: FAUX_MODEL_REF }, { host, parent: top });
  assert.equal(child.parentId, top.id);
  await assert.rejects(
    () => createAgent({ model: FAUX_MODEL_REF }, { host, parent: child }),
    /maxDepth|深度/,
  );
});

test("budgetTokens: 0 表示一个分身都不许起", async () => {
  const host = createAgentHost({ budgetTokens: 0 });
  await assert.rejects(() => createAgent({ model: FAUX_MODEL_REF }, { host }), /budget|预算/);
});

test("预算耗尽后 host.usage 仍可读，只是不再接新活", async () => {
  const host = createAgentHost({ budgetTokens: 1 });
  const a = await createAgent({ model: FAUX_MODEL_REF }, { host });
  await a.prompt("hi");
  const spent = host.usage.totalTokens;
  assert.ok(spent > 0, "一轮跑完后宿主用量应当大于 0");
  await assert.rejects(() => a.prompt("再来"), /budget|预算/);
  assert.equal(host.usage.totalTokens, spent);
  await assert.rejects(() => createAgent({ model: FAUX_MODEL_REF }, { host }), /budget|预算/);
});

test("dispose 会先 abort 正在跑的分身，等它 settle 再回收", async () => {
  const host = createAgentHost({});
  const a = await createAgent({ model: FAUX_MODEL_REF }, { host });
  let settled = false;
  const slow = a.prompt("[[sleep:800]] 慢").then(
    () => (settled = true),
    () => (settled = true),
  );
  await sleep(150);
  assert.equal(a.isStreaming, true, "应当真的在跑");

  host.dispose();
  assert.equal(host.list().length, 0);
  assert.equal(a.status, "disposed");
  await assert.rejects(() => a.prompt("x"), /disposed/);

  await slow;
  assert.equal(settled, true, "悬挂的 prompt 必须 settle，不能永远吊着");
});

test("host.usage 汇总所有分身用量；host.defaults 被成员定义覆盖", async () => {
  const host = createAgentHost({ defaults: { customTools: [echoTool] } });
  const a = await createAgent({ model: FAUX_MODEL_REF }, { host });
  const b = await createAgent({ model: FAUX_MODEL_REF, customTools: [] }, { host });

  const a1 = await a.prompt("[[tool:probe_echo]]");
  assert.ok(seenTools().includes("probe_echo"), "host.defaults 里的 customTools 应当生效");
  const ra = await b.prompt("[[tool:probe_echo]]");
  assert.ok(!seenTools().includes("probe_echo"), "成员定义里的 customTools 应当覆盖默认");

  const rb = await a.prompt("再来");
  assert.equal(host.usage.totalTokens, a1.usage.totalTokens + ra.usage.totalTokens + rb.usage.totalTokens);
  assert.equal(host.activeCount, 2);
  assert.equal(host.budgetTokens, undefined);
  assert.equal(host.maxAgents, 16);
  assert.equal(host.maxDepth, 2);
});
