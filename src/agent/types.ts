// 全部对外类型，无运行时代码。
// 类型一律从 pi 的包复用，不自己重定义（规格 §3）。
import type { AgentSession, InlineExtension, ModelRuntime, Skill, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Usage } from "@earendil-works/pi-ai";

export type { ImageContent, ModelRuntime, Usage };

/** 直接取会话自己的思考档类型（pi-agent-core 里那个，含 "off"），不自己重定义 */
export type ThinkingLevel = AgentSession["thinkingLevel"];

/** pi 会话里的消息类型（逃生口 session.messages 的元素） */
export type AgentMessage = AgentSession["messages"][number];

// ─────────────── 成员与实例（规格 §4.1） ───────────────

/** 成员定义：集群设计者写的，agent 不可改 */
export interface MemberSpec {
  /** 给 agent 看的职责说明，会出现在 spawn_agent 的工具描述里 */
  description?: string;
  cwd?: string;
  /** 默认：宿主级共享。另开会换掉这一份 models.json / auth.json（技能与设置也跟着隔离） */
  agentDir?: string;
  /** 角色说明 → appendSystemPrompt（决策 #25） */
  role?: string;
  /** 名字或 SKILL.md 路径。Skill 对象必须指向真实存在的文件（决策 #27）；名字解析失败必须抛错 */
  skills?: (string | Skill)[];
  extensions?: (string | InlineExtension)[];
  /** 白名单。非空时库并入 customTools 与**设计者声明的**扩展工具名；`[]` 表示一个工具都不给 */
  tools?: string[];
  excludeTools?: string[];
  customTools?: AgentTool[];
  /** "anthropic/claude-opus-4-5:high" */
  model?: string;
  thinking?: ThinkingLevel;
  /** 审批门 */
  onToolCall?: ToolGate;
}

/** 实例规格 = 成员定义 + 身份 */
export interface AgentSpec extends MemberSpec {
  /** 不填则自动生成 */
  id?: string;
}

// ─────────────── 工具地基（规格 §4.2） ───────────────

export type ToolGate = (
  call: { name: string; input: unknown },
  ctx: AgentToolContext,
) => Promise<{ block: true; reason?: string } | undefined>;

export interface AgentToolContext {
  /** 谁在调用。挑选型工具必须知道自己是谁 */
  agent: ControlledAgent;
  signal?: AbortSignal;
  /** 能力注入点：花名册、寻址、消息等将来从这里接 */
  host?: AgentHost;
}

/** 工厂式：需要上下文的工具走这里 */
export type AgentToolFactory = (ctx: AgentToolContext) => ToolDefinition;
/** 静态式：无上下文依赖的简单工具 */
export type AgentTool = ToolDefinition | AgentToolFactory;

// ─────────────── 单个 agent（规格 §4.3） ───────────────

export interface PromptOpts {
  images?: ImageContent[];
}

/** 投递模式 */
export interface SendOpts {
  /** "next"（默认）：等目标当前工作做完再交付；"interrupt"：立刻改变它的方向 */
  mode?: "next" | "interrupt";
}

export interface SendResult {
  /** "ran" = 目标空闲，已直接执行；"queued" = 目标在忙，已排队 */
  delivered: "ran" | "queued";
}

/** 本次运行的用量。agent.usage 是全生命周期的累计值 */
export interface RunResult {
  text: string;
  usage: Usage;
  /** pi 的 prompt() 接受后失败不 reject，必须显式暴露 */
  error?: string;
}

/** 按事件名收窄载荷类型，避免调用方到处 cast */
export interface AgentEventMap {
  text: { delta: string };
  thinking: { delta: string };
  tool_start: { toolName: string; callId: string };
  tool_end: { toolName: string; callId: string; isError: boolean };
  /** usage = 该轮（turn）的用量 */
  turn: { message: AgentMessage; usage: Usage };
  error: { message: string };
  /** usage = 本次运行的用量，与 RunResult.usage 同值 */
  done: { usage: Usage };
}
export type AgentEventName = keyof AgentEventMap;

export interface ControlledAgent {
  readonly id: string;
  /** 逃生口：原始 SDK 对象；消息历史也从这里取 */
  readonly session: AgentSession;
  readonly status: "idle" | "running" | "aborted" | "error" | "disposed";
  /** 直接用 SDK 的值，不自己推 */
  readonly isStreaming: boolean;
  /** 全生命周期累计 */
  readonly usage: Usage;
  readonly parentId: string | undefined;
  /** 由哪个成员创建；顶层 agent 为 undefined */
  readonly member: string | undefined;
  /** 最近一次跑完的结果；从未跑过则为 undefined */
  readonly lastResult: RunResult | undefined;

  prompt(text: string, opts?: PromptOpts): Promise<RunResult>;
  /**
   * 投递一条消息给这个 agent。目标忙时排队，**永不抛错**
   * （pi 的 prompt() 在目标 streaming 时会直接抛错，这里是必须补的那一层）
   */
  send(text: string, opts?: SendOpts): Promise<SendResult>;
  steer(text: string): Promise<void>;
  /** 等该 agent 不再运行。阶段 2 的等待与结果聚合全建在它上面 */
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  on<E extends AgentEventName>(event: E, fn: (payload: AgentEventMap[E]) => void): () => void;
  dispose(): void;
}

export interface CreateAgentDeps {
  host?: AgentHost;
  /** 默认宿主单例 */
  modelRuntime?: ModelRuntime;
  /** 内部使用：由 spawn_agent 设置，深度由 parent 链推出 */
  parent?: ControlledAgent;
  /** 内部使用：由 spawn_agent 设置，标明这个分身是哪个成员 */
  member?: string;
}

// ─────────────── 宿主与花名册（规格 §4.4） ───────────────

export interface HostOptions {
  /** 花名册：agent 只能从这里挑选成员，不能自己设计。一个成员可起多个分身 */
  members?: Record<string, MemberSpec>;
  /** 全生命周期分身总数上限（默认 16） */
  maxAgents?: number;
  /** 分身层数上限，顶层 agent 为第 0 层（默认 2） */
  maxDepth?: number;
  /** 全宿主累计 token 上限 */
  budgetTokens?: number;
  modelRuntime?: ModelRuntime;
  /** 所有成员的基线，被成员定义覆盖 */
  defaults?: Partial<MemberSpec>;
}

/** 宿主级事件。设计者靠它实现轮次督导、成本监控、进度上报等一切策略 */
export interface HostEventMap {
  agent_created: { agent: ControlledAgent; member: string | undefined; parent: ControlledAgent | undefined };
  agent_disposed: { agent: ControlledAgent };
  /** 一个分身被交办并跑完一轮（prompt 或已投递的 send） */
  round_completed: { agent: ControlledAgent; result: RunResult };
}

export interface AgentHost {
  /** 全宿主累计 */
  readonly usage: Usage;
  readonly activeCount: number;
  readonly maxAgents: number;
  readonly maxDepth: number;
  readonly budgetTokens: number | undefined;

  /** 仅未回收的分身 */
  list(): ControlledAgent[];
  get(id: string): ControlledAgent | undefined;
  /** 观测机制：库只发射事件，不内置任何监控策略 */
  on<E extends keyof HostEventMap>(event: E, fn: (payload: HostEventMap[E]) => void): () => void;
  /** 级联回收所有分身 */
  dispose(): void;
}
