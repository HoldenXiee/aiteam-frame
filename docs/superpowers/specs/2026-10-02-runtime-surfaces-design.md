# aiteam v2 —— 运行期操控面设计规格

- 状态：**待实现**（本文是 v2 的唯一宏观设计源）
- 日期：2026-10-02（rev.2，含 API review 修订）
- 关系：本规格是 v2 的宏观设计源。v1 的 [`docs/DESIGN.md`](../../DESIGN.md) 归档为历史与对照（`docs/archive/DESIGN-v1.md`），新 `docs/DESIGN.md` 由本规格派生
- 路径：架构级（brainstorming → 本规格 → writing-plans）

---

## 0. 为什么要重构

v1 把**研究假设当成了库的结构**。红线「agent 不能配置 agent」、花名册、委派原语，本身是**待研究的对象**（研究问题清单家族 3 直接问「红线的代价是多少」，家族 1 问「隔离 vs 共享的边界」），却被硬编码进了核心。后果：想做「允许 spawn 时传 tools」这类对照实验，必须改库源码。

新目标是**研究工具**，不是产品。研究工具的核心能力是**让假设可被替换、可被测量**，而不是替研究者选好立场。

还有一条更根本的诊断：**pi 的 `AgentSession` 本来就几乎全是运行期可改的句柄**，v1 却把它拍平成了创建时的一次性参数，再藏在 `session` 逃生口后面。所以「把底层打开」的动作不是加字段，而是**把一次性 spec 变成运行期句柄**。

---

## 1. 定位与不承诺

> aiteam 是一个 **agent 操控库**：给设计者的代码一双手，**在运行期**读、改、拦截一个 agent 的七个面。库不含任何策略。

- **库不含策略**：无花名册、无内置工具、无护栏、无红线、无 agent 寻址机制。
- **不承诺安全边界**：pi 没有内置沙箱；`tools` 白名单只是工具集裁剪，扩展与 `bash` 可以绕过。本库提供的是**能力裁剪 + 拦截**，不是权限系统。

---

## 2. 已定决策

### 2.1 头脑风暴结论

| # | 决策 | 理由 |
|---|---|---|
| D1 | 组织形式为**六面句柄式**（+ 模型 = 七个面） | 句柄是「可替换单元」：做「换掉权限策略」这类对照实验时是传一个对象 |
| D2 | **不做任何寻址机制** | 设计者写代码编排时手里就有 agent 引用，直接 `a.io.queue(…)`。旧库需要寻址只因为第二条路（agent 用工具驱动 agent）拿到的只有字符串 id；该路已砍 |
| D3 | 运行期增删（`tools.add` / `extensions.add` / `skills.add`）走 **`session.reload()` 重载语义** | 已核实 `DefaultResourceLoader.extensionFactories` 是公开字段、`reload()` 会重建工具注册表；代价是重载而非增量，明确标注 |
| D4 | **模型与思考档是第七个面**（`agent.model`） | 它是运行期可换的实验变量（`setModel` / `setThinkingLevel`） |
| D5 | 观测**以原始事件全量透传为主** | 旧库有损归一化丢了 `compaction_*`，压缩对设计者不可见；归一化是用户侧约 10 行，原始透传是用户做不到的 |
| D6 | **工具集裁剪归 `permissions`**，不归 `tools` | 否则 `tools.enable` 与 `permissions.allow` 是同一个东西 |
| D7 | 结算边界 = `agent_start` → `agent_settled` | SDK 明确 `agent_settled` 是「不会再有任何自动重试、压缩、排队续跑」；v1 用「排干共享消息池」是错在这里 |

### 2.2 API review 修订（rev.2）

| # | 决策 | 理由 |
|---|---|---|
| D8 | **spec 与面同形**（按面分组，字段名 = 面的原语名） | 否则 `createAgent` 的字段名与句柄方法名是两套词汇，使用者要背一张对照表 |
| D9 | **handler 的 ctx 原样透传 pi 的 `ExtensionContext`**，只额外挂 `agent` | 该 ctx 里已经有 `signal` / `abort()` / `isIdle()` / `getContextUsage()` / `compact()` / `getSystemPrompt()` / `model` / `cwd`。自造一套等于丢能力 + 多一套词汇 |
| D10 | **删掉 `SurfaceContext`**：工具 ctx = `{ agent, signal }` | 我先前卖的「工具只拿到该管的那一面」是过度设计；能力收窄用一行用户代码（把 `ctx.agent.context` 传给自己工厂）就能做到 |
| D11 | **删掉 `defineAgentTool`**：`tools.add` 接受 `ToolDefinition \| ((ctx: ToolContext) => ToolDefinition)`，用户用 pi 的 `defineTool` 建定义 | pi 包根已导出 `defineTool`（`index.d.ts:9`）；通过**工厂闭包**捕获 `ctx.agent` 就够了，不需要自己的包装器 |
| D12 | **常驻桥接扩展**（见 §3.4） | 让 `add` / `remove` / `gate` 只改内存表 + 一次 reload；并让钩子顺序可控 |
| D13 | `agent.on(event, handler)` 按事件名收窄 + `agent.onAny(handler)`；**不用 `observe(fn)`** | `ExtensionHandler<E,R> = (event, ctx) => R \| void`（`types.d.ts:1134`）——ctx 是必须的；pi 已导出判别联合 `ExtensionEvent`，不必自造，也不必 `e.type === …` 手动分派 |
| D14 | `RunResult` 加 `runId` | 研究要 trace 与结果归因的关联键 |

---

## 3. 架构

### 3.1 分层

```
L0  pi SDK（不动）
L1  aiteam v2 —— 面的组织、运行期句柄、结算、原始事件透传
L2  用户代码 / examples —— 花名册、委派、护栏、红线等一切策略
```

**L1 不做任何 SDK 已经做了的事。**

### 3.2 对外形状

```ts
const agent = await createAgent(spec)   // spec 与面同形，不引入第二套词汇

agent.id            // 只读；trace / 归因的关联键
agent.usage         // 全生命周期累计
agent.status        // "idle" | "running" | "disposed"

agent.io            // 输入输出
agent.context       // 上下文
agent.tools         // 工具
agent.permissions   // 权限
agent.extensions    // 插件
agent.skills        // 技能
agent.model         // 模型与思考档

agent.on(event, fn)     // 原始事件，按名收窄；返回退订函数
agent.onAny(fn)         // 全量；适用于横切观测（trace / 日志）
agent.dispose()
```

`spec` 与七面句柄**同形**——创建时的字段名就是面的原语名：

```ts
const a = await createAgent({
  cwd, agentDir,
  model: "anthropic/claude-opus-4-5:high",
  thinking: "high",
  permissions: { allow: ["read"], deny: [], gate: onDangerous },
  tools:       { custom: [lookup] },
  context:     { autoCompact: true },
  skills:      ["reviewer"],
  extensions:  [myExt],
})

// 创建后是同一套名字
a.permissions.allow(["read"])
a.tools.add(lookup)
a.context.autoCompact(true)
```

`tools.add` 发生在创建**之后**，agent 已存在——**v1 那个「惰性 holder」hack 不再需要**。

### 3.3 两个统一机制

**机制一 · 增删 = 重载**

```
tools.add / tools.remove / extensions.add / skills.add
  → 改内存注册表
  → await session.reload()     ← 一次
```

- 前置条件：**必须 idle**。运行中调用抛错（不是排队）。
- 语义：**重载**——发 `session_shutdown(reason:"reload")`、`settingsManager.reload()`、`resetApiProviders()`、`resourceLoader.reload()`、重建扩展运行器、重跑全部内联工厂。
- 时序约定：**凡是碰「声明面」的都是 async**（`async` 而非「偶尔 async」）——因为声明面变化必须走 reload。

**机制二 · 面 = 钩子的分组封装**

面与 `on` 共用**同一层**（pi 的扩展事件流），不是两套：

| 面 | 底层钩子 / API |
|---|---|
| `permissions.gate` | `tool_call`（返回 `{block, reason, terminate}`；**改参数靠原地改 `event.input`**） |
| `permissions.allow` / `deny` | `session.setActiveToolsByName()`（**同步，不触发 reload**） |
| `tools.onResult` | `tool_result`（返回 `{content, details, structuredContent, isError, usage}`） |
| `context.override` | `context` / `context_with_system`（返回 `{messages}`） |
| `extensions.add` | `loader.extensionFactories` + reload |
| `skills.add` | `loader.additionalSkillPaths` / `skillsOverride` + reload |
| `model.set` / `setThinking` | `session.setModel()` / `setThinkingLevel()`（同步语义，不触发 reload） |

**采样参数（temperature / top_p / seed）不在七面之内**。它们只能通过 `on("before_provider_request")`（payload 可整体替换）触达。

### 3.4 常驻桥接扩展（D12）

`createAgent` 时注册**一个**内联扩展。它的工厂在**每次 reload 时重跑**，把当前内存里的三张表整体接回 pi：

1. **工具表** → `pi.registerTool(definition)`
2. **事件监听表** → `pi.on(event, …)`（含 `permissions.gate` 与 `tools.onResult`）
3. 其余钩子（`context.override` 等）

由此得到三条性质：

- **`add` / `remove` / `gate` 只改内存表 + 触发一次 reload**，不是「每个工具一个扩展工厂」。
- **运行期改动在 reload 后不会丢**——它们活在表里，不活在扩展闭包里。
- **钩子顺序由桥接代码决定**（见下），不是碰运气。

**顺序规则（写死，S4 实测确认合并语义）**：
`permissions.gate` 先跑；被拦则不进 `on("tool_call")` 监听器。多个 `on` 监听器按注册顺序执行，**第一个返回有效结果者胜，不合并**；对事件的原地修改（如 `event.input`）对所有监听器可见。

---

## 4. 七个面

| 面 | 读 | 原语 | raw / 底层 |
|---|---|---|---|
| **io** | `pending` · `isRunning` | `prompt(text, opts?)` → `RunResult` · `queue(text)` · `steer(text)` · `abort()` · `waitIdle()` | `session` 输入侧；`followUpMode` / `steeringMode` |
| **context** | **`history`**（会话里存的消息） · `usage`（上下文占用） | `override(fn \| msgs)`（改**这一轮发给模型的内容**，不动历史） · `compact(instr?)` · `autoCompact(bool)` | `session` + `sessionManager`；`navigateTree` / `getUserMessagesForForking` 走 raw |
| **tools** | `list()`（含已注册未启用） | `add(tool)` · `remove(name)` · `onResult(fn)` | 工具注册表 / `getToolDefinition` |
| **permissions** | `gate()` | `gate(fn)` · `allow(names)` · `deny(names)` | `tool_call` 钩子；`setActiveToolsByName` |
| **extensions** | `list()` · **`errors`** | `add(factory \| path)` · `remove(path)` | 扩展运行器；`pi.on` 注册 |
| **skills** | `list()` | `add(name \| path)` · `remove(name)` | `loader`；`getSkills()` |
| **model** | `current` · `thinking` · `available` | `set(model)` · `setThinking(level)` | `modelRuntime`；`setModel` / `setThinkingLevel` / `scopedModels` |

**命名说明**：`context.history` 是**历史**（会话里存的），`context.override` 改的是**这一轮发给模型的**。两者刻意不同名——旧叫法 `context.messages` 会让人以为 override 改的是历史。

**边界说明**

- `tools` 管「**有哪些工具存在**、工具结果怎么处理」；`permissions` 管「**哪些允许被调用**、调用要不要放行」。
- `extensions.errors` 是 v1 的静默失败点之一（扩展加载失败零信号），必须可读。
- 每个面都有 raw 出口，指向对应的 SDK 对象/方法。
- `model.set(string)` 必须沿用 v1 的教训：`resolveCliModel` 对不存在的模型只给 `warning`，库必须转成**抛错**。

### 4.1 接口草案

```ts
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
```

**返回值类型必须按事件收窄**（映射类型或 32 个重载，实现计划里定）：`tool_call` → `ToolCallEventResult`、`tool_result` → `ToolResultEventResult`、`context` / `context_with_system` → `ContextEventResult`、`turn_end` / `agent_before_settle` → `BoundaryResult`、`message_end` → `MessageEndEventResult`、`before_agent_start` → `BeforeAgentStartEventResult`、`input` → `InputEventResult`、`session_before_compact` → `SessionBeforeCompactResult`，其余为 `void`。全部类型从 pi 直接 import，不自造。

```ts
export interface RunResult {
  runId: string;                 // D14
  text: string;
  usage: Usage;                  // 本次运行
  error?: string;                // pi 对「接受后失败」不 reject，必须显式暴露
  messages: AgentMessage[];      // 本次运行覆盖的区间（对象引用，不复制）
}

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
  /** 会话里存的**历史**（只读快照） */
  readonly history: readonly AgentMessage[];
  /** 上下文占用（来自 session.getContextUsage()） */
  readonly usage: ContextUsage | undefined;
  /** 改「这一轮发给模型的内容」；历史不变 */
  override(next: ((messages: AgentMessage[]) => AgentMessage[]) | AgentMessage[]): void;
  compact(instructions?: string): Promise<void>;
  autoCompact(enabled: boolean): void;
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
  gate(fn: ToolGate | undefined): void;   // 同步：只改内存表，下次钩子生效
  /** 同步：底层是 setActiveToolsByName，不触发 reload */
  allow(names: string[]): void;
  deny(names: string[]): void;
}
export type ToolGate = (
  call: { name: string; input: unknown; callId: string },
  ctx: AgentContext,
) => Promise<{ block: true; reason?: string } | undefined>;

/** 工具 ctx（D10/D11） */
export interface ToolContext {
  readonly agent: Agent;
  signal?: AbortSignal;
}
export type AgentTool = ToolDefinition | ((ctx: ToolContext) => ToolDefinition);
```

工具写法——**没有自造包装器**，靠工厂闭包捕获 agent：

```ts
await a.tools.add((ctx) =>
  defineTool({
    name: "lookup",
    label: "Lookup",
    description: "查内部知识库",
    parameters: Type.Object({ q: Type.String() }),
    execute: async (_id, { q }, signal) => ({
      content: [{ type: "text", text: await db(q, { signal, caller: ctx.agent.id }) }],
    }),
  }),
)
```

（其余面同形：读 + 原语 + raw，实现计划里细化。）

---

## 5. 结算

```
io.prompt("…")
  → 起点 agent_start
  → 终点 agent_settled
  → RunResult = { runId, text, usage, error?, messages }
```

- 一次「运行」= `agent_start` → `agent_settled`。
- `queue()` 投进来的消息若被并进同一次运行，**明说它属于同一次**（`messages` 区间里包含它），不再像 v1 的 `send()` 那样用 `{delivered:"ran"}` 谎报。
- 并发 `prompt` 各自持自己的区间；不再有「排干共享消息池」导致的串台。
- `runId` 由库生成，出现在 `RunResult` 上；钩子里通过 **`ctx.runId`** 读取。
  **不往 pi 的事件对象上加字段**——那会破坏 `event.input` 的原地修改语义（§3.3）与 transform 类钩子的返回值约定。

---

## 6. 迁移：v1 的东西去哪

| v1 | 处置 |
|---|---|
| `createAgentHost` / `members` 花名册 | **删除**。你的代码：一个对象字面量就是花名册 |
| `spawn_agent` / `send_message` | 移到 `examples/`：`tools.add()` + 设计者自己持有的 `Map<id, agent>` |
| `maxDepth` / `maxAgents` / `budgetTokens` | 移到 `examples/`：`RunResult.usage` 累加 + `permissions.gate` + `on("turn_end")` 的 `continue` |
| 红线「agent 不能配置 agent」 | 移到 `examples/`，作为**一种可选策略**（从墙变成可对照的实验对象） |
| 7 个归一化事件 | 移到 `examples/`，约 10 行 helper |
| `defineAgentTool` | **删除**（D11）。用 pi 的 `defineTool` + 工厂闭包 |
| `inspectEnv` | **保留**为独立只读模块（它不是「面」） |
| `loader`（skills/extensions/role 收敛） | **保留**，成为 `extensions` / `skills` 面的底座 |
| 用量累加 | **保留**（`usage.ts`） |

### 6.1 资产处置

- **`audit/` 冻结不动**，标注「只对 v1 有效」。它是已发布报告的复现脚本，改库即断链，删库则报告无法复现。新库的探测能力另建。
- **`test/faux-server.ts` / `faux-models.ts` 保留**（本机假 provider，零成本，是研究基建）；测试按新 API 重写。
- **`docs/` 全部重写**：v1 的 `DESIGN.md` 归档到 `docs/archive/DESIGN-v1.md`；新 `DESIGN.md` 由本规格派生；`GUIDE.md`（新用法）、`FACTS.md`（只留仍然成立的事实）、`AGENTS.md`（三概念/红线那节移除）重写。
- **`demo/` 与 `examples/` 合并**：demo = 跑通 examples 里的配方。

---

## 7. 实现前必须实测确认（不得当既成事实写进代码注释）

v1 的教训是「配置层静默失效」。以下四条在写实现之前先探路，各自留下一个可跑的探测脚本：

| # | 待确认 | 若不成立的退路 |
|---|---|---|
| S1 | `session.reload()` 之后，新注册的扩展工具是否**自动 active**（源码看着像 `_buildRuntime({includeAllExtensionTools:true})` 会带上） | reload 后显式 `setActiveToolsByName([...旧, 新])` |
| S2 | `context` 钩子改的是「本轮发给模型的」还是「会写进历史的」 | 若会写进历史，`override` 语义要改名并在文档里写死 |
| S3 | `reload()` 在 running 时的真实破坏面 | 已有「必须 idle」前置；确认抛错时机与错误文本 |
| S4 | **多 handler 的合并语义**（跨扩展时 pi 自己是否合并；同一钩子上我们的桥接与用户扩展的先后） | 若 pi 自会合并，把 §3.4 的顺序规则改成「不保证顺序，且文档写明」 |
| S5 | **包装 ctx 而不破坏 pi 的方法绑定**：`AgentContext` 是「pi 的 ctx + 两个字段」，但 `abort()` / `isIdle()` / `getContextUsage()` 可能是原型上的方法，展开（`{...ctx}`）会丢 | 用 **Proxy**（`get` 优先取 agent / runId，其余透传并 `Reflect.get(..., receiver=原对象)`）或显式委托；不得用展开 |

另需确认：`tools.add` 之后模型**真的能看到**新工具的 schema（声明面变化生效）。

**验证方式**：复用 `test/` 的假 provider 基建写探测，零 API 成本；结论写进 `docs/FACTS.md`。

---

## 8. 测试策略

- 全部走本机假 provider，**零 API 成本**。
- 每个面至少一组：**运行期改动能被观测到**（写 → 读 → 行为变化）。
- 三个统一机制各一组：add 的 idle 前置、reload 后注册表与声明面变化、`on` / `onAny` 的转发与返回值生效。
- 结算一组：并发 `prompt` 不串台；`queue` 的消息归属正确；`runId` 在事件与 `RunResult` 上一致。
- 顺序规则一组：`gate` 拦截后 `on("tool_call")` 不再被调用。
- 非平凡逻辑（结算区间、桥接表到钩子的接线）各留一个可跑的检查，不引入测试框架。

---

## 9. 非目标与候选

**明确不做**：配置 DSL / YAML 解析器、TUI、沙箱、集群持久化与恢复、磁盘会话、agent 寻址 / 全局注册表（D2）、任何轮次 / 预算 / 深度的强制护栏（它们是 L2 策略）。不修 pi 本身的问题（模型目录 warning、扩展静默失败等）——只在 L1 把它们变成可读。

**候选（本次未纳入，留待以后）**：

| 候选 | 价值 |
|---|---|
| 采样参数一等（`model.sampling` 读写 seed / temperature） | 研究家族 1「同代码跑 N 次方差多大」的前提 |
| `[Symbol.asyncDispose]()` + `prompt(text, { signal })` | 现代 TS 习惯，成本极低 |
| `snapshot()` / `restore(state)` | 固定其余面只变一个的对照实验基础设施 |
| 超时原语（`prompt` / `waitIdle` 带 timeout） | 研究清单 #19「超时解锁哪些拓扑」 |
| 失败分类（`errorKind`） | 研究清单 #17；现只有字符串 |

---

## 10. 待办：本文之后

1. 按本文写实现计划（writing-plans 技能）。
2. 实现前先完成 §7 的四条探路。
