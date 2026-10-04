# AGENTS.md

> ## ⚠️ 两条硬规则（先看这里）
>
> **① 启动 subagent —— 一律不传模型名，用会话默认模型。**
> 留空即用会话默认模型。**不要**为了「这活要更强的推理」而指定 `model` 参数：
> 那是在替使用者做一件他没要求的事，而且会让额度以一种没人察觉的速度流走。
> 派 subagent 时**只给**任务、文件路径、判据；不给模型。
>
> **② 配置 agent 集群 / 示例 / demo 的 agent —— 模型默认用 `(opencode-go) space-bunny-free`。**
> 这是本项目配置真实模型时的默认选择。
>
> 例外：用**本机假 provider**（`faux/*`，见 `test/faux-models.ts`、`examples/lib/faux-models.ts`）的那些 agent 不在此列 ——
> 它们是离线、零成本、有判别力的测试基建，**不要**换成真模型。

本文只描述**这个项目是什么**，不描述怎么做。开发流程、纪律、下一步计划不在本文范围内。

---

## 一句话

**aiteam 是一个 Agent 操控库**——基于 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，给设计者的代码一双手，在运行期**读、改、拦截**一个 agent 的七个面。非常基础、非常底层。

**库不含任何策略。** 花名册、委派、护栏、红线都是**使用者代码**——想让 agent 拥有哪种集群形态，那是你的代码的事，不是库的字段。

## 三个概念

| 概念 | 含义 | 谁能定义 |
|---|---|---|
| **成员（Member）** | 一种预定义好的 agent 类型：职责、技能、插件、工具集、模型 | **只有设计者**。v2 里它已经**不是库的功能**，就是你代码里的一个对象（见 `examples/09-roster.ts`） |
| **分身（Instance）** | 一个 `lab.createAgent` 出来的运行实例；同一成员可有多个分身 | 由**设计者的代码**在运行时调 `lab.createAgent` 起（见 `examples/10-spawn.ts`） |
| **花名册（members）** | 设计者声明的全部成员 | 设计者。v1 里它是 `createAgentHost({ members })` 的入参，**v2 已把它移出库** |

**红线同理**：v1 里「agent 不能设计、不能配置 agent」是焊在库里的；v2 把它降成一条**可被推翻的假设**，
写在 `examples/11-redline.ts` 的使用者代码里——注释掉那段检查，模型带的配置就真的会被接进子 agent。
三个文件的头部都逐字标着「⚠️ 这是一个【假设】，不是推荐做法」。

## 库有什么

对外只有一个函数（`src/index.ts` 是唯一入口，不做逻辑）：

- `createLab(opts)` → `Lab` —— **唯一**的启动入口：环境在这里声明一次（`agentDir` / `cwd` 必填），本实验室起的全部分身共用

`Lab` 上只有四个成员：

| 成员 | 管什么 |
|---|---|
| `lab.agentDir` / `lab.cwd` | 这个实验室的环境（两个目录，起 agent 时不再逐个传） |
| `lab.createAgent(spec?)` → `Agent` | **唯一**的 agent 创建入口；`spec`（`AgentSpec`）只说「这个 agent 用哪些」 |
| `lab.inspectEnv()` → `EnvReport` | 环境自检：这套环境里实际生效了什么（模型 / 扩展 / 技能 / 警告），只读 |

`Agent` 上是**七个面**：

| 面 | 管什么 |
|---|---|
| `agent.io` | 投递（`prompt` / `queue` / `steer` / `interrupt`）、`abort`、`waitIdle`、**结算**（`RunResult`） |
| `agent.context` | 读历史、改**这一轮发给模型的内容**、压缩、自动压缩开关、整段重置（`reset`） |
| `agent.tools` | 有哪些工具存在（`list` / `add` / `remove`）、工具结果拦截（`onResult`） |
| `agent.permissions` | 哪些工具**允许被调用**（`only` / `allow` / `deny`）、审批门（`gate`） |
| `agent.extensions` | 运行期加载 / 卸载插件，加载错误可读（`errors()`） |
| `agent.skills` | 运行期按路径注入技能、列出当前技能 |
| `agent.model` | 换模型 / 换思考档，读当前与可用 |

除七个面之外，只剩三样句柄与观测：

- **句柄** —— `agent.id`（trace 的关联键）/ `agent.usage`（**全生命周期**累计；本次运行看 `RunResult.usage`）/ `agent.status`（`idle` | `running` | `disposed`）/ `agent.dispose()`
- **观测** —— `agent.on(event, handler)`（**按名收窄** handler 的参数类型）与 `agent.onAny(handler)`（全量，适合 trace / 日志）。两者都**直接镜像 pi 的 `ExtensionEvent`**、返回退订函数；v1 那层「七个归一化事件」已删除
- **raw 出口** —— 除 `permissions` 外每个面都有 `agent.<面>.raw`，指向对应的 pi 对象。**全权、无护栏**：库的忙判据与结算在这一层不存在

**哪些动作要求空闲**：`tools.add/remove`、`permissions.only/allow/deny`、`extensions.add/remove`、`skills.add/remove`、`context.compact` —— 忙时**抛错**，先 `io.waitIdle()`。它们要碰「声明面」，得走 pi 的 `reload()`，而**不空闲时 reload 会静默不生效**。`model.set` / `setThinking` 不打断在飞那轮，改动从下一次请求起生效。`dispose()` 之后七面的一切都拒绝（`io.waitIdle` 例外，直接 resolve）。

## 现状

**机制层是完整的七面；策略层刻意留空。** 「库负责的机制 vs 使用者负责的政策」分工表、「哪些动作要求空闲」的表、
结算（一次运行 = `agent_start` → `agent_settled`）为什么这么切、明确不做的七件事，见 [`docs/DESIGN.md`](docs/DESIGN.md)（**唯一设计源**，v1 原文在 `docs/archive/`）。
怎么用见 [`docs/GUIDE.md`](docs/GUIDE.md)（代码引用 `examples/lib/snippets.ts` 的同源片段）；已实测核对的实现决策见 [`docs/FACTS.md`](docs/FACTS.md)。

**不承诺**：pi 没有内置沙箱，`permissions.only` 只是工具集裁剪，扩展与 `bash` 可以绕过它。本库提供的是**能力裁剪 + 拦截**，不是权限系统，更不是安全边界。

## 仓库地图

```
src/index.ts     唯一导出入口（不做逻辑）：createLab + 全部对外类型
src/agent/       lab.ts（createLab：环境所有者与唯一启动入口）· create-agent.ts（agent 的创建路径，只经 lab.createAgent 到达）· bridge.ts（面 = pi 钩子的分组封装）· env.ts（环境自检的实现）· loader.ts（skills / extensions / role 的注入与解析）· types.ts（对外类型）· usage.ts（用量累计）
src/surfaces/    七个面：io.ts · context.ts · tools.ts（tools + permissions）· resources.ts（extensions + skills）· model.ts
test/            node:test，本机假 provider，零 API 成本
examples/        11 个能 node 直接跑的示例（01–08 一面一事，09–11 是 v1 三条假设的使用者代码）；离线基建在 examples/lib/
demo/            实验脚手架（复制即开始实验）：lab.ts（起点）+ agent/（环境）+ check.ts（八项自检）；完整案例在 examples/12-team.ts
docs/DESIGN.md   宏观设计（唯一设计源）
docs/GUIDE.md    用法讲解（面向设计者；代码引用 examples/lib/snippets.ts 的同源片段）
docs/FACTS.md    已实测核对的实现决策（v1 段 + v2 段）
docs/research/   研究问题清单 · v1 能力与极限审计报告
```
