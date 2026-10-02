// spec → Agent：配置校验、loader、session、常驻桥接、七面装配、生命周期。
// 本任务只装配 io（最小驱动版）与桥接；其余六个面是「一碰就喊」的类型占位（分工见实现计划）。
import { join } from "node:path";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  resolveCliModel,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { buildLoader } from "./loader.ts";
import { ANY_EVENT, createBridge, type Handler } from "./bridge.ts";
import { emptyUsage } from "./usage.ts";
import type {
  Agent,
  AgentContext,
  AgentInit,
  ContextSurface,
  CreateAgentDeps,
  ExtensionsSurface,
  ExtensionEvent,
  IoSurface,
  ModelSurface,
  PermissionsSurface,
  RunResult,
  SkillsSurface,
  ThinkingLevel,
  ToolsSurface,
} from "./types.ts";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `a${counter}`;
}

let runCounter = 0;

export function defaultAgentDir(): string {
  return process.env.AITEAM_AGENT_DIR || getAgentDir();
}

/** 宿主级共享的 ModelRuntime（决策 #8）：**按 agentDir + 网络开关缓存** —— 一个凭证集一个 runtime。
 *  曾经是全局单例，结果是第二个不同 agentDir 的分身仍去读第一个的 models.json/auth.json。
 *  开关也必须进 key：否则第一个 runtime 的设置会决定后面所有分身（与 #8 同类的 bug）。 */
const sharedRuntimes = new Map<string, Promise<ModelRuntime>>();
export function getSharedRuntime(agentDir: string, opts: RuntimeOpts = {}): Promise<ModelRuntime> {
  const net = opts.modelNetwork !== false;
  const key = [agentDir, net ? "net" : "offline", opts.catalogBaseUrl ?? ""].join("\u0000");
  let runtime = sharedRuntimes.get(key);
  if (!runtime) {
    runtime = ModelRuntime.create({
      modelsPath: join(agentDir, "models.json"),
      authPath: join(agentDir, "auth.json"),
      ...(net ? { allowModelNetwork: true } : {}),
      ...(opts.catalogBaseUrl ? { catalogBaseUrl: opts.catalogBaseUrl } : {}),
    });
    sharedRuntimes.set(key, runtime);
  }
  return runtime;
}

/** 模型目录的网络与来源开关（来自 spec） */
export interface RuntimeOpts {
  modelNetwork?: boolean;
  catalogBaseUrl?: string;
}

/** 解析出来的模型：直接取 resolveCliModel 的返回类型，不自己重定义 */
type ResolvedModel = NonNullable<ReturnType<typeof resolveCliModel>["model"]>;

/** 决策 #28：resolveCliModel 对不存在的模型只给 warning，必须自己判 */
function resolveModel(
  spec: AgentInit,
  modelRuntime: ModelRuntime,
): { model?: ResolvedModel; thinkingLevel?: ThinkingLevel } {
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

/** spec 顶层的可用字段 */
const SPEC_KEYS = [
  "id",
  "cwd",
  "agentDir",
  "modelNetwork",
  "catalogBaseUrl",
  "role",
  "model",
  "thinking",
  "permissions",
  "tools",
  "context",
  "skills",
  "extensions",
] as const;

/** 每个面对象内的可用字段 */
const SURFACE_KEYS = {
  permissions: ["only", "deny", "gate"],
  tools: ["custom"],
  context: ["autoCompact"],
} as const satisfies Record<string, readonly string[]>;

/** 已经在 spec 里声明、但本任务还没接线的字段：宁可立刻喊，也不静默忽略（v1 的教训） */
const NOT_WIRED = ["permissions.only", "permissions.deny", "permissions.gate", "tools.custom", "context.autoCompact"];

function assertSpec(spec: AgentInit): void {
  const given = spec as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!SPEC_KEYS.includes(key as (typeof SPEC_KEYS)[number])) {
      throw new Error(`createAgent：未知字段「${key}」。可用字段：${SPEC_KEYS.join("、")}`);
    }
  }
  for (const [surface, allowed] of Object.entries(SURFACE_KEYS)) {
    const group = given[surface];
    if (!group || typeof group !== "object") continue;
    for (const key of Object.keys(group)) {
      if (!(allowed as readonly string[]).includes(key)) {
        throw new Error(`createAgent：${surface} 里的未知字段「${key}」。可用字段：${allowed.join("、")}`);
      }
    }
  }
  for (const path of NOT_WIRED) {
    const [surface, key] = path.split(".");
    const group = given[surface] as Record<string, unknown> | undefined;
    if (group && typeof group === "object" && group[key] !== undefined) {
      throw new Error(`createAgent：${path} 尚未实现（还没接线到 pi），先别传`);
    }
  }
}

export async function createAgent(rawSpec: AgentInit = {}, deps: CreateAgentDeps = {}): Promise<Agent> {
  const spec = rawSpec ?? {};
  assertSpec(spec);

  const id = spec.id ?? nextId();
  const cwd = spec.cwd ?? process.cwd();
  const agentDir = spec.agentDir ?? defaultAgentDir();
  const modelRuntime =
    deps.modelRuntime ??
    (await getSharedRuntime(agentDir, { modelNetwork: spec.modelNetwork, catalogBaseUrl: spec.catalogBaseUrl }));
  const settingsManager = SettingsManager.inMemory({});
  const sessionManager = SessionManager.inMemory(cwd);

  // 工厂要在 createAgentSession 之前就交出去，而 session / agent 那时还没建好 —— 用 holder 惰性取。
  const holder: { session?: AgentSession; agent?: Agent } = {};
  const need = (what: string): never => {
    throw new Error(`桥接：${what} 还没建好`);
  };
  const bridge = createBridge({
    session: () => holder.session ?? need("session"),
    agent: () => holder.agent ?? need("agent"),
  });

  const loader = await buildLoader(spec, {
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [bridge.factory],
  });
  const { model, thinkingLevel } = resolveModel(spec, modelRuntime);

  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
  const session = created.session;
  holder.session = session;

  // ─────────────── 状态 ───────────────
  let status: Agent["status"] = "idle";
  const usage = emptyUsage();

  function assertAlive(): void {
    if (status === "disposed") throw new Error(`agent ${id} 已 dispose（disposed），不能再操作`);
  }

  /** 任务 2-7 各实现一个面；这里只留下会喊的占位，不静默给假值 */
  const notImplemented = (what: string): never => {
    throw new Error(`${what} 未实现（还没接线到 pi）`);
  };

  // ─────────────── io（本任务的最小驱动版；结算与 queue/steer/abort 归任务 2）───────────────
  const io: IoSurface = {
    get pending() {
      return session.pendingMessageCount;
    },
    get isRunning() {
      return session.isStreaming;
    },
    async prompt(text, opts) {
      assertAlive();
      status = "running";
      const runId = `run${(runCounter += 1)}`;
      bridge.setRunId(runId);
      try {
        await session.prompt(text, opts?.images ? { images: opts.images } : undefined);
      } finally {
        bridge.setRunId(undefined);
        if (status === "running") status = "idle";
      }
      // 占位：真正的结算（文本 / 用量 / 消息区间 / 错误归属）归任务 2
      return { runId, text: "", usage: emptyUsage(), messages: [] };
    },
    queue: async () => notImplemented("io.queue"),
    steer: async () => notImplemented("io.steer"),
    abort: async () => notImplemented("io.abort"),
    async waitIdle() {
      await session.waitForIdle();
    },
    raw: session,
  };

  const context: ContextSurface = {
    get history() {
      return notImplemented("context.history");
    },
    get usage() {
      return notImplemented("context.usage");
    },
    get autoCompact() {
      return notImplemented("context.autoCompact");
    },
    set autoCompact(_enabled: boolean) {
      notImplemented("context.autoCompact");
    },
    override: () => notImplemented("context.override"),
    compact: async () => notImplemented("context.compact"),
    get raw() {
      return notImplemented("context.raw");
    },
  };

  const tools: ToolsSurface = {
    list: () => notImplemented("tools.list"),
    add: async () => notImplemented("tools.add"),
    remove: async () => notImplemented("tools.remove"),
    onResult: () => notImplemented("tools.onResult"),
    get raw() {
      return notImplemented("tools.raw");
    },
  };

  const permissions: PermissionsSurface = {
    gate: () => notImplemented("permissions.gate"),
    allow: () => notImplemented("permissions.allow"),
    deny: () => notImplemented("permissions.deny"),
    only: () => notImplemented("permissions.only"),
  };

  const extensions: ExtensionsSurface = {
    list: () => notImplemented("extensions.list"),
    errors: () => notImplemented("extensions.errors"),
    add: async () => notImplemented("extensions.add"),
    remove: async () => notImplemented("extensions.remove"),
    get raw() {
      return notImplemented("extensions.raw");
    },
  };

  const skills: SkillsSurface = {
    list: () => notImplemented("skills.list"),
    add: async () => notImplemented("skills.add"),
    remove: async () => notImplemented("skills.remove"),
    get raw() {
      return notImplemented("skills.raw");
    },
  };

  const modelSurface: ModelSurface = {
    get current() {
      return notImplemented("model.current");
    },
    get thinking() {
      return notImplemented("model.thinking");
    },
    get available() {
      return notImplemented("model.available");
    },
    set: async () => notImplemented("model.set"),
    setThinking: () => notImplemented("model.setThinking"),
    get raw() {
      return notImplemented("model.raw");
    },
  };

  // ─────────────── 观测 ───────────────
  function subscribe(name: string, handler: Handler): () => void {
    let set = bridge.listeners.get(name);
    if (!set) {
      set = new Set();
      bridge.listeners.set(name, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  function on<E extends ExtensionEvent["type"]>(
    event: E,
    handler: (event: Extract<ExtensionEvent, { type: E }>, ctx: AgentContext) => unknown,
  ): () => void {
    assertAlive();
    if (!bridge.eventNames().includes(event)) {
      throw new Error(`未知事件「${event}」。可用事件名：${bridge.eventNames().join("、")}`);
    }
    return subscribe(event, handler);
  }

  function onAny(handler: (event: ExtensionEvent, ctx: AgentContext) => unknown): () => void {
    assertAlive();
    return subscribe(ANY_EVENT, handler);
  }

  // ─────────────── 生命周期 ───────────────
  function dispose(): void {
    if (status === "disposed") return;
    const wasStreaming = session.isStreaming;
    status = "disposed";
    bridge.listeners.clear();
    if (wasStreaming) {
      // 先 abort，等它 settle，再真回收 —— 否则会留下悬挂的请求与永不 settle 的 promise
      void session
        .abort()
        .catch(() => {})
        .then(() => session.dispose())
        .catch(() => {});
      return;
    }
    try {
      session.dispose();
    } catch {
      /* 已经回收过了 */
    }
  }

  const agent: Agent = {
    id,
    get usage() {
      return usage;
    },
    get status() {
      return status;
    },
    io,
    context,
    tools,
    permissions,
    extensions,
    skills,
    model: modelSurface,
    on,
    onAny,
    dispose,
  };
  holder.agent = agent;
  return agent;
}
