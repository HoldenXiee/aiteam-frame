# aiteam —— Agent 操控库设计

- 状态：现行（本文是**唯一**的宏观设计源）
- 日期：2026-10-01

---

## 0. 定位

aiteam 是一个 **Agent 操控库**。它非常基础、非常底层：**给设计者的代码一双手，去创建、配置、驱动、观测 agent。**

它基于 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，是 SDK 上面薄薄的一层，不是 agent 框架的替代品。

操控面的例子（方向示意，不是全部）：控制 agent 的**上下文**、控制 agent 的**输入输出流向**。

库本身不规定使用者拿它做什么。它是一个以研究为目的的项目，但**研究取向不构成库的设计约束**——库只负责把操控能力做实。

## 1. 核心模型

| 概念 | 含义 | 谁能定义 |
|---|---|---|
| **成员（Member）** | 一种预定义好的 agent 类型：职责、技能、插件、工具集、模型 | **只有设计者**（写代码的人） |
| **分身（Instance）** | 某个成员的一个运行实例。同一成员可有多个分身 | 由 agent 在运行时启动 |
| **花名册（members）** | 设计者声明的全部成员 | 设计者 |

## 2. 红线

**agent 不能设计、不能配置 agent。**

它唯一能做的两件事是：**从花名册里挑一个成员**、**告诉它要干什么**。连「收窄工具集」这种小自由都不给——那已经是变相的自己设计 agent。

好处是双向的：agent 没有提权面（无法指定 `cwd` / `agentDir` / `extensions`，也就无法让子 agent 加载任意代码或换用贵模型）；而设计者的灵活性不受损——想加一种新 agent，就在花名册里加一个成员。

落到代码上：`spawn_agent` 工具**没有** `tools` 参数，也不接受任何配置覆盖。

## 3. 操控面：理想与现状

一个 agent 身上所有可被设计者用代码操控的地方，逐面列出**理想状态**与**当前状态**。

| 操控面 | 理想 | 现状 |
|---|---|---|
| **身份与归属** | 归属完整可视；能从 agent 反查它的配置；能导出拓扑 | `id` / `parentId` / `member` 可读；深度由 `parent` 链推出。无配置回读，无拓扑导出 |
| **上下文** | 读、裁剪、替换；压缩可配、可见；超限可恢复 | `session.messages` 可读（逃生口）。压缩**不可配置**（`SettingsManager.inMemory({})`）、**不可见**（`compaction_*` 事件被丢弃）、摘要 token **不计入 usage**。上下文超限后分身**永久静默返回空**（`{error:null, text:"", usage:0}`、`status` 停在 `idle`），除 `dispose` 外无恢复手段。被 `abort` 的轮次留下 user 消息永久占上下文 |
| **输入流向** | 何时投、投给谁、排队还是打断，都可控 | `prompt` / `send` / `steer` / `waitForIdle`。`send` 忙时排队且**永不抛错**，忙闲判据同时看自维护的 `running` 计数与 `isStreaming`。`send_message` 只能投给**自己的后代**。无超时，无等答复（`ask`）。预算耗尽后 `send` 仍返回 `{delivered:"ran"}` 而一个字没跑 |
| **输出流向** | 结果与**这一次调用**绑定；产出可路由 | `RunResult { text, usage, error? }` + `agent.lastResult`。`collectRun()` 排干共享消息池取**最后一条** assistant 消息 → 重叠投递时结果**串台**（per-call 用量随之错，三方累计值仍对，所以对账查不出）。无结构化输出契约 |
| **生命周期** | 起、停、回收、复活；子树级回收；配额随回收返还 | `createAgent` / `prompt` / `abort` / `dispose` / `waitForIdle`；`dispose` 在跑着时先 `abort` 等 settle 再真回收；`host.dispose()` 级联。`maxAgents` 是**终身累计**，回收不还；中间层 `dispose` 留孤儿，祖先对真后代的投递会被拒且理由是错的 |
| **工具集** | 精确裁剪与注入；工具结果可拦截 | `tools` 白名单（`[]` = 一个都不给）、`excludeTools`、`customTools`（静态对象或工厂）、`onToolCall` 审批门。非空白名单会**强制并入** customTools 与设计者声明的扩展工具名（关不掉，只能 `excludeTools`）。`tools` 写错一字符会静默塌成 `[]` |
| **模型** | 按 agent 指定、运行中可换、可调采样参数 | `model`（`"provider/id:thinking"`）、`thinking`；`resolveCliModel` 的 warning 被转成抛错。**无** temperature / top_p / seed（SDK 层可达，库未接）。非枚举的 `thinking` 值静默回落 |
| **技能与插件** | 按 agent 精确注入；加载失败可观测 | `skills`（名字 / 目录 / `SKILL.md` 路径 / `Skill` 对象）与 `extensions`（路径 / 内联工厂）；技能名字解析失败**抛错**。扩展加载失败**静默**（原因在 `loader.getExtensions().errors`，库不读）；环境里自动发现的扩展**不受** `tools` 白名单管辖，其钩子照样生效 |
| **角色与提示词** | 追加、替换、覆写 | `role` → `appendSystemPrompt`（保留 pi 默认提示词，追加在 `<tools>` 之后）。无整体替换入口 |
| **权限与审批** | 拦截、放行、可观测 | `onToolCall` 实现为动态扩展工厂，返回 `{ block: true, reason }`。键名大小写写错 → 门**完全不生效且零信号**；门内 `throw` = 无条件拦截且异常文本进上下文；拦截与「工具自身报错」在库层面同形（都只是 `tool_end.isError`） |
| **成本与配额** | 按分支归因；硬天花板；超支有出口 | `agent.usage` 累计、`RunResult.usage` 本次、`host.usage` 全宿主；三方对账差额 **0**。护栏是 `maxDepth` / `maxAgents` / `budgetTokens` 三道。但预算是**轮前软约束**：单轮不封顶，忙时 `followUp` / `steer` 完全绕过（实测击穿 5.0×）。被 `abort` 的轮次 usage 记 0 但请求真实计费 |
| **观测** | 事件全覆盖、载荷可序列化 | 7 个归一化事件（`text` / `thinking` / `tool_start` / `tool_end` / `turn` / `error` / `done`）+ 3 个宿主事件（`agent_created` / `agent_disposed` / `round_completed`）+ `session` 逃生口。忙时 `prompt()` 抛错且**不发任何事件**；事件载荷 `JSON.stringify` 会抛 `Theme not initialized` |

## 4. 对外接口

```ts
createAgent(spec: AgentSpec, deps?: CreateAgentDeps): Promise<ControlledAgent>
createAgentHost(opts?: HostOptions): AgentHost
defineAgentTool(def): AgentToolFactory
```

### 4.1 成员与实例

```ts
/** 成员定义：设计者写的，agent 不可改 */
export interface MemberSpec {
  /** 给 agent 看的职责说明，会出现在 spawn_agent 的工具描述里 */
  description?: string;
  cwd?: string;
  /** 默认宿主级共享。另开会换掉这一份 models.json / auth.json */
  agentDir?: string;
  /** 角色说明 → appendSystemPrompt */
  role?: string;
  /** 名字或 SKILL.md 路径；Skill 对象必须指向真实存在的文件 */
  skills?: (string | Skill)[];
  extensions?: (string | InlineExtension)[];
  /** 白名单。非空时并入 customTools 与设计者声明的扩展工具名；`[]` = 一个工具都不给 */
  tools?: string[];
  excludeTools?: string[];
  customTools?: AgentTool[];
  /** "provider/id:thinking" */
  model?: string;
  thinking?: ThinkingLevel;
  /** 审批门 */
  onToolCall?: ToolGate;
}

/** 实例规格 = 成员定义 + 身份 */
export interface AgentSpec extends MemberSpec {
  id?: string;   // 不填则自动生成
}
```

配置优先级：`host.defaults` ← `members[x]` ← 顶层 `spec`，**浅合并覆盖**（数组整体替换，不拼接）。

### 4.2 单个 agent

```ts
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

  /** 顶层交办，返回本轮结果 */
  prompt(text: string, opts?: PromptOpts): Promise<RunResult>;
  /** 投递一条消息。目标忙时排队，永不抛错 */
  send(text: string, opts?: SendOpts): Promise<SendResult>;
  /** 运行中插话 */
  steer(text: string): Promise<void>;
  /** 等它不再运行 */
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  on<E extends AgentEventName>(event: E, fn: (payload: AgentEventMap[E]) => void): () => void;
  dispose(): void;
}

export interface RunResult {
  text: string;
  usage: Usage;      // 本次运行；agent.usage 是全生命周期累计
  error?: string;    // pi 的 prompt() 接受后失败不 reject，必须显式暴露
}

export interface SendResult {
  delivered: "ran" | "queued";
}
export interface SendOpts {
  mode?: "next" | "interrupt";
}

export interface AgentEventMap {
  text:       { delta: string };
  thinking:   { delta: string };
  tool_start: { toolName: string; callId: string };
  tool_end:   { toolName: string; callId: string; isError: boolean };
  turn:       { message: AgentMessage; usage: Usage };
  error:      { message: string };
  done:       { usage: Usage };
}
```

### 4.3 宿主与花名册

```ts
export interface HostOptions {
  /** 花名册：agent 只能从这里挑人 */
  members?: Record<string, MemberSpec>;
  maxAgents?: number;      // 全生命周期分身总数上限，默认 16
  maxDepth?: number;       // 分身层数上限，顶层为第 0 层，默认 2
  budgetTokens?: number;   // 全宿主累计 token 上限
  modelRuntime?: ModelRuntime;
  /** 所有成员的基线，被成员定义覆盖 */
  defaults?: Partial<MemberSpec>;
}

export interface AgentHost {
  readonly usage: Usage;                    // 全宿主累计
  readonly activeCount: number;
  readonly maxAgents: number;
  readonly maxDepth: number;
  readonly budgetTokens: number | undefined;

  list(): ControlledAgent[];                // 仅未回收的分身
  get(id: string): ControlledAgent | undefined;
  on<E extends keyof HostEventMap>(event: E, fn: (payload: HostEventMap[E]) => void): () => void;
  dispose(): void;                          // 级联回收所有分身
}

/** 库只发射事件，不内置任何监控策略 */
export interface HostEventMap {
  agent_created:   { agent: ControlledAgent; member: string | undefined; parent: ControlledAgent | undefined };
  agent_disposed:  { agent: ControlledAgent };
  round_completed: { agent: ControlledAgent; result: RunResult };
}
```

宿主上的计数与用量是**只读访问器**。刻意**不提供** `host.createAgent()`——避免出现第二条创建路径。

### 4.4 工具地基

```ts
export interface AgentToolContext {
  /** 谁在调用。挑选型工具必须知道自己是谁 */
  agent: ControlledAgent;
  signal?: AbortSignal;
  /** 能力注入点：花名册、寻址、消息等从这里接 */
  host?: AgentHost;
}

/** 工厂式：需要上下文的工具走这里 */
export type AgentToolFactory = (ctx: AgentToolContext) => ToolDefinition;
/** 静态式：无上下文依赖的简单工具 */
export type AgentTool = ToolDefinition | AgentToolFactory;

export function defineAgentTool<P extends TSchema>(def: AgentToolDef<P>): AgentToolFactory;
```

工具工厂在 `createAgent` 期间被调用一次（模型得先看到 `name` / `parameters`），但 `ctx.agent` 是**惰性**的——只有 `execute` 时才取得到持有它的那个 agent。这是必需而非优化：SDK 传给工具 `execute` 的 `ctx` 是 `ExtensionToolContext`，**不含当前 agent 引用**。

### 4.5 库自带的两个能力工具

由 `spec.tools` 里的名字控制启用。

```ts
spawn_agent({ member: "reviewer", task: "审查 src/foo.ts" })
  -> 文本里带 agentId + 分身的最终文本

send_message({ agentId: "a3", message: "把结论写成 md" })
  -> "已投递：当时空闲，已开始处理" | "已投递：正忙，已排队"
```

`spawn_agent`：从花名册挑一个成员 → 起新分身 → 派活 → 等它做完 → 拿回结论。`member` 用 TypeBox 字面量联合约束，**工具描述动态列出花名册全部成员 + 各自 `description`**——不这么做，agent 无从「挑选」。分身跑完后**保留**在宿主中可寻址。

`send_message`：只准投给**自己的后代分身**（自己创建的及它们的后代）。三个收益：防跨分支干扰；后代关系是树，禁止反向投递就**免费消灭发送环**；与实际信息一致（agent 本来也只知道自己创建的 id）。

## 5. 实现约定

- **分层**：`L0` pi SDK（不动）→ `L1` 本库（配置收敛、事件归一、用量统计、护栏）。**L1 不做任何 SDK 已经做了的事。**
- **唯一创建入口**：`createAgent(spec, deps?)`。`host` 只在需要花名册/护栏时通过 `deps` 注入；单 agent 场景完全不需要它。
- **类型复用**：`Skill` / `ToolDefinition` / `AgentSession` / `AgentMessage` / `Usage` / `ThinkingLevel` 一律从 pi 的包直接 import，**不自己重定义**。
- **会话**：目前一律 in-memory（`SessionManager.inMemory`），不提供磁盘会话。
- **依赖**：固定 `@earendil-works/pi-coding-agent@0.99.1`。`typebox` 与 `@earendil-works/pi-ai` 必须**显式声明**——它们只是嵌套依赖，从项目根不可解析。

## 6. 不承诺

pi **没有内置沙箱**。`tools` 白名单只是工具集裁剪，扩展（尤其是环境里自动发现的扩展）与 `bash` 可以绕过它。真正的隔离只能靠容器 / VM。

本库提供的是**能力裁剪 + 审批门**，**不是安全边界**。不要把它当权限系统宣传。

当前明确不做：配置 DSL / YAML 解析器、TUI、沙箱、集群持久化与恢复、磁盘会话。

## 7. 仓库地图

```
src/agent/
  create-agent.ts   spec → ControlledAgent（生命周期、事件订阅、用量、工具接线、审批门）
  host.ts           createAgentHost + 花名册 + 三道护栏 + 宿主事件 + 级联回收
  loader.ts         skills / extensions / role 的配置收敛
  events.ts         pi 的 20+ 事件 → 7 个归一化事件（纯映射）
  usage.ts          用量累加
  types.ts          全部对外类型（无运行时代码）
src/tools/
  define-agent-tool.ts   工厂式工具地基 + 调用者上下文注入
  spawn-agent.ts         挑成员 + 派活 + 拿结果
  send-message.ts        给后代分身追加消息
test/              node:test，全部走本机假 provider，零 API 成本
audit/             能力与极限审计的探测脚本与发现（证据链）
demo/              真模型多轮协作 demo
docs/
  DESIGN.md        本文（唯一的宏观设计源）
  FACTS.md         已实测核对的实现决策
  research/        能力与极限审计的最终报告 · 研究问题清单
```

## 附录 A：集群形态清单

以下形态列出来是为了看原语够不够用。前 10 个都能**用库的原语表达**（库不为任何形态写代码——它只提供原语）；第 11 个当前表达不了。

两条路径都能走，可混用：

- **A 路：设计者写代码搭拓扑** —— `createAgent` + `prompt` + `send` + `waitForIdle` + `host`
- **B 路：agent 用工具自己组队** —— `spawn_agent` + `send_message`

| # | 形态 | 怎么表达 | 路 |
|---|---|---|---|
| 1 | 单 agent | `createAgent` | A |
| 2 | 并行扇出 | 一条 assistant 消息里发多个 `spawn_agent`（pi 并发执行兄弟工具调用） | A/B |
| 3 | 流水线 | `const r = await a.prompt(x); await b.prompt(r.text)` | A |
| 4 | 监督者 + 工人池 | 设计者起 manager；manager 用 `spawn_agent` 派活，分身复用靠 `send_message` | B |
| 5 | 团队内部探讨直到收敛 | 主持人 spawn 成员拿回观点 → `send_message` 转发他人观点 → 循环，直到主持人自己判断收敛 | B |
| 6 | 两团队争辩 + 裁决 | 顶层挑两个主持人各自组队（各自子树）→ 顶层在两者之间转发 → 最后挑 judge 成员裁决 | B |
| 7 | 共享黑板式协作 | 全队 `MemberSpec.cwd` 指向同一目录，成员读写同一个文件 | A/B |
| 8 | 竞标 / 择优 | 同一任务扇出给多个成员，顶层或 judge 成员选优 | A/B |
| 9 | 反思-修订循环 | 写手与审阅者两个分身，靠 `send_message` 反复复用，直到审阅者说通过 | A/B |
| 10 | 层级汇报（逐层汇聚） | 每个主持人先汇总队员结论再上报；同步 `spawn_agent` 的返回值天然支持 | B |
| 11 | 长跑监督 | agent 长期存活、被消息唤醒 —— **当前原语表达不了**，缺一个 `waiting` 状态与唤醒后的结果回收 | — |

两个已验证的结论：

1. **「`send_message` 只给后代投递」不妨碍以上任何一种形态。** 形态 5/6 的本质都是「主持人持有全局状态并转发」，成员只需回应主持人。被挡住的只有**无人主持的对等闲聊**。
2. **共享上下文不需要框架支持。** 全队同一个 `cwd`，成员读写同一个文件就是黑板。刻意不做共享内存 / 共享 session——那会把「每个 agent 上下文隔离」的优势翻转成劣势。
