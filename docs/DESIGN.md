# aiteam —— Agent 操控库，v2

- 状态：**现行**（本文是唯一的宏观设计源）
- 版本：**v2**。v1 归档在 [`archive/DESIGN-v1.md`](archive/DESIGN-v1.md)
- 日期：2026-10-03
- 来源：本文由 [v2 规格](superpowers/specs/2026-10-02-runtime-surfaces-design.md)（rev.8，R1–R48）派生；裁决全文与「代价若错」见计划 1 账本与规格 §11
- 面向：**设计者**（写代码用这个库的人）。用法讲解见 [`GUIDE.md`](GUIDE.md)，已实测的 pi 事实见 [`FACTS.md`](FACTS.md)

---

## 0. 一句话

> aiteam 是一个 **agent 操控库**：给设计者的代码一双手，**在运行期**读、改、拦截一个 agent 的七个面。**库不含任何策略。**

它基于 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，是 SDK 上面薄薄的一层。它的目标是**研究工具**，不是产品。

「研究工具」这四个字是有后果的：研究工具的核心能力是**让假设可被替换、可被测量**，而不是替研究者选好立场。所以库里没有花名册、没有内置工具、没有护栏、没有红线、没有 agent 寻址机制 —— 那些都是**可以被对照实验证伪的假设**，它们属于使用者的代码，不属于库。

v1 恰好把这件事做反了：它把研究假设当成了库的结构（红线「agent 不能配置 agent」、花名册、委派原语都是**待研究的对象**），于是想做「允许 spawn 时传 tools」这种对照实验，必须改库源码。v1 的原文见 [`archive/DESIGN-v1.md`](archive/DESIGN-v1.md)。

**不承诺**：pi 没有内置沙箱。`permissions.only` 只是工具集裁剪，扩展与 `bash` 可以绕过它。本库提供的是**能力裁剪 + 拦截**，**不是权限系统**，更不是安全边界。

---

## 1. 三个概念：v1 → v2 的变化

| 概念 | v1（已归档） | v2 |
|---|---|---|
| **成员（Member）** | 一种预定义好的 agent 类型：职责、技能、插件、工具集、模型。由设计者在花名册里声明 | 概念保留，但**不再是库的一部分**——它就是设计者的代码里的一个对象 / 一条记录 |
| **分身（Instance）** | 某个成员的一个运行实例；由 agent 在运行时通过 `spawn_agent` 启动 | 仍是「一个 `createAgent` 出来的运行实例」，但**起分身是设计者的代码在做**（在自己的工具实现里调 `createAgent`） |
| **花名册（members）** | 设计者声明的全部成员，交给 `createAgentHost({ members })` | **已移出库**。「花名册」在 v2 里就是设计者自己的一个 `Map`／对象字面量 |

v2 **删掉了** `createAgentHost` / `members` / `spawn_agent` / `send_message` / `maxDepth` / `maxAgents` / `budgetTokens`，以及那条红线。

原因不是「它们不好」，而是**它们是假设**：

- 「预定义成员能约束 agent 的行为」
- 「委派给分身能扩展能力」
- 「agent 不该能配置 agent」

这三条正是研究问题清单要测量的对象。写进库的那一刻，它们就从**可对照的变量**变成了**不可质疑的前提**——测量工具把结论烤进了自己的结构里。

v2 里这三条**全部保留为使用者代码**，且每条都写成「一个可被推翻的写法 + 一行具体的改法」：

| 文件 | 假设 | 在 v2 里怎么摆 |
|---|---|---|
| [`examples/09-roster.ts`](../examples/09-roster.ts) | 预定义成员能约束行为 | 一个 `Map<string, {role, tools}>`；约束效果成为可对照的变量（删掉花名册、让 spawn 接受任意角色，再跑同一个任务） |
| [`examples/10-spawn.ts`](../examples/10-spawn.ts) | 委派给分身能扩展能力 | 一个 `spawn` 工具，内部 `createAgent` + `io.prompt`；深度计数器是**使用者代码**（改成 1 或去掉，看结果怎么变） |
| [`examples/11-redline.ts`](../examples/11-redline.ts) | agent 不该能配置 agent | `spawn` 参数表上的一段检查；注释掉它，模型带的配置就真的会被接进子 agent（这就是那条假设的代价） |

三个文件的头部都逐字标着「⚠️ 这是一个【假设】，不是推荐做法」。**若把它们写成库功能，就是把 v1 删掉的政策又请回来。**

一句话记法：**库给机制，使用者给政策。** 想在 v2 里加一条「规矩」，正确的动作是在自己的工具实现里加一段 `if`，而不是往库里加一个字段。

---

## 2. 七个面

```
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

两张表先立好边界，后面每一节都在这两条线之内：

- **一张表回答「谁负责机制、谁负责政策」**；
- **另一张表回答「哪些动作要求空闲」**。

### 2.1 谁负责机制、谁负责政策

| 面 | 库负责的机制 | **使用者**负责的政策 |
|---|---|---|
| `io` | 投递、排队、打断、等待、**结算**（一次运行的区间与归属） | 投什么、什么时候投、要不要超时、失败怎么办 |
| `context` | 读历史、改**这一轮发给模型的内容**、压缩、自动压缩开关 | 裁多少、按什么规则裁、压不压、什么时候压 |
| `tools` | 有哪些工具存在、工具结果怎么处理（`onResult` 拦截） | 工具做什么、给谁工具（工具集裁剪归 `permissions`） |
| `permissions` | 哪些**允许被调用**、调用要不要放行 | 放行判据、白名单里放什么、拒绝的理由怎么写 |
| `extensions` | 加载 / 卸载、加载错误可读（`errors()`） | 扩展干什么、装几个、按什么角色装 |
| `skills` | 按路径注入技能、列出当前技能 | 技能内容、按角色装载 |
| `model` | 换模型、换思考档、读当前与可用 | 什么时候换、为什么换、预算怎么分 |

**一条边界要特别说清**：`tools` 管「**有哪些工具存在**、工具结果怎么处理」，`permissions` 管「**哪些允许被调用**、调用要不要放行」。两者不是一回事——`tools.enable` 与 `permissions.allow` 会变成同一个东西，所以裁剪只归 `permissions`。

**每个面都有一个 raw 出口**（`agent.context.raw` 等），指向对应的 pi 对象 / 方法。分工是固定的：**一等接口自带该有的守卫与结算，raw 是全权、无护栏**。想绕开库的判断（比如运行中硬压缩），去 raw；不想自己承担代价，用一等接口。

### 2.2 哪些动作要求空闲（R29 / R38）

| 动作 | 同步 / 异步 | 要求空闲 |
|---|---|---|
| `io.prompt` / `queue` / `steer` / `abort` / `waitIdle` | async | — |
| `context.override` / `autoCompact` | 同步 | — |
| `context.compact` | async | **是** |
| `tools.add` / `tools.remove` / `tools.onResult` | async（`onResult` 同步装监听） | **是**（`add` / `remove`） |
| `permissions.gate` | **同步** | — |
| `permissions.only` / `allow` / `deny` | **async** | **是** |
| `extensions.add` / `remove` / `skills.add` / `remove` | async | **是** |
| `model.set` / `model.setThinking` | async / 同步 | —（运行中调用不打断在飞那轮，改动从下一次请求起生效） |

#### 为什么「碰声明面」就要空闲：R29 单一忙判据

「声明面」= 有哪些工具 / 扩展 / 技能存在、白名单允许哪些。改变它要走 pi 的 `reload()`，而**不空闲时 reload 会静默不生效**：pi 的 `reload()` 撞上在飞的那轮不抛错，约 7ms 静默返回 ok、在飞那轮照常跑完，于是「刚加的工具在飞那轮里不存在」这种零症状的失效就发生了（`FACTS.md` #3，spike `s3-reload-while-running.ts`）。

**pi 不兜这个底，所以守卫必须由库自己加。** 而守卫的判据必须**只有一处**：

```
isBusy = io.isRunning || session.pendingMessageCount > 0
```

两个分量都不是装饰：

- `io.isRunning` 里的 `running` 计数（库自己数在飞运行）是**必需的**。pi 的 `isStreaming` 要等 `prompt()` 内部若干 await 之后才翻真，而 `io.prompt()` 是**先发起再返回**的——启动窗口里 `isStreaming` 假、`pendingMessageCount` 也是 0。只看 pi 的两个信号，正是那道守卫本来要挡的洞。
- `pendingMessageCount` 也不能丢：follow-up 消息在 idle 时也会排队（`isRunning` 假、但一轮运行马上要开始），只留第一项会漏判。

若在别处再抄一份判据，两份口径迟早分叉，而分离出来的那一刻守卫就白设了。**注**：`io.queue` / `io.prompt` 自身的忙判据用的是另一份更窄的信号——它只回答「我现在能不能起一轮」，不回答「现在能不能改声明面」。

#### R48：`dispose` 之后，**七个面的一切**都拒绝

`agent.dispose()` 之后，七个面的**每一个成员**（含 `io.pending` / `io.isRunning` 这类读数，以及全部的 `raw` 逃生口）都抛错：「agent … 已 dispose，不能再操作」。

为什么不省掉读数上的守卫：**dispose 后读数不会炸，它返回陈旧值。** 那比抛错更坏——调用方无从判断手里拿到的是活值还是死值。而原先只有 `io` 的三个成员漏了守卫，形成「七分之六遵守、一个面例外」的隐形不对称：例外是可以被查出来的，**不对称的例外是要靠背的**。一张表驱动用例把 40 个面成员放同一条判据下（`test/bridge.test.ts`），从此「哪些成员受管辖」由契约决定，不由记忆决定。

两处是**有注释的例外**，不是漏网：

- `io.waitIdle()` 在已 dispose 时**直接 resolve**（已回收的 agent 永远「已静下来」，v1 决策 #21）；
- `Agent.session` —— 契约里**没有**这个成员（`agent.session` 是 v1 的逃生口名字，v2 走各面的 `raw`）。

---

## 3. 两个统一机制（以及它们决定了什么）

七个面看起来是七套 API，底下只有两个机制。知道它们，就能预判行为而不是查文档。

### 3.1 机制一：增删 = 改表 + 一次 `reload()`

```
tools.add / tools.remove / permissions.only|allow|deny / extensions.add|remove / skills.add|remove
  → 改内存里的注册表
  → await session.reload()     ← 一次
```

pi 的 `reload()` 是**重载**而不是增量：丢旧 runner（全部扩展工厂**重跑**）、`settingsManager.reload()`、`resetApiProviders()`、重建工具注册表与活跃集。所以：

- 凡是碰声明面的操作**一律 async**——不是「偶尔 async」，是语义上必须等一次重载。这一条消除了同步版本的整个天花板（见 R38）；
- 代价是**重载而非增量**：一次 `extensions.add` 可能让工厂与生命周期事件跑两遍（R41 的双趟 reload，见 §3.4）。

**「活的表在库里，不在扩展闭包里」**：`createAgent` 时注册**一个**常驻桥接扩展。它的工厂在每次 reload 时重跑，把当前内存里的工具表、监听表整体接回 pi。由此：运行期改动不会因 reload 丢失；`add` / `gate` 只改内存表 + 触发一次重载，而不是「每个工具一个扩展工厂」。

### 3.2 机制二：面 = 钩子的分组封装（R26 槽位顺序）

面与 `agent.on()` 共用**同一层**（pi 的扩展事件流），不是两套：

| 面 | 底层钩子 / API |
|---|---|
| `permissions.gate` | `tool_call`（返回 `{block, reason}`；**改参数靠原地改 `event.input`**） |
| `permissions.only` / `allow` / `deny` | 白名单 / 排除集（唯一扛得过 reload 的硬过滤）+ `reload()` |
| `tools.onResult` | `tool_result` |
| `context.override` | `context` / `context_with_system` |
| `extensions.add` / `skills.add` | loader 的注入表 + reload |
| `model.set` / `setThinking` | `session.setModel()` / `setThinkingLevel()`（不触发 reload） |

`permissions.gate` / `context.override` / `tools.onResult` 是**专属槽位**（单槽位，后一次覆盖前一次）。槽位与 `on()` 的关系有两条硬规则：

**① 槽位排在监听表之前生效。** 一条硬理由是安全顺序：`permissions.gate` 必须先跑，才能保证「门拦住之后，用户的 `on("tool_call")` 从不被调用」——否则被拦下的调用还是会出现在用户的监听器里，用户会以为它跑过了。

**② 槽位的结果计入同一个「已有非空结果」守卫。** 也就是：设了 `context.override` 之后，再用 `on("context", …)` 返回一个变换结果会**抛错**，而不是静默地只生效一个。若不留这条规则，「槽位 + `on()` 同时改同一件事」就会变成「后一个悄悄覆盖前一个」——正是 v2 要消灭的那种失效。

**桥接的合并规则**（与 pi 逐字对齐）：监听器按注册顺序执行、拿到的是**原始事件**；最后一个非空结果生效（last-wins）；判据是**真值**（`undefined` / `null` / `0` / `''` / `false` 都不算结果）；返回 `{block:true}` 立即短路。

**为什么桥接不能复刻 pi 的链式传递，于是选择抛错**：pi 里跨扩展返回变换结果时会**链式传递**（后一个扩展看到前一个处理后的结果）。但桥接是 pi 的**单个**扩展，pi 的跨扩展机制在它内部不生效——两个监听器都返回变换结果时，后者会覆盖前者，**前者做的活被静默丢弃**。本库的取舍是：宁可拒绝这种组合，也不静默丢一半。

**R47：非对象的真值（number / string / boolean / bigint）直接抛错，不当变换结果。** 危险写法是 `agent.on("before_provider_request", (e) => arr.push(e))` —— 一行箭头函数想收集事件，实际返回的是数组长度。

`arr.push` 返回数字（真值）⇒ 被当成变换结果 ⇒ pi 的 `before_provider_request` 对任何非 undefined 返回**整体替换 payload** ⇒ 请求里 0 条消息 ⇒ pi 静默重试 ⇒ **空文本、耗时 14 秒、没有任何报错**（探针实测 14265ms、provider 被调 4 次，`FACTS.md` #25）。pi 全部 `handlerResult` 消费点都解构对象字段，**没有任何事件接受非对象变换结果**；pi 自己只对 `user_bash` 做形状校验、对 `before_provider_request` 不设防。所以这一层守卫由库补上，错误文案直接给出正确写法（写块体）。**真值判据本身没改**——改成「非 undefined」会与 pi 分叉。

**错误可见性**：pi 的 `emitError` 只遍历 `errorListeners`、**没有任何 console 兜底**（`FACTS.md` #10），所以钩子里抛的异常在某些事件上会彻底消失。库注册了错误监听器把它们转成带 `[aiteam]` 前缀的 `console.error`（含事件名与扩展路径），并在每次 reload 后**重新挂载**（reload 会换掉 runner 实例，挂在旧实例上的监听器随之死掉，`FACTS.md` #9）。

### 3.3 R37 / R43 / R44：三个「谁压过谁」

同一件事在三个不同场景下会被问到，规则必须一致，否则使用者的预期会随场景漂移。

**统一原则：时间上更晚的显式声明胜；同一份声明内（创建期 spec）无法分先后时，更具体者胜。**

| 编号 | 场景 | 谁胜 | 为什么 |
|---|---|---|---|
| **R37** | 运行期 `tools.add(x)`，而 `x` 之前被 `deny` 过 | **add 胜**（add 解除同名 deny） | 点名 add 比之前的点名 deny **更晚**且同样具体。若不这样：新工具停在 `active:false`、模型静默收不到——设计者调了 `add` 却什么都没发生 |
| **R43** | **同一个 spec 内**：`permissions.deny: ["x"]`，而 `spec.extensions` 声明的扩展注册了 `x` | **deny 胜**（排除集比白名单更硬） | 并列、无法分先后 ⇒ 走具体性。`deny` **点名**了某一个工具；「声明一个扩展」是笼统地把它注册的**所有**工具带进来。前者更具体 |
| **R44** | **运行期**：先 `deny`，之后更晚的 `extensions.add` 注册了被 deny 的名字 | **add 胜**（并入白名单的同时摘掉排除集） | R37 的对称情形。若不这样，同一个逻辑情形会因为 deny 的来源不同而**结果相反**——创建期 deny + 更晚的 add ⇒ deny 仍胜（排除集没被摘）；运行期 deny + 更晚的 add ⇒ add 胜。同一原则两种结果就是不一贯 |

R43 与 R37 不矛盾：R37 说的是**运行期点名 add**（更晚、更具体），R43 说的是**同一份声明内并列**（只能比具体性）。

### 3.4 R41：显式声明一定生效

`permissions.only` 非空时，**你在同一个 spec 里显式声明的工具会自动并入白名单**：

1. `tools.custom` 里那些工具的定义名；
2. `extensions` 里**显式声明**的扩展 / 内联工厂所注册的工具名；
3. 运行期 `extensions.add(...)` 同理，把它新注册的工具名并进来（R44：同时摘掉排除集）。

**环境里自动发现的扩展不并入。** 理由是 v1 就定下、v2 继续沿用的：否则 `only` 的「精确」会被环境里碰巧存在的扩展悄悄撑开，等于绕过设计者写的能力裁剪。

**若不这样做会怎样**：设计者在同一个 spec 里两行之内写了白名单和扩展，扩展的工具却被 pi 的白名单**硬过滤**掉、无人并入——**两行声明，一行静默无效**。而这条与 R34（`defaultActive:false` 的工具 `add` 之后必须能收到）/ R37 **是同一条原则**：显式声明一定生效。考虑过并否决的替代方案是抛错 / 只警告——那会把库的机械约束转嫁给使用者：他明明写了扩展，却还得为了生效再去 `only` 里手抄一遍工具名。

**代价（必须知道）**：`only` 的「精确」被削弱成「精确 + 你在同一个 spec 里显式声明的工具」。另外，有白名单时的 `extensions.add` 需要**两趟 `reload()`**（第一趟之后才知道工厂注册了哪些名字），而 pi 的每次 reload 都会带 `session_shutdown(reason:"reload")` + 全部扩展工厂重跑 + 设置重载 + `resetApiProviders()` ⇒ **工厂副作用与生命周期事件会观察到双份**（`FACTS.md` #20）。无白名单时只有一趟（库里有短路）。

### 3.5 R38 与「三档优先级」：`only` / `allow` / `deny`

运行期三档语义互不重叠，**都是 async + 要求空闲**：

| 档 | 语义 | 底层 |
|---|---|---|
| `only(names)` | **精确**：允许的集合就是这些 | 白名单 |
| `allow(names)` | **并集**：启用这些（可以推翻之前的 `deny`） | 白名单 + 排除集摘名 + 显式激活 |
| `deny(names)` | **差集**：关掉这些 | 有白名单时从白名单删名；无白名单时记进排除集 |

**创建期只有 `only` 与 `deny`**（`permissions: { only?, deny?, gate? }`），**没有 `allow`**。这不是省略：创建时最常说的是「只给它这几个」，那是精确语义；而运行期 `allow` 是并集。**同名不同义是陷阱**，所以两边用不同的名字。

**R38：为什么这三档从「同步只改活跃集」改成了 async + reload。** 起因是实现者披露的一个天花板：`allow` 的立即生效只对**注册表里已有**的名字成立，被创建期白名单筛掉的名字要等下一次 reload——而契约规定这三个操作同步、不触发 reload ⇒ **设计者没有任何办法让它生效**，且 `tools.list()` 里连这个名字都看不到 ⇒ 一个**不可见的部分 no-op**。审理后采纳「改契约」而不是「写文档」，三条理由：

1. 它碰的是**声明面**（工具存在与允许的宇宙），与 `tools.add` / `extensions.add` / `skills.add` **同类**——后者全是 async + 需 idle，**同步才是异类**；
2. 它**简化**实现：原设计要「白名单负责持久 + 活跃集负责立即生效」两层都动，`reload()` 一步同时决定白名单过滤与活跃集，只剩一层机制；
3. 消除的是**静默失效**——本项目的立项理由。

代价：调用点从 `a.permissions.only([...])` 变成 `await a.permissions.only([...])`，运行中调用会抛（需先 `io.waitIdle()`）。后者正是我们想要的诚实。

**为什么裁剪必须落在「白名单 / 排除集」这一层，而不是只改活跃集**：`reload()` 会**重算**活跃集。凡是只改活跃集的收紧，都会被下一次任何声明面操作**静默抹掉**（`FACTS.md` #13）。这一条还有个反直觉的推论：即使想「我只要临时关掉一个工具」，也该用 `deny` 而不是去动活跃集——临时收紧要能扛过它后面随便一次 `tools.add`。

**为什么 `allow` 多一步「显式激活」**：这是三档里唯一保留第二层的地方，且是**拿测试答的**（删净后一条用例当场红）。原因是 pi 在这里有一处真实的不对称：无白名单时 reload 只把**扩展工具**按 `defaultActive` 推回活跃集，内置工具里没被点名过的不会自己回来——创建期被 `deny` 筛掉的内置 `bash` 就是这种。证据优先于优雅，所以留着这一层，且它有判别用例。

---

## 4. 结算：一次运行，一个归属单位

```
io.prompt("…")
  → 起点 agent_start
  → 终点 agent_settled
  → RunResult = { runId, text, usage, error?, messages }
```

**一次「运行」= `agent_start` → `agent_settled`。** `RunResult` 的归属单位就是**这一次运行**：

- `runId`：库生成，出现在 `RunResult` 上；钩子里通过 `ctx.runId` 读。研究里要 trace 与结果归因对得上，就需要这个关联键。**不往 pi 的事件对象上加字段**——那会破坏「原地改 `event.input`」这类变换钩子的约定；
- `usage`：**本次运行**的用量。别和 `agent.usage`（**全生命周期**累计）混——两者都叫 usage，语义必须靠类型注释与文档写死；
- `error?`：pi 对「接受之后失败」**不 reject**，只把错误写进消息。所以要显式看 `result.error`：光读 `text` 会把一轮失败读成「空回复」；
- `messages`：本次运行覆盖的**消息区间**（对象引用，不复制）。

### 为什么是 `agent_settled`，以及为什么 `messages` 不含 `system`

v1 的 `RunResult` 是「排干共享消息池取最后一条 assistant 消息」的结果，后果是**重叠投递时结果串台**（per-call 用量随之错，但三方累计值仍然对，所以对账查不出）。

v2 取 `agent_start` → `agent_settled` 作边界，因为 pi 明确 `agent_settled` 表示「不会再有任何自动重试、压缩、排队续跑」。**边界取错了，归属就是错的**，而归属错误不会有 симптом——它只会让研究数据安静地偏。

`messages` **不含 `system`**：pi 在**首次** prompt 时才把 system 消息写进会话，不过滤的话只有**第一轮**会多带一条，导致轮与轮之间不可比。system 是会话级的，不属于任何一次运行。要看会话原样（含 system）走 `context.raw.session.messages`。

### `queue` 的语义边界

- `queue` **永不因「目标忙」抛错**——这是它存在的理由（v1 `send()` 的同一件事：pi 的 `prompt()` 撞上目标 streaming 会直接抛错，而「目标正忙」在编排里是常态）。
- 但若**底层投递本身失败**（pi 拒收），`queue` **必须 reject**。把失败的投递报成 `{queued:true}` 是谎报——比 v1 的 `{delivered:"ran"}` 更糟。
- 忙时投进来的消息若被并进**同一次**运行，就明说它属于同一次（`messages` 区间里包含它），不再拿「已跑过」骗人；闲时 `queue` 会起一次**不 await** 的运行，这种运行的失败**必须经 `console.error` 浮出**（带 `[aiteam]` 前缀与 `runId`），不能只吞不报。要拿到结果与失败就用 `prompt()`。
- 一次运行的边界由 `prompt` **同步**确定（起手即记下消息下标），所以**并发 `prompt` 各自持自己的区间**，不会串台。

---

## 5. 明确不做

写下这些是为了让「为什么没有 X」不必每次重新论证一遍。

- **配置 DSL / YAML 解析器**——配置就是 TypeScript。加一层 DSL 会把类型检查从设计者手里拿走。
- **TUI**——那是 pi 的事。
- **沙箱**——pi 没有，本库也不承诺（见 §0）。
- **集群持久化与恢复、磁盘会话**——库在内存里工作；要落盘走各面的 `raw`。
- **agent 寻址 / 全局注册表**——设计者写代码编排时手里**就有** agent 引用，直接 `a.io.queue(…)`。v1 需要寻址只因为第二条路（agent 用工具驱动 agent）拿到的只有字符串 id；v2 里那条路已经是使用者代码，寻址随之失去理由。
- **任何轮次 / 预算 / 深度的强制护栏**——它们全是 L2 策略（§1 的三条假设就是其中三条）。要护栏，在自己的工具实现里加 `if`；要观测，用 `RunResult.usage` 累加 + `on("turn_end")`。
- **修 pi 本身的问题**（模型目录 warning、扩展静默失败等）——只在 L1 把它们变成**可读**的（`model.set` 把 warning 转成抛错；`extensions.errors()` 可读），不改 pi。

以及一条**分层纪律**（比上面任何一条都重要）：

```
L0  pi SDK（不动）
L1  aiteam —— 面的组织、运行期句柄、结算、原始事件透传
L2  你的代码 —— 花名册、委派、护栏、红线等一切策略
```

**L1 不做任何 SDK 已经做了的事。** 每加一个字段都要能回答「pi 为什么不能直接做这件事」。

**候选（本次未纳入，留待以后）**：采样参数一等（`model.sampling` 读写 seed / temperature，研究「同代码跑 N 次方差多大」的前提）、`[Symbol.asyncDispose]()`、带超时的 `prompt` / `waitIdle`、`snapshot()` / `restore(state)`、失败分类（`errorKind`）。

---

## 6. 从哪里开始读

| 想做的事 | 去哪 |
|---|---|
| 跑起来 | [`demo/README.md`](../demo/README.md) —— 一条命令验证本机装好了 |
| 学会用七个面 | [`docs/GUIDE.md`](GUIDE.md) —— 每个面一段；代码与 [`examples/lib/snippets.ts`](../examples/lib/snippets.ts) 同源 |
| 看一个完整例子 | [`demo/agent-team.ts`](../demo/agent-team.ts) —— 多 agent 协作写报告，七面全出场 |
| 看某个面的最小用法 | [`examples/`](../examples)：`01-first-agent.ts` … `08-raw-escape.ts` 一事一文件 |
| 看 v1 的三条假设怎么变成使用者代码 | [`examples/09-roster.ts`](../examples/09-roster.ts) / [`10-spawn.ts`](../examples/10-spawn.ts) / [`11-redline.ts`](../examples/11-redline.ts) |
| 查某个行为「为什么是这样」 | [`docs/FACTS.md`](FACTS.md)（已实测核对的 pi 事实）→ 本文相关节 → [v2 规格](superpowers/specs/2026-10-02-runtime-surfaces-design.md) |
| 看 v1 长什么样 | [`docs/archive/DESIGN-v1.md`](archive/DESIGN-v1.md) |

本文里凡是关于**库行为**的断言，都能在 [v2 规格](superpowers/specs/2026-10-02-runtime-surfaces-design.md) 的 §1 / §3 / §4 / §5 / §6 / §9，或 [`docs/FACTS.md`](FACTS.md) 的实测事实，或 [v2 核心计划](superpowers/plans/2026-10-02-aiteam-v2-core.md)（R1–R48 裁决）里找到出处。**没有出处的断言不该出现在这里。**
