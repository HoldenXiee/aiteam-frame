// 工具地基：工厂式工具 + 调用者上下文注入。
// 用户写的是 `execute(params, ctx)`；SDK 看到的是标准 ToolDefinition。
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { AgentToolContext, AgentToolFactory } from "../agent/types.ts";

export interface AgentToolDef<P extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: P;
  /** ctx.agent / ctx.host 在真正被调用时才需要有效 */
  execute(params: Static<P>, ctx: AgentToolContext): Promise<AgentToolResult<any>>;
}

/**
 * 工厂式工具（决策 #11/#12）：工厂本身在 createAgent 期间被调用一次（模型得先看到 name/parameters），
 * 但 ctx.agent 是惰性的 —— 只有 execute 时才取得到持有它的那个 agent。
 */
export function defineAgentTool<P extends TSchema>(def: AgentToolDef<P>): AgentToolFactory {
  return (ctx: AgentToolContext): ToolDefinition => ({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    execute: async (_toolCallId, params, signal) => def.execute(params as Static<P>, { ...ctx, signal }),
  });
}
