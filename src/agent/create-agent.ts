// spec → ControlledAgent：生命周期、事件订阅、用量、工具接线、审批门。
// host 相关（花名册登记、护栏计数、宿主事件）在 host.ts 那一层挂进来，这里只认 deps。
import { join } from "node:path";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  resolveCliModel,
  type ExtensionAPI,
  type InlineExtension,
  type Model,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { buildLoader } from "./loader.ts";
import { normalizeEvent } from "./events.ts";
import { addUsage, emptyUsage } from "./usage.ts";
import type {
  AgentEventMap,
  AgentEventName,
  AgentHost,
  AgentMessage,
  AgentSpec,
  AgentToolContext,
  ControlledAgent,
  CreateAgentDeps,
  PromptOpts,
  RunResult,
  Usage,
} from "./types.ts";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `a${counter}`;
}

function defaultAgentDir(): string {
  return process.env.AITEAM_AGENT_DIR || getAgentDir();
}

/** 宿主级共享的 ModelRuntime 单例（决策 #8）：按第一个 agentDir 建，避免每 agent 重复读盘 */
let sharedRuntime: Promise<ModelRuntime> | undefined;
function getSharedRuntime(agentDir: string): Promise<ModelRuntime> {
  sharedRuntime ??= ModelRuntime.create({
    modelsPath: join(agentDir, "models.json"),
    authPath: join(agentDir, "auth.json"),
  });
  return sharedRuntime;
}

/** 决策 #28：resolveCliModel 对不存在的模型只给 warning，必须自己判 */
function resolveModel(
  spec: AgentSpec,
  modelRuntime: ModelRuntime,
): { model?: Model<any>; thinkingLevel?: AgentSpec["thinking"] } {
  if (!spec.model) return { thinkingLevel: spec.thinking };
  const resolved = resolveCliModel({ cliModel: spec.model, modelRuntime });
  if (resolved.error || !resolved.model) {
    throw new Error(`模型「${spec.model}」解析失败：${resolved.error ?? "未知原因"}`);
  }
  if (resolved.warning) {
    throw new Error(`模型「${spec.model}」解析有警告：${resolved.warning}`);
  }
  return { model: resolved.model, thinkingLevel: spec.thinking ?? resolved.thinkingLevel };
}

export async function createAgent(spec: AgentSpec, deps: CreateAgentDeps = {}): Promise<ControlledAgent> {
  const id = spec.id ?? nextId();
  const cwd = spec.cwd ?? process.cwd();
  const agentDir = spec.agentDir ?? defaultAgentDir();
  const modelRuntime = deps.modelRuntime ?? (await getSharedRuntime(agentDir));
  const settingsManager = SettingsManager.inMemory({});
  const host: AgentHost | undefined = deps.host;

  // holder：工厂式工具在 createAgentSession 之前就要交出 name/parameters，
  // 而 ControlledAgent 那时还没构造完 —— 所以 ctx.agent 用 getter 惰性取（决策 #12）。
  const holder: { agent?: ControlledAgent } = {};
  const makeCtx = (signal?: AbortSignal): AgentToolContext => ({
    get agent() {
      if (!holder.agent) throw new Error("工具上下文里的 agent 尚未构造完成");
      return holder.agent;
    },
    host,
    signal,
  });

  const customTools: ToolDefinition[] = [];
  for (const tool of spec.customTools ?? []) {
    customTools.push(typeof tool === "function" ? tool(makeCtx()) : tool);
  }

  const extensionFactories: InlineExtension[] = [];
  if (spec.onToolCall) {
    const gate = spec.onToolCall;
    extensionFactories.push((pi: ExtensionAPI) => {
      pi.on("tool_call", async (event) => {
        const verdict = await gate({ name: event.toolName, input: event.input }, makeCtx());
        return verdict ? { block: true, reason: verdict.reason } : undefined;
      });
    });
  }

  const loader = await buildLoader(spec, { cwd, agentDir, settingsManager, extensionFactories });

  // 决策 #4：只有设计者给了 tools 白名单时才并入 customTools / 扩展工具名；不给就一个都不动
  const tools = spec.tools
    ? [
        ...new Set([
          ...spec.tools,
          ...customTools.map((t) => t.name),
          ...loader.getExtensions().extensions.flatMap((e) => [...e.tools.keys()]),
        ]),
      ]
    : undefined;

  const { model, thinkingLevel } = resolveModel(spec, modelRuntime);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader: loader,
    customTools,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(tools ? { tools } : {}),
    ...(spec.excludeTools ? { excludeTools: spec.excludeTools } : {}),
  });

  // ─────────────── 内部状态 ───────────────
  const listeners = new Map<AgentEventName, Set<(payload: any) => void>>();
  /** 已经算进用量的 assistant 消息（用对象身份而不是下标，上下文压缩后也不会错算） */
  const counted = new WeakSet<object>();
  const state: { status: ControlledAgent["status"]; usage: Usage; lastResult: RunResult | undefined } = {
    status: "idle",
    usage: emptyUsage(),
    lastResult: undefined,
  };

  const unsubscribe = session.subscribe((raw) => {
    const normalized = normalizeEvent(raw);
    if (!normalized) return;
    const { type, ...payload } = normalized;
    for (const fn of listeners.get(type) ?? []) fn(payload);
  });

  function assertAlive(): void {
    if (state.status === "disposed") throw new Error(`agent ${id} 已 dispose（disposed），不能再操作`);
  }

  /** 本次运行新增的 assistant 用量 + 最后一段文本 + 错误 */
  function collectRun(): RunResult {
    let fresh = emptyUsage();
    let text = "";
    let error: string | undefined;
    for (const message of session.messages as AgentMessage[]) {
      if (message.role !== "assistant" || counted.has(message)) continue;
      counted.add(message);
      if (message.usage) fresh = addUsage(fresh, message.usage);
      const chunk = message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (chunk) text = chunk;
      if (message.errorMessage) error = message.errorMessage;
    }
    state.usage = addUsage(state.usage, fresh);
    return { text, usage: fresh, ...(error ? { error } : {}) };
  }

  async function prompt(text: string, opts?: PromptOpts): Promise<RunResult> {
    assertAlive();
    state.status = "running";
    try {
      await session.prompt(text, opts?.images ? { images: opts.images } : undefined);
    } catch (err) {
      // 未接受就失败（目标正忙、没有可用模型…）：抛出去，这不是「跑完但出错」
      state.status = session.isStreaming ? "running" : "idle";
      throw err;
    }
    const result = collectRun();
    state.lastResult = result;
    state.status = result.error ? "error" : "idle";
    return result;
  }

  function on<E extends AgentEventName>(event: E, fn: (payload: AgentEventMap[E]) => void): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  function dispose(): void {
    if (state.status === "disposed") return;
    state.status = "disposed";
    listeners.clear();
    unsubscribe();
    try {
      session.dispose();
    } catch {
      /* 已经回收过了 */
    }
  }

  const agent = {
    id,
    session,
    parentId: deps.parent?.id,
    member: deps.member,
    get status() {
      return state.status;
    },
    get isStreaming() {
      return session.isStreaming;
    },
    get usage() {
      return state.usage;
    },
    get lastResult() {
      return state.lastResult;
    },
    prompt,
    // send / steer / waitForIdle / abort 在任务 5 落地
    on,
    dispose,
  } as unknown as ControlledAgent;

  holder.agent = agent;
  return agent;
}
