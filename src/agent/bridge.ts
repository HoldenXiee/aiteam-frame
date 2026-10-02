// 常驻桥接扩展（规格 §3.4 / D12）。
// 三张表活在内存里；工厂每次 reload 重跑一次，把表整体接回 pi —— 所以运行期改动不会丢，
// 且钩子顺序由桥接代码决定（桥接是第一个注册的工厂）。
import type { AgentSession, ExtensionAPI, ExtensionContext, ExtensionEvent, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Agent, AgentContext, AgentMessage, AgentTool, ToolGate } from "./types.ts";

/**
 * pi 的全部扩展事件名，与 `ExtensionEvent["type"]` 一一对应。
 * 实测：给全部事件挂 no-op handler 不改变 pi 行为（spike/FINDINGS.md S6/S6b），
 * 所以桥接在工厂里一次性全挂，不做按需懒注册（那会引入「on() 要触发 reload」）。
 */
export const EVENT_NAMES = [
  "project_trust",
  "resources_discover",
  "mcp_servers_change",
  "session_start",
  "session_info_changed",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_shutdown",
  "session_before_tree",
  "session_tree",
  "context",
  "context_with_system",
  "cache_warming_decision",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "provider_stream_event",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_before_settle",
  "agent_settled",
  "ui_prompt_start",
  "ui_prompt_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "model_select",
  "thinking_level_select",
  "tool_call",
  "tool_result",
  "user_bash",
  "input",
] as const satisfies readonly ExtensionEvent["type"][];

// 编译期完整性：pi 升级后新增的事件名会让这里报错，而不是静默地漏透传（v2 不静默失效）
type MissingEventName = Exclude<ExtensionEvent["type"], (typeof EVENT_NAMES)[number]>;
const eventNamesAreComplete: MissingEventName extends never ? true : ["漏了事件名", MissingEventName] = true;
void eventNamesAreComplete;

/** `onAny` 的监听挂在这个伪事件名下（不是 pi 的事件名，只在库内部用） */
export const ANY_EVENT = "*";

export type Handler = (event: any, ctx: AgentContext) => unknown;

export interface Bridge {
  readonly tools: Map<string, AgentTool>;          // 名称 → 工具（工厂或定义）
  readonly listeners: Map<string, Set<Handler>>;   // 事件名 → 监听器（含门、onResult、override）
  readonly factory: InlineExtension;                // 每次 reload 重跑：三张表接回 pi
  /** permissions 面的门。本任务不接线（留给 permissions 面），接线时在 dispatch 里排在监听表之前 */
  gate: ToolGate | undefined;
  /** context 面的 override。本任务不接线（留给 context 面），接线时在 dispatch 里生效 */
  contextOverride: ((messages: AgentMessage[]) => AgentMessage[]) | undefined;
  setRunId(id: string | undefined): void;
  reload(): Promise<void>;                          // 带 idle 守卫
  eventNames(): string[];
}

export function createBridge(deps: { session: () => AgentSession; agent: () => Agent }): Bridge {
  const tools = new Map<string, AgentTool>();
  const listeners = new Map<string, Set<Handler>>();
  let runId: string | undefined;

  /**
   * 派发器：按注册顺序跑监听表，返回 `{block:true}` 立即短路（pi 实测语义，S4/S4b）。
   * 跨扩展之间的链式与合并由 pi 自己完成（S4b），这里只管本扩展的监听表。
   */
  async function dispatch(name: string, event: unknown, piCtx: ExtensionContext): Promise<unknown> {
    const ctx: AgentContext = { ...piCtx, agent: deps.agent(), runId };
    let result: unknown;
    for (const fn of [...(listeners.get(name) ?? []), ...(listeners.get(ANY_EVENT) ?? [])]) {
      const returned = await fn(event, ctx);
      if (returned === undefined) continue;               // undefined 不覆盖前一个有效结果
      result = returned;
      if ((returned as { block?: boolean } | null)?.block) return returned;
    }
    return result;
  }

  return {
    tools,
    listeners,
    gate: undefined,
    contextOverride: undefined,
    setRunId(id) {
      runId = id;
    },
    eventNames: () => [...EVENT_NAMES],
    async reload() {
      const session = deps.session();
      // pi 的 reload() 撞上 running 会静默返回 ok、在飞那轮照常跑完（spike S3）——
      // 声明面变化对在飞轮次静默不生效。pi 不兜底，这道守卫必须由库自己加。
      if (session.isStreaming || session.pendingMessageCount > 0) {
        throw new Error("agent 正忙（streaming 或有排队消息）：声明面只能在 idle 时重载，先 io.waitIdle()");
      }
      await session.reload();
    },
    factory: (pi: ExtensionAPI) => {
      for (const tool of tools.values()) {
        pi.registerTool(typeof tool === "function" ? tool({ agent: deps.agent() }) : tool);
      }
      const on = pi.on as unknown as (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
      for (const name of EVENT_NAMES) on(name, (event, ctx) => dispatch(name, event, ctx));
    },
  };
}
