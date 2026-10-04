# DESIGN.md 解读

> **这份文件不是设计源。** 设计源是 [`DESIGN.md`](DESIGN.md)，由你手写。
> 本文只做三件事：把 DESIGN.md 逐段转成「我理解成了什么」、列出它和 git 历史的差异、把含糊的地方编号成问题。
> 结论、裁决、字段名一律不在这里定；你的 DESIGN.md 怎么改，以你写的为准。

生成依据：工作区版 `docs/DESIGN.md`（未提交的手写版）对比 HEAD `a9edc1c` 的 `docs/DESIGN.md`（v2 自动生成版）；
以及 `src/surfaces/*.ts`、`src/agent/types.ts`、`docs/FACTS.md`、`docs/research/`，和 pi SDK `0.99.1` 的 `dist/**/*.d.ts`。

---

## 0. 已定 / 封存（2026-10-04 本轮答复）

**已定**

| 问题 | 你的答复 | 落到代码意味着什么 |
|---|---|---|
| Q1 设定（模板）归属 | **只是概念模型** | 库不提供模板登记 / 查找；模板就是使用者代码里的对象，`createAgent(spec)` 接它。模板的概念不变（入口被实验室取代，见 §3.6） |
| Q3 「赋予上下文」改哪一层 | **本轮 + 历史 + 整段重置，三样都要** | **已落地**：`override`（本轮）/ `replace`、`erase`（历史追改 / 抹除）/ `reset`（整段重置，仍是同一个 agent；不可编辑条目进返回值 `skipped`）。详见 §4.4 |
| Q5 自定义环境怎么强制 | **缺省拒绝** | 不显式给 `agentDir` 就抛错。后果见 §4.5（现已改为由实验室声明，见 §3.6） |
| Q2 项目对象 | ✅ 已澄清：**实验室**——环境本身，agent 必须先加入它、由它启动（见 §3.6） | 库多一个宿主对象；形态细节待定（Q-A…Q-D，见 §3.6） |
| Q-A 启动入口 | **只留 `lab.createAgent`** | 顶层 `createAgent` 不再导出。「必须加入实验室」是类型上的事实 |
| Q-B 环境声明 | **先逐项显式**，以后可能优化 | agentDir / cwd / skills / extensions / model 各一个字段；不先做约定推导 |
| Q-D 工作目录 | **共用实验室的** | 实验室就是隔离单位；要隔离就再开一个实验室 |
| Q4 工具 / 权限 | **不合并**，保持两个面 | `tools`（存在 + `onResult`）与 `permissions`（裁剪 + `gate`）各自独立；无 `tools.enable` |

**封存：等真实实验，现在不设计**

你两次说过同一件事：「等真正研究、实操、知道需要怎么用过后，我再亲自设计」「现在去设计完全是空想」。
所以下面这些**不是待答问题，是登记项**。本文不再就它们提方案。

| 登记项 | 展开在 |
|---|---|
| Q6 观测的粒度与去向 | §3.8 |
| Q7 `permissions` 的 raw 例外 | §3 |
| Q-C 实验室生命周期 | §3.6 |
| 上下文的压缩策略 / token 估算 / 落盘 | §4.6 |
| 以及 §5 全部 | §5 |

---

## 1. 逐段转写

「我的理解」一栏是我的转写，不是你的原话。**如果转写错了，是转写错，不是你写错。**

| DESIGN.md 原话（节选） | 我理解成了什么 | 现在库里对应的东西 | 差距 |
|---|---|---|---|
| 「agent 操控库：给研究员提供研究工具，可以搭建各种对于 agent 的实验」 | 使用者是**研究员**，产出是**实验**；库是实验台，不是产品 | 定位一致（README / AGENTS.md 都这么写） | 无 |
| 「是 SDK 上面薄薄的一层」 | 不重写 pi 已有的东西；每一层都要能回答「pi 为什么不能直接做」 | v2 的 L0/L1 纪律 | 手写版没保留这条纪律的表述 |
| 「研究工具的核心能力是提供那种绝对的操控能力」 | 「绝对」= 设计者的代码说了算，库不加策略、不替使用者做选择 | v2 第 0 节的「库不含任何策略」 | 同一件事，两处说法不同 |
| 「为分析研究提供材料的能力就是研究员可以通过代码暴露出他想要的信息来进行分析」 | 观测 = **可编程地取出**上下文、输入输出、工具调用等；不是日志、不是报告 | `agent.on` / `agent.onAny` / `RunResult` / `agent.usage` | 手写版没有点名这些机制 |
| 「必须要避免的就是过度的封装而导致操控能力下降，或者把它当做一个产品来开发」 | 两条禁令：**别包**（包一层就少一个能拧的旋钮）、**别产品化**（产品要替用户决定，研究工具不替） | v2「明确不做」清单 + 「L1 不做任何 SDK 已经做了的事」 | 手写版把「明确不做」整节删了 |
| 「研究员能够通过代码利用该库的 API 来控制 Agent 的状态、输入输出、上下文、工具、插件、Skills、model」 | 这七类就是**操控面**的总清单 | 七个面：`io` / `context` / `tools` / `permissions` / `extensions` / `skills` / `model` | 手写版把 `permissions` 并进了「工具」；没提观测面 |
| 「Agent 分为设定和使用两个部分。设定相当于把 Agent 的模板给定下来；使用时新开一个空白 Agent 对象，再把这个模板赋给该 Agent」 | **模板 → 实例**两段式；一个模板可以有多个实例 | `createAgent(spec)` 里的 `spec` ≈ 模板，返回值 ≈ 实例；实例靠 `agent.id` 区分（`a1`、`a2`…） | ✅ 已定：**只是概念模型**（Q1）。库不加模板登记 / 查找 |
| 「同一个模板可以有多个 Agent，通过 Agent ID 来区分」 | 一个模板 → N 个实例，`id` 是关联键 | `nextId()` 自增；`agent.id` | 无 |
| 「状态：获取 idle / running / disposed；控制即可以让该 agent disposed」 | 读状态 + 主动回收 | `agent.status`（只读）+ `agent.dispose()` | 无 |
| 「输出…就可以获取 Agent 的输出」 | 一次运行的结果要能拿到 | `io.prompt()` 的 `RunResult{text, usage, messages, error}` | 手写版没提「一次运行」这个边界概念 |
| 「输入分为两种：1. 排队输入…2. 截断输入：直接中断当前工作内容，立即发送」 | `queue` 和 `interrupt` | `io.queue()` / `io.interrupt()` | 已落地：`interrupt` 真的 abort 在飞那轮（`steer` 不 abort，只改向） |
| 「上下文…比较简单的可以分为：获取当前 Agent 的上下文和直接赋予 Agent 的上下文」 | 读 + 写；「赋予」听起来是**把整段上下文换掉**，比「改这一轮」强 | `context.history`（读）、`context.override`（改**这一轮发给模型的**）、`replace` / `erase`（改历史）、`reset`（整段重置） | Q3 已裁决并落地（§4.4） |
| 「工具也分两部分：可自定义工具、使用工具（就是 Agent 可以使用哪些工具的权限）」 | (a) 注册新工具 (b) 裁剪模型能用的工具集 | `tools.add/remove/onResult` + `permissions.only/allow/deny/gate` | v2 刻意拆成两个面（存在 vs 允许调用）。手写版把它们并提，见 Q4 |
| 「这部分的可操控性一定要强一点，因为有很多研究中的高级功能都是通过自定义工具来实现的」 | 自定义工具是主要研究手段，所以入口不能窄 | `tools.custom` + `AgentTool` | 无 |
| 「插件、Skill：这两个主要是给 Agent 配置使用的」 | 资源装载，不是研究变量本身 | `extensions.*`（含 `errors()`）、`skills.*` | 无 |
| 「model：该 Agent 用的模型和思考档」 | 换模型 / 换思考档 | `model.set` / `setThinking` / `current` / `available` | 无 |
| 「功能二：能够获得研究员想要的那个 Agent 的各种信息…就是能够暴露获取」 | 观测要**可编程取用**，且能覆盖到研究关心的任意切面 | `on` / `onAny` 直通 pi 全部事件；`RunResult`；`agent.usage` | ⚠️ 手写版把这一条压缩成一句，没说观测的**粒度**（原始事件 vs 归一化事件）与**去向**（只看还是要落盘） |
| 「必须使用自定义的环境，电脑中的 pi Agent 的环境是不能使用的。一切的插件、Skill、Key 都是要自己设置的」 | 环境隔离是**硬要求**，不是选项：不用宿主的 `~/.pi`、不用宿主的凭证、不用宿主的插件与技能 | `spec.agentDir` / `spec.cwd`；`AITEAM_AGENT_DIR` 环境变量；demo 第 8 项自检 | ⚠️ **今天不强制**：`agentDir` 缺省就是宿主目录（`create-agent.ts:42` → `getAgentDir()`）。硬要求要落到「缺省拒绝」还是「缺省自有 + 显式覆盖」？见 Q5 |
| 「这个环境的设置应该有一个规范，大致可以借鉴 pi agent」 | 环境要有**目录规范**（哪些文件、什么含义），照 pi 的形态来 | `agentDir` 下 `models.json` / `auth.json` / 技能 / 扩展 / `SYSTEM.md` | 「规范」还没被写下来过 |
| 「在真正研究 Agent 启动运行时，它必须要有一个项目对象来设置这些，比如：自定义环境设置的东西在哪里？agents 的工作目录在哪里？」 | 启动时要有一个**项目级对象**，统一回答「环境在哪、工作目录在哪」 | 现在这些字段散在每个 `AgentInit` 上（`cwd` / `agentDir` / `model` / `permissions`…） | ⚠️ **「项目对象」是新概念**，v2 里完全没有。它和 spec 的关系是什么？见 Q2 |

---

## 2. 与 git HEAD 的差异

### 2.1 HEAD 有、手写版没有（或只剩一句）

| HEAD 里的东西 | 手写版的状态 | 我要提醒的事 |
|---|---|---|
| **「库不含任何策略」** 这句立库之本的表述 | 只剩「必须避免过度封装」的意思 | 这句话是 v2 删掉 v1 花名册/委派/红线的**唯一理由**。删了它，下次有人往库里加「规矩」时就没有挡箭牌了 |
| **L0 / L1 / L2 分层纪律**（pi 不动 → aiteam 只做面的组织与结算 → 策略全在使用者代码） | 没有 | 这是「薄薄一层」的操作定义。没有它，「薄」只是形容词 |
| **七个面 vs「观测面」的边界**（`permissions` 无 raw；其余面都有 raw） | 没有 raw 的说法 | raw 是「绝对操控」的兜底出口。手写版强调「绝对」，但没写这条出路 |
| **忙判据 / 「哪些动作要求空闲」**（声明面改动要走 reload，不空闲时 reload 静默失效） | 没有 | 这是已经实测的坑（FACTS #3）；不写进设计，实现时必踩 |
| **结算：一次运行 = `agent_start` → `agent_settled`**，`RunResult` 的归属 | 没有（只有「获取输出」） | 研究要 trace + 对账时，运行边界取错会**静默**偏（v1 就踩过：重叠投递串台） |
| **`inspectEnv`**：只读回答「这套环境里实际生效了什么」 | 没有 | 和「功能二」同属观测，但它是**启动前**的自检，性质不同 |
| **「明确不做」清单**（DSL / TUI / 沙箱 / 持久化 / 寻址 / 护栏 / 修 pi） | 没有 | 这节的用途是「为什么没有 X 不必重新论证一遍」。不写就会反复被问 |
| **三个概念（成员 / 分身 / 花名册）的 v1→v2 处置** | 只剩「模板 / 实例」的说法 | 处置结论其实还在，但理由没了 |
| **v1 三条假设 = 使用者代码**（`examples/09`–`11`） | 没有 | 「策略不属于库」的**活证据**。删掉后，这句话就只是主张 |

### 2.2 手写版有、HEAD 没有

| 手写版新增的东西 | 我的判断 |
|---|---|
| **「Agent 分为设定和使用两部分」** | 这是 v1 的「成员 / 分身」概念的**回归**，但换了词、并且没说它是不是库功能。见 Q1 |
| **「为分析研究提供材料的能力」作为独立功能（功能二）** | HEAD 里它是散在 `on`/`usage`/`RunResult` 里的实现细节，没有作为**功能**单列。单列是对的 |
| **「必须使用自定义的环境」** | HEAD 只做了一层弱的 env 隔离（可传 `agentDir`），没有「必须」。这是**收紧**，影响 API 默认值 |
| **「项目对象」** | HEAD 完全没有。这是本次手写版里最大的新结构 |
| **「环境的设置应该有一个规范」** | HEAD 没有环境规范文档 |
| **「避免过度封装」作为一条禁令** | HEAD 只有「L1 不做 SDK 已做的事」，没有从**操控能力**角度提这条 |

### 2.3 同一件事、两处名字不同

| 手写版用语 | HEAD / 代码里的名字 | 备注 |
|---|---|---|
| 截断输入 | `io.interrupt` | 语义一致（`io.steer` 只改向，**不中断**） |
| 排队输入 | `io.queue` | 语义一致 |
| 直接赋予 Agent 的上下文 | `context.override` | ⚠️ **语义可能不等价**：「赋予」像整段替换历史，「override」明确只改这一轮 |
| 使用工具（权限） | `permissions` 面 | 手写版把它挂在「工具」下 |
| 设定 / 模板 | v1 的 Member / 花名册 | 同一个东西的两个名字 |
| 项目对象 | 现在的 `AgentInit`（每个实例一份） | ⚠️ 可能是两个不同层级的东西 |

---

## 3. 待澄清清单

每条只问一件事。你答完哪条，我就在 DESIGN.md 里看到你手写的那段话，不再追问。

### 3.5 先解释：`spec` 现在有什么用（Q2 的前置）

`spec`（代码里的名字是 `AgentInit`）是 `createAgent(spec, deps?)` 的第一个参数，**一个实例的创建期声明**。
它今天承载这些东西（`src/agent/types.ts:30-62`）：

| 字段 | 类型 | 作用 |
|---|---|---|
| `id` | `string?` | 指定实例 id；不给就自增（`a1`、`a2`…） |
| `cwd` | `string?` | 工作目录；缺省 `process.cwd()` |
| `agentDir` | `string?` | **环境目录**：`models.json` / `auth.json` / 技能 / 扩展 / `SYSTEM.md` 都从这里找；缺省宿主 pi 目录 |
| `modelNetwork` / `catalogBaseUrl` | | 模型目录是否联网刷新、从哪拉 |
| `model` / `thinking` | `string?` / 档位 | 模型与思考档，形如 `"anthropic/claude-opus-4-5:high"` |
| `skills` / `extensions` / `role` | `ResourceSpec` | 装载哪些技能、插件、角色文本 |
| `permissions` | `{only?, deny?, gate?}` | 能力裁剪与审批门（创建期只有 `only`/`deny`，没有 `allow`） |
| `tools.custom` | `AgentTool[]` | 自定义工具 |
| `context.autoCompact` | `boolean?` | 自动压缩初值 |
| `deps.modelRuntime` | 第二个参数 | 直接注入一个 model runtime，绕开按 `agentDir` 取共享实例 |

**它今天同时干了两件不同层级的事**：

1. **模板**——同一个 `spec` 对象传多次就得到多个实例，字段完全一样。这一半就是你说的「设定」。
2. **环境配置**——`cwd` / `agentDir` / 模型目录源 / 凭证。这些是**一台机器、一个项目**的属性，不是某个 agent 的属性。

你的「项目对象」要解决的正是第 2 件：把它从每个 `AgentInit` 里抽出来，变成一次配置、多处继承。
所以 Q2 的三条选项，实际是在问：**抽出来之后，它只提供缺省值，还是变成一个 agent 必须挂靠的容器？**

---

**Q1 ✅ 已定：只是概念模型**

库不提供模板登记 / 查找。模板就是使用者代码里的一个普通对象，`createAgent(spec)` 接它，同一个对象可以传多次。
**反面（被否决）**：库提供 `defineMember` / 花名册表，`createAgent` 按 id 取模板 —— 那是 v1 的形态，等于把策略请回库里。

**Q1（原始问法，保留备查）：「Agent 的设定」是库的概念模型，还是库的字段？**
「同一个模板可以有多个 Agent」今天已经成立（`spec` → 实例 → `id`）。歧义在**模板本身归谁**：
- (a) **概念模型**：模板就是使用者代码里的一个普通对象，库只负责 `createAgent(模板)`。写法上库不提供 `defineMember()` 之类的东西。→ 与 v2 一致。
- (b) **库功能**：库提供模板的登记/查找（类似 v1 的 `members`），`createAgent` 按 id 取模板。→ 等于把 v1 的花名册请回来。
你写的是「**本库**对于 agent 的设定、理解」——「本库」两个字偏向 (b)，但「设定相当于把模板给定下来」又像 (a)。

**Q2：「项目对象」是什么？它和 `spec` 是两层还是一层？**
我读到的信息是：环境设置在哪、agents 工作目录在哪，这些要在**启动时**由一个对象统一给出。现在这些字段是**每个 `AgentInit` 各带一份**。
- (a) 项目对象 = 环境级的默认值（`agentDir` / `cwd` / 模型目录 / 凭证），`createAgent` 缺省继承、实例级 spec 可覆盖。→ 一层配置 + 一层覆盖。
- (b) 项目对象 = 一个**运行容器**，所有 agent 必须挂在它下面，由它管工作目录、产物目录、进程生命周期。
- (c) 只是你自己的使用者代码里约定一个对象，**不进库**。
这条决定了库有没有第三个对外入口。

**Q3 ✅ 已定：三样都要**（本轮 / 历史 / 整段重置）。落地方案见 §4.4。

**Q3（原始问法，保留备查）：「直接赋予 Agent 的上下文」改的是哪一层？**
pi 里能改的层次有三个，代价完全不同：
- (a) **本轮**：只改这一次发给模型的内容，历史不动 → 就是现在的 `context.override`。
- (b) **历史**：把会话里已有的某一轮内容换掉或删掉（pi 有 `appendContextEdit`，是追改、append-only）。
- (c) **整段重置**：清空历史重来（pi 没有清空 API，只能新建 agent，或直接换 session）。
你写的「赋予」更像 (b) 或 (c)。选哪个，决定 `context` 面长什么样。

**Q4 ✅ 已定：不合并**，保持两个面。依据见 §3.7。

**Q4（原始问法，保留备查）：「工具」和「权限」是一个面还是两个面？**
v2 拆成两个：`tools` = 有哪些工具**存在**，`permissions` = 哪些**允许被调用**。
你把它们写在同一条下（「工具也分两部分」）。这是(a) 只是行文并提，实现上仍是两个面，还是(b) 你真的想要一个「工具面」把它们合起来？
（提醒：`tools.enable` 和 `permissions.allow` 一旦并存就会变成同一个东西，这是 v2 拆开的理由。）

**Q5 ✅ 已定：缺省拒绝**。后果见 §4.5。

**Q5（原始问法，保留备查）：「必须使用自定义的环境」怎么落到代码？**
今天 `agentDir` 缺省 = 宿主 pi 目录。三种落法：
- (a) **缺省拒绝**：不显式给 `agentDir` 就抛错，逼使用者面对。
- (b) **缺省自有**：缺省给一个独立目录（如 `./.aiteam`），用了宿主目录才警告/抛错。
- (c) **只自检**：像现在 demo 第 8 项那样，`inspectEnv` 报出来，不拦。
「必须」两个字偏 (a)/(b)，但 (a) 会让每个最小示例都得先配环境。

**Q6 封存：观测的粒度与去向**（事实见 §3.8）。
- 粒度：`on`（按名收窄）+ `onAny`（全量原始）今天都在。要不要再加一层归一化事件（v1 有，v2 删了）。
- 去向：要不要落盘。

**Q7 `permissions` 没有 raw 出口的那个例外（封存）**
v2 的规矩是「除 `permissions` 外每个面都有 raw」。这条不对称是有理由的（pi 的白名单是私有字段，没有公开对象可指），但它是需要背的例外。

**Q8 ✅ 已办**：本文就是那个登记处（§5）。

---

### 3.6 实验室（= 项目对象）：你的澄清

你的原话：「项目对象相当于就是实验室这个本身这个环境，就比如说这个声明实验室，它的 key 是什么？工作目录、
skill、插件在哪里？等等等等，这是实验室环境。如果要启动 Agent，就必须把 agent 加入实验室环境，由实验室环境来启动。」

**我的转写。** 这不是「给 `spec` 补默认值」，而是一个**宿主对象**。它有三个性质：

1. **环境所有者**——key / 模型目录 / 工作目录 / skill 位置 / 插件位置，都是它的属性，一台机器声明一次。
2. **唯一启动入口**——agent 不能自己跑起来，必须由实验室启动。
3. **归属**——每个 agent 属于某个实验室（至少创建时如此）。

**对照 v1。** v1 里已经有这个东西，叫 `createAgentHost(opts)`（`archive/DESIGN-v1.md` §4.3）：

```ts
HostOptions { members?, maxAgents?, maxDepth?, budgetTokens?, modelRuntime?, defaults?: Partial<MemberSpec> }
AgentHost   { usage, activeCount, on(...), list(), get(id), dispose() }
```

所以 **实验室 ≈ v1 的 host − 花名册 − 三道护栏 + 「它是启动入口」**。
（花名册与护栏已经被你归为使用者代码，Q1 也确认了模板不进库。）

**一个关键反转。** v1 的注释里写着（逐字）：

> 刻意**不提供** `host.createAgent()`——避免出现第二条创建路径。

你现在要的正是 `lab.createAgent()`。这是有意推翻 v1 的取舍，不是遗漏——但它得写下来，因为理由变了：v1 把 host 当作可选的花名册容器，所以「创建」保持在库顶层；你把实验室当作**环境本身**，环境不进 agent 才是危险的。

**与 Q5 的关系（顺便变好了）。** 「缺省拒绝」原本要落在每个 `createAgent` 调用点上（`examples/` 与 `demo/` 全改）。
改由实验室声明环境之后，落点变成「**实验室必须声明环境**」——一台机器声明一次，`createAgent` 根本不需要看到 `agentDir`。
§4.5 里那三条后果，前两条随之简化。

**你的四条答复**（2026-10-04）

| # | 答复 | 含义 |
|---|---|---|
| Q-A 启动入口 | **只留 `lab.createAgent`** | 顶层 `createAgent` 不再导出。这与 v1 「只留一条创建路径」的取舍同向，但落点从「顶层唯一」变成「实验室唯一」。同时也意味着 `inspectEnv` 要重新定位（它现在自己接 spec + agentDir，见下） |
| Q-B 环境声明 | **先逐项显式**（agentDir / cwd / skills / extensions / model），以后可能优化成约定推导 | 实验室的 `opts` 字段直写，不先发明目录约定。你说的「借鉴 pi agent 的规范」作为以后优化的方向 |
| Q-C 生命周期 | **暂不设计** | 「后面经过真实检验后，可能会设计，现在设计只是凭空想象」→ 已归入 §5 封存 |
| Q-D 工作目录 | **共用实验室的 cwd** | 实验室就是隔离单位；要隔离就再开一个实验室 |

**由 Q-A 带出来、还没定的一件小事**：`inspectEnv(spec?)` 今天自己接 `agentDir` 并回落到宿主目录（`env.ts:57`）。
实验室成为环境所有者之后，环境自检有两个合理位置：`lab.inspectEnv()`（查这个实验室的环境）或保持顶层但要求给实验室。
这不需要现在定，但别让它成为第二个「绕过实验室就能拿环境」的口子。

---

### 3.7 工具 vs 权限：事实上的区别（Q4 的前置）

| | `tools` 面 | `permissions` 面 |
|---|---|---|
| 输入 | `AgentTool`（定义 / 工厂） | `string[]`（工具名） |
| 管什么 | 工具**存在**：注册与注销 | 工具**能被模型拿到 / 能被调用**：裁剪与放行 |
| 成员 | `add` / `remove` / `list` / `onResult` | `only` / `allow` / `deny` / `gate` |
| 底层 | `bridge.tools` 表 + `allowedToolNames` + `reload()` | `_allowedToolNames` / `_excludedToolNames` + `reload()`（`allow` 多一步活跃集） |
| 要求 idle | 是 | 是 |

**各自独有、对方完全没有的两个成员：**

- `tools.onResult`——改工具**跑完之后**返回给模型的内容（`tool_result` 钩子）。权限面不碰这个。
- `permissions.gate`——工具**被调用时**拦截（`tool_call` 钩子），能看参数、能原地改参数、能拦。工具面没有这个。

**唯一的重叠区：哪些工具在活跃集里。** `tools.add` 必须动它（否则加了不生效，R37），`permissions.only/allow/deny` 专门动它。

**实操上「缺一不可」的例子**——想让 agent 只用一个自定义 `search`：

```ts
await agent.tools.add(searchTool);          // 造：把定义注册进去
await agent.permissions.only(["search"]);   // 挑：只让模型看到它
```

- 只 `add` 不 `only`：内置工具还在，模型照样能调 `bash`。
- 只 `only` 不 `add`：`search` 压根没注册过。R41 只会把**同一个 spec 里显式声明**的工具并进白名单，运行期 add 是另一条路。

**结论：不合并（已定）。** 重叠只在「活跃集」这一格；`onResult` 与 `gate` 各归各。
两个面共用同一份 filters 访问器、代码同在一个文件，但**对外保持两个面**：
使用者接受「加工具走 tools、挑工具走 permissions」这个记忆代价，换来每个面的输入形状和时机都单一。

---

### 3.8 观测：粒度与去向（Q6 的完整事实）

**粒度：四层，今天有的是 L2 / L3 / L4。**

| 层 | 是什么 | 今天 | 备注 |
|---|---|---|---|
| L1 归一化事件 | 把 pi 的事件翻译成自制的一套（v1 是 7 个：`text` / `thinking` / `tool_start` / `tool_end` / `turn` / `error` / `done`） | **v2 删了** | 理由（spec D5）：**有损**——丢了 `compaction_*`，压缩对设计者不可见；而「归一化」是使用者约 10 行 helper，原始透传则是使用者**做不到**的。附带：v1 承诺载荷可序列化，实测 `JSON.stringify` 抛 `Theme not initialized` |
| L2 原始事件 | `agent.on(name, fn)` 按名收窄 + `agent.onAny(fn)` 全量 | ✅ | **41 个事件名**，与 `ExtensionEvent["type"]` 逐字对应；`bridge.ts:57` 有编译期完整性检查（pi 新增事件名会报错，不会静默漏透传）。返回真值 = **变换事件**，不只是「看」 |
| L3 结算 | `RunResult { runId, text, usage, error?, messages }` | ✅ | 归属单位是 `agent_start` → `agent_settled` |
| L4 累计 / 快照 | `agent.usage`（全生命周期）、`context.usage`（当前占用）、`getSessionStats()`（含被压缩掉的历史）、`inspectEnv()` | 部分 | 后两个 pi 有，库没暴露 |

**去向：三个问题。**

1. **推还是拉**——推 = 回调（`on` / `onAny`），拉 = 句柄（`RunResult` / `usage` / `history`）。今天两者都有。
2. **活多久**——今天只有「当次回调」与「全生命周期累计」两个极端。**中间层全缺**：没有 `lastResult`（v1 有，v2 删了）、没有「这个 agent 跑过哪些 run」的记录。
3. **落在哪**——今天**只在内存**：`createAgent` 用的是 `SessionManager.inMemory(cwd)`（`create-agent.ts:154`），没有 session 文件、没有 JSONL。pi 侧现成的出口：`exportToJsonl(path)` / `exportToHtml()` / `getSessionStats()` / `SessionManager.inMemory(cwd, opts, entries)`（可**用 entries 预置**会话）。v2 立场：库不落盘，要落盘走 `raw`。

**此项已封存**（你说：等真正实验时再设计，现在设计是空想）。上面是事实清单，不是要你现在选的菜单。

---

## 4. 专题：上下文的操控能力

这一节回答你问的问题：「pi 有上下文管理，这个库理想状态能提供哪些操控能力」。

### 4.1 pi 已有的原语

| 原语 | 在哪 | 干什么 | 附带代价 / 陷阱 |
|---|---|---|---|
| `context` 钩子 | 扩展事件 | 每次 LLM 调用前给一份**不含 system** 的消息数组，可返回替换后的数组 | 拿到的是**副本**；不含 system；改的是「这一轮」 |
| `context_with_system` 钩子 | 扩展事件 | 在 `context` 之后跑，**含 system**；可整段替换 transcript，此时 system 与工具声明由 handler 自己负责 | 覆盖整段，容易连系统提示一起弄丢 |
| `session.messages` | `AgentSession` | 读全量消息（含 custom / bash） | **只有 getter，没有 setter**——不能整体写回 |
| `session.systemPrompt` | `AgentSession` | 读当前生效的系统提示（含尚未发出的改动） | 只读；替换要走 `before_agent_start` 返回 `systemPrompt` |
| `session.getContextUsage()` | `AgentSession` | `{tokens: number\|null, contextWindow, percent: number\|null}` | 数据来自上一次响应的 usage；**刚压缩完是 null** |
| `session.compact(instructions?)` | `AgentSession` | 手动压缩：生成摘要、裁掉旧 entry。`instructions` 可自定义摘要关注点 | **首行就是 `await abort()`**——会打断在飞那轮；会话太小抛 `Nothing to compact` |
| `session.abortCompaction()` / `isCompacting` | `AgentSession` | 取消压缩 / 观察压缩是否在跑 | — |
| `setAutoCompactionEnabled()` / `autoCompactionEnabled` | `AgentSession` | 自动压缩开关 | — |
| `settings.compaction` | `Settings` | `{enabled, reserveTokens, keepRecentTokens}`——裁剪策略参数 | 目前只在 settings 文件层，库没暴露 |
| `session_before_compact` 事件 | 扩展事件 | 压缩**前**：拿到 `preparation`（要摘要哪些消息、保留哪些）、`reason`（manual/threshold/overflow）、`willRetry`；可 `cancel` 或**直接给一份 `compaction` 结果** | 这是「自己决定怎么压」的正门 |
| `session_compact` / `session_compact_failed` | 扩展事件 | 压缩成功/失败后 | 失败事件里有 `reason` 与 `errorMessage` |
| `turn_end` / `agent_before_settle` 的 `BoundaryResult` | 扩展事件 | 在轮次结算/最终结算前 **append entry 并继续**：可以追加 `custom_message`、**`context_edit`**、`compaction` | 最强的「事后改上下文」入口 |
| `sessionManager.appendContextEdit(targetId, replacement\|null)` | `SessionManager` | **追改**：把早先某条 entry 在本轮上下文里的贡献换成新内容，或 `null` 直接**从上下文里抹掉**。原 entry 不动 | 这是「改历史」的正道，append-only、可审计 |
| `sessionManager.appendCustomMessageEntry(customType, content, display, details)` | `SessionManager` | 往上下文注入一条 user 角色的消息；`display` 只管 TUI 怎么渲染 | — |
| `navigateTree(targetId, {summarize, customInstructions, replaceInstructions, label})` | `AgentSession` | 跳到会话树另一节点，可对被放弃的分支生成摘要接回上下文 | 有 abort 风险 |
| `branch(id)` / `getTree()` / `getBranch()` / `buildSessionProjection()` | `SessionManager` | 会话树：分支、遍历、投影出「实际发给模型的 messages」 | 投影是理解「上下文到底长什么样」的关键对象 |
| `exportToJsonl()` / `exportToHtml()` / `getSessionStats()` | `AgentSession` | 导出会话 / 统计（**含被压缩掉的历史**，反映真实计费） | — |
| `estimateTokens()` / `findCutPoint()` / `prepareCompaction()` / `generateSummary(customInstructions)` | compaction 纯函数 | 自己算 token、自己选裁剪点、自己写摘要 prompt | `estimateTokens` 是 chars/4 启发式；研究记录里实测**严重低估**（1.5–1.6 字符/token） |
| `before_provider_request` 事件 | 扩展事件 | 可整段替换请求 payload | 返回任何非 `undefined` 值即替换，一行 `arr.push(e)` 就能把请求清空 |

### 4.2 库里现在有什么

`context` 面（`src/surfaces/context.ts`）只有五项：`history`（读，不含 system）、`usage`（读）、`autoCompact`（读写）、`override`（改**本轮**）、`compact(instructions)`（手动压，带 idle 守卫）、`raw`。
另外 `on("session_before_compact")` / `on("turn_end")` / `on("agent_before_settle")` 今天就能用——但那是**原始事件**，不是一等接口。

### 4.3 理想状态可以分成四层

按「改动的持久程度」排，从浅到深：

**T0 观测（今天基本齐了，只差落盘）**
- 读历史（`history`，不含 system）与读原始（`raw.session.messages`，含 system）
- 读占用：`tokens` / `contextWindow` / `percent`（缺 `null` 时的处理）
- 读生效中的系统提示（`raw.session.systemPrompt`）
- 看「实际发给模型的 messages」（`raw.sessionManager.buildSessionProjection()`）——这是「上下文」二字的**准确含义**，比 `history` 更贴
- 全量事件（`onAny` / `on`）+ 运行结算（`RunResult`）+ 生命周期累计（`agent.usage`）
- 缺：导出（`exportToJsonl` / `getSessionStats`）没进一等接口

**T1 改本轮（今天有 `override`，够用）**
- 替换/裁剪这一轮发给模型的消息
- 替换这一轮的系统提示（`before_agent_start` 返回 `systemPrompt`）——**今天没进一等接口**，虽然原始事件能收
- 改这一轮的工具声明（归 `permissions` / `tools`）

**T2 改历史（今天的真缺口，也是「赋予上下文」的落点）**
- **追改**：把某一轮的某条消息换掉（`appendContextEdit(targetId, {content})`）
- **抹除**：把某一轮从上下文里删掉（`appendContextEdit(targetId, null)`）——这是研究「死消息占 token」（研究 S-23）的正面手段
- **注入**：插一条自定义消息（`appendCustomMessageEntry`）——黑板上写一行、给模型塞一条提示
- **重置**：清空重来。pi 没有这个 API，只能新建 agent 或换 session（这本身就是一条设计约束，值得写进 DESIGN.md）
- **分支 / 回滚**：`branch` + `navigateTree` + 分支摘要
- 提交时机：这些是 append-only entry，写完后在当前轮**下一次**请求生效；不需要 reload

**T3 压缩与预算（部分齐）**
- 触发：手动 `compact(instructions)` ✓、自动开关 ✓
- 观察：`isCompacting`、`session_before_compact` / `session_compact` / `session_compact_failed` ✓（原始事件）
- 介入：`session_before_compact` 里 `cancel` 或**自己给一份压缩结果** ✓（原始事件）
- 策略：`reserveTokens` / `keepRecentTokens` ✗（只在 settings 文件层）
- 自定义摘要：`compact(instructions)` ✓；完全替换摘要 prompt 要自己调 `generateSummary` ✗
- 自选裁剪点：`findCutPoint` / `prepareCompaction` 是纯函数，能自己算 ✗（没暴露）
- 估 token：`estimateTokens` 低估，自己估更准——这是**已知的实测结论**，不是猜测

### 4.4 Q3 的落地：三层「赋予上下文」

你选了三样都要。pi 侧三层各有不同的机关，**不能合成一个 API**：

| 层 | 语义 | pi 侧的机关 | 持久性 | 要不要 idle |
|---|---|---|---|---|
| **本轮** | 只改这一次发给模型的内容 | `context` 钩子（= 现在的 `context.override`） | 一次性，下一轮消失 | 不要 |
| **历史（追改）** | 把已有轮次换掉 | `sessionManager.appendContextEdit(targetId, {content})` | append-only entry，永久 | 不要 |
| **历史（抹除）** | 把已有轮次从上下文里删掉 | `sessionManager.appendContextEdit(targetId, null)` | append-only entry，永久 | 不要 |
| **整段重置** | 清空重来 | **pi 没有这个 API** | — | — |

**已落地** —— `context.reset()`：对每条**可编辑** entry 逐条 `appendContextEdit(id, null)`（即下面的路径 (c)），仍然是同一个 agent；不可编辑条目（system / 压缩摘要）进返回值 `skipped`。

「整段重置」要自己造，可选路径有三条，代价不同：

- (a) **换 session**：丢弃当前 `SessionManager`，用 `SessionManager.inMemory(cwd)` 建一个新的，重新装载资源 + `reload()`。等价于「把这个 agent 的会话重开」，`agent.id` 与七个面的引用能保留。
- (b) **新建 agent**：`dispose()` 旧的，`createAgent(同一个 spec)` 新的。最干净，但 `id` 变了、闭包里的引用失效。
- (c) **只 mark**：不真清，用 `appendContextEdit` 逐条抹除。能精确留痕，但 N 条要 append N 次。

哪条当正门，是要你定的下一件事。提醒：**「重置」必须留下痕迹**——研究里「清空过」这个事实本身是数据，不是实现细节。

### 4.5 Q5 的落地：缺省拒绝的连带后果

- 每个 `createAgent` 调用点都必须给 `agentDir`，否则抛错。**`examples/` 与 `demo/` 全部要改**。
- `AITEAM_AGENT_DIR` 环境变量与 `defaultAgentDir()`（`create-agent.ts:42`）的定位要重新想：它现在是「缺省值」，在缺省拒绝下要么删掉、要么降级成「显式声明的一种写法」。
- `inspectEnv(spec?)` 也必须给 `agentDir`（它现在会回落到宿主目录，`env.ts:57`）。
- 好消息：demo 第 8 项自检（「只认自己的技能与插件」）已经从**判据**变成了**契约**——它不再是提醒，而是库保证的行为。

### 4.6 本节的开放项（已封存）

**已定**：「赋予上下文」三层都要（§4.4）。

下面这些需要真实实验才能判定，**归入封存，现在不设计**（登记在 §5）：

- 「整段重置」走哪条路（换 session / 新建 agent / 逐条抹除）
- 压缩要不要做成可介入的策略，而不只是开关
- token 估算要不要自己做（pi 的 `estimateTokens` 已知低估）
- 「材料」要不要落盘
- 观测用原始事件还是归一化事件

---

## 5. 按你说的封存的部分

你的话：「等真正研究、实操、知道需要怎么用过后，我再亲自设计」「现在去设计完全是空想」。
**本文不回答、不推荐、不替你想。只登记，好让它们不消失。**

登记项：

- 实验室的生命周期与级联回收（Q-C）
- 实验室环境声明从逐项显式 → 约定推导的优化（Q-B）
- 环境规范的目录布局与文件含义
- 云端 provider / 凭证来源的约定（`models.json` / `auth.json` 之外还有什么）
- 多个 agent 的工作目录划分、产物归置
- 观测的粒度与去向：归一化层、中间保留层（run 记录）、落盘（Q6 / §3.8）
- `permissions` 的 raw 例外（Q7）
- 上下文的：「整段重置」走哪条路、压缩策略是否可介入、token 估算归谁（§4.6）

等你有真实使用经验后，在 DESIGN.md 里手写。

---

## 6. 术语表（读 DESIGN.md 会遇到的东西）

只解释本文与 DESIGN.md 里出现过的名字，不展开设计。

| 名字 | 是什么 |
|---|---|
| `agentDir` | pi 的**用户级配置根目录**。默认 `~/.pi/agent`（pi 可用 `PI_CODING_AGENT_DIR` 覆盖）。详见下面 §6.1 |
| `cwd` | agent 的**工作目录**（项目级）。`<cwd>/.pi/` 下的技能/插件/上下文文件跟着它走 |
| `spec` / `AgentInit` | `createAgent` 的第一个参数，一个实例的创建期声明。字段表见 §3.5 |
| `deps` / `CreateAgentDeps` | `createAgent` 的第二个参数，今天只有一个字段：注入 `modelRuntime` |
| `reload()` | pi 的重载：重跑全部扩展工厂 + 重载设置 + `resetApiProviders()` + 重建工具注册表与活跃集。库里的增删都要走它，而且**只能在空闲时** |
| `raw` | 每个面（除 `permissions`）的逃生口，指向对应的 pi 对象。全权、无护栏、无忙判据 |
| idle / busy | `idle` = 没有在飞运行也没有排队消息。改声明面（工具/插件/技能/权限/compact）要求 idle |
| `steer` | 运行中**改向**：在飞那轮的工具调用跑完后、下一次 LLM 调用前投递，**不 abort**。真中断见 `io.interrupt` |
| `queue` | 排队投递：不影响当前工作，等空闲再发。目标忙时**不报错** |
| `gate` | 审批门：工具**被调用时**拦截（`tool_call` 钩子），能看参数、原地改参数、能拦 |
| settle | 一次运行的终点：`agent_start` → `agent_settled`。`RunResult` 的归属单位 |
| `inspectEnv` | 环境自检：只读回答「这套环境里实际生效了什么」。详见 §6.2 |

### 6.1 `agentDir` 里面有什么

pi 在这里找（都是它自己认的约定）：

| 路径 | 作用 |
|---|---|
| `auth.json` | **凭证**（API key） |
| `models.json` | 模型目录 / 自定义 provider |
| `models-store.json` | 联网刷新下来的 overlay 缓存（pi.dev，带新鲜度窗口） |
| `settings.json` | 全局设置 |
| `skills/` · `extensions/` · `prompts/` · `themes/` | 自动发现的技能 / 插件 / 提示词模板 / 主题 |
| `SYSTEM.md` | 全局系统提示词（**整体替换**） |
| `APPEND_SYSTEM.md` | 追加到系统提示词的尾巴 |
| `sessions/` | 会话存档 |
| `bin/` · `pi-debug.log` | 可执行文件目录 / 调试日志 |

**两个目录的分工**：`agentDir` = 用谁的身份与装备（key / 模型 / 插件 / 技能 / 系统提示词）；`cwd` = 在哪里干活。

**aiteam 里**：`defaultAgentDir()` = `AITEAM_AGENT_DIR` 环境变量 → 否则 `getAgentDir()`（即回落宿主 pi 目录，`create-agent.ts:42`）。
所以「使用自定义环境」这句话落到代码上，就是「让 `agentDir` 指向你自己的目录」——demo 的第 8 项自检查的就是这个。

### 6.2 `inspectEnv` 是什么

库的第二个出口（另一个是 `createAgent`）。签名：`inspectEnv(spec?, deps?) → EnvReport`，**只读**：
不建 session、不改行为、不写盘、不新增创建路径。

它做的是「把 pi 的自动发现摊平」：pi 把 `agentDir` 与 `cwd` 里碰巧存在的东西**静默**接进会话，
inspectEnv 把那些东西列成一张单子：

| 报告字段 | 回答的问题 |
|---|---|
| `agentDir` / `cwd` | 实际用的是哪两个目录 |
| `models` | 哪些 provider 配好了凭证、现在能用哪些模型 id |
| `extensions` | 环境里发现哪些插件、各自注册了哪些工具名 |
| `skills` | 发现哪些技能、名字、文件路径、来源范围 |
| `systemPromptFile` | 有 `SYSTEM.md` 吗（有就是**整体替换**系统提示词） |
| `appendSystemPromptFiles` | `APPEND_SYSTEM.md` 链 |
| `contextFiles` | `AGENTS.md` / `CLAUDE.md` 链 |
| `warnings` | 「agentDir 不存在」「没有 `models.json`」「没有任何可用模型」「扩展加载失败」「技能诊断」…… |

它存在的理由：库把 `agentDir` 与 `cwd` 的自动发现交给了 SDK，**那里碰巧存在的东西会静默生效**。
inspectEnv 就是回答「为什么我一个模型都没有」「我装了插件为什么没生效」的那个入口。

demo 的第 8 项自检（「环境隔离：只认自己的技能与插件」）用的就是它。
