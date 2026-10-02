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
import { addUsage, emptyUsage } from "./usage.ts";
import { createIo } from "../surfaces/io.ts";
import { createContext } from "../surfaces/context.ts";
import { createTools } from "../surfaces/tools.ts";
import type {
  Agent,
  AgentContext,
  AgentInit,
  ContextSurface,
  CreateAgentDeps,
  ExtensionsSurface,
  ExtensionEvent,
  ModelSurface,
  PermissionsSurface,
  SkillsSurface,
  ThinkingLevel,
  ToolsSurface,
} from "./types.ts";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `a${counter}`;
}

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
const NOT_WIRED = ["permissions.deny", "permissions.gate", "tools.custom"];

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
  const settingsManager = SettingsManager.inMemory();
  const sessionManager = SessionManager.inMemory(cwd);

  // 工厂要在 createAgentSession 之前就交出去，而 session / agent 那时还没建好 —— 用 holder 惰性取。
  const holder: { session?: AgentSession; agent?: Agent } = {};
  // 先声明、后赋值：桥接的守卫与三个面都按**调用时**取值，所以 isBusy 直到 io 建好之前不可用。
  // （桥接工厂 / reload 只可能在本函数返回之后触发，那时 isBusy 已经指向 io。）
  let isBusy: () => boolean;
  const need: (what: string) => never = (what) => {
    throw new Error(`桥接：${what} 还没建好`);
  };
  const bridge = createBridge({
    session: () => holder.session ?? need("session"),
    agent: () => holder.agent ?? need("agent"),
    // R29：桥接的 reload 守卫与 io / context / tools 共用同一个判据（由 createAgent 注入）
    isBusy: () => isBusy(),
  });

  const loader = await buildLoader(spec, {
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [bridge.factory],
  });
  const { model, thinkingLevel } = resolveModel(spec, modelRuntime);

  // `permissions.only` 的创建期接线只有**一处**：`createAgentSession({ tools: only })`。
  //   - `sdk.js:145` 把它当 `allowedToolNames` —— 硬过滤，白名单之外的工具连注册表都进不去（含内置的）；
  //   - `sdk.js:148` 的 `initialActiveToolNames = options.tools ?? …` 同时决定初始活跃集。
  // 一处即两效，不需要再给 `settings.defaultTools`：`options.tools` 有值时它**永远不会被咨询**
  // （`getDefaultTools()` 在 dist 里只有 `sdk.js:144` 一个消费者，而那行只在 `options.tools` 为
  //  undefined 时才轮到）；`_restoreToolsFromTranscript()`（agent-session.js:1306-1310）也只在
  //  `_initialActiveToolNames === undefined` 时才调（:194-195），给了 `tools` 就不会走到。
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    ...(spec.permissions?.only ? { tools: spec.permissions.only } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
  const session = created.session;
  holder.session = session;
  // 创建期的唯一一个 context 面字段（§3.2）：写进 session，不写进模块状态
  if (spec.context?.autoCompact !== undefined) session.setAutoCompactionEnabled(spec.context.autoCompact);

  // 扩展错误监听器（R17）。pi 的 `emitError` 只遍历 `errorListeners`，**没有任何 console 兜底**
  // （runner.js:497-501）；`createAgentSession` 不注入 `onError`（sdk.js 零命中），我们也没调过
  // `bindExtensions`。净效果：桥接抛出的异常，在 `context` / `tool_result` 这类「handler 抛错被
  // `emitError` 吞掉」的事件上会彻底消失（runner.js:1018-1026 等）—— 用户看不到任何症状，正是 v2
  // 要根除的失效模式。注册这个监听器是让它们变成可见输出的唯一途径。
  //
  // R18：监听器挂在 runner **实例**上，而 `session.reload()` 会 `new ExtensionRunner(...)`
  // （agent-session.js:2852 + 2593-2598 的 `_applyExtensionBindings`），旧实例连同它的
  // errorListeners 一起被丢弃 —— 只挂一次的话，**reload 之后钩子异常重新静默**（实测：reload 前
  // 打印一条，reload 后零输出）。所以必须 re-arm：下面是幂等的重挂函数 + 一次 reload 包装。
  let armedRunner: AgentSession["extensionRunner"] | undefined;
  let offExtensionError: (() => void) | undefined;

  /** 把监听器挂到**当前**的 runner 上；同一个 runner 上重复调用是 no-op（否则同一条错误打印多份） */
  function armExtensionError(): void {
    const runner = session.extensionRunner;
    if (runner === armedRunner) return;
    // 这里只丢掉旧句柄、不对旧 runner 调 off()：能走到这一步说明 runner 已经被换下（旧实例非法、
    // 其监听表随之不可达），对着已死的实例退订没有意义。dispose 时退订的是 armedRunner（当前那个）。
    armedRunner = runner;
    offExtensionError = runner.onError((e) => {
      // event 与 extensionPath 都要带上：没有这两样，用户不知道该去关哪个钩子
      console.error(`[aiteam] 扩展/钩子错误 event=${e.event} path=${e.extensionPath}：${e.error}`);
    });
  }

  armExtensionError();

  // `reload()` 是 extensionRunner 被换掉的唯一入口（`_buildRuntime` 只在构造与 reload 里调，
  // agent-session.js:188 / 2876），桥接的 `bridge.reload()` 也走这里 —— 所以包在 session 这一层，
  // 所有路径（含 T1 阶段唯一公开可用的 `io.raw.reload()`）都覆盖到。放 finally 而不是成功之后：
  // reload 可能在换完 runner 之后才抛（换 runner 之后还有 session_start / 资源扩展），那种情况也得重挂，
  // 而 armExtensionError 对未换 runner 的场景本来就是 no-op。
  const rawReload = session.reload.bind(session);
  session.reload = async (options) => {
    try {
      await rawReload(options);
    } finally {
      armExtensionError();
    }
  };

  // ─────────────── 状态 ───────────────
  let status: Agent["status"] = "idle";
  let usage = emptyUsage();

  function assertAlive(): void {
    if (status === "disposed") throw new Error(`agent ${id} 已 dispose（disposed），不能再操作`);
  }

  /** 任务 2-7 各实现一个面；这里只留下会喊的占位，不静默给假值 */
  const notImplemented = (what: string): never => {
    throw new Error(`${what} 未实现（还没接线到 pi）`);
  };

  // ─────────────── io（驱动 + 结算，见 src/surfaces/io.ts）───────────────
  const io = createIo({
    session,
    bridge,
    assertAlive,
    getStatus: () => status,
    setStatus: (next) => {
      status = next;
    },
    accumulate: (fresh) => {
      usage = addUsage(usage, fresh);
    },
  });

  // 忙判据的**唯一一处定义**：声明面（reload）与 compact 都会「先 abort 或静默不生效」在飞的那轮，
  // 所以两边必须口径一致，否则迟早分叉成两份措辞、两份逻辑。
  // 两个分量都不是装饰：
  //   - `io.isRunning` = `running > 0 || session.isStreaming`。`session.isStreaming` 就是 pi 的
  //     `_isAgentRunActive`，它在 `_runAgentPrompt` 第一行才置真（agent-session.js:1320），而 `prompt()`
  //     要先 await 好几回合（`_runInputHandlers` → emitBeforeAgentStart / 图片归一化，:1470-1563）才走到
  //     那里 —— 所以 `io.prompt()` 刚发起、还没 await 时 isStreaming 是**假**的。这段启动窗口里
  //     pi 的 `reload()` 不会抛错，它照常跑完、在飞的请求不受影响，于是「刚加的工具在飞那轮里不存在」
  //     这种**静默**失效就发生了（实测 S3）。`running` 计数在第一个 await 之前同步自增，正好补上这个洞。
  //   - `pendingMessageCount` 只数 pi 的 steering / follow-up 队列。follow-up 是**idle 时也能排队**的
  //     （agent-session.js:1824-1825），此刻 isRunning 仍是假、但一轮运行马上就要开始。丢了这一项就漏判。
  isBusy = () => io.isRunning || session.pendingMessageCount > 0;

  const context: ContextSurface = createContext({
    session,
    sessionManager,
    bridge,
    isBusy,
    assertAlive,
  });

  const tools: ToolsSurface = createTools({
    session,
    bridge,
    agent: () => holder.agent ?? need("agent"),
    isBusy,
    assertAlive,
  });

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
    offExtensionError?.(); // 否则已 dispose 的会话还在往控制台写；这里退订的始终是当前 runner
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
