// 测试公共助手。
// 每个测试文件一个进程（node --test 默认行为），所以这里的 faux 单例与进程同生命周期。
// 导入本模块即启动假服务，并把 AITEAM_AGENT_DIR 指向它的 models.json —— 这样
// `createAgent({ model: FAUX_MODEL_REF })` 不传任何依赖也能零成本跑起来。
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FAUX_MODEL_ALT_ID, FAUX_MODEL_ALT_REF, FAUX_MODEL_REF, makeFauxRuntime } from "./faux-models.ts";
import { startFaux } from "./faux-server.ts";
import { createAgent } from "../src/agent/create-agent.ts";
import type { Agent, AgentInit, AgentTool } from "../src/agent/types.ts";

export { FAUX_MODEL_ALT_ID, FAUX_MODEL_ALT_REF, FAUX_MODEL_REF };

export const faux = await startFaux();
// 测试一律不允许模型目录联网：否则每个测试文件都会去打 pi.dev（冷 store 实测 +2.2s，离线时更久）。
process.env.PI_OFFLINE = "1";
const made = await makeFauxRuntime(faux.baseUrl);
export const fauxAgentDir = made.agentDir;
export const fauxCwd = made.cwd;
process.env.AITEAM_AGENT_DIR = fauxAgentDir;

/** 起一个走库真实入口（createAgent）的 agent，默认对着本机假 provider */
export async function makeAgent(spec: AgentInit = {}): Promise<Agent> {
  return createAgent({ agentDir: fauxAgentDir, cwd: fauxCwd, model: FAUX_MODEL_REF, ...spec });
}

/** 模型实际收到的工具名（index 省略时取最近一次请求） */
export function sentTools(index?: number): string[] {
  return faux.calls[index ?? faux.calls.length - 1]?.tools ?? [];
}

/** 模型实际收到的消息条数（index 省略时取最近一次请求） */
export function sentMessages(index?: number): number {
  return faux.calls[index ?? faux.calls.length - 1]?.messageCount ?? 0;
}

/** 一个只回显的静态工具，名字默认 probe_echo */
export function echoTool(name = "probe_echo"): AgentTool {
  const tool: ToolDefinition = defineTool({
    name,
    label: "Probe Echo",
    description: "回显参数里的 text",
    parameters: Type.Object({ text: Type.Optional(Type.String()) }),
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: `echo:${params.text ?? ""}` }],
      details: {},
    }),
  });
  return tool;
}

/**
 * 跑一轮，返回假服务记录的 system 字符串（loader / env 测试要的「模型实际收到了什么」）。
 * 需要单独调 buildLoader 的测试直接用 buildLoader。
 */
export async function captureSystemPrompt(spec: AgentInit = {}): Promise<{ system: string }> {
  const before = faux.calls.length;
  const agent = await makeAgent(spec);
  try {
    await agent.io.prompt("hi");
  } finally {
    agent.dispose();
  }
  return { system: faux.calls[before]?.system ?? "" };
}
