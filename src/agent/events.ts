// 原始事件 → 归一化事件的纯映射。只看事件形状，不碰会话状态，因此可直接单测。
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEventMap, AgentEventName, AgentMessage, Usage } from "./types.ts";
import { addUsage, emptyUsage } from "./usage.ts";

export type { AgentEventMap, AgentEventName };

/** 带 type 标签的归一化事件：`{ type: "text", delta }` 之类 */
export type NormalizedEvent = { [K in AgentEventName]: { type: K } & AgentEventMap[K] }[AgentEventName];

/** 一次运行里所有 assistant 消息的用量之和 */
function runUsage(messages: readonly AgentMessage[]): Usage {
  return messages.reduce<Usage>(
    (acc, m) => (m.role === "assistant" && m.usage ? addUsage(acc, m.usage) : acc),
    emptyUsage(),
  );
}

export function normalizeEvent(raw: AgentSessionEvent): NormalizedEvent | undefined {
  switch (raw.type) {
    case "message_update": {
      const inner = raw.assistantMessageEvent;
      if (inner?.type === "text_delta") return { type: "text", delta: inner.delta };
      if (inner?.type === "thinking_delta") return { type: "thinking", delta: inner.delta };
      return undefined;
    }
    case "tool_execution_start":
      return { type: "tool_start", toolName: raw.toolName, callId: raw.toolCallId };
    case "tool_execution_end":
      return { type: "tool_end", toolName: raw.toolName, callId: raw.toolCallId, isError: raw.isError };
    case "turn_end":
      return {
        type: "turn",
        message: raw.message,
        usage: raw.message.role === "assistant" && raw.message.usage ? raw.message.usage : emptyUsage(),
      };
    case "message_end":
      return raw.message.role === "assistant" && raw.message.errorMessage
        ? { type: "error", message: raw.message.errorMessage }
        : undefined;
    case "agent_end":
      // willRetry = 这次 agent_end 之后还会自动重试，不算一轮跑完
      return raw.willRetry ? undefined : { type: "done", usage: runUsage(raw.messages) };
    default:
      return undefined;
  }
}
