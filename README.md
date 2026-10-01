# aiteam

搭建 **agent 团队**的 TypeScript 库。基于 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，不是 agent 框架的替代品，而是它上面的一层「团队操控层」。

阶段 1（当前）：单 agent 操控 + 花名册 + 自定义工具地基 + 两个能力工具。
阶段 2（未开始）：集群编排（并发闸门、消息路由、结果聚合）。

## 核心模型

| 概念 | 含义 | 谁能定义 |
|---|---|---|
| **成员（Member）** | 一种预定义好的 agent 类型：职责、技能、插件、工具集、模型 | **只有集群设计者**（写代码的人） |
| **分身（Instance）** | 某个成员的一个运行实例，同一成员可起多个 | 由 agent 在运行时启动 |
| **花名册（members）** | 设计者声明的全部成员 | 设计者 |

**设计红线（永不支持）**：agent 不能设计、不能配置 agent。它只能**从花名册里挑一个成员**、**告诉它要干什么**。连「收窄工具集」都不给。

好处是双向的：agent 没有提权面（无法指定 `cwd` / `agentDir` / `extensions`，也就无法让子 agent 加载任意代码或换用贵模型）；设计者的灵活性不受损——想加一种新 agent，就在花名册里加一个成员。

## 装

```bash
npm install
```

要求 Node ≥ 24（直接跑 `.ts`，靠 Node 原生类型剥离），peer 依赖是 `@earendil-works/pi-coding-agent`。
库本身不发布，按本地路径引用或直接读源码。

## 用

```ts
import { createAgentHost, createAgent } from "./src/index.ts";

// 1. 设计者声明花名册 —— agent 只能从这里挑人
const host = createAgentHost({
  members: {
    researcher: {
      description: "查资料并把结论落成事实清单",
      role: "你是研究员。只给事实，不给建议。",
      model: "anthropic/claude-haiku-4-5",
      tools: ["read", "grep"],
    },
    writer: { description: "把事实清单写成稿子", role: "你是撰稿人。" },
  },
  maxAgents: 16,   // 全生命周期分身总数上限
  maxDepth: 2,     // 分身层数上限，顶层为第 0 层
  budgetTokens: 200_000,
});

// 2. 起顶层 agent。库自带的 spawn_agent / send_message 在 tools 白名单里点了名才会挂上
const lead = await createAgent({
  id: "lead",
  role: "你是主持人。用 spawn_agent 挑选成员派活，用 send_message 追加消息。",
  model: "anthropic/claude-opus-4-5:high",
  tools: ["spawn_agent", "send_message"],
}, { host });

// 3. 交办，拿结果
const { text, usage } = await lead.prompt("调研 X，然后让 writer 写一篇 800 字的稿子");
console.log(text, usage);

// 4. 宿主观测：库只发事件，监控策略由设计者写
host.on("round_completed", ({ agent, result }) => console.log(agent.id, result.usage));

host.dispose(); // 级联回收所有分身
```

设计者也可以不走工具，直接把一个 agent 的输出喂给另一个：

```ts
const a = await createAgent({ model: "..." }, { host });
const b = await createAgent({ model: "..." }, { host });
const r = await a.prompt("给我一份事实清单");
await b.prompt(`基于这份清单写稿：\n${r.text}`);
```

### API 速览

**`createAgent(spec, deps?)` → `ControlledAgent`** —— 唯一的 agent 创建入口。

`spec` 字段：`description` / `cwd` / `agentDir` / `role` / `skills` / `extensions` / `tools` / `excludeTools` / `customTools` / `model` / `thinking` / `onToolCall`。
非空 `tools` 是白名单，`[]` 表示一个工具都不给；优先级为 `host.defaults` ← `members[x]` ← 顶层 spec，浅合并覆盖（数组整体替换）。

`ControlledAgent` 上：

| 成员 | 说明 |
|---|---|
| `prompt(text)` | 顶层交办，返回 `{ text, usage, error? }` |
| `send(text, { mode })` | 给已有分身投递消息。忙时排队，**永不抛错**；`mode: "interrupt"` 立刻改方向 |
| `steer(text)` | 运行中插话 |
| `waitForIdle()` | 等它不再运行 |
| `abort()` / `dispose()` | 中断 / 回收 |
| `on(event, fn)` | 7 个归一化事件：`text` / `thinking` / `tool_start` / `tool_end` / `turn` / `error` / `done`，返回退订函数 |
| `status` / `isStreaming` / `usage` / `lastResult` / `session` | 状态与观测；`session` 是原始 SDK 对象的逃生口 |
| `parentId` / `member` | 归属 |

**`createAgentHost({ members, maxAgents?, maxDepth?, budgetTokens?, defaults?, modelRuntime? })` → `AgentHost`**

`list()` / `get(id)` / `usage` / `activeCount` / `on(event, fn)` / `dispose()`；宿主事件 `agent_created` / `agent_disposed` / `round_completed`。

**自定义工具地基**：`defineAgentTool(fn)` 拿到调用者上下文（`ctx.agent`、`ctx.host`），工具因此知道「是谁在调用我」。库自带两个：`spawn_agent`（挑成员 + 派活 + 拿结果）、`send_message`（给已有分身追加消息）。

### 明确不做的

配置 DSL / YAML 解析器、TUI、沙箱、集群持久化与恢复、磁盘会话。

**明确不承诺**：pi 没有内置沙箱，`tools` 白名单只是工具集裁剪，扩展与 `bash` 可以绕过它。真正的隔离只能靠容器/VM。本库提供的是**能力裁剪 + 审批门**，不是安全边界；不要把它当权限系统宣传。

## 现状与已知问题

阶段 1 做过一轮三轮交叉验证的能力与极限审计（约 50 个探测脚本、600+ 条实测项、约 400 次真实模型调用），结论摘要：

- **机制层可靠**：钩子、工具通道、事件、`abort`、`dispose`、子进程并发，测下来基本没有坏的。
- **配置层不可靠而且静默**：写错一个字段名就能把功能关掉、把工具集清空、把审批门废掉，全程零信号。
- **归属层不可靠而且静默**：`RunResult` 不跟调用绑定，重叠投递下会把别人的答案给你——**包括主力委派原语 `spawn_agent`**。
- **长跑状态层**：上下文超限会让分身永久静默返回空；预算对主要成本来源是盲的；回收不还配额。

一句话：**能搭集群，能跑得很花；但主力委派原语会说错话、配置写错不报错、长跑会静默死掉。**

细节与复现脚本见 [`docs/research/2026-10-01-phase1-capability-audit-final.md`](docs/research/2026-10-01-phase1-capability-audit-final.md)。

## 目录

```
src/agent/     单 agent 操控 + 花名册 + 事件 + 用量
  create-agent.ts   spec → ControlledAgent
  host.ts           花名册、三道护栏、宿主事件、级联回收
  loader.ts         skills / extensions / tools 配置收敛
  events.ts         pi 20+ 事件 → 7 个归一化事件
  types.ts          全部对外类型（无运行时逻辑）
src/tools/     自定义工具：define-agent-tool / spawn-agent / send-message
test/          node:test，全部走本机假 provider，零 API 成本
probe/         SDK 能力探针（探路阶段留下的实证）
audit/         阶段 1 能力与极限审计的探测脚本与发现
demo/          真模型多轮协作 demo
docs/specs/    设计规格
docs/plans/    实现计划
docs/research/ 审计计划与报告
```

## 跑

```bash
npm test     # node --test，假 provider，不发真请求
npm run demo # 真模型多轮协作，要凭证、要花钱
npm run probe
```

`npm test` 会起一个本机假 provider 并把 `AITEAM_AGENT_DIR` 指向它，所以不需要任何 API key。

## 文档

- 设计规格：[`docs/specs/2026-09-30-agent-control-lib-design.md`](docs/specs/2026-09-30-agent-control-lib-design.md)
- 实现计划：[`docs/plans/2026-09-30-agent-control-lib.md`](docs/plans/2026-09-30-agent-control-lib.md)
- 能力与极限审计（最终）：[`docs/research/2026-10-01-phase1-capability-audit-final.md`](docs/research/2026-10-01-phase1-capability-audit-final.md)
- 审计计划：[`docs/research/2026-09-30-framework-capability-audit-plan.md`](docs/research/2026-09-30-framework-capability-audit-plan.md)

## 许可

MIT，见 [LICENSE](LICENSE)。
