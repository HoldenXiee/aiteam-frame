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
  SendOpts,
  SendResult,
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

  // session.waitForIdle() 在「还没开始 streaming」的窗口里会直接返回，
  // 而 send() 正是先启动再返回 —— 所以自己要记得「有几个跑在飞」（决策 #21/#23）
  let running = 0;
  let idleWaiters: Array<() => void> = [];
  function endRun(): void {
    running -= 1;
    if (running === 0) for (const wake of idleWaiters.splice(0)) wake();
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
    running += 1;
    try {
      await session.prompt(text, opts?.images ? { images: opts.images } : undefined);
    } catch (err) {
      // 未接受就失败（目标正忙、没有可用模型…）：抛出去，这不是「跑完但出错」
      if (state.status === "running") state.status = session.isStreaming ? "running" : "idle";
      throw err;
    } finally {
      endRun();
    }
    const result = collectRun();
    state.lastResult = result;
    if (state.status === "running") state.status = result.error ? "error" : "idle";
    return result;
  }

  /**
   * 投递一条消息。目标忙时排队，**永不抛错**（决策 #18/#19/#26）。
   * 空闲时直接跑，但**不 await** —— await 了 send 就变成同步 ask，会把死锁引进来（决策 #23）。
   */
  async function send(text: string, opts?: SendOpts): Promise<SendResult> {
    assertAlive();
    if (session.isStreaming) {
      if (opts?.mode === "interrupt") await session.steer(text);
      else await session.followUp(text);
      return { delivered: "queued" };
    }
    void prompt(text).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      for (const fn of listeners.get("error") ?? []) fn({ message });
    });
    return { delivered: "ran" };
  }

  async function steer(text: string): Promise<void> {
    assertAlive();
    await session.steer(text);
  }

  async function waitForIdle(): Promise<void> {
    // 已回收的分身永远「已静下来」，不抛错（决策 #21）
    if (state.status === "disposed") return;
    if (running > 0) await new Promise<void>((resolve) => idleWaiters.push(resolve));
    await session.waitForIdle();
  }

  async function abort(): Promise<void> {
    assertAlive();
    state.status = "aborted";
    await session.abort();
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
    send,
    steer,
    waitForIdle,
    abort,
    on,
    dispose,
  } as unknown as ControlledAgent;

  holder.agent = agent;
  return agent;
}
