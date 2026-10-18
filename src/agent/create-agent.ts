// spec → Agent：配置校验、loader、session、常驻桥接、七面装配、生命周期。
// 入口只有 `createAgentInLab(env, spec)`：环境（agentDir / cwd / 网络 / runtime）全部来自实验室，
// 本文件不再有「自己去搞一个环境」的任何回落路径。
import { join, resolve } from "node:path";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  resolveCliModel,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { buildLoader, declaredExtensionToolNames } from "./loader.ts";
import { ANY_EVENT, createBridge, type Handler } from "./bridge.ts";
import { addUsage, emptyUsage } from "./usage.ts";
import { createIo } from "../surfaces/io.ts";
import { createContext } from "../surfaces/context.ts";
import { createObserve, type ObserveSurface } from "../surfaces/observe.ts";
import { createTools, createPermissions } from "../surfaces/tools.ts";
import { createExtensions, createSkills } from "../surfaces/resources.ts";
import { createModel } from "../surfaces/model.ts";
import type {
  Agent,
  AgentContext,
  AgentSpec,
  ContextSurface,
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

/**
 * 实验室交给 `createAgentInLab` 的环境：`agentDir` / `cwd` 在导出的 `Lab` 接口上也有一份，
 * `modelRuntime` 只在这里 —— 它是实现细节，不进对外类型（R2 的 (i)）。
 * `createLab` 把这份记录直接传进来，没有中间注册表：传错环境由类型挡住。
 */
export interface LabEnv {
  agentDir: string;
  cwd: string;
  modelRuntime: ModelRuntime;
  /**
   * ★★★ 模型白名单（可选）—— 这个实验室**只能**解析这些型号。
   *
   * ★ 为什么要有它（2026-10-18，实测到的事故）：
   *   使用者把每一处 `model` 都钉死了，**仍然漏了一个入口** ——
   *   · `sandbox.spawn({ model: "…" })` 是**模型运行时自己填的参数**，绕过所有钉死点
   *   · 而**不传** `model` 时，`resolveModel` 会把选择权交给 **pi 的全局默认**（不在使用者控制内）
   *   ⇒ 实测：一个只声明了 `opencode-go/deepseek-v4.1-flash` 的实验室，
   *     **静默地**用 pi 的默认型号发起了请求。
   *   ★★ 这是 `P17`「一个能力多个入口」在**型号**上的再现：堵了 5 个入口，第 6 个是模型自己开的。
   *
   * ★★ 它是**机制不是策略**：库不说"不许用 X"，只说"这个实验室的型号集是这些"。
   *   声明什么由使用者定 —— 与 `permissions.only`（工具白名单）同一种性质。
   *
   * 不传 ⇒ 保持旧行为（不限制）；传了空数组 ⇒ 拒绝一切显式 model（只能用 `defaultModel`）。
   */
  modelAllow?: readonly string[];
  /**
   * 没给 `model` 时用的型号。
   *
   * ★★ 治的是上面那条的**第二半**：原来是 `return { thinkingLevel }` —— **不解析**，
   *   于是落到 pi 的全局默认。现在实验室可以声明"我的默认是哪个"，
   *   而它**必须**在白名单里（构造时校验）。
   */
  defaultModel?: string;
}

/** 宿主级共享的 ModelRuntime（决策 #8）：**按 agentDir + 网络开关缓存** —— 一个凭证集一个 runtime。
 *  曾经是全局单例，结果是第二个不同 agentDir 的分身仍去读第一个的 models.json/auth.json。
 *  开关也必须进 key：否则第一个 runtime 的设置会决定后面所有分身（与 #8 同类的 bug）。
 *  key 里的 agentDir 必须**规范化**：`demo/agent` 与它的绝对路径是同一个目录，原样字符串
 *  会让同一份凭证集拿到两份 runtime —— 而两份 runtime 读改写同一个 auth.json 正是 #8 要根除的。 */
const sharedRuntimes = new Map<string, Promise<ModelRuntime>>();
export function getSharedRuntime(agentDir: string, opts: RuntimeOpts = {}): Promise<ModelRuntime> {
  const net = opts.modelNetwork !== false;
  const key = [resolve(agentDir), net ? "net" : "offline", opts.catalogBaseUrl ?? ""].join("\u0000");
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

/** 模型目录的网络与来源开关（来自 LabOptions） */
export interface RuntimeOpts {
  modelNetwork?: boolean;
  catalogBaseUrl?: string;
}

/** 解析出来的模型：直接取 resolveCliModel 的返回类型，不自己重定义 */
type ResolvedModel = NonNullable<ReturnType<typeof resolveCliModel>["model"]>;

/** 决策 #28 的判据只有这一处：`resolveCliModel` 对不存在的模型只给 warning，也不保证 model 存在。
 *  创建期（spec.model）与运行期（model.set）都走这里 —— 两边口径不许分叉。 */
function resolveModelOrThrow(
  ref: string,
  modelRuntime: ModelRuntime,
): { model: ResolvedModel; thinkingLevel?: ThinkingLevel } {
  const resolved = resolveCliModel({ cliModel: ref, modelRuntime });
  if (resolved.error || !resolved.model) {
    throw new Error(`模型「${ref}」解析失败：${resolved.error ?? "未知原因"}`);
  }
  if (resolved.warning) {
    throw new Error(`模型「${ref}」解析有警告：${resolved.warning}`);
  }
  return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
}

/**
 * ★★★ 模型白名单的唯一执行点（创建期 / 默认期 / 运行期三处都过这里）。
 *
 * ★ 为什么收敛到一处：型号有三个入口（`spec.model` / 不传时的默认 / `agent.model.set()`），
 *   分散校验一定会漏 —— 本项目已在这类"多入口"上反复吃亏（`P17`）。
 *
 * ★★ 它是**机制**：只问"在不在这个实验室声明的型号集里"，不问"该不该允许”。
 */
function assertModelAllowed(ref: string, env: LabEnv, where: string): void {
  const allow = env.modelAllow;
  if (!allow) return; // 没声明 ⇒ 不限制（保持旧行为）
  // 允许两种写法：完整 ref（`provider/id`）或裸 id —— 使用者两种都容易写出来。
  const bare = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
  const ok = allow.includes(ref) || allow.includes(bare);
  if (ok) return;
  throw new Error(
    `${where}：模型「${ref}」不在这个实验室允许的型号里。\n` +
      `  允许的：${allow.length ? allow.join("、") : "（空 —— 只能用实验室默认型号）"}\n` +
      `  ★ 这是 createLab({ modelAllow }) 定的 —— 要改就先改实验室声明，不要在调用处绕。`,
  );
}

/** 创建期解析：没给 `model` 就用实验室默认（★ 不再落到 pi 的全局默认） */
function resolveModel(
  spec: AgentSpec,
  modelRuntime: ModelRuntime,
  env: LabEnv,
): { model?: ResolvedModel; thinkingLevel?: ThinkingLevel } {
  if (!spec.model) {
    // ★★★ 这里原来是 `return { thinkingLevel }` —— **不解析**，于是落到 pi 的全局默认。
    //   那是使用者控制不到的地方（实测：一个只想要 deepseek 的实验室静默用了默认型号）。
    //   现在：实验室声明了默认就解析它，没声明才保持旧行为。
    if (!env.defaultModel) return { thinkingLevel: spec.thinking };
    assertModelAllowed(env.defaultModel, env, "实验室默认型号");
    const d = resolveModelOrThrow(env.defaultModel, modelRuntime);
    const t = spec.thinking ?? d.thinkingLevel;
    assertThinkingSupported(d.model, t, "createAgent（实验室默认型号）");
    return { model: d.model, thinkingLevel: t };
  }
  assertModelAllowed(spec.model, env, "createAgent");
  const resolved = resolveModelOrThrow(spec.model, modelRuntime);
  const t = spec.thinking ?? resolved.thinkingLevel;
  assertThinkingSupported(resolved.model, t, "createAgent");
  return { model: resolved.model, thinkingLevel: t };
}

/**
 * ★★★ 创建期思考档的守卫。
 *
 * ★ 为什么必需（由 lab-3b 研究员集群实测发现，2026-10-19）：
 *   `surfaces/model.ts` 的 `setThinking`/`set` 已守住**运行期**；
 *   但**创建期**（`spec.thinking`、以及 `model` 后缀里的档）把档**直接**交给
 *   `createAgentSession({ thinkingLevel })` —— 而 pi 的 `setThinkingLevel`
 *   对非法档**静默钳**（实测 `very-high → low`，**连抛都不抛**，而且**不是最近档**）。
 *   ⇒ 调用方以为设成了 A，实际是 B，**且要读 `agent.model.thinking` 才发现**。
 *
 * ★★ 这是同一个库里的**两套口径**：运行期拒绝、创建期静默降级 ——
 *   正是 v1 决策 #28 要治的病，**只在创建路径漏了**（同族：`modelAllow` 那次事故
 *   也是"创建路径缺守卫"）。
 *
 * ★ 与 `model.ts` 的 `setThinking` 用**同一判据**（`getSupportedThinkingLevels(model)`），
 *   创建/运行两期口径一致。
 *
 * ★★ 影响面：**只影响非法档**（合法档与"不写 thinking"完全不变）。
 */
function assertThinkingSupported(
  model: ResolvedModel,
  thinkingLevel: ThinkingLevel | undefined,
  where: string,
): void {
  if (!thinkingLevel) return;
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(thinkingLevel)) return;
  const name = (model as { id?: string; name?: string }).id ?? (model as { name?: string }).name ?? "?";
  throw new Error(
    `${where}：思考档「${thinkingLevel}」在模型「${name}」上不支持（可用：${supported.join("、")}）。` +
      "pi 的 setThinkingLevel 对非法档会静默钳到**别的**档（实测 very-high→low，不是最近档），" +
      "所以这里自己判、不静默降级；agent 未创建，请换档位。",
  );
}

/** spec 顶层的可用字段（环境字段不在这里：它们只属于 `LabOptions`） */
const SPEC_KEYS = [
  "id",
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

function assertSpec(spec: AgentSpec): void {
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
}

/** 起作用的是实验室：`agentDir` / `cwd` / `modelRuntime` 全部来自 `createLab` 交过来的那份环境 */
export async function createAgentInLab(env: LabEnv, rawSpec: AgentSpec = {}): Promise<Agent> {
  const spec = rawSpec ?? {};
  assertSpec(spec);

  const id = spec.id ?? nextId();
  const { agentDir, cwd, modelRuntime } = env;
  const settingsManager = SettingsManager.inMemory();
  const sessionManager = SessionManager.inMemory(cwd);

  // 工厂要在 createAgentSession 之前就交出去，而 session / agent 那时还没建好 —— 用 holder 惰性取。
  const holder: { session?: AgentSession; agent?: Agent } = {};

  // ─────────────── 状态 ───────────────
  let status: Agent["status"] = "idle";
  let usage = emptyUsage();
  // 句柄先建、面后挂（R42）：创建期 `tools.custom` 的工厂在 session 之前就要 `ctx.agent`，而工厂常把
  // agent 存进闭包留到 execute 再取 ⇒ 必须是**同一个**对象。所以先给一个只带 id / usage / status 的空壳，
  // 七个面等 session 拼好后用 Object.assign 挂上去（工厂拿到的引用因此始终是最终那个句柄）。
  const agent = {
    id,
    get usage() { return usage; },
    get status() { return status; },
  } as Agent;
  holder.agent = agent;
  // 先声明、后赋值：桥接的守卫与三个面都按**调用时**取值，所以 isBusy 直到 io 建好之前不可用。
  // （桥接工厂 / reload 只可能在本函数返回之后触发，那时 isBusy 已经指向 io。）
  let isBusy: () => boolean;
  const need: (what: string) => never = (what) => {
    throw new Error(`桥接：${what} 还没建好`);
  };
  // ★ 观测面的记帐口：bridge 在 179 行就建好了，而 observe 要等到 subscribe 之后（≈348 行）。
  //   用一个可变槽位把两者接起来 —— bridge 每次调用时现取，不用关心谁先建。
  let observeRef: ObserveSurface | undefined;
  const bridge = createBridge({
    session: () => holder.session ?? need("session"),
    agent: () => holder.agent ?? need("agent"),
    // R29：桥接的 reload 守卫与 io / context / tools 共用同一个判据（由 createAgent 注入）
    isBusy: () => isBusy(),
    note: (name, args, returned) => observeRef?.noteInjection(name, args, returned),
  });
  // 创建期的 gate 就是运行期那个槽位（单槽位，后一次覆盖前一次）
  if (spec.permissions?.gate) bridge.gate = spec.permissions.gate;

  const loader = await buildLoader(spec, {
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [bridge.factory],
  });
  const { model, thinkingLevel } = resolveModel(spec, modelRuntime, env);

  // R41：白名单会自动并入**你在同一个 spec 里显式声明的**工具（显式声明一定生效）。
  // 两个来源都是显式声明：`spec.tools.custom` 的定义名（R42 接线后这里才有调用者）与
  // `spec.extensions` 里显式声明的扩展/内联工厂所注册的工具名。
  // 环境自动发现的扩展**不**并入：白名单不该被环境里碰巧存在的扩展悄悄撑开（`declaredExtensionToolNames`）。
  const only = spec.permissions?.only;
  // R42：创建期自定义工具落 pi 的真选项 `customTools`（`sdk.d.ts:47` → `sdk.js:298`）。工厂式在这里就调成
  // 成品（R30b）：`customTools` 只收 `ToolDefinition`，pi 不会替你调工厂；而且只调这一次，工厂里的副作用
  // 不许跑两遍。ctx 只给 agent —— 挂面之前空壳已经建好，工厂无论当场用还是存进闭包都对。
  const customTools = (spec.tools?.custom ?? []).map((tool) =>
    typeof tool === "function" ? tool({ agent }) : tool,
  );
  const whitelist = only
    ? [...new Set([...only, ...declaredExtensionToolNames(spec, loader, cwd), ...customTools.map((t) => t.name)])]
    : undefined;

  // `permissions.only` 的创建期接线只有**一处**：`createAgentSession({ tools: whitelist })`（R41 并入后的那份）。
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
    ...(whitelist ? { tools: whitelist } : {}),
    ...(customTools.length ? { customTools } : {}),
    // 创建期 `deny` 落 `excludeTools`（`sdk.js:146` → pi 的 `_excludedToolNames`）：比白名单更硬 ——
    // 被排除的名字连工具注册表都进不去，也不会被 `initialActiveToolNames` 选中。
    ...(spec.permissions?.deny ? { excludeTools: spec.permissions.deny } : {}),
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

  function assertAlive(): void {
    if (status === "disposed") throw new Error(`agent ${id} 已 dispose（disposed），不能再操作`);
  }

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

  const permissions: PermissionsSurface = createPermissions({
    session,
    bridge,
    isBusy,
    assertAlive,
  });

  const extensions: ExtensionsSurface = createExtensions({ loader, session, bridge, isBusy, assertAlive });

  const skills: SkillsSurface = createSkills({ loader, bridge, isBusy, assertAlive });

  const modelSurface: ModelSurface = createModel({
    session,
    modelRuntime,
    // 决策 #28 的唯一判据：ref 解析不出来（或只有警告）就抛错，绝不静默降级到别的模型。
    // 连同后缀里的思考档一起交出：运行期 `set` 要兑现它（R45）
    resolveModel: (ref) => {
      // ★★ 运行期 `agent.model.set()` 是**第三个**入口 —— 也必须过白名单，
      //   否则创建期的限制可以被运行期一句 set 绕过去。
      assertModelAllowed(ref, env, "agent.model.set");
      return resolveModelOrThrow(ref, modelRuntime);
    },
    assertAlive,
  });

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

  // ─────────────── 观测面（DESIGN「功能二」） ───────────────
  // ★ 必须建在 subscribe 之后（它要用 subscribe），并在 Object.assign 之前。
  //   记录「每一轮真正发给模型的 messages」—— 治「它没听劝 vs 它根本没收到」这个区分。
  const observe: ObserveSurface = createObserve({ subscribe, assertAlive });
  observeRef = observe;

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

  // 七个面在句柄建好之后挂上去（R42 的「句柄先建、面后挂」）：
  Object.assign(agent, {
    io,
    context,
    tools,
    permissions,
    extensions,
    skills,
    model: modelSurface,
    observe,
    on,
    onAny,
    dispose,
  });
  return agent;
}
