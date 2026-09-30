// 测试公共助手。
// 每个测试文件一个进程（node --test 默认行为），所以这里的 faux 单例与进程同生命周期。
// 导入本模块即启动假服务并把 AITEAM_AGENT_DIR 指向它的 models.json —— 这样
// `createAgent({ model: FAUX_MODEL_REF })` 不传任何依赖也能零成本跑起来。
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { startFaux } from "./faux-server.ts";
import { makeFauxRuntime } from "./faux-models.ts";
import { buildLoader } from "../src/agent/loader.ts";
import { createSpawnAgentTool } from "../src/tools/spawn-agent.ts";
import { createSendMessageTool } from "../src/tools/send-message.ts";
import { createAgent } from "../src/agent/create-agent.ts";
import { FAUX_MODEL_REF } from "./faux-models.ts";
import type { AgentToolContext, MemberSpec } from "../src/agent/types.ts";

export const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);
export const fauxAgentDir = made.agentDir;
export const fauxCwd = made.cwd;
process.env.AITEAM_AGENT_DIR = fauxAgentDir;

/** 假服务收到的工具名。index 省略时取最近一次请求。 */
export function seenTools(target: typeof faux = faux, index?: number): string[] {
  const call = target.calls[index ?? target.calls.length - 1];
  return call?.tools ?? [];
}

/** 一个只回显的静态工具，名字固定叫 probe_echo */
export const echoTool = defineTool({
  name: "probe_echo",
  label: "Probe Echo",
  description: "回显参数里的 text",
  parameters: Type.Object({ text: Type.Optional(Type.String()) }),
  execute: async (_id, params) => ({
    content: [{ type: "text" as const, text: `echo:${params.text ?? ""}` }],
    details: {},
  }),
});

/**
 * 起一个 agent（走库的真实入口 createAgent）跑一轮，返回假服务记录的 system 字符串。
 * 需要单独调 buildLoader 的测试直接用 buildLoader。
 */
export async function captureSystemPrompt(
  spec: MemberSpec & { model?: string } = {},
): Promise<{ system: string }> {
  const before = faux.calls.length;
  const agent = await createAgent({ model: FAUX_MODEL_REF, ...spec });
  try {
    await agent.prompt("hi");
  } finally {
    agent.dispose();
  }
  return { system: faux.calls[before]?.system ?? "" };
}

/** 库自带的工具（不进 LLM，直接 execute）—— 用于测护栏与错误路径 */
const LIBRARY_TOOLS: Record<string, (ctx: AgentToolContext) => ToolDefinition> = {
  spawn_agent: createSpawnAgentTool,
  send_message: createSendMessageTool,
};

export async function runTool(
  name: string,
  args: unknown,
  ctx: AgentToolContext,
): Promise<AgentToolResult<any>> {
  const make = LIBRARY_TOOLS[name];
  if (!make) throw new Error(`runTool: 测试助手不认识工具「${name}」`);
  const tool = make(ctx);
  return tool.execute("call_test_1", args as never, undefined, undefined, undefined as never);
}

/** 工具结果里的文本 */
export function textOf(result: AgentToolResult<any>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
