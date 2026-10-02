# aiteam v2 —— 运行期操控面设计规格

- 状态：**待实现**（本文是 v2 的唯一宏观设计源）
- 日期：2026-10-02（rev.6：任务 5 审查回写——`permissions.only/allow/deny` 由「同步只改活跃集」改为 **async + reload**；显式 `tools.add` 必须解除同名 deny。依据是 R35/R37/R38，实测事实见 `docs/FACTS.md` #13）
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

- 前置条件：**必须 idle**。运行中调用抛错（不是排队）。**这个守卫必须由库自己加**：实测 pi 的 `reload()` 在 streaming 中 7ms 静默返回 `ok`、在飞的那轮照常跑完——也就是说**声明面变化对在飞轮次静默不生效**。这正是 v1 那类静默失效，不能靠 pi 兜（`spike/s3-reload-while-running.ts`）。
- 语义：**重载**——发 `session_shutdown(reason:"reload")`、`settingsManager.reload()`、`resetApiProviders()`、`resourceLoader.reload()`、重建扩展运行器、重跑全部内联工厂。
- 时序约定：**凡是碰「声明面」的都是 async**（`async` 而非「偶尔 async」）——因为声明面变化必须走 reload。

**机制二 · 面 = 钩子的分组封装**

面与 `on` 共用**同一层**（pi 的扩展事件流），不是两套：

| 面 | 底层钩子 / API |
|---|---|
| `permissions.gate` | `tool_call`（返回 `{block, reason, terminate}`；**改参数靠原地改 `event.input`**） |
| `permissions.only` / `allow` / `deny` | **白名单 / 排除集**（`allowedToolNames` / `_excludedToolNames`，唯一扛得过 reload 的硬过滤）+ `session.reload()`——**async、需 idle**。只调 `setActiveToolsByName` 不够：实测 `reload()` 会**重算**活跃集，只改活跃集的收紧会被下一次声明面操作**静默抹掉**（R35/R38） |
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

**顺序规则（已实测，`spike/s4-handler-merge.ts` / `s4b` + pi 源码 `runner.js`）**：

1. 同一事件上的多个 handler 按注册顺序执行；跨扩展的顺序 = 扩展工厂的注册顺序。
2. **跨扩展**：返回变换结果时链式传递（后一个扩展看到前一个处理后的结果）；返回**假值**（`undefined` / `null` / `0` / `''`）**不覆盖**前一个的有效结果（pi 用真值判据 `if (handlerResult)`）；返回 `{block:true}` **短路**（后续 handler 与其他扩展都收不到）。
3. **桥接内部**（库自己的派发器，它是 pi 的**单个**扩展，所以 pi 的跨扩展机制在这里不生效）：监听器按注册顺序执行、拿到的是**原始事件**（**不复刻**链式）；合并规则照搬 pi 的 **last-wins**——最后一个非空结果生效，判据是真值（与 pi 逐字一致）。
4. 因为桥接无法复刻链式，**同一个事件上只允许一个监听器返回变换结果**：第二个非 `undefined` 的返回值**抛错**，不静默丢弃前一个监听器的结果（静默丢弃正是本项目要消灭的失效模式）。要拦截就走专属槽位（`permissions.gate` / `tools.onResult` / `context.override`）。
5. **槽位与监听表的关系（R26）**：专属槽位（`gate` / `contextOverride` / `onResult`）**排在监听表之前**生效，且**槽位的结果计入同一个「已有非空结果」守卫**——所以「设了 `context.override`，又用 `on("context")` 返回变换」会**抛错**，而不是静默地只生效一个。槽位排前面还有一条硬理由：`permissions.gate` 必须抢在用户监听器之前，才能保证「拦住之后 `on("tool_call")` 不被调用」。
6. 库的桥接扩展是**第一个**注册的工厂，所以 `permissions.gate` 天然排在用户后加的扩展之前；`gate` 一旦拦住（`block` 短路），用户的 `on("tool_call")` **不会知道发生过这件事**——文档要明说。

---

## 4. 七个面

| 面 | 读 | 原语 | raw / 底层 |
|---|---|---|---|
| **io** | `pending` · `isRunning` | `prompt(text, opts?)` → `RunResult` · `queue(text)` · `steer(text)` · `abort()` · `waitIdle()` | `session` 输入侧；`followUpMode` / `steeringMode` |
| **context** | **`history`**（会话里存的消息） · `usage`（上下文占用） · `autoCompact` | `override(fn \| msgs)`（改**这一轮发给模型的内容**，不动历史） · `compact(instr?)` | `session` + `sessionManager`；`navigateTree` / `getUserMessagesForForking` 走 raw |
| **tools** | `list()`（含已注册未启用） | `add(tool)` · `remove(name)` · `onResult(fn)` | 工具注册表 / `getToolDefinition` |
| **permissions** | —（`gate` 只写不读） | `gate(fn)`（同步，单槽位） · `allow(names)`（并集启用，**async**） · `deny(names)`（移除，**async**） · `only(names)`（精确设置，**async**） | `tool_call` 钩子；白名单 / 排除集 + `reload()` |
| **extensions** | `list()` · **`errors()`** | `add(factory \| path)` · `remove(path)` | 扩展运行器；`pi.on` 注册 |
| **skills** | `list()` | `add(path \| Skill)` · `remove(path)` | `loader`；`getSkills()` |
| **extensions** | `list()` · **`errors`** | `add(factory \| path)` · `remove(path)` | 扩展运行器；`pi.on` 注册 |
| **skills** | `list()` | `add(name \| path)` · `remove(name)` | `loader`；`getSkills()` |
| **model** | `current` · `thinking` · `available` | `set(model)` · `setThinking(level)` | `modelRuntime`；`setModel` / `setThinkingLevel` / `scopedModels` |

**读写形式约定**（避免每个面各一套）：简单状态用 getter / accessor（`context.autoCompact` 可读写，`context.history`、`model.current`、`io.pending` 只读）；要计算或返回新数组的用方法（`tools.list()`、`extensions.errors()`、`skills.list()`）；有副作用的用方法。

**三处与早版措辞的消歧**（实现计划自检时发现同名不同义，会同治于本文与计划）：

1. **创建期用 `only` 而不是 `allow`**。创建时最常说的是「只给它这几个」（精确白名单，对应 pi 的 `tools` 选项）；运行期 `allow` 是**并集启用**。同名不同义是陷阱，所以创建期叫 `only`：`permissions: { only?: string[]; deny?: string[] }`。
2. **运行期补 `only(names)`** 做精确设置。`allow`（并集）/ `deny`（移除）/ `only`（精确）三档语义互不重叠。
3. **`skills.add` 只接受路径或 `Skill` 对象，不接受裸技能名**。技能是被环境发现的，不是按名注册的；运行期「按名 add」没有意义，只能变成静默 no-op——传名字时招错并指向 `skills.list()`。

**定义**：

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
// 实测（spike/s5-ctx-shape.ts）：ctx 是对象字面量、方法全是自有属性且不依赖 this，
// 所以实现上 `{ ...piCtx, agent, runId }` 直接用即可，不需要 Proxy。
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
  /** 自动压缩开关，可读写（映射到 session.autoCompactionEnabled） */
  autoCompact: boolean;
  /** 改「这一轮发给模型的内容」；历史不变。传 undefined 清除 */
  override(next: ((messages: AgentMessage[]) => AgentMessage[]) | AgentMessage[] | undefined): void;
  compact(instructions?: string): Promise<void>;
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
  /** 只写不读：单槽位，后一次覆盖前一次。同步生效 */
  gate(fn: ToolGate | undefined): void;
  /** 碰声明面 → async（reload），要求 idle */
  allow(names: string[]): Promise<void>;   // 并集：启用这些
  deny(names: string[]): Promise<void>;    // 差集：关掉这些
  only(names: string[]): Promise<void>;    // 精确：集合就是这些
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
- `RunResult.messages` **不含 `system`**：pi 在首次 prompt 时才把 system 消息写进会话，不过滤的话只有**第一轮**会多带一条，导致轮与轮之间不可比。system 是会话级的，不属于任何一次运行。
- `queue()` 在**空闲**时会起一次不 await 的运行（否则 `queue` 就变成同步 ask）。这种运行的失败**必须经 `console.error` 浮出**（带 `[aiteam]` 前缀与 `runId`），不能只吞不报——它是与 R17 同一条可见性通道。要拿到结果与失败就用 `prompt()`。
- **「`queue` 永不抛错」的精确范围**（R25）：指**不因「目标忙」而抛错**——那正是 v1 `send()` 存在的理由（pi 的 `prompt()` 在目标 streaming 时直接抛）。但若**底层投递本身失败**（`session.followUp` 被 pi 拒收），`queue` **必须 reject**：把失败的投递报成 `{queued:true}` 是谎报，比 v1 的 `{delivered:"ran"}` 更糟。已知失败形态两条（reject 与 resolve-但-`error` 有值）都要覆盖。
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

## 7. 探路结论（已实测，2026-10-02）

全部在本机假 provider 上跑，零 API 成本。证据与完整输出见 [`spike/FINDINGS.md`](../../../spike/FINDINGS.md)，脚本在 `spike/`。

| # | 问题 | 实测结论 | 对设计的影响 |
|---|---|---|---|
| S1 | reload 后新注册的工具是否自动 active、能否被调用 | **成立**：进 `getActiveToolNames()`、进模型收到的 schema、能被执行、remove 后消失 | §3.4 桥接路线确认 |
| S2 | `context` 钩子改的是本轮还是历史 | **本轮发给模型的**：逐轮生效、历史不受影响、原地改也不污染历史（pi 传副本）；钩子拿到的是不含 system 的消息 | `context.override` 语义照原设计 |
| S3 | reload 撞上 running | **pi 不抛错**：7ms 静默返回 ok，在飞那轮照常跑完 | 「必须 idle」是**库自己加的守卫**，必须加 |
| S3b | reload 后桥接的钩子是否还活着 | **活着、可反复**：门继续生效、新工具继续可见；reload 会发 `session_shutdown(reason:"reload")` | §3.4「改动活在表里」被证实 |
| S4 | 多 handler 的顺序与合并 | 按注册顺序链式跑；返回 `block` **短路**（后续 handler 与其他扩展都收不到）；`undefined` 不覆盖前一个结果 | §3.4 顺序规则改成 pi 原生语义；`gate` 天然排在用户扩展之前 |
| S5 | `AgentContext` 能否 `{...ctx}` 展开 | **可以**：ctx 是对象字面量，方法在自有属性且不依赖 `this` | **删掉原设的 Proxy 方案**，实现少一层包装 |

**没有推翻任何一条设计决策**；S3 修正了「抛错」的错误预期，S5 删掉了一处多余复杂度。

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

§7 的探路已于 2026-10-02 完成，结论已写回本文（§3.3 / §3.4 / §4.1 / §7）。

---

## 11. rev.6 的两条裁决（任务 5 期间由审查证据触发）

**R38：`permissions.only` / `allow` / `deny` 必须 async + reload。**

起因是任务 5 实现者披露的天花板：`allow` 的立即生效只对**注册表里已有**的名字成立——被创建期白名单筛掉的名字要等下一次 reload。而契约规定这三个操作是同步、不触发 reload ⇒ **设计者没有任何办法让它生效**，且 `tools.list()` 里根本看不到这个名字 ⇒ 这是一个**不可见的部分 no-op**。

审理后采纳「改契约」而非「写文档」。理由：
1. 它**碰的是声明面**（工具存在与允许的宇宙），与 `tools.add` / `remove` / `extensions.add` / `skills.add` **同类**——后者全是 async + 需 idle。同步才是异类。
2. 它**简化**实现：原设计要「白名单负责持久 + `setActiveToolsByName` 负责立即生效」两层都动；`reload()` 一步就同时决定白名单过滤与活跃集，只剩一层机制。
3. 消除的是**静默失效**——本项目的立项理由。

**R37：显式 `tools.add(x)` 必须解除同名的 deny。**

起因是另一个跨面交互：`deny` 过的名字再 `tools.add` 会**静默不生效**（新工具停在 `active:false`）。取向与「`add` 会扩白名单」一致：**显式 add 一定让它生效**（R34 已为 `defaultActive:false` 立过同一原则）。若要让 deny 压过 add，那 add 就必须**抛错**——但那是多一条错误路径、且与既有取向矛盾；故取「add 解除 deny」。
