import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { AgentHost, ControlledAgent } from "../src/index.ts";
import { createAgent, createAgentHost, defineAgentTool } from "../src/index.ts";
import { FAUX_MODEL_REF } from "./faux-models.ts";
import { echoTool, seenTools } from "./helpers.ts";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

test("工厂式工具在 execute 时拿到持有它的 agent", async () => {
  let seen: ControlledAgent | undefined;
  const factory = defineAgentTool({
    name: "whoami",
    label: "Who",
    description: "返回调用者 id",
    parameters: Type.Object({}),
    execute: async (_params, ctx) => {
      seen = ctx.agent;
      return ok(ctx.agent.id);
    },
  });

  const agent = await createAgent({ model: FAUX_MODEL_REF, customTools: [factory] });
  await agent.prompt("[[tool:whoami]]");
  assert.equal(seen?.id, agent.id);
  assert.ok(seenTools().includes("whoami"));
});

test("工厂的 execute 在 createAgent 期间不被调用", async () => {
  let calls = 0;
  const factory = defineAgentTool({
    name: "never_called",
    label: "Never",
    description: "只在被模型调用时才跑",
    parameters: Type.Object({}),
    execute: async () => {
      calls += 1;
      return ok("ran");
    },
  });

  await createAgent({ model: FAUX_MODEL_REF, customTools: [factory] });
  assert.equal(calls, 0);
});

test("静态 ToolDefinition 与工厂式可以并存", async () => {
  const factory = defineAgentTool({
    name: "whoami",
    label: "Who",
    description: "返回调用者 id",
    parameters: Type.Object({}),
    execute: async (_params, ctx) => ok(ctx.agent.id),
  });
  const agent = await createAgent({ model: FAUX_MODEL_REF, customTools: [echoTool, factory] });
  await agent.prompt("[[tool:probe_echo]]");
  const names = seenTools();
  assert.ok(names.includes("probe_echo"), JSON.stringify(names));
  assert.ok(names.includes("whoami"), JSON.stringify(names));
});

test("ctx.host 在带宿主时可用", async () => {
  const host = createAgentHost({});
  let seenHost: AgentHost | undefined;
  let siblingCount = -1;
  const factory = defineAgentTool({
    name: "whoishost",
    label: "Host",
    description: "返回宿主状态",
    parameters: Type.Object({}),
    execute: async (_params, ctx) => {
      seenHost = ctx.host;
      siblingCount = ctx.host?.list().length ?? -1;
      return ok(String(siblingCount));
    },
  });

  const agent = await createAgent({ model: FAUX_MODEL_REF, customTools: [factory] }, { host });
  await agent.prompt("[[tool:whoishost]]");
  assert.equal(seenHost, host);
  assert.equal(siblingCount, 1);
});
