// 20-delivery 共用小工具（不碰 src/）
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSpawnAgentTool } from "../../src/tools/spawn-agent.ts";
import { createSendMessageTool } from "../../src/tools/send-message.ts";
import type { AgentToolContext } from "../../src/agent/types.ts";

const LIB: Record<string, (ctx: AgentToolContext) => ToolDefinition> = {
  spawn_agent: createSpawnAgentTool,
  send_message: createSendMessageTool,
};

/** 直接执行库自带工具（不进 LLM），与 test/helpers.ts 的 runTool 等价但不动环境变量 */
export async function runLibTool(name: string, args: unknown, ctx: AgentToolContext): Promise<any> {
  const make = LIB[name];
  if (!make) throw new Error(`不认识工具 ${name}`);
  return (make(ctx) as any).execute("call_test_1", args, undefined, undefined, undefined);
}

export function textOf(result: any): string {
  return (result?.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

/** 记录一次调用：抛错？返回什么？ */
export async function attempt(label: string, fn: () => Promise<unknown>): Promise<{ label: string; threw?: string; ret?: unknown }> {
  try {
    const ret = await fn();
    return { label, ret: ret === undefined ? "(undefined)" : ret };
  } catch (err) {
    return { label, threw: err instanceof Error ? err.message : String(err) };
  }
}

export const j = (v: unknown) => JSON.stringify(v ?? null);
