# aiteam

**一个 Agent 操控库。**

基于 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，给设计者的代码一双手，去创建、配置、驱动、观测 agent。非常基础、非常底层的一层——不是 agent 框架的替代品。

理想是一个 agent 身上的每个面都能被设计者的代码操控；现在只覆盖了一部分。完整的操控面清单与对外接口见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 核心模型

| 概念 | 含义 | 谁能定义 |
|---|---|---|
| **成员（Member）** | 一种预定义好的 agent 类型：职责、技能、插件、工具集、模型 | **只有设计者**（写代码的人） |
| **分身（Instance）** | 某个成员的一个运行实例，同一成员可起多个 | 由 agent 在运行时启动 |
| **花名册（members）** | 设计者声明的全部成员 | 设计者 |

**红线**：agent 不能设计、不能配置 agent。它只能**从花名册里挑一个成员**、**告诉它要干什么**。连「收窄工具集」都不给。

好处是双向的：agent 没有提权面（无法指定 `cwd` / `agentDir` / `extensions`，也就无法让子 agent 加载任意代码或换用贵模型）；而设计者的灵活性不受损——想加一种新 agent，就在花名册里加一个成员。

## 装

```bash
npm install
```

要求 Node ≥ 24（直接跑 `.ts`，靠 Node 原生类型剥离），peer 依赖是 `@earendil-works/pi-coding-agent@0.99.1`。
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

// 2. 起顶层 agent，它自带 spawn_agent / send_message 两个工具
const lead = await createAgent({
  id: "lead",
  role: "你是主持人。用 spawn_agent 挑选成员派活，用 send_message 追加消息。",
  model: "anthropic/claude-opus-4-5:high",
}, { host });

// 3. 交办，拿结果
const { text, usage } = await lead.prompt("调研 X，然后让 writer 写一篇 800 字的稿子");
console.log(text, usage);

// 4. 宿主观测：库只发事件，监控策略由设计者写
host.on("round_completed", ({ agent, result }) => console.log(agent.id, result.usage));

host.dispose(); // 级联回收所有分身
```

### 环境：三样东西

`agentDir` 决定这个 agent 能用什么。默认是 `AITEAM_AGENT_DIR` 环境变量或本机 pi 目录（`~/​.pi/agent`）；换成自己的目录就完全脱离本机 pi 设置。一个目录里只放三样：

```
my-pi/
  models.json + auth.json   模型 api（也可只用环境变量凭证）
  extensions/               插件
  skills/                   技能
```

```ts
const spec = { agentDir: "D:/my-pi", cwd: "./work" };

// 验证语句：先看清楚这套环境里实际生效了什么，再建 agent
const env = await inspectEnv(spec);
env.models;      // [{ provider: "opencode-go", total: 29, available: [...] }]  只有配好凭证的
env.extensions;  // [{ path, scope, tools: [...] }]  tools = 它注册的工具名
env.skills;      // [{ name, filePath, scope }]
env.warnings;    // 目录不存在 / 没有 models.json / 扩展加载失败 / SYSTEM.md 会替换提示词…

const agent = await createAgent(spec);
```

模型目录默认允许联网刷新（`modelNetwork`，pi.dev 的 overlay，缓存在 `<agentDir>/models-store.json`，4 小时新鲜度窗口）。`PI_OFFLINE=1` 关掉一切模型网络请求。

设计者也可以不走工具，直接把一个 agent 的输出喂给另一个：

```ts
const a = await createAgent({ model: "..." }, { host });
const b = await createAgent({ model: "..." }, { host });
const r = await a.prompt("给我一份事实清单");
await b.prompt(`基于这份清单写稿：\n${r.text}`);
```

### API 速览

| | |
|---|---|
| `createAgent(spec, deps?)` | 唯一的 agent 创建入口 → `ControlledAgent` |
| `inspectEnv(spec?, deps?)` | 环境自检（模型 / 插件 / 技能 / 警告），只读，不建 agent |
| `createAgentHost({ members, maxAgents, maxDepth, budgetTokens, defaults, modelRuntime })` | 花名册 + 护栏 + 宿主事件 + 级联回收 → `AgentHost` |
| `defineAgentTool(def)` | 工厂式工具，`execute(params, ctx)` 里的 `ctx.agent` / `ctx.host` 知道「是谁在调用我」 |

`spec` 字段：`description` / `cwd` / `agentDir` / `modelNetwork` / `catalogBaseUrl` / `role` / `skills` / `extensions` / `tools` / `excludeTools` / `customTools` / `model` / `thinking` / `onToolCall`。非空 `tools` 是白名单，`[]` 表示一个工具都不给；优先级为 `host.defaults` ← `members[x]` ← 顶层 spec，浅合并覆盖。

`ControlledAgent`：`prompt` / `send` / `steer` / `waitForIdle` / `abort` / `dispose` / `on`，以及 `status` / `isStreaming` / `usage` / `lastResult` / `session`（原始 SDK 对象的逃生口）/ `parentId` / `member`。

库自带两个能力工具：`spawn_agent`（挑成员 + 派活 + 拿结果）、`send_message`（给已有分身追加消息，只能投给自己的后代）。

## 跑

```bash
npm test              # node --test，本机假 provider，不发真请求
npm run demo:tour     # 全操控面导览，看它怎么写最省事（要凭证、要花钱，约 $0.003）
npm run demo          # 真模型多轮协作：形态 5「团队探讨到收敛」
npm run demo:self-env # 只用自建环境（auth.json + 自己的技能）跑一轮
```

`npm test` 会起一个本机假 provider 并把 `AITEAM_AGENT_DIR` 指向它，所以不需要任何 API key。
导览的运行产物留在 `demo/run-output/`（`tour.log` / `report.json` / agent 真写出来的文件）。
**想看怎么用这个库，先读 [`docs/GUIDE.md`](docs/GUIDE.md)**，它逐面讲解并引用上面那份日志。

## 想开发

### 要求与装

Node ≥ 24（直接跑 `.ts`，靠 Node 原生类型剥离）；没有构建步骤、没有打包器、没有 lint 器。

```bash
git clone <repo> && cd test
npm install
```

### 三条命令

```bash
npm test            # 76 项测试，本机假 provider，零 API 成本 —— 改完先跑它
npm run typecheck   # tsc --noEmit
npm run demo:tour   # 真模型端到端全导览（要凭证、要花钱，约 $0.003）
```

`npm test` 里没有真 API：`test/helpers.ts` 会起一个本机假 provider（HTTP + SSE），把 `AITEAM_AGENT_DIR` 指向它，并设 `PI_OFFLINE=1`。每个测试文件是独立进程，互不污染。

### 改哪儿

| 你要改的东西 | 落点 |
|---|---|
| 创建 / 生命周期 / 事件 / 用量接线 | `src/agent/create-agent.ts` |
| 花名册、三道护栏、宿主事件、级联回收 | `src/agent/host.ts` |
| skills / extensions / role 的注入与解析 | `src/agent/loader.ts` |
| 环境自检 `inspectEnv` | `src/agent/env.ts` |
| pi 的 20+ 事件 → 7 个归一化事件（纯映射） | `src/agent/events.ts` |
| 对外类型（无运行时逻辑） | `src/agent/types.ts` |
| 库自带的两个能力工具 | `src/tools/` |
| 对外导出（唯一入口，不做逻辑） | `src/index.ts` |
| 设计 / 实测事实 / 用法 | `docs/DESIGN.md` / `docs/FACTS.md` / `docs/GUIDE.md` |

相对 import **必须带 `.ts` 后缀**，只能用**可擦除**的 TS 语法（无 `enum` / `namespace` / 装饰器 / 参数属性）。

### 改代码的五条规矩

这几条是这个库可信度的来源，不是风格偏好：

1. **L1 不做 SDK 已经做了的事。** 加功能前先确认 pi SDK 里没有等价物 —— `node_modules/@earendil-works/pi-coding-agent/docs/` 是第一手资料。
2. **只说实测过的。** 任何「已实现 / 已修复」都要配一个能跑出结果的检查（`npm test` 里的一条断言，或 `audit/` 下的一个探针）。
3. **类型不重定义。** `Skill` / `ToolDefinition` / `AgentSession` / `Message` / `Usage` / `ThinkingLevel` 一律从 pi 的包 import。
4. **唯一创建入口。** 不加第二条造 agent 的路径（`host.createAgent()` 之类）；不给 agent 提权面（`spawn_agent` 永远不许加 `tools`）。
5. **接口变了就同步三份文档**：`DESIGN.md`（接口与现状）→ `FACTS.md`（带编号的决策与理由）→ `GUIDE.md`（怎么用）。

### 加一个测试

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { captureSystemPrompt } from "./helpers.ts";

test("role 追加在 <tools> 之后，不替换默认提示词", async () => {
  const { system } = await captureSystemPrompt({ role: "我是审查员" });
  assert.match(system, /<tools>/);
  assert.ok(system.indexOf("我是审查员") > system.indexOf("<tools>"));
});
```

`test/helpers.ts` 里有现成的 ground truth：`seenTools()`（模型**实际**收到的工具名）、`captureSystemPrompt()`（**实际**发出的 system）、`runTool()`（直接执行库自带工具，不进 LLM）、`faux.calls`（假服务收到的一切）。

### 不花钱验证一个能力

不确定 SDK 的某个行为时**不要猜**，写一个一次性探针：

```bash
node audit/你的脚本.ts        # audit/ 下全是这种脚本，_faux.ts 提供假环境基建
```

真模型实验先跑 1 次记下实际 token 与花费，再决定样本量；费用从 `agent.usage.cost.total` 累加。真模型跑出来的结论写进 `audit/**/FINDINGS.md`，被验证的决策写进 `docs/FACTS.md`。

### 提交

Conventional Commits + 中文描述（照 `git log` 的风格）：`feat:` / `fix:` / `docs:` / `audit:` / `chore:`。
`demo/run-output/` 是导览跑出来的产物（`tour.log` / agent 真写的文件），已经在 `.gitignore` 里，不要提交。

## 现状

库做过一轮能力与极限的实测审计（约 50 个探测脚本、600+ 条实测项、约 400 次真实模型调用）：

- **机制层可靠**：钩子、工具通道、事件、`abort`、`dispose`、子进程并发，测下来基本没有坏的。
- **配置层不可靠而且静默**：写错一个字段名就能把功能关掉、把工具集清空、把审批门废掉，全程零信号。
- **归属层不可靠而且静默**：`RunResult` 不跟调用绑定，重叠投递下会把别人的答案给你——**包括 `spawn_agent`**。
- **长跑状态层**：上下文超限会让分身永久静默返回空；预算对主要成本来源是盲的；回收不还配额。

细节与复现脚本见 [`docs/research/`](docs/research/)。

**明确不承诺**：pi 没有内置沙箱，`tools` 白名单只是工具集裁剪，扩展与 `bash` 可以绕过它。真正的隔离只能靠容器 / VM。本库提供的是**能力裁剪 + 审批门**，不是安全边界。

## 目录

```
src/agent/     单 agent 操控 + 花名册 + 事件 + 用量
  create-agent.ts   spec → ControlledAgent
  host.ts           花名册、三道护栏、宿主事件、级联回收
  loader.ts         skills / extensions / role 的配置收敛
  env.ts            inspectEnv：环境自检（模型/插件/技能），只读
  events.ts         pi 的 20+ 事件 → 7 个归一化事件
  types.ts          全部对外类型（无运行时逻辑）
src/tools/     自定义工具：define-agent-tool / spawn-agent / send-message
test/          node:test，全部走本机假 provider，零 API 成本
audit/         能力与极限审计的探测脚本与发现（证据链）
demo/          真模型 demo：tour（全操控面导览）/ demo（多轮协作）/ self-env（自建环境）
docs/          设计文档 + 用法讲解
```

## 文档

- [`AGENTS.md`](AGENTS.md) —— 项目是什么（快速全貌）
- [`docs/GUIDE.md`](docs/GUIDE.md) —— **用法讲解**：上手、逐个操控面、已知边界、常用配方
- [`docs/DESIGN.md`](docs/DESIGN.md) —— 宏观设计（唯一设计源）：操控面理想与现状、对外接口、能力边界
- [`docs/FACTS.md`](docs/FACTS.md) —— 已实测核对的实现决策
- [`docs/research/`](docs/research/) —— 能力与极限审计报告 · 研究问题清单

## 许可

MIT，见 [LICENSE](LICENSE)。
