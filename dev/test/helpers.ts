// 测试公共助手。
// 每个测试文件一个进程（node --test 默认行为），所以这里的 faux 单例与进程同生命周期。
// 导入本模块即启动假服务，并声明一个指向它 models.json 的实验室 —— 这样
// `makeAgent()` 不传任何依赖也能零成本跑起来。
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FAUX_MODEL_ALT_ID, FAUX_MODEL_ALT_REF, FAUX_MODEL_REF, makeFauxRuntime } from "./faux-models.ts";
import { startFaux } from "./faux-server.ts";
import { createLab, type Agent, type AgentSpec, type AgentTool } from "../src/index.ts";

export { FAUX_MODEL_ALT_ID, FAUX_MODEL_ALT_REF, FAUX_MODEL_REF };

export const faux = await startFaux();
// 测试一律不允许模型目录联网：否则每个测试文件都会去打 pi.dev（冷 store 实测 +2.2s，离线时更久）。
process.env.PI_OFFLINE = "1";
const made = await makeFauxRuntime(faux.baseUrl);
export const fauxAgentDir = made.agentDir;
export const fauxCwd = made.cwd;

/** 模块级一个实验室：测试全程只声明一次环境（agentDir / cwd / 离线） */
export const lab = await createLab({ agentDir: fauxAgentDir, cwd: fauxCwd, modelNetwork: false });

/** 起一个走库真实入口（lab.createAgent）的 agent，默认对着本机假 provider */
export async function makeAgent(spec: AgentSpec = {}): Promise<Agent> {
  return lab.createAgent({ model: FAUX_MODEL_REF, ...spec });
}

/** 同上，但换一个 cwd —— 相对路径解析类用例要自己那个目录（实验室的 cwd 是环境的一部分，不能只换 agent 的） */
export async function makeAgentIn(cwd: string, spec: AgentSpec = {}): Promise<Agent> {
  const own = await createLab({ agentDir: fauxAgentDir, cwd, modelNetwork: false });
  return own.createAgent({ model: FAUX_MODEL_REF, ...spec });
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
export async function captureSystemPrompt(spec: AgentSpec = {}): Promise<{ system: string }> {
  const before = faux.calls.length;
  const agent = await makeAgent(spec);
  try {
    await agent.io.prompt("hi");
  } finally {
    agent.dispose();
  }
  return { system: faux.calls[before]?.system ?? "" };
}
