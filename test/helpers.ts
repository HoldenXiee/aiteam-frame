// 测试公共助手。
// 每个测试文件一个进程（node --test 默认行为），所以这里的 faux 单例与进程同生命周期。
// 导入本模块即启动假服务并把 AITEAM_AGENT_DIR 指向它的 models.json —— 这样
// `createAgent({ model: FAUX_MODEL_REF })` 不传任何依赖也能零成本跑起来。
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  defineTool,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { startFaux } from "./faux-server.ts";
import { makeFauxRuntime } from "./faux-models.ts";
import { buildLoader } from "../src/agent/loader.ts";
import { createSpawnAgentTool } from "../src/tools/spawn-agent.ts";
import type { AgentToolContext, MemberSpec } from "../src/agent/types.ts";

export const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);
export const fauxRuntime = made.runtime;
export const fauxAgentDir = made.agentDir;
export const fauxCwd = made.cwd;
process.env.AITEAM_AGENT_DIR = fauxAgentDir;

export const fauxModel = fauxRuntime.getModel("faux", "echo")!;

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
 * 起一个 agent 跑一轮，返回假服务记录的 system 字符串。
 * 走库的真实入口 buildLoader —— 否则断言的就不是交付物。
 */
export async function captureSystemPrompt(spec: MemberSpec = {}): Promise<{ system: string }> {
  const cwd = spec.cwd ?? fauxCwd;
  const agentDir = spec.agentDir ?? fauxAgentDir;
  const settingsManager = SettingsManager.inMemory({});
  const loader = await buildLoader(spec, { cwd, agentDir, settingsManager });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: fauxModel,
    modelRuntime: fauxRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  const before = faux.calls.length;
  await session.prompt("hi");
  return { system: faux.calls[before]?.system ?? "" };
}

/** 库自带的工具（不进 LLM，直接 execute）—— 用于测护栏与错误路径 */
const LIBRARY_TOOLS: Record<string, (ctx: AgentToolContext) => ToolDefinition> = {
  spawn_agent: createSpawnAgentTool,
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
