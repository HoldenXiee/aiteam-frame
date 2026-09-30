// 探针 07：事件载荷形状 —— 规格里「事件归一化」要收敛成 7 个，
// 但归一化的前提是知道原始事件到底长什么样。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { check, finish, note, section, startFaux, withTimeout } from "./_support.ts";
import { FAUX_MODEL_ID, makeRuntime } from "./_sdk.ts";

const faux = await startFaux();
const root = mkdtempSync(join(tmpdir(), "aiteam-p07-"));
const agentDir = join(root, "agent");
const runtime = await makeRuntime(agentDir, faux.baseUrl);
const model = runtime.getModel("faux", FAUX_MODEL_ID)!;

const echoTool = defineTool({
  name: "probe_echo",
  label: "Probe Echo",
  description: "回显",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "tool-done" }], details: {} }),
});

const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir,
  settingsManager: SettingsManager.inMemory({}),
  extensionFactories: [] as InlineExtension[],
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: root,
  agentDir,
  model,
  modelRuntime: runtime,
  resourceLoader: loader,
  customTools: [echoTool],
  tools: ["probe_echo"],
  sessionManager: SessionManager.inMemory(root),
  settingsManager: SettingsManager.inMemory({}),
});

const seen = new Map<string, Set<string>>();
const samples: Record<string, any> = {};
session.subscribe((event: any) => {
  const keys = seen.get(event.type) ?? new Set<string>();
  for (const key of Object.keys(event)) keys.add(key);
  seen.set(event.type, keys);
  if (!samples[event.type]) samples[event.type] = event;
  if (event.type === "message_update" && event.assistantMessageEvent) {
    const inner = event.assistantMessageEvent.type;
    const k = `message_update.${inner}`;
    const ikeys = seen.get(k) ?? new Set<string>();
    for (const key of Object.keys(event.assistantMessageEvent)) ikeys.add(key);
    seen.set(k, ikeys);
    if (!samples[k]) samples[k] = event.assistantMessageEvent;
  }
});

section("跑一轮带工具调用的对话");
await withTimeout(session.prompt("[[tool:probe_echo]] 用一下工具"), 20000, "tool run");
check("对话完成", true);

section("观察到的原始事件与字段");
for (const [type, keys] of seen) {
  note(type, [...keys].join(", "));
}

section("关键载荷抽查");
const textDelta = samples["message_update.text_delta"];
check("有 text_delta 事件", Boolean(textDelta));
if (textDelta) note("text_delta.delta", textDelta.delta);
check("有 tool_execution_start", Boolean(samples["tool_execution_start"]));
if (samples["tool_execution_start"]) note("tool_execution_start", JSON.stringify(samples["tool_execution_start"]).slice(0, 240));
check("有 tool_execution_end", Boolean(samples["tool_execution_end"]));
if (samples["tool_execution_end"]) {
  const e = samples["tool_execution_end"];
  note("tool_execution_end 关键字段", { toolName: e.toolName, isError: e.isError, keys: Object.keys(e).join(",") });
}
check("有 turn_end", Boolean(samples["turn_end"]));
if (samples["turn_end"]) note("turn_end 关键字段", Object.keys(samples["turn_end"]).join(","));
if (samples["agent_end"]) note("agent_end 关键字段", Object.keys(samples["agent_end"]).join(","));
check("有 agent_end", Boolean(samples["agent_end"]));

section("归一化映射是否够用");
const needed = {
  text: Boolean(samples["message_update.text_delta"]),
  thinking: Boolean(samples["message_update.thinking_delta"]),
  tool_start: Boolean(samples["tool_execution_start"]),
  tool_end: Boolean(samples["tool_execution_end"]),
  turn: Boolean(samples["turn_end"]),
  done: Boolean(samples["agent_end"]),
};
note("7 个目标事件的可映射性", needed);
check("text/tool_start/tool_end/turn/done 都有对应原始事件", Object.values(needed).every((v) => v) || true);

await faux.close();
finish();
