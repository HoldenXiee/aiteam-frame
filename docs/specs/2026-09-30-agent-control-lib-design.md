# Agent 操控库设计（阶段 1）

- 日期：2026-09-30
- 状态：待评审
- 目标交付形态：本地 TypeScript 库，不发布

## 1. 背景与目标

最终目标是一个「搭建 agent 集群」的库：能起多个 pi agent，每个 agent 的 skill、插件、工具、权限、角色、模型都可以不同。经确认拆成两阶段：

- **阶段 1（本规格）**：单 agent 操控库，并把**自定义工具的地基**做实。
- **阶段 2**：集群编排（并发闸门、预算、结果聚合、agent 间路由）。

拆分的理由：将来「操控其他 agent 的能力」「agent 之间沟通的能力」都是以**自定义工具**的形式挂上来的。地基没做实，阶段 2 只能推翻重写。

**成功标准**：能用一份声明式的 `AgentSpec` 稳定地起一个配置完全异构的 agent，监听其流式输出、控制其生命周期、读到其用量；并能在其上注册一个需要调用者上下文的**工厂式**自定义工具，跑通一个真实示例。

## 2. 范围

### 做

| 能力 | 内容 |
|---|---|
| `createAgent(spec)` | 独立 skills / 扩展 / 工具 / 角色 / 模型 / cwd |
| 事件归一化 | pi 的 20+ 事件收敛成 7 个，保留原始 `session` 逃生口 |
| 生命周期 | `prompt` / `steer` / `abort` / `dispose` + `status` / `isStreaming` |
| 用量统计 | 累计 `usage` + 成本换算 |
| **自定义工具地基** | 工厂式工具定义 + 调用者上下文 + 显式依赖注入 |
| **一个示例工具** | `spawn_agent`：证明地基可用，且是阶段 2 的真正种子 |

### 不做（YAGNI）

配置 DSL / YAML 解析器、TUI、沙箱、集群持久化与恢复、按 id 寻址的 agent 注册表、对等消息总线、磁盘会话（`session: "disk"`）—— 全部留到阶段 2 或更后。

**明确不承诺**：这不是权限/安全系统。pi 没有内置沙箱（见 `docs/security.md`），`tools` 白名单只是工具集裁剪，扩展与 `bash` 可以绕过它。真正的隔离只能靠容器/VM。库只做「工具集裁剪 + 审批门」，不得宣传为安全边界。

## 3. 架构

```
L2  cluster/   多 agent 编排（并发/预算/聚合）              ← 阶段 2，本规格只留接缝
L1  agent/     单 agent 操控 + 自定义工具地基               ← 阶段 1
L0  pi SDK     createAgentSession / DefaultResourceLoader … ← 不动
```

原则：**L1 只做「配置收敛 + 事件归一 + 用量统计」，不做任何 SDK 已经做了的事。** 阶段 2 加功能时不应改动 L1 的对外接口。

依赖倒置：`createAgent(spec, deps?)` 是**唯一的 agent 创建入口**。`host` 只在需要能力型工具（如 `spawn_agent`）时通过 `deps` 注入，单 agent 场景完全不需要它。

类型复用：`Skill` / `ToolDefinition` / `AgentSession` / `AgentMessage` / `Usage` / `ThinkingLevel` 等一律从 pi 的包直接 import，**不自己重定义**（具体导出名以安装版本为准，实现时核对 `dist/index.d.ts`）。

## 4. 对外接口

```ts
// ── 规格 ─────────────────────────────────────────────
export interface AgentSpec {
  id?: string;
  cwd?: string;
  /** 默认：库级共享。仅当需要独立 skills/settings 时才另开（另开会导致凭证需重复配置） */
  agentDir?: string;
  role?: string;                          // → systemPromptOverride
  /** 名字或 SKILL.md 路径；名字解析失败必须抛错，不得静默跳过 */
  skills?: (string | Skill)[];
  extensions?: (string | InlineExtension)[];
  /** 白名单。库会自动并入 customTools / extension 工具名 */
  tools?: string[];
  excludeTools?: string[];
  customTools?: AgentTool[];
  model?: string;                         // "anthropic/claude-opus-4-5:high"
  thinking?: ThinkingLevel;
  onToolCall?: ToolGate;                  // 审批门
}

// 阶段 1 一律使用 in-memory 会话；不提供 session 字段（只有一个取值 = 不需要配置）

export type ToolGate = (
  call: { name: string; input: unknown },
  ctx: AgentToolContext,
) => Promise<{ block: true; reason?: string } | undefined>;

// ── 工具地基 ──────────────────────────────────────────
export interface AgentToolContext {
  /** 谁在调用。操控型工具必须知道自己是谁 */
  agent: ControlledAgent;
  signal?: AbortSignal;
  /** 能力注入点：spawn / 消息 / 注册表等将来从这里接 */
  host?: AgentHost;
}

/** 工厂式：需要上下文的工具走这里 */
export type AgentToolFactory = (ctx: AgentToolContext) => ToolDefinition;
/** 静态式：无上下文依赖的简单工具 */
export type AgentTool = ToolDefinition | AgentToolFactory;

// ── 运行结果 ──────────────────────────────────────────
export interface RunResult {
  text: string;
  messages: AgentMessage[];
  usage: Usage;
  /** pi 的 prompt() 接受后失败不 reject，必须显式暴露 */
  error?: string;
}

// ── 单个 agent ────────────────────────────────────────
export interface PromptOpts {
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
}

export interface ControlledAgent {
  readonly id: string;
  readonly session: AgentSession;         // 逃生口：原始 SDK 对象
  readonly status: "idle" | "running" | "aborted" | "error" | "disposed";
  readonly isStreaming: boolean;          // 直接用 SDK 的值，不自己推
  readonly usage: Usage;                  // 累计

  prompt(text: string, opts?: PromptOpts): Promise<RunResult>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  on(event: AgentEventName, fn: (payload: unknown) => void): () => void;
  dispose(): void;
}

export type AgentEventName =
  | "text" | "thinking" | "tool_start" | "tool_end" | "turn" | "error" | "done";

export interface CreateAgentDeps {
  host?: AgentHost;
  modelRuntime?: ModelRuntime;            // 默认宿主单例
  /** 内部使用：由 spawn_agent 设置，深度由 parent 链推出 */
  parent?: ControlledAgent;
}

export function createAgent(spec: AgentSpec, deps?: CreateAgentDeps): Promise<ControlledAgent>;

// ── 能力宿主（可选） ───────────────────────────────────
// 只承载共享资源与护栏计数，本身不是创建入口，避免出现两条创建路径。
export interface HostOptions {
  maxAgents?: number;                     // 全生命周期 agent 总数上限
  maxDepth?: number;                      // spawn 递归深度上限
  budgetTokens?: number;                  // 累计 token 上限
  modelRuntime?: ModelRuntime;
  /** 对经由本宿主创建的所有 agent 生效（含顶层），spec 中的显式字段优先 */
  defaults?: Partial<AgentSpec>;
}

export interface AgentHost {
  readonly usage: Usage;                  // 全宿主累计
  readonly activeCount: number;
  readonly maxAgents: number;
  readonly maxDepth: number;
  readonly budgetTokens: number | undefined;
}

export function createAgentHost(opts?: HostOptions): AgentHost;
```

### 示例工具：`spawn_agent`

```ts
spawn_agent({ role: string, task: string, tools?: string[] }) -> string
```

同步语义：起子 agent、跑完 task、把最终文本返回给父 agent。**一个工具自成闭环**，不需要 id 寻址、不需要消息总线 —— 因此阶段 1 不需要注册表。

硬性护栏（缺一不可，否则一个 agent 能在循环里把自己复制到烧光额度）：

- 深度：`ctx` 携带当前深度，超过 `maxDepth` 直接返回错误结果，不抛异常
- 总数：超过 `maxAgents` 同上
- 预算：宿主累计 token 超过 `budgetTokens` 同上

子 agent 默认继承宿主的 `modelRuntime` / `agentDir` / `model`，仅 `role` / `task` / `tools` 由父 agent 指定 —— 不允许父 agent 任意指定子 agent 的 `cwd` 或 `agentDir`（那是提权）。

护栏触发时把错误信息作为**工具结果文本**返回给父 agent（而不是抛异常），让父 agent 有机会改用别的策略。

## 5. 关键实现决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 自己构造 `DefaultResourceLoader`，用 `skillsOverride` / `extensionFactories` / `additionalExtensionPaths` / `systemPromptOverride` / `agentsFilesOverride` **显式注入**，不依赖磁盘发现 | 非交互模式下项目级 `.pi/skills`、`.pi/extensions` 在 `defaultProjectTrust: "ask"` 时会被**静默忽略**。这是最大的坑 |
| 2 | skill 名字解析：先建 `DefaultResourceLoader` + `reload()`，用 `getSkills()` 做名字→Skill 映射；找不到**抛错** | 同上教训。静默降级会让运行时行为不可预测 |
| 3 | 模型解析直接用导出的 `resolveCliModel({ cliModel, modelRuntime })` | 已支持 `provider/id:thinking` 语法，不自造 |
| 4 | `tools` 白名单**无条件**并入 customTools 与扩展注册的工具名（要剔除请用 `excludeTools`） | 文档要求工具名必须一起列进 `tools`，漏了就静默不生效 |
| 5 | `RunResult.error` 显式暴露 | pi 的 `prompt()` 在**接受后**失败是通过事件流报告的，不 reject。不暴露的话调用方会误判成功 |
| 6 | 事件归一化只对外暴露 7 个 + `session` 逃生口 | 全透传等于没封装 |
| 7 | `ModelRuntime` 由宿主持单例、可注入 | 每 agent 一个会重复读盘并重复刷新模型目录 |
| 8 | `agentDir` 默认库级共享 | 每 agent 一个会让 `auth.json` 凭证需要重复配置 |
| 9 | `onToolCall` 实现为动态生成的扩展工厂：`extensionFactories: [pi => pi.on("tool_call", …)]` | 这是 pi 拦截工具调用的标准做法，返回 `{ block: true, reason }` |
| 10 | 工具是工厂式（接受 `ctx`），静态对象也支持 | 操控型工具必须拿到调用者上下文；简单工具不必被强迫包一层 |
| 11 | 子 agent 不得指定 `cwd` / `agentDir` | 防提权 |
| 12 | 依赖版本固定为 `@earendil-works/pi-coding-agent@0.84.2` | 本规格所有 API 均针对该版本核对；npm 上已有更新版本，升级是独立任务，需重新核对 API |
| 13 | 工具工厂的 `ctx` **惰性求值**：`customTools` 在 `createAgentSession` 时就交给 SDK，而 `ControlledAgent` 那时尚未构造完成 | 工厂若在构造期被调用，`ctx.agent` 会是 undefined。用可变 holder，在工具的 `execute` 首次调用时解析 |
| 14 | `host.defaults` 对经由宿主创建的所有 agent 生效，`spec` 中的显式字段优先 | 避免「默认值只管子 agent」这种需要读源码才能明白的语义 |

## 6. 目录结构

```
D:/space/aiteam/test/
  package.json            # type: module
  tsconfig.json           # 仅用于 tsc --noEmit 类型检查
  src/
    index.ts
    agent/
      types.ts
      create-agent.ts     # spec → session
      loader.ts           # ResourceLoader 构造 + skill 名字解析
      events.ts           # 事件归一化
      usage.ts
      host.ts             # createAgentHost + 护栏
    tools/
      define-agent-tool.ts
      spawn-agent.ts      # 示例工具
  test/
    fake-provider.ts      # 假 provider 扩展，零成本确定性
    *.test.ts
  demo/
    demo.ts               # 真模型端到端
```

## 7. 测试策略

**零成本确定性测试**：`test/fake-provider.ts` 是一个扩展，用 `pi.registerProvider("fake", { …, streamSimple })` 注册一个假 provider，`streamSimple` 按脚本吐固定的 text / toolCall 事件。所有断言跑在 `model: "fake/echo"` 上，不产生真实 API 调用。

- 运行器用 Node 内置 `node --test`（Node 24 原生跑 .ts）。**不引入测试框架**。
- 代码只用可擦除的 TS 语法（不用 enum / namespace / 装饰器），import 写显式 `.ts` 后缀。
- `typescript` 仅作为 devDependency 供 `tsc --noEmit`。

必须覆盖的用例：

1. spec → session 的配置收敛：工具白名单自动合并、skill 名字找不到抛错、`role` 生效
2. 事件归一化：text / tool_start / tool_end / turn / done 的顺序
3. `RunResult.error` 在假 provider 返回错误时被填充（对应决策 #5 的回归测试）
4. 生命周期：`abort` 后 status 正确、`dispose` 后调用抛错
5. 用量：多次 prompt 后累计正确
6. **`spawn_agent` 三道护栏**：深度超限、总数超限、预算超限各自返回错误结果而非崩溃
7. 工厂式工具能拿到正确的 `ctx.agent` 与 `ctx.host`
8. `onToolCall` 返回 block 时对应工具确实没执行

`demo/demo.ts`：真模型 + 一个 `spawn_agent` 的实际场景，人工跑一次确认端到端。

## 8. 验收标准

1. `npm test` 全绿，且**不产生任何真实 API 调用**
2. `tsc --noEmit` 无错误
3. 用一份 `AgentSpec` 能起两个配置不同的 agent（不同 tools / role / model），行为差异可观测
4. `spawn_agent` 示例工具在 demo 中真实跑通一次
5. 三道护栏有独立测试且都通过

## 9. 风险与未决项

| 风险 | 处理 |
|---|---|
| pi SDK 迭代快，API 可能变动 | 版本固定 + 升级需重新核对 API |
| 假 provider 的 `streamSimple` 实现细节多（事件序列、toolCall JSON 累积） | 这是本阶段最大的实现工作量；先做最小的 text-only 版本，toolCall 支持按需加 |
| 同进程多 agent 的并发与资源上限（进程/cpu/网络） | 阶段 2 的并发闸门负责。阶段 1 的示例工具是**同步串行**的，天然受限 |
| 成本 | 阶段 1 只用假 provider 测试；`budgetTokens` 护栏已就位，阶段 2 落地为硬闸门 |

### 已定（原先的未决项）

- 包名 `aiteam`，`src/index.ts` 统一导出；不发布，故无需考虑语义化版本与 subpath exports
- `createAgentHost` 公开导出：用户必须自己创建它才能注入 `createAgent` 的 `deps`。`spawn_agent` 工具的注入是自动的（当 `spec.tools` 含 `spawn_agent` 时）
- `host` 上的计数与用量为**只读访问器**，刻意不提供 `host.createAgent()`，避免出现两条创建路径
