# aiteam v2 —— 运行期操控面设计规格

- 状态：**待实现**（本文是 v2 的唯一宏观设计源）
- 日期：2026-10-02
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

## 2. 已定决策（本次头脑风暴结论）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 组织形式为**六面句柄式**（+ 模型 = 七个面） | 句柄是「可替换单元」：做「换掉权限策略」这类对照实验时是传一个对象；工具 ctx 可只拿到该管的那一面，天然支持能力收窄研究 |
| D2 | **不做任何寻址机制** | 设计者写代码编排时手里就有 agent 引用，直接 `a.io.queue(…)`。旧库需要寻址只因为第二条路（agent 用工具驱动 agent）拿到的只有字符串 id；该路已砍 |
| D3 | 运行期增删（`tools.add` / `extensions.add` / `skills.add`）走 **`session.reload()` 重载语义** | 已核实 `DefaultResourceLoader.extensionFactories` 是公开字段、`reload()` 会重建工具注册表；代价是重载而非增量，明确标注 |
| D4 | **模型与思考档是第七个面**（`agent.model`） | 它是运行期可换的实验变量（`setModel` / `setThinkingLevel`），v1 已有，不该丢 |
| D5 | 观测**以原始事件全量透传为主** | 旧库有损归一化丢了 `compaction_*`，压缩对设计者不可见；归一化是用户侧约 10 行，原始透传是用户做不到的 |
| D6 | **工具集裁剪归 `permissions`**，不归 `tools` | 否则 `tools.enable` 与 `permissions.allow` 是同一个东西 |
| D7 | 结算边界 = `agent_start` → `agent_settled` | SDK 明确 `agent_settled` 是「不会再有任何自动重试、压缩、排队续跑」；v1 用「排干共享消息池」是错在这里 |

---

## 3. 架构

### 3.1 分层

```
L0  pi SDK（不动）
L1  aiteam v2 —— 面的组织、运行期句柄、结算、原始事件透传
L2  用户代码 / examples —— 花名册、委派、护栏、红线等一切策略
```

**L1 不做任何 SDK 已经做了的事**（沿用 v1 的这条约定，它是对的）。

### 3.2 对外形状

```ts
const agent = await createAgent(spec)   // spec 只是七面的初始值

agent.io            // 输入输出
agent.context       // 上下文
agent.tools         // 工具
agent.permissions   // 权限
agent.extensions    // 插件
agent.skills        // 技能
agent.model         // 模型与思考档

agent.observe(fn)   // 40 个扩展钩子全量透传（可听可改）
agent.dispose()     // 生命周期
```

`spec` 与七面句柄的关系：**spec 是初始值，等价于对句柄做一批 set。** 不存在两套入口。

### 3.3 两个统一机制

**机制一 · add = 重载**

```
tools.add / extensions.add / skills.add
  → 往 loader 塞内联扩展工厂（skills 走 additionalSkillPaths / skillsOverride）
  → await session.reload()
```

- 前置条件：**必须 idle**。运行中调用抛错（不是排队）。
- 语义：**重载**——发 `session_shutdown(reason:"reload")`、`settingsManager.reload()`、`resetApiProviders()`、`resourceLoader.reload()`、重建扩展运行器、重跑全部内联工厂。
- 这本身是一个**可研究的实验变量**（工具声明面中途变化对模型行为的影响），不是缺陷。

**机制二 · 面 = 钩子的分组封装**

面与 `observe` 共用**同一层**（pi 的扩展事件流），不是两套：

| 面 | 底层钩子 |
|---|---|
| `permissions.gate` | `tool_call`（返回 `{block, reason, terminate}`；**改参数靠原地改 `event.input`**） |
| `tools.onResult` | `tool_result`（返回 `{content, details, structuredContent, isError, usage}`） |
| `context.override` | `context` / `context_with_system`（返回 `{messages}`） |
| `extensions.add` | `loader.extensionFactories` + `reload()` |
| `skills.add` | `loader.additionalSkillPaths` / `skillsOverride` + `reload()` |

**采样参数（temperature / top_p / seed）不在七面之内**。它们只能通过 `before_provider_request` 钩子（payload 可整体替换）触达，所以那是 `observe` 的用法，不是 `model` 面的原语。

---

## 4. 七个面

| 面 | 读 | 原语 | raw / 底层 |
|---|---|---|---|
| **io** | `pending` · `isRunning` | `prompt(text, opts?)` → `RunResult` · `queue(text)` · `steer(text)` · `abort()` · `waitIdle()` | `session` 输入侧；`followUpMode` / `steeringMode` |
| **context** | `messages`（会话里的） · `usage`（上下文占用） | `override(fn \| msgs)`（改**这一轮发给模型的内容**） · `compact(instr?)` · `autoCompact(bool)` | `session` + `sessionManager`；`navigateTree` / `getUserMessagesForForking` 走 raw |
| **tools** | `list()`（含已注册未启用） | `add(tool)` · `remove(name)` · `onResult(fn)` | 工具注册表 / `getToolDefinition` |
| **permissions** | `gate()` | `gate(fn)` · `allow(names)` · `deny(names)` | `tool_call` 钩子；`setActiveToolsByName` / `excludeTools` |
| **extensions** | `list()` · **`errors`** | `add(factory \| path)` · `remove(path)` | 扩展运行器；`pi.on` 注册 |
| **skills** | `list()` | `add(name \| path)` · `remove(name)` | `loader`；`getSkills()` |
| **model** | `current` · `thinking` · `available` | `set(model)` · `setThinking(level)` | `modelRuntime`；`setModel` / `setThinkingLevel` / `scopedModels` |

**边界说明**

- `tools` 管「**有哪些工具存在**、工具结果怎么处理」；`permissions` 管「**哪些允许被调用**、调用要不要放行」。
- `extensions.errors` 是 v1 的静默失败点之一（扩展加载失败零信号），必须是可读的。
- 每个面都有 raw 出口，指向对应的 SDK 对象/方法。

### 4.1 接口草案

```ts
export interface Agent {
  readonly io: IoSurface;
  readonly context: ContextSurface;
  readonly tools: ToolsSurface;
  readonly permissions: PermissionsSurface;
  readonly extensions: ExtensionsSurface;
  readonly skills: SkillsSurface;
  readonly model: ModelSurface;

  observe(fn: (event: RawAgentEvent) => unknown | Promise<unknown>): () => void;
  dispose(): void;
}

export interface RunResult {
  text: string;
  usage: Usage;          // 本次运行
  error?: string;
  /** 本次运行覆盖的消息区间（对象引用，不复制） */
  messages: AgentMessage[];
}

export interface ContextSurface {
  /** 会话里存的消息（只读快照） */
  readonly messages: readonly AgentMessage[];
  /** 上下文占用（来自 session.getContextUsage()） */
  readonly usage: ContextUsage | undefined;
  /** 改「这一轮发给模型的内容」；历史不变 */
  override(next: ((messages: AgentMessage[]) => AgentMessage[]) | AgentMessage[]): void;
  compact(instructions?: string): Promise<void>;
  autoCompact(enabled: boolean): void;
  readonly raw: { session: AgentSession; sessionManager: SessionManager };
}

export interface PermissionsSurface {
  gate(fn: ToolGate | undefined): void;
  /** 同步：底层是 setActiveToolsByName，不触发 reload */
  allow(names: string[]): void;
  deny(names: string[]): void;
}
export type ToolGate = (
  call: { name: string; input: unknown; callId: string },
  ctx: SurfaceContext,
) => Promise<{ block: true; reason?: string } | undefined>;
```

（其余面同形：读 + 原语 + raw，此处不逐一展开，实现计划里细化。）

### 4.2 工具上下文改为「拿面」

工具工厂拿到的 `ctx` 从 `{ agent, host }` 改为：

```ts
export interface SurfaceContext {
  /** 调用者的身份（只读） */
  readonly id: string;
  /** 按需注入该工具该管的面，而不是整个 agent —— 天然支持能力收窄研究 */
  readonly tools?: ToolsSurface;
  readonly context?: ContextSurface;
  readonly io?: IoSurface;
  readonly signal?: AbortSignal;
}
```

---

## 5. 结算

```
io.prompt("…")
  → 起点 agent_start
  → 终点 agent_settled
  → RunResult = { text, usage, error?, messages: 本次区间 }
```

- 一次「运行」= `agent_start` → `agent_settled`。
- `queue()` 投进来的消息若被并进同一次运行，**明说它属于同一次**（`messages` 区间里包含它），不再像 v1 的 `send()` 那样用 `{delivered:"ran"}` 谎报。
- 并发 `prompt` 各自持自己的区间；不再有「排干共享消息池」导致的串台。
- `queue()` 返回队列事实（`"queued"`），不假装它已经跑过。

---

## 6. 迁移：v1 的东西去哪

| v1 | 处置 |
|---|---|
| `createAgentHost` / `members` 花名册 | **删除**。你的代码：一个对象字面量就是花名册 |
| `spawn_agent` / `send_message` | 移到 `examples/`：`tools.add()` + 设计者自己持有的 `Map<id, agent>` |
| `maxDepth` / `maxAgents` / `budgetTokens` | 移到 `examples/`：`io` 结算的 `usage` 累加 + `permissions.gate` + `turn_end` 的 `continue` |
| 红线「agent 不能配置 agent」 | 移到 `examples/`，作为**一种可选策略**（从墙变成可对照的实验对象） |
| 7 个归一化事件 | 移到 `examples/`，约 10 行 helper |
| `inspectEnv` | **保留**为独立只读模块（它不是「面」） |
| `loader`（skills/extensions/role 收敛） | **保留**，成为 `extensions` / `skills` 面的底座 |
| `usage.ts` / 事件归一化 | 用量累加保留；归一化降级为 example |

### 6.1 资产处置

- **`audit/` 冻结不动**，标注「只对 v1 有效」。它是已发布报告的复现脚本，改库即断链，删库则报告无法复现。新库的探测能力另建。
- **`test/faux-server.ts` / `faux-models.ts` 保留**（本机假 provider，零成本，是研究基建）；测试按新 API 重写。
- **`docs/` 全部重写**：v1 的 `DESIGN.md` 归档到 `docs/archive/DESIGN-v1.md`；新 `DESIGN.md` 由本规格派生；`GUIDE.md`（新用法）、`FACTS.md`（只留仍然成立的事实）、`AGENTS.md`（三概念/红线那节移除）重写。
- **`demo/` 与 `examples/` 合并**：demo = 跑通 examples 里的配方。

---

## 7. 实现前必须实测确认（不得当既成事实写进代码注释）

v1 的教训是「配置层静默失效」。以下三条在写实现之前先探路，各自留下一个可跑的探测脚本：

| # | 待确认 | 若不成立的退路 |
|---|---|---|
| S1 | `session.reload()` 之后，新注册的扩展工具是否**自动 active**（源码看着像 `_buildRuntime({includeAllExtensionTools:true})` 会带上，但要实测） | reload 后显式 `setActiveToolsByName([...旧, 新])` |
| S2 | `context` 钩子改的是「本轮发给模型的」还是「会写进历史的」——两种语义差别很大 | 若会写进历史，`override` 语义要改名并在文档里写死 |
| S3 | `reload()` 在 running 时的真实破坏面 | 已有「必须 idle」前置；确认抛错时机与错误文本 |

另需确认：`tools.add` 之后模型**真的能看到**新工具的 schema（声明面变化生效）。

**验证方式**：复用 `test/` 的假 provider 基建写探测，零 API 成本；结论写进 `docs/FACTS.md`。

---

## 8. 测试策略

- 全部走本机假 provider，**零 API 成本**（沿用 v1 的约定）。
- 每个面至少一组：**运行期改动能被观测到**（写 → 读 → 行为变化）。
- 三个统一机制各一组：add 的 idle 前置、reload 后注册表与声明面变化、`observe` 全量钩子的转发与返回值生效。
- 结算一组：并发 `prompt` 不串台；`queue` 的消息归属正确。
- 非平凡逻辑（结算游标、面封装的事件转发）各留一个可跑的检查，不引入测试框架。

---

## 9. 非目标

- 不做配置 DSL / YAML 解析器、TUI、沙箱、集群持久化与恢复、磁盘会话。
- 不做 agent 寻址 / 全局注册表（D2）。
- 不做任何轮次 / 预算 / 深度的强制护栏——它们是策略，属于 L2。
- 不修 pi 本身的问题（模型目录 warning、扩展静默失败等）——只在 L1 把它们变成可读。

---

## 10. 待办：本文之后

1. 按本文写实现计划（writing-plans 技能）。
2. 实现前先完成 §7 的三条探路。
