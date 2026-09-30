# Agent 操控库设计（阶段 1）

- 日期：2026-09-30
- 状态：待评审（第 2 版，按团队/成员模型重写）
- 目标交付形态：本地 TypeScript 库，不发布

## 0. 核心模型：团队、成员、分身

这个库要搭的是 **agent 团队**，不是让 agent 自我繁殖。

| 概念 | 含义 | 谁能定义 |
|---|---|---|
| **成员（Member）** | 一种预定义好的 agent 类型：职责、技能、插件、工具集、模型 | **只有集群设计者**（写代码的人） |
| **分身（Instance）** | 某个成员的一个运行实例。同一成员可以有多个分身 | 由 agent 在运行时启动 |
| **花名册（members）** | 设计者声明的全部成员 | 设计者 |

**设计红线（永不支持）**：agent **不能设计、不能配置 agent**。它唯一能做的两件事是——**从花名册里挑选一个成员**、**告诉它要干什么**。连"收窄工具集"这种小自由都不给，因为那已经是变相的自己设计 agent。

好处是双向的：agent 没有提权面（无法指定 `cwd` / `agentDir` / `extensions`，也就无法让子 agent 加载任意代码或换用贵模型），而设计者的灵活性没有损失（想加一种新 agent，就在花名册里加一个成员）。

## 1. 背景与目标

最终目标是「搭建 agent 集群」的库：能起多个 pi agent，每个 agent 的 skill、插件、工具、权限、角色、模型都可以不同。经确认拆成两阶段：

- **阶段 1（本规格）**：单 agent 操控库 + 自定义工具地基 + 一个示例工具（`spawn_agent`）
- **阶段 2**：集群编排（并发闸门、消息路由、结果聚合）

拆分的理由：将来「挑选成员的能力」「agent 之间沟通的能力」都以**自定义工具**的形式挂上来。地基没做实，阶段 2 只能推翻重写。

**成功标准**：设计者能声明一张花名册；起一个顶层 agent；该 agent 能通过 `spawn_agent` 挑选成员、派活、拿到结果；同一成员能起多个互不干扰的分身；所有分身都受深度、数量、预算三道护栏约束。

## 2. 范围

### 做

| 能力 | 内容 |
|---|---|
| `createAgent(spec)` | 独立 skills / 扩展 / 工具 / 角色 / 模型 / cwd |
| `createAgentHost({ members })` | 花名册 + 共享资源 + 护栏计数 |
| 事件归一化 | pi 的 20+ 事件收敛成 7 个，保留原始 `session` 逃生口 |
| 生命周期 | `prompt` / `steer` / `abort` / `dispose` + `status` / `isStreaming` |
| 用量统计 | 每次运行的用量 + 累计用量 |
| **自定义工具地基** | 工厂式工具定义 + 调用者上下文 + 显式依赖注入 |
| **示例工具 `spawn_agent`** | 挑选成员 + 派活 + 拿结果；证明地基可用，是阶段 2 的种子 |

### 不做（YAGNI）

配置 DSL / YAML 解析器、TUI、沙箱、集群持久化与恢复、磁盘会话。

### 不做（留阶段 2，本规格只留接缝）

**工具形式**的寻址与通信：`list_agents` / `send_message` / `wait_agents` / `stop_agent` 工具、agent 间消息总线。宿主内部保留最小寻址能力（`host.list()` / `host.get()`）作为接缝。

### 不做（永不）

- agent 设计 / 配置 agent（见第 0 节红线）
- 把本库宣传为权限或安全系统

**明确不承诺**：pi 没有内置沙箱（`docs/security.md`），`tools` 白名单只是工具集裁剪，扩展与 `bash` 可以绕过它。真正的隔离只能靠容器/VM。库提供的是**能力裁剪 + 审批门**，不是安全边界。

## 3. 架构

```
L2  cluster/   多 agent 编排（并发/预算/消息路由）           ← 阶段 2
L1  agent/     单 agent 操控 + 花名册 + 自定义工具地基       ← 阶段 1
L0  pi SDK     createAgentSession / DefaultResourceLoader …  ← 不动
```

原则：**L1 只做「配置收敛 + 事件归一 + 用量统计 + 护栏」，不做任何 SDK 已经做了的事。** 阶段 2 加功能时不应改动 L1 的对外接口。

依赖倒置：`createAgent(spec, deps?)` 是**唯一的 agent 创建入口**。`host` 只在需要 `spawn_agent` 时通过 `deps` 注入，单 agent 场景完全不需要它。

类型复用：`Skill` / `ToolDefinition` / `AgentSession` / `AgentMessage` / `Usage` / `ThinkingLevel` 等一律从 pi 的包直接 import，**不自己重定义**（具体导出名以安装版本为准，实现时核对 `dist/index.d.ts`）。

## 4. 对外接口

### 4.1 成员与实例

```ts
/** 成员定义：集群设计者写的，agent 不可改 */
export interface MemberSpec {
  /** 给 agent 看的职责说明，会出现在 spawn_agent 的工具描述里 */
  description?: string;
  cwd?: string;
  /** 默认：宿主级共享。仅当需要独立 skills/settings 时才另开（另开会导致凭证需重复配置） */
  agentDir?: string;
  role?: string;                          // → systemPromptOverride
  /** 名字或 SKILL.md 路径；名字解析失败必须抛错，不得静默跳过 */
  skills?: (string | Skill)[];
  extensions?: (string | InlineExtension)[];
  /** 白名单。库会无条件并入 customTools / extension 工具名 */
  tools?: string[];
  excludeTools?: string[];
  customTools?: AgentTool[];
  model?: string;                         // "anthropic/claude-opus-4-5:high"
  thinking?: ThinkingLevel;
  onToolCall?: ToolGate;                  // 审批门
}

/** 实例规格 = 成员定义 + 身份 */
export interface AgentSpec extends MemberSpec {
  id?: string;                            // 不填则自动生成
}
```

阶段 1 一律使用 in-memory 会话，不提供 `session` 字段（只有一个取值 = 不需要配置）。

### 4.2 工具地基

```ts
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
```

### 4.3 单个 agent

```ts
export interface PromptOpts {
  images?: ImageContent[];
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
  text:       { delta: string };
  thinking:   { delta: string };
  tool_start: { toolName: string; callId: string };
  tool_end:   { toolName: string; callId: string; isError: boolean };
  /** usage = 该轮（turn）的用量 */
  turn:       { message: AgentMessage; usage: Usage };
  error:      { message: string };
  /** usage = 本次运行的用量，与 RunResult.usage 同值 */
  done:       { usage: Usage };
}
export type AgentEventName = keyof AgentEventMap;

export interface ControlledAgent {
  readonly id: string;
  readonly session: AgentSession;         // 逃生口：原始 SDK 对象；消息历史也从这里取
  readonly status: "idle" | "running" | "aborted" | "error" | "disposed";
  readonly isStreaming: boolean;          // 直接用 SDK 的值，不自己推
  readonly usage: Usage;                  // 全生命周期累计
  readonly parentId: string | undefined;
  readonly member: string | undefined;    // 由哪个成员创建；顶层 agent 为 undefined

  prompt(text: string, opts?: PromptOpts): Promise<RunResult>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  on<E extends AgentEventName>(event: E, fn: (payload: AgentEventMap[E]) => void): () => void;
  dispose(): void;
}

export interface CreateAgentDeps {
  host?: AgentHost;
  modelRuntime?: ModelRuntime;            // 默认宿主单例
  /** 内部使用：由 spawn_agent 设置，深度由 parent 链推出 */
  parent?: ControlledAgent;
}

export function createAgent(spec: AgentSpec, deps?: CreateAgentDeps): Promise<ControlledAgent>;
```

### 4.4 宿主与花名册

```ts
export interface HostOptions {
  /** 花名册：agent 只能从这里挑选成员，不能自己设计。一个成员可起多个分身 */
  members?: Record<string, MemberSpec>;
  maxAgents?: number;                     // 全生命周期分身总数上限（默认 16）
  maxDepth?: number;                      // 分身层数上限，顶层 agent 为第 0 层（默认 2）
  budgetTokens?: number;                  // 全宿主累计 token 上限
  modelRuntime?: ModelRuntime;
  /** 所有成员的基线，被成员定义覆盖 */
  defaults?: Partial<MemberSpec>;
}

export interface AgentHost {
  readonly usage: Usage;                  // 全宿主累计
  readonly activeCount: number;
  readonly maxAgents: number;
  readonly maxDepth: number;
  readonly budgetTokens: number | undefined;

  list(): ControlledAgent[];              // 仅未回收的分身
  get(id: string): ControlledAgent | undefined;
  /** 级联回收所有分身 */
  dispose(): void;
}

export function createAgentHost(opts?: HostOptions): AgentHost;
```

**配置优先级**：成员定义（或顶层 `spec`）> `host.defaults`。

### 4.5 示例工具：`spawn_agent`

```
spawn_agent({ member: "reviewer", task: "审查 src/foo.ts" })
  -> { agentId: "a3", text: "..." }
```

工具的两个必做细节：

1. **`member` 参数用枚举约束**，取值只能是花名册里的成员名（TypeBox 的字面量联合）。模型在类型层面就无法请求不存在的成员；运行时仍要再校验一次。
2. **工具描述动态生成**，逐条列出花名册成员名 + 各自的 `description`。不这么做，agent 根本无从"挑选"。

语义：为指定成员起一个**新分身**，跑完 task，把分身 id 与最终文本返回给父 agent。分身**保留在宿主中可寻址**（阶段 2 的消息与聚合需要它），由 `host.dispose()` 统一回收。

返回值落地形式：工具结果的 `content` 是文本（把 `agentId` 写进自然语言里，父 agent 能读到），`details` 里放结构化的 `{ agentId }` 供库自己使用。

**没有 `tools` 参数，也不接受任何配置覆盖。** 类成员配置只能由花名册决定。

硬性护栏（缺一不可，否则一个 agent 能在循环里把自己复制到烧光额度），按顺序检查：

1. 成员名不在花名册 → 错误结果
2. 深度超过 `maxDepth` → 错误结果
3. 宿主累计分身数超过 `maxAgents` → 错误结果
4. 宿主累计 token 超过 `budgetTokens` → 错误结果

护栏触发时把错误信息作为**工具结果文本**返回给父 agent（而不是抛异常），让父 agent 有机会改用别的策略。

## 5. 关键实现决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 自己构造 `DefaultResourceLoader`，用 `skillsOverride` / `extensionFactories` / `additionalExtensionPaths` / `systemPromptOverride` / `agentsFilesOverride` **显式注入**，不依赖磁盘发现 | 非交互模式下项目级 `.pi/skills`、`.pi/extensions` 在 `defaultProjectTrust: "ask"` 时会被**静默忽略**。这是最大的坑 |
| 2 | skill 名字解析：先建 `DefaultResourceLoader` + `reload()`，用 `getSkills()` 做名字→Skill 映射；找不到**抛错** | 同上教训。静默降级会让运行时行为不可预测 |
| 3 | 模型解析直接用导出的 `resolveCliModel({ cliModel, modelRuntime })` | 已支持 `provider/id:thinking` 语法，不自造 |
| 4 | `tools` 白名单**无条件**并入 customTools 与扩展注册的工具名（要剔除请用 `excludeTools`） | 文档要求工具名必须一起列进 `tools`，漏了就静默不生效 |
| 5 | `RunResult.error` 显式暴露 | pi 的 `prompt()` 在**接受后**失败是通过事件流报告的，不 reject。不暴露的话调用方会误判成功 |
| 6 | `RunResult.usage` = 本次运行；`ControlledAgent.usage` = 全生命周期累计 | 两者都叫 usage 极易误用，必须在类型注释与文档里写死语义 |
| 7 | 事件归一化只对外暴露 7 个 + `session` 逃生口；载荷用 `AgentEventMap` 收窄 | 全透传等于没封装；`unknown` 会逼用户到处 cast |
| 8 | `ModelRuntime` 由宿主持单例、可注入 | 每 agent 一个会重复读盘并重复刷新模型目录 |
| 9 | `agentDir` 默认宿主级共享 | 每 agent 一个会让 `auth.json` 凭证需要重复配置 |
| 10 | `onToolCall` 实现为动态生成的扩展工厂：`extensionFactories: [pi => pi.on("tool_call", …)]` | 这是 pi 拦截工具调用的标准做法，返回 `{ block: true, reason }` |
| 11 | 工具是工厂式（接受 `ctx`），静态对象也支持 | 挑选型工具必须拿到调用者上下文；简单工具不必被强迫包一层 |
| 12 | 工具工厂的 `ctx` **惰性求值**：`customTools` 在 `createAgentSession` 时就交给 SDK，而 `ControlledAgent` 那时尚未构造完成 | 工厂若在构造期被调用，`ctx.agent` 会是 undefined。用可变 holder，首次 `execute` 时解析 |
| 13 | `host.defaults` 是所有成员的基线，被成员定义覆盖 | 避免「默认值只管子 agent」这种需要读源码才能明白的语义 |
| 14 | 深度由 `parent` 链推出，不作为参数传入 | 可被伪造的参数等于没有护栏 |
| 15 | 分身在 `spawn_agent` 返回后**保留**在宿主中 | 阶段 2 的 `send_message(id)` / `wait_agents(ids)` / 聚合都需要 id 与存活实例。若此时丢弃，阶段 2 必须改工具契约 |
| 16 | `spawn_agent` 的 `member` 用枚举约束 + 描述动态列出花名册 | 模型在类型层面就无法请求不存在的成员，也无从挑选如果它不知道有哪些成员 |
| 17 | 依赖版本固定为 `@earendil-works/pi-coding-agent@0.84.2` | 本规格所有 API 均针对该版本核对；npm 上已有更新版本，升级是独立任务，需重新核对 API |

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
      host.ts             # createAgentHost + 花名册 + 护栏 + 回收
    tools/
      define-agent-tool.ts
      spawn-agent.ts      # 示例工具：挑选成员 + 派活
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

1. 配置收敛：工具白名单自动合并、skill 名字找不到抛错、`role` 生效
2. 事件归一化：text / tool_start / tool_end / turn / done 的顺序与载荷
3. `RunResult.error` 在假 provider 返回错误时被填充（决策 #5 的回归测试）
4. `RunResult.usage` 是本次用量、`agent.usage` 是累计（决策 #6 的回归测试）
5. 生命周期：`abort` 后 status 正确、`dispose` 后调用抛错
6. **花名册**：`spawn_agent` 的描述里列出了全部成员；请求不存在的成员被拒
7. **分身**：同一成员起两个分身，各自独立（各自的 messages / usage 不串）
8. **三道护栏**：深度、总数、预算超限各自返回错误结果而非崩溃
9. **回收**：`host.dispose()` 后 `list()` 为空，且分身的 status 为 `disposed`
10. 工厂式工具能拿到正确的 `ctx.agent` 与 `ctx.host`
11. `onToolCall` 返回 block 时对应工具确实没执行

`demo/demo.ts`：真模型 + 一张两三个成员的花名册，顶层 agent 挑选成员派活，人工跑一次确认端到端。

## 8. 验收标准

1. `npm test` 全绿，且**不产生任何真实 API 调用**
2. `tsc --noEmit` 无错误
3. 用一份 `AgentSpec` 能起两个配置不同的 agent（不同 tools / role / model），行为差异可观测
4. 设计者声明的花名册能约束 agent 只能挑选、不能自造
5. 同一成员能起多个互不干扰的分身
6. `host.dispose()` 能级联回收干净
7. 三道护栏有独立测试且都通过
8. `spawn_agent` 在 demo 中真实跑通一次

## 9. 风险

| 风险 | 处理 |
|---|---|
| pi SDK 迭代快，API 可能变动 | 版本固定（决策 #17）+ 升级需重新核对 API |
| 假 provider 的 `streamSimple` 实现细节多（事件序列、toolCall JSON 累积） | 本阶段最大实现工作量；先做最小 text-only 版本，toolCall 支持按需加 |
| 同进程多 agent 的并发与资源上限（进程/cpu/网络） | 阶段 2 的并发闸门负责。阶段 1 的 `spawn_agent` 是同步的，但 pi 会并发执行同一消息里的兄弟工具调用 → 实际可能出现并发分身，由 `maxAgents` 兜住 |
| 分身保留会累积内存 | `maxAgents` 封顶 + `host.dispose()` 回收 |
| 成本 | 阶段 1 只用假 provider 测试；`budgetTokens` 护栏已就位，阶段 2 落地为硬闸门 |

### 已定

- 包名 `aiteam`，`src/index.ts` 统一导出；不发布，无需考虑语义化版本与 subpath exports
- `createAgentHost` 公开导出：用户必须自己创建它才能注入 `createAgent` 的 `deps`。`spawn_agent` 工具的注入是自动的（当 `spec.tools` 含 `spawn_agent` 时）
- `host` 上的计数与用量为**只读访问器**；刻意不提供 `host.createAgent()`，避免出现两条创建路径
