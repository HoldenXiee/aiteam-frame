// 全部对外类型，无运行时代码。
// 类型一律从 pi 直接 import，不自己重定义（规格 §3、§4.1）。
import type {
  AgentSession,
  ContextUsage,
  DefaultResourceLoader,
  Extension,
  ExtensionContext,
  ExtensionError,
  ExtensionEvent,
  InlineExtension,
  ModelRuntime,
  SessionManager,
  Skill,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, Usage } from "@earendil-works/pi-ai";

export type { ContextUsage, Extension, ExtensionError, ExtensionEvent, ImageContent, ModelRuntime, Skill, Usage };

/** 直接取会话自己的思考档类型（含 "off"），不自己重定义 */
export type ThinkingLevel = AgentSession["thinkingLevel"];

/** pi 会话里的消息类型（`context.history` 的元素） */
export type AgentMessage = AgentSession["messages"][number];

// ─────────────── 创建期 ───────────────

/** 交给 loader 的那部分声明：技能 / 扩展 / 角色 */
export interface ResourceSpec {
  skills?: (string | Skill)[];
  extensions?: (string | InlineExtension)[];
  role?: string;
}

/** 创建期 spec，与七个面同形（字段名 = 面的原语名，规格 §3.2） */
export interface AgentInit extends ResourceSpec {
  id?: string;
  cwd?: string;
  agentDir?: string;
  /**
   * 是否允许联网刷新模型目录（带 ETag，4 小时新鲜度窗口），默认 true。
   * false 时仍会从 `<agentDir>/models-store.json` **恢复**已缓存的 overlay（离线也生效），只是不主动拉。
   * 环境变量 `PI_OFFLINE=1` 可全局关掉一切模型相关网络请求。
   */
  modelNetwork?: boolean;
  /** 覆盖模型目录源，默认 https://pi.dev（企业镜像 / 测试用） */
  catalogBaseUrl?: string;
  /** "anthropic/claude-opus-4-5:high" */
  model?: string;
  thinking?: ThinkingLevel;
  /**
   * 创建期只有 `only` / `deny`：创建时最常说的是「只给它这几个」，所以这里是**精确白名单**。
   * 运行期（`agent.permissions`）才有并集语义的 `allow`。同名不同义是陷阱，故这里叫 `only`。
   */
  permissions?: { only?: string[]; deny?: string[]; gate?: ToolGate };
  tools?: { custom?: AgentTool[] };
  context?: { autoCompact?: boolean };
}

export interface CreateAgentDeps {
  /** 默认按 agentDir + 网络开关取宿主级共享的那个 */
  modelRuntime?: ModelRuntime;
}

// ─────────────── 句柄 ───────────────

export interface Agent {
  readonly id: string;
  readonly usage: Usage;                       // 全生命周期累计
  readonly status: "idle" | "running" | "disposed";

  readonly io: IoSurface;
  readonly context: ContextSurface;
  readonly tools: ToolsSurface;
  readonly permissions: PermissionsSurface;
  readonly extensions: ExtensionsSurface;
  readonly skills: SkillsSurface;
  readonly model: ModelSurface;

  /** 原始事件，按名收窄（镜像 pi 的 on 重载）。返回值类型按事件收窄 */
  on<E extends ExtensionEvent["type"]>(
    event: E,
    handler: (event: Extract<ExtensionEvent, { type: E }>, ctx: AgentContext) => unknown,
  ): () => void;
  /** 全量：横切观测（trace / 日志） */
  onAny(handler: (event: ExtensionEvent, ctx: AgentContext) => unknown): () => void;

  dispose(): void;
}

/** pi 的 ExtensionContext 原样透传，只额外挂两个字段（D9） */
export type AgentContext = ExtensionContext & {
  readonly agent: Agent;
  /** 当前这次运行；不在运行中则为 undefined */
  readonly runId: string | undefined;
};
// 实测（spike/s5-ctx-shape.ts）：ctx 是对象字面量、方法全是自有属性且不依赖 this，
// 所以实现上 `{ ...piCtx, agent, runId }` 直接用即可，不需要 Proxy。

// ─────────────── 结算 ───────────────

export interface RunResult {
  runId: string;                 // D14
  text: string;
  usage: Usage;                  // 本次运行
  error?: string;                // pi 对「接受后失败」不 reject，必须显式暴露
  messages: AgentMessage[];      // 本次运行覆盖的区间（对象引用，不复制）
}

// ─────────────── 七个面 ───────────────

export interface IoSurface {
  readonly pending: number;
  readonly isRunning: boolean;
  prompt(text: string, opts?: { images?: ImageContent[] }): Promise<RunResult>;
  /** 目标忙则排队；返回队列事实，不谎报「已跑过」 */
  queue(text: string): Promise<{ queued: true }>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  waitIdle(): Promise<void>;
  readonly raw: AgentSession;
}

export interface ContextSurface {
  /**
   * 会话里存的**历史**（只读快照）。**不含 `system`**——与 `RunResult.messages` 一致；
   * 要看会话原样（含 system）用 `raw.session.messages`。
   */
  readonly history: readonly AgentMessage[];
  /** 上下文占用（来自 session.getContextUsage()） */
  readonly usage: ContextUsage | undefined;
  /** 自动压缩开关，可读写（映射到 session.autoCompactionEnabled） */
  autoCompact: boolean;
  /** 改「这一轮发给模型的内容」；历史不变。传 undefined 清除 */
  override(next: ((messages: AgentMessage[]) => AgentMessage[]) | AgentMessage[] | undefined): void;
  /**
   * 压缩。**要求 idle**：pi 的 `session.compact()` 第一行就是 `await this.abort()`（`agent-session.js:2101`），
   * 运行中调用会静默 abort 在飞轮次并抛「Nothing to compact」类错误。要无守卫的真直通用 `raw.session.compact()`。
   */
  compact(instructions?: string): Promise<void>;
  readonly raw: { session: AgentSession; sessionManager: SessionManager };
}

export interface ToolsSurface {
  list(): { name: string; active: boolean }[];
  /** 碰声明面 → async（reload），要求 idle */
  add(tool: AgentTool): Promise<void>;
  remove(name: string): Promise<void>;
  /** tool_result 拦截：改工具返回给模型的内容 */
  onResult(fn: (result: ToolResultEvent, ctx: AgentContext) => unknown): () => void;
  readonly raw: { getToolDefinition(name: string): ToolDefinition | undefined };
}

export interface PermissionsSurface {
  /** 只写不读：单槽位，后一次覆盖前一次。同步生效 */
  gate(fn: ToolGate | undefined): void;
  /** 同步：底层是 setActiveToolsByName，不触发 reload */
  allow(names: string[]): void;   // 并集：启用这些
  deny(names: string[]): void;    // 差集：关掉这些
  only(names: string[]): void;    // 精确：集合就是这些
}

export interface ExtensionsSurface {
  list(): Extension[];
  /** 扩展加载失败零信号是 v1 的静默失败点之一，必须可读 */
  errors(): ExtensionError[];
  /** 碰声明面 → async（reload），要求 idle */
  add(extension: InlineExtension | string): Promise<void>;
  remove(path: string): Promise<void>;
  readonly raw: { readonly loader: DefaultResourceLoader; readonly session: AgentSession };
}

export interface SkillsSurface {
  list(): Skill[];
  /** 只接受路径或 `Skill` 对象：技能是被环境发现的，按名注册没有意义 */
  add(skill: string | Skill): Promise<void>;
  remove(path: string): Promise<void>;
  readonly raw: DefaultResourceLoader;
}

export interface ModelSurface {
  readonly current: Model<any> | undefined;
  readonly thinking: ThinkingLevel;
  readonly available: readonly Model<any>[];
  set(model: string): Promise<void>;
  setThinking(level: ThinkingLevel): void;
  readonly raw: { readonly session: AgentSession; readonly modelRuntime: ModelRuntime };
}

// ─────────────── 工具与门 ───────────────

export interface ToolContext {
  readonly agent: Agent;
  signal?: AbortSignal;
}
export type AgentTool = ToolDefinition | ((ctx: ToolContext) => ToolDefinition);

export type ToolGate = (
  call: { name: string; input: unknown; callId: string },
  ctx: AgentContext,
) => Promise<{ block: true; reason?: string } | undefined>;
