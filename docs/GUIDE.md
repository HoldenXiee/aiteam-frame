# aiteam 用法讲解

面向**设计者**（写代码的人）：这个库怎么用。宏观设计（为什么是这样）见 [`DESIGN.md`](DESIGN.md)，已实测核对的实现决策见 [`FACTS.md`](FACTS.md)。

> **本文不贴代码。** 每个面的正确用法是 [`examples/lib/snippets.ts`](../examples/lib/snippets.ts) 里的**真函数**——它们会被 `tsc` 检查，库 API 一变就编译不过。所以本文只给指针：
>
> - 「片段 `io.prompt`」= `examples/lib/snippets.ts` 里那个片段；
> - 「`examples/03-context.ts`」= 一个能 `node` 直接跑的示例（每个面的最小用法，一事一文件）。
>
> 手抄的代码会漂移，而**漂移的文档比没有文档更坏**。

---

## 0. 先跑起来

```bash
node demo/check.ts              # 安装自检：七项，不需要 key，全程离线
node examples/01-first-agent.ts # 最小示例：起一个 agent、交办一件事、拿结果
npm test                        # 全部断言，本机假 provider，零 API 成本
```

`examples/` 里 `01`–`08` 一面一事（最小用法），`09`–`11` 是 v1 三条假设的「可被推翻的写法」。`demo/` 是安装自检 + 一个多 agent 协作的完整例子，细节见 [`demo/README.md`](../demo/README.md)。

---

## 1. 创建：一个入口，七个面

对外只有两个函数（[`src/index.ts`](../src/index.ts) 是唯一出口，不做逻辑）：

| | |
|---|---|
| `createAgent(spec, deps?)` | **唯一**的 agent 创建入口 → 一个 `Agent`（七个面 + 句柄 + 观测） |
| `inspectEnv(spec?, deps?)` | 环境自检，只读：这套环境里实际生效了什么。见 §6 |

**创建期 spec 与运行期面是一一对应的**——字段名就是那个面的原语名（契约在 [`src/agent/types.ts`](../src/agent/types.ts) 的 `AgentInit`）：

| 面 | 创建期 `spec` | 运行期（`agent.<面>`） |
|---|---|---|
| `io` | ——（创建时不必配） | `prompt` / `queue` / `steer` / `abort` / `waitIdle` + 读数 `pending` / `isRunning` |
| `context` | `context.autoCompact` | `history` / `usage` / `autoCompact` / `override` / `compact` |
| `tools` | `tools.custom` | `list` / `add` / `remove` / `onResult` |
| `permissions` | `permissions.only` / `deny` / `gate` | `only` / `allow` / `deny` / `gate`（**没有**创建期 `allow`） |
| `extensions` | `extensions`（路径或内联工厂） | `add` / `remove` / `list` / `errors` |
| `skills` | `skills`（路径或 `Skill` 对象） | `add` / `remove` / `list` |
| `model` | `model` / `thinking` / `modelNetwork` / `catalogBaseUrl` | `set` / `setThinking` + 读数 `current` / `thinking` / `available` |

其余 `spec` 字段：`id`（不写则自动生成）、`cwd`、`agentDir`、`role`（追加到系统提示词尾部，不替换）。

**记忆点**：库给机制，使用者给政策。`createAgent` 造出来的是一个**裸 agent**——它没有任何内置工具、没有花名册、没有委派能力。想组队、想加护栏、想画红线，都是你自己的工具实现里的几行代码（见 `examples/09-roster.ts` / `10-spawn.ts` / `11-redline.ts`）。

---

## 2. 结算：`RunResult` 是**一次运行**的归属单位

```text
io.prompt("…")
  → 起点 agent_start
  → 终点 agent_settled
  → RunResult = { runId, text, usage, error?, messages }
```

一次「运行」= `agent_start` → `agent_settled`，`RunResult` 就是**这一次运行**的产出：

- `runId`（库生成的关联键，钩子里通过 `ctx.runId` 读）——做 trace 与结果归因时靠它对得上；
- `usage` 是**本次运行**的用量；`agent.usage` 是**全生命周期累计**，两者语义不同，别混；
- `error?` **必须显式看**：pi 对「接受之后失败」不 reject，只把错误写进消息，光读 `text` 会把一轮失败读成「空回复」；
- `messages` 是本次运行覆盖的**消息区间**（对象引用，不复制），**不含 `system`**。

`prompt` 的区间是**同步**定下的（起手即记下消息下标），所以并发投递各自持自己的区间、不会串台。`queue` 不给 `RunResult`（只回一个「已排队」的事实），这一轮的结果要看事件，或等 `waitIdle()` 后自行读。

→ 片段：`io.prompt`、`io.queue`。示例：`examples/01-first-agent.ts`。

---

## 3. 七个面

### 3.1 `io` —— 驱动与结算

**能做什么**：`prompt`（交办并拿 `RunResult`）、`queue`（忙时排队、**永不因忙抛错**）、`steer`（运行中改向）、`abort`、`waitIdle`；读数 `pending` / `isRunning`。

**关键取舍**：

- `prompt` 撞上「正忙」**抛错**，因为一次交办不该被静默丢掉——该走 `queue`。
- `queue` 忙时并进**当前这次运行**（结算区间里包含它，不谎报「另起一轮」）；闲时起一轮但**不 await**（await 了它就变成同步 ask），所以紧跟一句 `waitIdle()` 是最常见的写法。这一条路的失败没有 promise 可接，会以 `[aiteam]` 前缀打到 `console.error`——**要拿结果就用 `prompt`**。
- `waitIdle` 不只是「pi 静下来」，还会等库这边在飞运行的收尾（清 `runId`、归状态）。

→ 片段：`io.prompt`、`io.queue`、`io.waitIdle`。示例：`examples/01-first-agent.ts`。

### 3.2 `context` —— 历史 / 本轮覆盖 / 压缩

**能做什么**：`history`（只读快照）、`usage`（上下文占用）、`autoCompact`（自动压缩开关，可读写）、`override`（改**这一轮发给模型的内容**）、`compact`（压缩）。

**关键取舍**：

- `history` 与 `RunResult.messages` 同一视角：**不含 `system`**（system 是会话级的，每轮由 pi 重建）。要看会话原样走 `context.raw.session.messages`。
- `override` **不动历史**，逐轮生效（设一次，之后每轮都裁），传进来的是**副本**，随手 slice / filter 不会写坏会话。要裁就按**整轮**裁：只删 `toolResult` 却留下带工具调用的 assistant，pi 会把工具结果补回来。
- `compact` **要求空闲**（见 §5）：pi 的压缩首行就是 `abort()`，运行中调用会静默打断在飞那轮。

→ 片段：`context.history`、`context.override`、`context.compact`。示例：`examples/03-context.ts`。

### 3.3 `tools` —— 有哪些工具存在

**能做什么**：`list()`（名字 + active）、`add(tool)`、`remove(name)`、`onResult(fn)`（在 `tool_result` 事件上装监听，返回退订函数）。

**关键取舍**：

- `add` 碰**声明面**，要走 pi 的 `reload()`，**要求空闲**；脏活它替你做了：白名单自动补名、同名 `deny` 自动解除、reload 后显式激活。所以加完**不用**再去动 `permissions`。
- 判定「工具真的上了线」有两条判据，缺一不可：`list()` 里 `active`，且**模型下一轮实际收到的声明里有它**。顺序必须「先起、后加、再看下一轮」——创建期给的工具不加也在，看到它说明不了 `add` 做了什么。
- 工具需要 agent 句柄时用**工厂式**（`(ctx) => defineTool(...)`）：工厂在声明时被调一次，`ctx.agent` 就是本 agent，要用的能力在那一刻取好存进闭包。

→ 片段：`tools.add`、`tools.addThenInspect`、`tools.addFactory`。示例：`examples/04-tools.ts`。

### 3.4 `permissions` —— 哪些允许被调用

**能做什么**：`gate(fn)`（审批门）、`only(names)`（精确）、`allow(names)`（并集）、`deny(names)`（差集）。

**关键取舍**：

- `tools` 管「**有哪些工具存在**」，`permissions` 管「**哪些允许被调用**」——裁剪只归 `permissions`。
- `gate` 是**同步单槽位**：后设的覆盖先设的，**没有读回来的机会**，所以判定逻辑一次写清。返回 `{block: true, reason}` 挡下这次调用，`reason` 会作为工具结果回到模型面前——写清「为什么」远比单纯拒绝有用，门排在 `on("tool_call")` 之前，所以被拦下的调用不会出现在你的监听器里。
- 三档语义**同名不同义**是陷阱：创建期只有 `only`（精确）与 `deny`，**运行期的 `allow` 才是并集**。三档都 async、**都要求空闲**。
- 「精确」的边界：你在同一个 spec 里**显式声明**的工具（`tools.custom` 的名字、`extensions` 里显式声明的扩展所注册的工具名）**自动并入**白名单；环境自动发现的扩展不并入。这是刻意的——写了两行声明却有一行静默无效，比多一个字段糟糕。
- **这个面没有 `raw`**：它底下是 `tool_call` 钩子加两张私有过滤集合，pi 没有公开对象可指。

→ 片段：`permissions.gate`、`permissions.only`。示例：`examples/05-permissions.ts`。

### 3.5 `extensions` —— 插件

**能做什么**：`add(工厂 | 路径)`、`remove(path)`、`list()`、`errors()`。

**关键取舍**：

- 加载失败**不静默**：`errors()` 里读得到（路径不存在、扩展自己抛错都在这里）。但运行期钩子抛错走的是另一条路（`console.error`），不在 `errors()` 里。
- 内联工厂注册的工具名会**自动并进白名单**——不并的话，在白名单下会被 pi 静默硬过滤掉，表现为工具人间蒸发。
- 有白名单时 `add` 要**两趟** `reload()`（第一趟之后才知道工厂注册了哪些名字），pi 的每次 reload 都会重跑全部扩展工厂并发 `session_shutdown` ⇒ **工厂副作用与生命周期事件会观察到双份**。无白名单时只有一趟。

→ 片段：`extensions.add`。示例：`examples/06-resources.ts`。

### 3.6 `skills` —— 技能

**能做什么**：`add(路径 | Skill 对象)`、`remove(path)`、`list()`。

**关键取舍**：

- **只接受路径**（技能目录或 `SKILL.md`）或 `Skill` 对象：技能是被环境发现的，按名字注册没有意义，会直接抛错（避免「写了却什么都没发生」）。
- 路径加载不出任何技能会**抛错并把注入撤掉**，不静默降级。
- 技能要求空闲（同 `extensions`）。

→ 片段：`skills.add`。示例：`examples/06-resources.ts`。

### 3.7 `model` —— 模型与思考档

**能做什么**：`set(ref)`、`setThinking(level)`；读数 `current`（pi 的 `Model` 对象）、`thinking`、`available`（**可用模型列表**，不是档位）。

**关键取舍**：

- `ref` 是 `provider/id`，可带思考档后缀 `provider/id:high`（后缀会一并兑现）。**模型名错了抛错**，不会静默用回原模型——拼写错误变成静默怪行为比报错昂贵得多。
- `set` 与 `setThinking` **不打断在飞那轮**，改动从**下一次请求**起生效（同轮的后半段可能已经是新模型）。`setThinking` 是**同步**的（不碰声明面、不 reload）。
- 与 pi 的差别：`setThinking` 遇非法档位**抛错**，pi 是静默钳到最近的档（`very-high` → `off`）。

→ 片段：`model.set`、`model.setThinking`。示例：`examples/07-model.ts`。

---

## 4. 观测：`on` / `onAny` 直接是 pi 的事件

- `agent.on(event, handler)` —— **按名收窄**：handler 的事件参数类型随事件名收窄，不用自己 cast。
- `agent.onAny(handler)` —— **全量**：拿到的是判别的联合，先看 `event.type` 再取字段。trace / 日志要这个形状。
- 两者都**直接镜像 pi 的 `ExtensionEvent`**（没有归一化层），都返回**退订函数**，第二个参数是 `ctx`（pi 的 `ExtensionContext` 原样透传，外加 `agent` 与当前 `runId`）。
- **handler 必须写成块体**：`(e) => arr.push(e)` 返回的是数组长度（真值），会被当成变换结果，库直接抛错。收集信息请写 `{ arr.push(e); }`。
- 同一个事件上**只允许一个监听器返回变换结果**：设了 `context.override` 之后再 `on("context", …)` 返回变换会**抛错**，而不是静默只生效一个。理由与代价见 [`DESIGN.md`](DESIGN.md) §3.2。

→ 片段：`events.on`、`events.onAny`。示例：`examples/02-events.ts`。

---

## 5. 哪些动作要求空闲

忙判据只有一处：`io.isRunning || session.pendingMessageCount > 0`。凡是**碰声明面**的操作（改变「有哪些工具 / 扩展 / 技能存在、允许哪些」）都要走一次 pi 的 `reload()`，而**不空闲时 reload 会静默不生效**——在飞那轮照常跑完，改动毫无痕迹。库因此让这些操作**忙时抛错**，并要求你先 `io.waitIdle()`。

| 要求空闲 | 不要求 |
|---|---|
| `context.compact` | `io.prompt` / `queue` / `steer` / `abort` / `waitIdle` |
| `tools.add` / `tools.remove` | `context.override` / `autoCompact` / `tools.onResult` / `permissions.gate` |
| `permissions.only` / `allow` / `deny` | `model.set` / `model.setThinking`（改动从下一次请求起生效） |
| `extensions.add` / `remove`、`skills.add` / `remove` | |

`agent.dispose()` 之后，七个面的**一切**（含读数与全部 `raw`）都抛错——只有 `io.waitIdle()` 例外，直接 resolve（已回收的 agent 永远「已静下来」）。

---

## 6. 环境自检：`inspectEnv`

只读、不建 agent、不写盘。它回答一个问题：**「为什么我一个模型都没有？」**

`agentDir` 与 `cwd` 里的东西是 SDK 自动发现的，会静默生效；环境报告把它们摊平：`models`（只列配好凭证的 provider）、`extensions`（路径、来源、它注册了哪些工具名）、`skills`、`contextFiles`（跟着 `cwd` 走的上下文文件链）、`warnings`（目录不存在 / 没有 `models.json` / 扩展加载失败 / `SYSTEM.md` 会整体替换系统提示词…）。

模型目录默认允许联网刷新（`modelNetwork`，带新鲜度窗口的 overlay，缓存到 `<agentDir>/models-store.json`）：只刷新**有凭证的 provider**；关掉它仍然会从缓存恢复 overlay。`PI_OFFLINE=1` 关掉一切模型相关网络请求。

→ 示例：`demo/check.ts` 第 3 项（「模型可读」那一步就走它）。设计理由见 [`FACTS.md`](FACTS.md) v2 段 #31。

---

## 7. raw：逃生口

除 `permissions` 外，每个面都有一个 raw 出口，指向底层的 pi 对象。**全权、无护栏**：库的忙判据、结算、白名单自动并入、上下文视角，在这一层都不存在。想绕开库的判断（比如运行中硬压缩）就去 raw；不想自己承担代价，用一等接口。

| 面的 raw | 是什么 | 什么时候用 |
|---|---|---|
| `io.raw` | pi 的 `AgentSession` 本体（消息含 `system`） | 要会话原样 / 库没有的 pi 能力 |
| `context.raw` | `{ session, sessionManager }` | 要会话文件、会话 id，或真直通的 `compact()` |
| `tools.raw` | `{ getToolDefinition(name) }` | 要参数的**实际** schema / description（`list()` 只给名字 + active） |
| `extensions.raw` | `{ loader, session }` | `loader` 看到的是**真实加载结果**，含环境自动发现、不归库管的那些 |
| `skills.raw` | `loader` 本身 | 技能只有「被环境发现」一种来路，没有额外包装 |
| `model.raw` | `{ session, modelRuntime }` | `session` 是会话当前模型与档；`modelRuntime` 是宿主级目录 + 凭证 |

→ 片段：`raw.io`、`raw.context`、`raw.tools`、`raw.extensions`、`raw.skills`、`raw.model`。示例：`examples/08-raw-escape.ts`。

---

## 8. 库不做的事

**不做**配置 DSL、TUI、沙箱（pi 没有，本库也不承诺）、集群持久化与恢复、agent 寻址 / 全局注册表、以及**任何轮次 / 预算 / 深度的强制护栏**。要护栏，在自己的工具实现里加 `if`；要观测，用 `RunResult.usage` 累加 + 事件。

**不承诺**：pi 没有内置沙箱，`permissions.only` 只是工具集裁剪，扩展与 `bash` 可以绕过它。本库提供的是**能力裁剪 + 拦截**，不是权限系统，更不是安全边界。

---

## 附：配置 agent 时用什么模型

本仓约定：给示例 / demo / 集群配 agent 时默认用 **`(opencode-go) space-bunny-free`**。
`examples/` 与 `test/` 里的 `faux/*`（`faux/echo`、`faux/echo-alt`）是**本机假 provider**——离线、零成本、有判别力的测试基建，不要换成真模型。