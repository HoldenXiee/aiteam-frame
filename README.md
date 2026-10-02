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

## 检测环境装好没有

```bash
npm install        # 装依赖（Node ≥ 24）
npm run demo:env   # 只准备 + 体检这套自建环境：不花模型钱，几秒出结果
npm run demo       # 全流程：环境 → 真模型 → agent 集群 → 对账（约 $0.003）
```

`demo/` 是一份**安装自检**：凭证 / 技能 / 插件全在 `demo/env/` 里，不读本机 pi 的设置 ——
所以**别人没装 pi 也能跑**，跑通就说明这个库在他那儿是好的。

### 运行结果的标准

**`npm run demo:env`** —— 最后一行必须是：

```
环境 OK：技能 / 插件 / 模型都从 demo/env/ 生效，本机 pi 没混进来。
```

四项检查：技能来自 `demo/env` ｜ 本机 pi 的技能/插件一个都没混进来 ｜ 插件从 `demo/env/extensions/` 自动加载 ｜ `DEMO_MODEL` 指的模型现在可用。退出码 0。

**`npm run demo`** —— 四步里每一项检查都是 `✔`（实测 23 项；`·` 是依赖模型配合的软提示，不算失败），最后两行必须是：

```
结论：库装好了，这套自建环境也是通的。
全程 xx.x 秒，xxxxx tokens ≈ $0.00xxxx（另有 N 项软提示）
```

并且退出码是 0。四步分别验：

| 步骤 | 过了意味着 |
|---|---|
| 1 自建环境 | 凭证 / 技能 / 插件 / 上下文文件都从 `demo/env/` 生效，本机 pi 没混进来 |
| 2 真模型连通 | 真发了一次请求：读到文件，且技能暗号、工作目录守则暗号都回到话里 |
| 3 agent 集群 | 主持人从花名册挑出 scout / checker / scribe，黑板写出三条要点，worker 用上了 `demo/env` 插件注册的 `env_probe`，报告真落盘 |
| 4 对账 | 事件成对、`agent.usage` 与 `host.usage` 归属正确、护栏还在、级联回收干净 |

挂了不会静默：行首是 `✘`，后面跟原因，退出码 1，并提示跑 `npm run demo:env` 单独体检环境。
凭证找不到也不静默：`demo/env/auth.json` 优先 → 其次自动从 `~/.pi/agent/auth.json` 拷一份 → 都没有就报错并给出两条路（照 `auth.json.example` 手写，或设 `OPENCODE_API_KEY`）。细节见 [`demo/README.md`](demo/README.md)。

改这个库的人另一个免费保险是 `npm test`：76 项测试走本机假 provider，零 API 成本，不碰真模型。

**想看怎么用这个库，先读 [`docs/GUIDE.md`](docs/GUIDE.md)**，它逐面讲解每个操控面。

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
npm run demo        # 真模型端到端：自建环境 → 集群（要凭证、要花钱，约 $0.003）
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
`demo/work/` 是 demo 跑出来的产物（黑板 / 报告 / 临时文件），已经在 `.gitignore` 里，不要提交。

## 研究课题与研究方向

### 研究方向：一种新的编程方式

> 我理想中的这个框架应该是一种新的编程方式。目前不是 Vibe Coding 吗？把工作交给 AI 去做。但我认为这种 Agent 的集群方式应该是：**自己写一个集群，用代码把它的逻辑给规范好，由这个小小的世界去完成我对应的目标。在完成一个阶段性目标过后，再反过来改这个集群的代码，而不是改它写的代码。**

差别就在最后一句：产物是一次性的，**集群代码是可迭代的资产**。所以这个库不把「管好一个 agent」当成目标 —— 它把 agent 集群当成一段**可以像代码一样修改、版本化、测量**的东西。上面那个闭环能不能成立，就是下面这些课题要回答的事（尤其是家族 2）。

### 研究课题（26 条）

来源：[`docs/research/2026-10-01-research-questions.md`](docs/research/2026-10-01-research-questions.md)，只列问题，不排计划。
标记：**●** 完全空白（检索中没人在做）· **◐** 有人提过、没人测 · **○** 已有部分结论、缺另一半

**家族 1：范式成立的前提**

- ● **1** 如果底下的模型是概率系统，「用代码定义规则」到底继承了多少确定性？同一集群代码跑 N 次，产出的方差有多大？
- ◐ **2** 自由发挥 vs 固定流程的边界在哪？哪些任务形状下前者真的赢，哪些必输？
- ◐ **3** 规模律：agent 数量 / 委派深度 → 产出质量的曲线，拐点在哪？协调开销什么时候吃掉收益？
- ● **4** 上下文隔离 vs 共享的边界：每个 agent 独立上下文 vs 共享黑板，分别在什么条件下更优？
- ● **5** 委派多跳的信息保真衰减：深度 1→2→3→4，一条信息传到底还剩多少？

**家族 2：规则的可迭代性**

- ● **6** 改一轮集群规则，产出提升多少？收敛还是震荡？迭代几轮后收益消失？
- ● **7** 规则过拟合：为任务 A 调出来的规则，在任务 B 上掉多少？
- ● **8** 规则的最小充分集：几条规则能表达多少种集群形态？
- ● **9** 人 vs agent 的规则分工边界：哪些规则必须人写、哪些交给 agent 运行时决定更好？

**家族 3：红线的代价与强度**

- ● **10** 「agent 不能配置 agent」的代价是多少？表达力损失多大？
- ● **11** 红线在对抗条件下的强度：prompt injection 能否让子 agent 越权？
- ● **12** 「连收窄工具集都不给」这一条的净成本：它挡住的合法用法多不多？

**家族 4：低层操控面的工程极限**

- ○ **13** 把 `RunResult` 绑到调用，代价多大、收益多大？（游标切片 / 队列 / 事件关联对比）
- ○ **14** 配置层的静默失败能否被系统性消除？校验覆盖到哪一层就够？
- ○ **15** 长跑状态出口的设计空间：上下文超限 / 压缩 / 预算，恢复机制有几种，各自代价？
- ● **16** 预算是硬天花板还是软约束，agent 的策略会不同吗？
- ◐ **17** 失败语义化的覆盖率与实用性：失败分类学能做到多细？分细之后有人用吗？
- ○ **18** 护栏强度 vs 资源利用率：终身配额（回收不还）锁死长驻模式，配额返还的设计空间有多大？
- ● **19** 超时的引入会解锁哪些拓扑？

**家族 5：治理与观测 —— 护栏买到什么**

- ● **20** 审批门 / 护栏对产出质量与成本是拖累还是保险？
- ◐ **21** 观测粒度与督导质量的关系：7 个事件够督导吗？缺哪个事件导致督导失效？
- ● **22** 按分支归因成本能改变哪些决策？归因到分支之后，人实际改了什么？

**家族 6：方法学**

- ● **23** 假 provider 的结论能外推到真模型吗？哪些可外推、哪些不可？
- ● **24** 测「涌现」必须用真模型吗？假 provider 的确定性脚本能否测自组织？
- ● **25** 审计式探测（拼写矩阵、边角组合）能否系统化成可复用的验证套件？

**家族 7：对照基准**

- ● **26** 需要一个公开、可复现、零成本的任务集，让「自由发挥 / 固定流程 / 单 agent / 既有框架」四者可比

若只挑三个先做：**26 → 1 → 6**（26 让后面可比，1 让范式站得住，6 是「迭代集群代码」这条主线上唯一没有任何数据的部分）。完整的「值钱在哪 / 空白在哪 / 谁挡着谁」，见上面链接那份文档。

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
demo/          安装自检 demo：自建环境（demo/env）+ 一个 agent 集群（要凭证、要花钱）
docs/          设计文档 + 用法讲解
```

## 文档

- [`AGENTS.md`](AGENTS.md) —— 项目是什么（快速全貌）
- [`docs/GUIDE.md`](docs/GUIDE.md) —— **用法讲解**：上手、逐个操控面、已知边界、常用配方
- [`docs/DESIGN.md`](docs/DESIGN.md) —— 宏观设计（唯一设计源）：操控面理想与现状、对外接口、能力边界
- [`docs/FACTS.md`](docs/FACTS.md) —— 已实测核对的实现决策
- [`docs/research/`](docs/research/) —— 能力与极限审计报告 · [研究问题清单（26 条 / 7 家族）](docs/research/2026-10-01-research-questions.md)

## 许可

MIT，见 [LICENSE](LICENSE)。
