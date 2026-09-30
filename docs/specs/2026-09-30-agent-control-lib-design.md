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

**成功标准**：设计者能声明一张花名册；起一个顶层 agent；该 agent 能通过 `spawn_agent` 挑选成员、派活、拿到结果，并能通过 `send_message` 给已有分身继续交办；同一成员能起多个互不干扰的分身；所有分身都受深度、数量、预算三道护栏约束；设计者代码也能直接把一个 agent 的输出喂给另一个 agent。

## 2. 范围

### 做

| 能力 | 内容 |
|---|---|
| `createAgent(spec)` | 独立 skills / 扩展 / 工具 / 角色 / 模型 / cwd |
| `createAgentHost({ members })` | 花名册 + 共享资源 + 护栏计数 |
| 事件归一化 | pi 的 20+ 事件收敛成 7 个，保留原始 `session` 逃生口 |
| 生命周期 | `prompt` / `steer` / `send` / `abort` / `dispose` / `waitForIdle` + `status` / `isStreaming` |
| **投递原语** | 给一个 agent 发消息（忙时排队，**永不抛错**）；支持「等它做完」与「打断它」两种模式 |
| **宿主观测事件** | `agent_created` / `agent_disposed` / `round_completed` + `agent.lastResult`；库只发射事件，不固化任何监控策略 |
| 用量统计 | 每次运行的用量 + 累计用量 |
| **自定义工具地基** | 工厂式工具定义 + 调用者上下文 + 显式依赖注入 |
| **能力工具** | `spawn_agent`（挑成员 + 派活 + 拿结果）与 `send_message`（给已有分身追加消息）；两条地基都被真工具验证过 |

### 不做（YAGNI）

配置 DSL / YAML 解析器、TUI、沙箱、集群持久化与恢复、磁盘会话。

### 不做（留阶段 2，本规格只留接缝）

**工具形式**的寻址与批量编排：`list_agents` / `wait_agents` / `stop_agent` / `ask_agent` 工具、agent 间消息总线。宿主内部保留最小寻址能力（`host.list()` / `host.get()`）作为接缝。

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
  role?: string;                          // → appendSystemPrompt（决策 #25）
  /** 名字或 SKILL.md 路径。Skill 对象必须指向真实存在的文件（决策 #27）；名字解析失败必须抛错 */
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
  /**
   * 投递一条消息给这个 agent。目标忙时排队，**永不抛错**
   * （pi 的 prompt() 在目标 streaming 时会直接抛错，这里是必须补的那一层）
   */
  send(text: string, opts?: SendOpts): Promise<SendResult>;
  steer(text: string): Promise<void>;
  /** 等该 agent 不再运行。阶段 2 的等待与结果聚合全建在它上面 */
  waitForIdle(): Promise<void>;
  /** 最近一次跑完的结果；从未跑过则为 undefined */
  readonly lastResult: RunResult | undefined;
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
  /** 观测机制：库只发射事件，不内置任何监控策略 */
  on<E extends keyof HostEventMap>(event: E, fn: (payload: HostEventMap[E]) => void): () => void;
  /** 级联回收所有分身 */
  dispose(): void;
}

/** 宿主级事件。设计者靠它实现轮次督导、成本监控、进度上报等一切策略 */
export interface HostEventMap {
  agent_created:   { agent: ControlledAgent; member: string | undefined; parent: ControlledAgent | undefined };
  agent_disposed:  { agent: ControlledAgent };
  /** 一个分身被交办并跑完一轮（prompt 或已投递的 send） */
  round_completed: { agent: ControlledAgent; result: RunResult };
}

export function createAgentHost(opts?: HostOptions): AgentHost;
```

**配置优先级**：成员定义（或顶层 `spec`）> `host.defaults`。

### 4.5 能力工具

阶段 1 提供两个工具：`spawn_agent`（验证 spawn 地基）与 `send_message`（验证投递地基）。两者都由 `spec.tools` 里的名字控制是否启用。

#### `spawn_agent`

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

#### `send_message`

```
send_message({ agentId: "a3", message: "把刚才的结论写成 md" })
  -> "已投递（目标空闲，已开始处理）" | "已排队（目标正在忙）" | 错误文本
```

给一个已存在的分身追加消息。`agentId` 来自此前 `spawn_agent` 的返回文本。

**只能投递给自己的后代分身**（自己创建的分身，以及它们的后代）。这不是额外限制，而是三个收益：

1. 防干扰：A 无法插手 B 那边正在跑的工作
2. **免费消灭一类死锁**：后代关系是一棵树，禁止反向投递就切断了发送环
3. 与实际信息一致：阶段 1 agent 本来也只知道自己创建的那些 id（没有 `list_agents`）

跨分支的对等交流留到阶段 2，届时才需要配护栏。

## 5. 关键实现决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 自己构造 `DefaultResourceLoader`，用 `additionalSkillPaths` / `extensionFactories` / `additionalExtensionPaths` / `appendSystemPrompt` / `agentsFilesOverride` **显式注入**，不依赖磁盘发现 | 理由不是「绕开 trust」（探路证伪：SDK 路径下 `projectTrusted` 默认就是 `true`，项目资源正常加载），而是**确定性**：注入什么就是什么，不受磁盘布局与 cwd 影响 |
| 2 | skill 名字解析：建 `DefaultResourceLoader` + `reload()`，用 `getSkills().skills` 做名字→Skill 映射；找不到**抛错** | 静默降级会让运行时行为不可预测。注意 0.99.1 的 `getSkills()` 返回 `{ skills, diagnostics }` 而**不是**数组 |
| 3 | 模型解析直接用导出的 `resolveCliModel({ cliModel, modelRuntime })` | 已支持 `provider/id:thinking` 语法，不自造。**但它对不存在的模型只给 warning 不报错**，库必须自己判 warning（见决策 #28） |
| 4 | 仅当 `spec` 提供了 `tools` 时才把 customTools 与扩展工具名并入白名单 | 探路实测：不传 `tools` 时 customTools 自动生效；传了 `tools` 就必须把 customTools 名列进去，否则它静默不生效 |
| 5 | `RunResult.error` 显式暴露 | pi 的 `prompt()` 在**接受后**失败是通过事件流报告的，不 reject。不暴露的话调用方会误判成功 |
| 6 | `RunResult.usage` = 本次运行；`ControlledAgent.usage` = 全生命周期累计 | 两者都叫 usage 极易误用，必须在类型注释与文档里写死语义 |
| 7 | 事件归一化只对外暴露 7 个 + `session` 逃生口；载荷用 `AgentEventMap` 收窄 | 全透传等于没封装；`unknown` 会逼用户到处 cast |
| 8 | `ModelRuntime` 由宿主持单例、可注入 | 每 agent 一个会重复读盘并重复刷新模型目录 |
| 9 | `agentDir` 默认宿主级共享 | 每 agent 一个会让 `auth.json` 凭证需要重复配置 |
| 10 | `onToolCall` 实现为动态生成的扩展工厂：`extensionFactories: [pi => pi.on("tool_call", …)]` | 这是 pi 拦截工具调用的标准做法，返回 `{ block: true, reason }` |
| 11 | 工具是工厂式（接受 `ctx`），静态对象也支持 | 挑选型工具必须拿到调用者上下文；简单工具不必被强迫包一层 |
| 12 | 工具工厂的 `ctx` **惰性求值**：`customTools` 在 `createAgentSession` 时就交给 SDK，而 `ControlledAgent` 那时尚未构造完成 | 探路实测：工具 `execute` 拿到的 `ctx` 是 SDK 的 `ExtensionToolContext`，**不含当前 agent 引用**。所以库必须自己用可变 holder 注入，这不是优化而是必需 |
| 13 | `host.defaults` 是所有成员的基线，被成员定义覆盖 | 避免「默认值只管子 agent」这种需要读源码才能明白的语义 |
| 14 | 深度由 `parent` 链推出，不作为参数传入 | 可被伪造的参数等于没有护栏 |
| 15 | 分身在 `spawn_agent` 返回后**保留**在宿主中 | 阶段 2 的 `send_message(id)` / `wait_agents(ids)` / 聚合都需要 id 与存活实例。若此时丢弃，阶段 2 必须改工具契约 |
| 16 | `spawn_agent` 的 `member` 用枚举约束 + 描述动态列出花名册 | 模型在类型层面就无法请求不存在的成员，也无从挑选如果它不知道有哪些成员 |
| 17 | 依赖版本固定为 `@earendil-works/pi-coding-agent@0.99.1` | 本规格所有 API 与决策均针对该版本**实跑核对过**（7 个探针全绿）。已知与 0.84.2 文档的漂移见第 11 节 |
| 18 | **`send()` 是必需的一层，不是便利方法** | pi 的 `prompt()` 在目标 streaming 且无 `streamingBehavior` 时**直接抛错**。团队交流里目标正忙是常态，不补这层，阶段 2 的消息功能一写就崩 |
| 19 | `send()` 忙时用 `followUp`（mode `next`）/ `steer`（mode `interrupt`）排队，空闲时直接 `prompt` | 投递者不应被迫关心目标当前是否在忙。探路已核实空闲 `steer` 的危害，见决策 #26 |
| 20 | `send_message` 只能投递给**自己的后代分身** | 防跨分支干扰；同时因为后代关系是树，禁止反向投递就免费消灭了发送环 |
| 21 | `waitForIdle()` 包裹 `session.agent.waitForIdle()`，且已 `dispose` 时直接 resolve | 阶段 2 不该为了等待穿到逃生口；已回收的 agent 永远“已静下来” |
| 22 | **宿主只提供机制，不固化策略**：发射 `agent_created` / `agent_disposed` / `round_completed`，但**不内置**轮次上限或督导逻辑 | B 路（agent 自己组织循环）下设计者看不到循环体，**不给观測就是瞎的**。但轮次督导只是众多监控需求中的一种，写进 L1 既伤灵活性又多写代码。开箱即用的版本做在它之上 |
| 23 | `send()` 不带回复通道，用 `agent.lastResult` 配合 | 带回复的 `send` 就是同步 `ask`，会把死锁引进来。督导等场景只需「投递 → `waitForIdle()` → 读 `lastResult`」 |
| 24 | 不做轮次硬上限 | 「轮次上限 + 督导 agent」是一种可用方案，不是唯一方案。硬上限会阻止合法的长任务；统一由 `budgetTokens` 兑底，需要更早千预时用决策 #22 的事件 |
| 25 | **`role` 用 `appendSystemPrompt` 实现，不用 `systemPrompt` 也不用 `systemPromptOverride`** | 探路实测：`systemPromptOverride(base)` 的 base 是 `systemPrompt` **选项的值**，不是 pi 内置默认提示词；`systemPrompt` 是整体替换，会把 `<tools>` 段一起换掉。`appendSystemPrompt` 保留默认行为，角色说明追加在 `<tools>` 之后、`<available_skills>` 之前 |
| 26 | `send()` 必须自己分派状态：`isStreaming` → `steer`/`followUp`，空闲 → `prompt` | 探路实测：**空闲时 `steer()` 不抛错但静默丢弃消息**（请求数不变）；忙时 `prompt()` 抛错并要求 `streamingBehavior`。若 `send()` 直映到 `steer()`，空闲时的消息会被无声吞掉 |
| 27 | `skills` 里的 `Skill` 对象必须指向**真实存在**的文件 | 探路实测：虚拟 `filePath` 会在 `getDefaultSourceInfoForPath` 里 `ENOENT` 崩掉。按名字解析也必须走磁盘上的真技能 |
| 28 | `resolveCliModel` 返回的 `warning` 必须自己处理，不得忽略 | 探路实测：不存在的模型返回 `model` **仍然有值** + `warning: 'Model "nope" not found ... Using custom model id'`。直接信任 `model` 会把拼写错误变成静默的奇怪行为 |
| 29 | 依赖必须**显式声明**：至少 `@earendil-works/pi-coding-agent` + `typebox`；若要用 `calculateCost` / `Usage` 则还需 `@earendil-works/pi-ai` | 探路实测：三者中只有 pi-coding-agent 是顶层依赖，`typebox` 与 `pi-ai` 都只是它的嵌套依赖，**从项目根不可解析**。不加 `typebox` 连 `defineTool` 都写不出来 |

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
      spawn-agent.ts      # 挑选成员 + 派活
      send-message.ts     # 给已有分身追加消息
  test/
    faux-server.ts        # 本机 HTTP 假 LLM（零成本）
    faux-models.ts        # 写 models.json 并造 ModelRuntime
    *.test.ts
  demo/
    demo.ts               # 真模型端到端
  probe/                  # 探路代码（一次性），可作 test/ 的起点
```

## 7. 测试策略

**零成本确定性测试**（探路已验证可行）：在独立 agentDir 写一份 `models.json`，声明一个 `api: "openai-completions"` 的假 provider，指向一个本机 HTTP 服务；该服务按脚本吐 OpenAI 风格的 SSE chunk。所有断言跑在 `model: "faux/echo"` 上，**不产生任何真实 API 调用**。

可用探针 `probe/` 里的实现作起点（`_support.ts` 的假服务 + `_sdk.ts` 的 `models.json` 写法）—— 探路阶段 7 个探针共约 60 条断言，全程零花费。

脚本约定（写在最后一条 user 消息里）：`[[tool:NAME]]` 发起工具调用、`[[sleep:MS]]` 制造「正忙」窗口、`[[fail]]` 走错误路径。

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
9. **投递**：目标空闲时 `send` 返回 `ran`；目标正在跑时返回 `queued` 且**不抛错**（决策 #18 的回归测试）
10. **投递范围**：`send_message` 给非后代分身被拒
11. **`waitForIdle`**：忙时调用会等到静下来；已 dispose 的分身立即 resolve
12. **回收**：`host.dispose()` 后 `list()` 为空，且分身的 status 为 `disposed`
13. 工厂式工具能拿到正确的 `ctx.agent` 与 `ctx.host`
14. `onToolCall` 返回 block 时对应工具确实没执行
15. **宿主事件**：`agent_created` / `agent_disposed` / `round_completed` 在正确时机各触发一次；已 `dispose` 的分身不再触发
16. **循环督导可建**：基于 `round_completed` 实现的计数器能在第 N 轮准确触发，且 `agent.lastResult` 能拿到督导分身的回复

`demo/demo.ts`：真模型 + 一张两三个成员的花名册，顶层 agent 挑选成员派活、再给同一个分身追加一条消息，人工跑一次确认端到端。

## 8. 验收标准

1. `npm test` 全绿，且**不产生任何真实 API 调用**
2. `tsc --noEmit` 无错误
3. 用一份 `AgentSpec` 能起两个配置不同的 agent（不同 tools / role / model），行为差异可观测
4. 设计者声明的花名册能约束 agent 只能挑选、不能自造
5. 同一成员能起多个互不干扰的分身
6. `host.dispose()` 能级联回收干净
7. 三道护栏有独立测试且都通过
8. 设计者代码能把 A 的输出喂给 B（`b.prompt(r.text)`），且 agent 能通过 `send_message` 给已有分身追加消息
9. `spawn_agent` 与 `send_message` 在 demo 中真实跑通一次
10. **至少一个多轮协作形态**（见第 10 节）在 demo 中真实跑通；其余形态用假 provider 脚本化验证

## 9. 风险

| 风险 | 处理 |
|---|---|
| pi SDK 迭代快，API 可能变动 | 版本固定（决策 #17）为 **0.99.1** 并已实跑核对。已知与 0.84.2 文档的漂移见第 11 节 |
| 假 provider 实现有细节坑 | **已解决**。探路选定「本地 HTTP + models.json」而非 `streamSimple` 扩展，代码少且走真实的 openai-completions 客户端路径，已跑通 |
| 同进程多 agent 的并发与资源上限（进程/cpu/网络） | 阶段 2 的并发闸门负责。阶段 1 的 `spawn_agent` 是同步的，但 pi 会并发执行同一消息里的兄弟工具调用 → 实际可能出现并发分身，由 `maxAgents` 兜住 |
| 分身保留会累积内存 | `maxAgents` 封顶 + `host.dispose()` 回收 |
| 成本 | 阶段 1 只用假 provider 测试；`budgetTokens` 护栏已就位，阶段 2 落地为硬闸门 |
| **死锁**（等待型能力必然引来） | 阶段 1 的 `send` 是**非阻塞**的，本身不产生等待，所以阶段 1 无死锁。预埋规则，避免阶段 2 踩坑：① 后代关系是树 + `send_message` 只能向后代投递 → 切断了发送环；② 阶段 2 的 `ask_agent`（同步等答复）**必须带超时**，且**禁止等待祖先**；③ 任何无超时的等待都是死锁的充分条件，一律不允许 |
| **循环失控**（团队探讨/反思-修订这类多轮形态） | 不做轮次硬上限（会误杀合法长任务），统一由 `budgetTokens` 兑底。需要更早千预时，用宿主事件自己实现督导（见第 10 节），把失控变成一次智能干预而不是硬失败 |

### 已定

- 包名 `aiteam`，`src/index.ts` 统一导出；不发布，无需考虑语义化版本与 subpath exports
- `createAgentHost` 公开导出：用户必须自己创建它才能注入 `createAgent` 的 `deps`。`spawn_agent` 工具的注入是自动的（当 `spec.tools` 含 `spawn_agent` 时）
- `host` 上的计数与用量为**只读访问器**；刻意不提供 `host.createAgent()`，避免出现两条创建路径

## 10. 集群形态：验收「灵活性」的清单

「灵活」不能靠形容词，靠这张表。**每一种形态都必须能用阶段 1 的原语表达**；做不到的，就是 L1 的接缝漏了。

两条路径都能走，且可混用：

| | 路径 | 用什么 |
|---|---|---|
| **A 路：确定性编排** | 设计者写代码搭拓扑，拓扑可复现 | `createAgent` + `prompt` + `send` + `waitForIdle` + `host` |
| **B 路：涌现式自组织** | agent 用工具自己组队，拓扑由 LLM 决定 | `spawn_agent` + `send_message` |

| # | 形态 | 怎么表达 | 路 |
|---|---|---|---|
| 1 | 单 agent | `createAgent` | A |
| 2 | 并行扇出 | 一条 assistant 消息里发多个 `spawn_agent`（pi 并发执行兄弟工具调用） | A/B |
| 3 | 流水线 | `const r = await a.prompt(x); await b.prompt(r.text)` | A |
| 4 | 监督者 + 工人池 | 设计者起 manager；manager 用 `spawn_agent` 派活，分身复用靠 `send_message` | B |
| 5 | **团队内部探讨直到收敛** | 主持人 spawn 成员拿回各自观点 → `send_message` 把他人观点转发给每个成员 → 循环，直到主持人自己判断收敛 | B |
| 6 | **两团队争辩 + 裁决** | 顶层挑两个「主持人」成员各自组队（各自子树）→ 顶层在两者之间转发 → 最后挑 `judge` 成员裁决 | B |
| 7 | 共享黑板式协作 | 全队 `MemberSpec.cwd` 指向同一目录，成员读写同一个 md 文件 | A/B |
| 8 | 竞标/择优 | 同一任务扇出给多个成员，顶层（或一个 `judge` 成员）选优 | A/B |
| 9 | 反思-修订循环 | 写手与审阅者两个分身，靠 `send_message` 反复复用，直到审阅者说通过 | A/B |
| 10 | 层级汇报（逐层汇聚） | 每个主持人先汇总队员结论再上报；同步 `spawn_agent` 的返回值天然支持 | B |
| 11 | 长跑监督 | agent 长期存活、被消息唤醒。需一个新的 `waiting` 状态，**属阶段 2** | — |

### 循环督导：你提的那个机制怎么落

库不实现它，但只靠决策 #22 的宿主事件 + `agent.lastResult`，大约十几行就能写出来：

```ts
const LIMIT = 6, counters = new Map<string, number>();

host.on("round_completed", ({ agent }) => {
  const n = (counters.get(agent.id) ?? 0) + 1;
  counters.set(agent.id, n);
  if (n % LIMIT) return;                       // 每周 LIMIT 轮督导一次
  void (async () => {
    // 「循环任务的目标 + agent 间的对话」：子树内所有分身的 messages
    const transcript = subtreeOf(host, agent).flatMap((a) => a.session.messages);
    await supervisor.send(JSON.stringify({ goal, transcript, round: n }));
    await supervisor.waitForIdle();
    if (supervisor.lastResult) await agent.send(supervisor.lastResult.text);
  })();
});
```

`subtreeOf` 用 `host.list()` + `agent.parentId` 自己走一遍就行，**库不为它加代码**。

### 已验证的两个结论

1. **「`send_message` 只给后代投递」不妨碍以上任何一种形态。** 形态 5 和 6 的本质都是「主持人持有全局状态并转发」，成员只需要回应主持人。被挡住的只有**无人主持的对等闲聊**，而那恰好是最难控制的一种，所以不放宽。若日后确实需要对等交流，才需要配环检测与超时（`send` 非阻塞，本身不构成死锁）。
2. **共享上下文不需要框架支持。** 全队同一个 `cwd`，成员读写同一个文件就是黑板。刻意不做共享内存/共享 session —— 那会把「每个 agent 上下文隔离」的优势翻转成劣势（一个成员的污染传染全队），而且 O(n²) 的 token 成本会失控。

### 怎么验证这张表

- 用例 2/3/7 用假 provider 脚本化，零成本、确定性
- 用例 5 用假 provider 脚本化**多轮**流程（验证主持人能拿到成员观点并转发，且分身能复用）
- 用例 6 用假 provider 脚本化（验证子树嵌套、跨团队转发、护栏不误触发）
- `demo/demo.ts` 用真模型跑**至少一个多轮形态**（建议 5，最便宜）；只跑单轮等于灵活性没被验证

## 11. 探路结论（已实跑核对）

阶段 1 开工前跑了一轮探路，7 个探针全绿（`probe/`，见 `probe/README.md`），**零 API 花费**。以下是已确认的事实，实现时不必重新怀疑。

### 11.1 可行性已成立

| 事项 | 实证结果 |
|---|---|
| 零成本测试 | 本机 HTTP 假 provider + `models.json` 跑通完整 prompt，usage 可读 |
| 多 agent 同进程 | 3 个 session 建了 **16ms**；共享一个 `ModelRuntime` 与 agentDir 无冲突；上下文与 cwd 互不串 |
| 真并发 | 3 个 `sleep 400ms` 的任务并发总耗时 **545ms** |
| 忙时 `prompt()` | 抛错：`Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.` |
| 忙时 `steer()` / `followUp()` | 可排队，不抛错；每条队列消息各自产生一轮 |
| **空闲 `steer()`** | **不抛错，但静默丢弃消息** —— 决策 #26 的依据 |
| `tool_call` 审批门 | 扩展返回 `{ block: true }` 时工具确实未执行 |
| 工具 `execute` 签名 | `(toolCallId, params, signal, onUpdate, ctx)`，`ctx` 是 `ExtensionToolContext`，**不含当前 agent 引用** |
| `resolveCliModel` | 存在，`faux/echo:high` 正常解出模型 + 思考档 |
| 事件覆盖 | `text` / `tool_start` / `tool_end` / `turn` / `done` 都有对应原始事件（`thinking` 需模型支持 reasoning） |

### 11.2 与 0.84.2 文档的漂移（0.99.1 实际）

- `getModel`（pi-ai）与 `openAICompletionsApi` **已不存在**
- `loader.getSkills()` 返回 `{ skills, diagnostics }`，不是数组
- 多出文档没有的事件：`agent_settled`、`message_update.toolcall_start/delta/end`
- `systemPromptOverride(base)` 的 base 是 `systemPrompt` 选项的值，不是内置默认提示词
- `pi-ai` / `pi-agent-core` / `typebox` 是**嵌套依赖，从项目根不可解析**

### 11.3 探路解决掉的风险

- ~~「非交互模式下项目资源被静默跳过」~~ —— **证伪**，`projectTrusted` 默认就是 `true`
- ~~「假 provider 实现细节多」~~ —— 改用本机 HTTP 后代码量很小，且走的是真实客户端路径
- ~~「空闲 `steer` 行为未知」~~ —— 已定性（静默丢消息）

### 11.4 探路**没有**覆盖的（属实现阶段）

- `spawn_agent` 的端到端（需真实 L1 代码）
- 真实模型下多轮 `steer` / `followUp` 的交互与收敛行为
- `session_before_*` 等低频事件的行为
