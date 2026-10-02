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
  /** permissions 面的门。dispatch 里排在监听表之前，与监听表共用同一守卫（R26） */
  gate: ToolGate | undefined;
  /** context 面的 override（context 面接线）。dispatch 里排在监听表之前，与监听表共用同一守卫（R26） */
  contextOverride: ((messages: AgentMessage[]) => AgentMessage[]) | undefined;
  setRunId(id: string | undefined): void;
  reload(): Promise<void>;                          // 带 idle 守卫
  eventNames(): string[];
}

/**
 * R47：监听器返回了**真值但不是对象**时抛错。
 *
 * pi 的派发用真值判据（与本文件 `:139` 逐字一致），而它全部 `handlerResult` 消费点都**解构对象字段**
 * （runner.js 逐行核实：`:1009`/`:1034` 要 `.messages`，`:1070-1072` 对任何非 undefined 返回
 * **整体替换 payload**）——**没有任何事件接受非对象变换结果**。
 *
 * 危险在于这句写法极常见：`on("before_provider_request", (e) => arr.push(e))`。
 * `push` 返回**数组新长度**（真值），于是被当成变换结果 ⇒ payload 被整个换掉 ⇒ 0 条消息的请求
 * ⇒ pi 静默重试 ⇒ 空文本、耗时 14 秒、**无任何可见错误**（任务 8 探针实测：14265ms、provider 被调 4 次）。
 * 抛错会经 R17 的可观测错误通路变成具名 console 输出，而不是默默腐蚀整轮。
 *
 * 这不是重复造轮子（不违反 L1）：pi 自己只对 `user_bash` 做形状校验（runner.js:975），
 * 对 `before_provider_request` 不设防。**真值判据本身不许改**（改成「非 undefined」会与 pi 分叉），
 * 只加一层类型守卫。`block` 短路在前，不经过这里。
 */
function assertTransformShape(name: string, returned: unknown): void {
  const t = typeof returned;
  if (t !== "object" && t !== "function") {
    throw new Error(
      `事件「${name}」的监听器返回了 ${t}（${String(returned)}）。` +
        "监听器的返回值会被当作**变换结果**交给 pi，而 pi 的每个事件都只接受对象式的变换结果。" +
        "像 `(e) => arr.push(e)` 这种写法返回的是数组长度，会被当成变换结果用，" +
        "后果是载荷被整体替换（表现为空回复、长时间重试、且没有任何报错）。" +
        "只是想收集事件请写成块体：`(e) => { arr.push(e); }`",
    );
  }
}

export function createBridge(deps: {
  session: () => AgentSession;
  agent: () => Agent;
  /** 忙判据（R29）：由 createAgent 注入的**唯一一份**定义，`reload()` 的 idle 守卫用 */
  isBusy: () => boolean;
}): Bridge {
  const tools = new Map<string, AgentTool>();
  const listeners = new Map<string, Set<Handler>>();
  let runId: string | undefined;
  let contextOverride: Bridge["contextOverride"];
  let gate: ToolGate | undefined;

  /**
   * 派发器。四条规则，与 pi 的 `emitToolCall` 同构（依据：pi 源码
   * `dist/core/extensions/runner.js:951-969`，**不是**简报早版「取第一个非 undefined」的措辞）：
   *
   *   1. last-wins —— 最后一个返回非空结果的监听器生效；
   *   2. 真值判据 —— `!returned` 就跳过（`undefined` / `null` / `0` / `''` / `false` 都不算结果）；
   *   3. `{block:true}` 立即短路返回 —— 优先级最高，先于下面那条守卫；
   *   4. 双变换抛错 —— 同一事件上已有非空结果时，第二个非空结果**抛错**，不静默丢弃。
   *
   * 规则 4 是本库自己的取舍：桥接是 pi 的**单个**扩展，每个监听器拿到的都是原始事件，
   * 无法复刻 pi 跨扩展的链式传递（pi 里后一个 handler 能看到前一个处理后的结果）。
   * 若照搬 last-wins，先返回的那个监听器的工作会被后一个**静默覆盖** —— 正是 v2 要根除的失效模式。
   * 所以同一事件只允许一个监听器返回变换结果；拦截走专属槽位（permissions.gate / tools.onResult / context.override）。
   *
   * 专属槽位（R26）**排在监听表之前**取用，并把 `hasResult` 预置成 true —— 也就是计入**同一个**守卫：
   * 设了 `context.override` 之后，用户再 `on("context", …)` 返回变换就会抛下面这个错，而不是静默只生效一个。
   */
  async function dispatch(name: string, event: unknown, piCtx: ExtensionContext): Promise<unknown> {
    const ctx: AgentContext = { ...piCtx, agent: deps.agent(), runId };
    let result: unknown;
    let hasResult = false;
    // `context` 钩子拿到的是**不含 system** 的那批消息（S2），override 收到的就是它、原样返回即可
    if (name === "context" && contextOverride) {
      result = { messages: contextOverride((event as { messages: AgentMessage[] }).messages) };
      hasResult = true;
    }
    // permissions 的审批门（R26）：与 override 一样是专属槽位，排在监听表**之前**，结果计入同一个守卫。
    // 事件上的 `input` 就是 pi 交给工具的**同一个对象**（`validateToolArguments` 出来的 validatedArgs，
    // agent-loop.js:492-531 把它同时交给 beforeToolCall 与 execute），所以门原地改 `call.input` 能真的传下去。
    if (name === "tool_call" && gate) {
      const call = event as { toolName: string; toolCallId: string; input: unknown };
      let returned: unknown;
      try {
        returned = await gate({ name: call.toolName, input: call.input, callId: call.toolCallId }, ctx);
      } catch (err) {
        // 门抛异常不许裸奔：异常会一路穿出派发器，落进 pi 自己的兜底（`prepareToolCall` 的 catch，
        // agent-loop.js:533-539）—— 拦截 reason 就成了 pi 的措辞（`err.message`，非 Error 还会被包成
        // `Extension failed, blocking execution`，agent-session.js:319-324）。统一在这里转成 block。
        returned = { block: true, reason: String(err) };
      }
      if (returned) {
        if ((returned as { block?: boolean }).block) return returned;   // block 短路，监听表不跑（pi 同构）
        result = returned;
        hasResult = true;
      }
    }
    for (const fn of [...(listeners.get(name) ?? []), ...(listeners.get(ANY_EVENT) ?? [])]) {
      const returned = await fn(event, ctx);
      if (!returned) continue;                            // 真值判据，与 pi 逐字一致
      if ((returned as { block?: boolean }).block) return returned; // block 短路优先于守卫
      assertTransformShape(name, returned);               // R47：非对象真值不是变换结果，是误用
      if (hasResult) {
        throw new Error(
          `事件「${name}」上已有监听器返回了变换结果；` +
            "桥接无法像 pi 跨扩展那样链式传递，所以同一事件只允许一个监听器返回变换结果。" +
            "要拦截请用专属槽位（permissions.gate / tools.onResult / context.override）",
        );
      }
      result = returned;
      hasResult = true;
    }
    return result;
  }

  return {
    tools,
    listeners,
    get gate() {
      return gate;
    },
    set gate(fn) {
      gate = fn;
    },
    get contextOverride() {
      return contextOverride;
    },
    set contextOverride(fn) {
      contextOverride = fn;
    },
    setRunId(id) {
      runId = id;
    },
    eventNames: () => [...EVENT_NAMES],
    async reload() {
      const session = deps.session();
      // pi 的 reload() 撞上 running 会静默返回 ok、在飞那轮照常跑完（spike S3）——
      // 声明面变化对在飞轮次静默不生效。pi 不兜底，这道守卫必须由库自己加。
      // 判据来自 createAgent 的 `isBusy`（R29）：`io.isRunning || session.pendingMessageCount > 0`。
      // 不在这里重写一遍 —— 两份口径迟早分叉，而这个守卫存在的理由就是「不许漏判」。
      if (deps.isBusy()) {
        throw new Error("agent 正忙（在飞运行或有排队消息）：声明面只能在空闲时重载，先 io.waitIdle()");
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
