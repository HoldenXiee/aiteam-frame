// send_message：给自己的后代分身追加一条消息。
// 只能向后代投递（决策 #20）：后代关系是一棵树，禁止反向/横向投递就免费消灭了发送环。
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentHost, AgentToolContext, ControlledAgent } from "../agent/types.ts";

const TOOL_NAME = "send_message";

/** 沿 parentId 链往上走，看 target 是不是 ancestor 的后代 */
function isDescendant(host: AgentHost, ancestor: ControlledAgent, target: ControlledAgent): boolean {
  const seen = new Set<string>();
  let current = target.parentId;
  while (current && !seen.has(current)) {
    if (current === ancestor.id) return true;
    seen.add(current);
    current = host.get(current)?.parentId;
  }
  return false;
}

export function createSendMessageTool(ctx: AgentToolContext): ToolDefinition {
  return {
    name: TOOL_NAME,
    label: "Send Message",
    description: [
      "给自己的后代分身（自己创建的那些分身，以及它们的后代）追加一条消息。",
      "只能往自己的后代投递：不能给祖先、兄弟或不相干的分身发消息。",
      "目标正忙时消息会排队，不会打断它；投递不等回复，靠返回的状态判断是「已开始处理」还是「已排队」。",
    ].join("\n"),
    parameters: Type.Object({
      agentId: Type.String({ description: "分身 id，来自 spawn_agent 的返回文本" }),
      message: Type.String({ description: "要投递的内容" }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const { agentId, message } = rawParams as { agentId: string; message: string };
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

      if (!ctx.host) return fail("send_message 需要一个宿主：分身都登记在宿主里。");
      const target = ctx.host.get(agentId);
      if (!target) {
        return fail(`宿主里没有 id=${agentId} 的分身（它可能已经被回收，或者这个 id 根本不存在）。`);
      }
      if (!isDescendant(ctx.host, ctx.agent, target)) {
        return fail(`只能给自己的后代分身投递：${agentId} 不是你的后代（它可能是祖先、兄弟或不相干的分身）。`);
      }

      const result = await target.send(message);
      const text =
        result.delivered === "ran"
          ? `已投递：${agentId} 当时空闲，已开始处理。`
          : `已投递：${agentId} 正忙，消息已排队，等它做完当前这轮再处理。`;
      return {
        content: [{ type: "text" as const, text }],
        details: { agentId, delivered: result.delivered },
      };
    },
  };
}
