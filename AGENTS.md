# AGENTS.md

本文只描述**这个项目是什么**，不描述怎么做。开发流程、纪律、下一步计划不在本文范围内。

> **在 aiteam 里配置 agent 集群 / 示例 / demo 的 agent 时，模型默认用 `(opencode-go) space-bunny-free`。**
>
> **启动 subagent 时不要传模型名** —— 留空即用会话默认模型。不为了「强一点」随手指定更贵的模型：额度比速度重要。
>
> 注：用**本机假 provider**（`faux/*`，见 `test/faux-models.ts`、`examples/lib/faux-models.ts`）的那些 agent 不在此列 —— 它们是离线、零成本、有判别力的测试基建，不要换成真模型。

---

## 一句话

**aiteam 是一个 Agent 操控库**——基于 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，给设计者的代码一双手，去创建、配置、驱动、观测 agent。非常基础、非常底层。

## 三个概念

| 概念 | 含义 | 谁能定义 |
|---|---|---|
| **成员（Member）** | 一种预定义好的 agent 类型：职责、技能、插件、工具集、模型 | **只有设计者**（写代码的人） |
| **分身（Instance）** | 某个成员的一个运行实例。同一成员可有多个分身 | 由 agent 在运行时启动 |
| **花名册（members）** | 设计者声明的全部成员 | 设计者 |

## 红线

**agent 不能设计、不能配置 agent。** 它只能**从花名册里挑一个成员**、**告诉它要干什么**。`spawn_agent` 工具没有 `tools` 参数，也不接受任何配置覆盖。

## 库有什么

```ts
createAgent(spec, deps?)      // 唯一的 agent 创建入口 → ControlledAgent
createAgentHost({ members })  // 花名册 + 三道护栏 + 宿主事件 → AgentHost
inspectEnv(spec?)             // 环境自检：有哪些模型 / 插件 / 技能（只读）
defineAgentTool(def)          // 工厂式工具地基，工具能拿到 ctx.agent / ctx.host
```

创建出来的 agent 上可操控的面：

- **上下文** —— 读消息历史（`agent.session` 逃生口）
- **输入流向** —— `prompt` / `send`（忙时排队、永不抛错）/ `steer` / `waitForIdle`
- **输出流向** —— `RunResult { text, usage, error? }` + `agent.lastResult`
- **生命周期** —— `abort` / `dispose`；`host.dispose()` 级联回收
- **工具集** —— `tools` 白名单 / `excludeTools` / `customTools` / `onToolCall` 审批门
- **模型与思考档** —— `model`（`"provider/id:thinking"`）/ `thinking`
- **技能与插件** —— `skills` / `extensions`
- **角色** —— `role` → `appendSystemPrompt`
- **护栏** —— `maxDepth` / `maxAgents` / `budgetTokens`
- **观测** —— 7 个归一化事件（`text` / `thinking` / `tool_start` / `tool_end` / `turn` / `error` / `done`）+ 3 个宿主事件（`agent_created` / `agent_disposed` / `round_completed`）
- **用量** —— `agent.usage` 累计 / `RunResult.usage` 本次 / `host.usage` 全宿主

自带两个能力工具（由 `spec.tools` 里的名字控制启用）：`spawn_agent`（挑成员 + 派活 + 拿结果）、`send_message`（给**自己的后代**分身追加消息）。

## 现状

**理想是一个 agent 身上的每个面都能被设计者的代码操控；现在只覆盖了一部分。**

各个操控面的完整对照（理想 / 现状）、对外接口、能力边界、集群形态清单，见 [`docs/DESIGN.md`](docs/DESIGN.md)。

库的能力与极限做过一轮实测审计（约 600 条实测项）：机制层可靠；配置层与结果归属层存在**静默**失效。细节见 [`docs/research/`](docs/research/)。

**不承诺**：pi 没有内置沙箱，`tools` 白名单只是工具集裁剪，不是安全边界。

## 仓库地图

```
src/agent/       create-agent.ts / host.ts / loader.ts / events.ts / usage.ts / types.ts
src/tools/       define-agent-tool.ts / spawn-agent.ts / send-message.ts
test/            node:test，本机假 provider，零 API 成本
audit/           能力与极限审计的探测脚本与发现（证据链）
demo/            安装自检 demo：自建环境（demo/env）+ 一个 agent 集群，跑通即说明库装好了
docs/DESIGN.md   宏观设计（唯一设计源）
docs/GUIDE.md    用法讲解（面向设计者怎么用）
docs/FACTS.md    已实测核对的实现决策
docs/research/   能力与极限审计的最终报告 · 研究问题清单
```
