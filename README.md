# aiteam

**一个 Agent 操控库。**

基于 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，给设计者的代码一双手，去创建、配置、驱动、观测 agent。非常基础、非常底层的一层——不是 agent 框架的替代品。

理想是一个 agent 身上的每个面都能被设计者的代码操控；v2 里**机制层已经补齐**（七个面，逐面见 [`docs/GUIDE.md`](docs/GUIDE.md)），**策略层刻意留空**。完整的操控面清单与对外接口见 [`docs/DESIGN.md`](docs/DESIGN.md)。

> **第一次接手这个项目？** 读 [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)——30 分钟跑起来、看懂、开始研究。
> **想看这个库能操控什么？** `npm install && node examples/12-team.ts`（一条命令，不需要 key，七个面全出场）。
> **想自己动手做实验？** `cp -r demo demo-exp1 && node demo-exp1/lab.ts`（**实验脚手架**：复制即用，改 `lab.ts` 就行；跑真模型，需要 `demo/agent/auth.json`）。
> **只想验证这台机器能不能跑？** `node demo/check.ts`（八项环境自检）。

## 核心模型

下面三样是 **v1 当作「库的功能」的东西，v2 全部移出了库**——它们现在是**使用者代码**，写在哪、要不要做，都是你的决定：

| 概念 | 含义 | v2 里由谁定义 |
|---|---|---|
| **成员（Member）** | 一种预定义好的 agent 类型：职责、技能、插件、工具集、模型 | **只有设计者**（写代码的人），就是你代码里的一个对象（`examples/09-roster.ts`） |
| **分身（Instance）** | 某个成员的一个运行实例，同一成员可起多个 | 由**设计者的代码**在运行时调 `lab.createAgent` 起（`examples/10-spawn.ts`） |
| **花名册（members）** | 设计者声明的全部成员 | 设计者。v1 里它是 `createAgentHost({ members })` 的入参，**v2 已把那个函数删掉** |

**红线同理**：v1 的「agent 不能设计、不能配置 agent」是焊在库里的；v2 把它降成一条**可被推翻的假设**，写在 `examples/11-redline.ts` 的使用者代码里。

好处仍然是双向的：agent 没有提权面（无法指定 `cwd` / `agentDir` / `extensions`，也就无法让子 agent 加载任意代码或换用贵模型）；而设计者的灵活性不受损——想加一种新 agent，就在花名册里加一个成员。

## 装

```bash
npm install
```

要求 Node ≥ 24（直接跑 `.ts`，靠 Node 原生类型剥离），peer 依赖是 `@earendil-works/pi-coding-agent@0.99.1`。
库本身不发布，按本地路径引用或直接读源码。

## 用

对外只有一个入口：`createLab({ agentDir, cwd, ... })` → `Lab`——环境在这里声明一次，agent 由 `lab.createAgent(spec?)` 起，环境自检是 `lab.inspectEnv()`（只读）。库**不附带任何内置工具**、没有花名册、没有委派能力——工具集要么用 `permissions.only` 显式给，**要么就是 pi 的默认集**（`read` / `bash` / `edit` / `write`）；要**零工具**必须显式写 `permissions.only: []`。

最小可跑示例：[`examples/01-first-agent.ts`](examples/01-first-agent.ts)（起一个 agent、交办一件事、拿 `RunResult`）。`examples/` 里 `01`–`08` 一面一事，`09`–`11` 是上面三条假设的「可被推翻的写法」，`12-team.ts` 是七面全出场的完整案例。
逐面怎么用、每个取舍的代价，见 [`docs/GUIDE.md`](docs/GUIDE.md)。

### 环境：三样东西

`agentDir` 决定这个实验室起的 agent 能用什么。**必填，没有默认值**——缺 `agentDir` 或缺 `cwd` 直接抛错，也不会回落到环境变量或本机 pi 目录（`~/​.pi/agent`）；换成自己的目录就完全脱离本机 pi 设置。一个目录里只放三样：

```
my-pi/
  models.json + auth.json   模型 api（也可只用环境变量凭证）
  extensions/               插件
  skills/                   技能
```

`lab.inspectEnv()` 把这套环境里**实际生效**的东西摊平给你看：`models`（只列配好凭证的 provider）/ `extensions`（路径、来源、它注册了哪些工具名）/ `skills` / `contextFiles`（跟着 `cwd` 走的上下文文件链）/ `warnings`（目录不存在、没有 `models.json`、扩展加载失败、`SYSTEM.md` 会整体替换提示词…）。
跑法见 `demo/check.ts` 第 3 项。

模型目录默认允许联网刷新（`createLab` 的 `modelNetwork` 选项，pi.dev 的 overlay，缓存在 `<agentDir>/models-store.json`，4 小时新鲜度窗口）。`PI_OFFLINE=1` 关掉一切模型网络请求。

设计者也可以不走工具，直接把一个 agent 的输出喂给另一个：`a.io.prompt(...)` 的 `text` 直接拼进 `b.io.prompt(...)`，或让两个 agent 通过共享的外部状态（黑板文件、数据库）交换——怎么做都是你的代码。例子见 [`examples/12-team.ts`](examples/12-team.ts)。

### API 速览

对外只有一个函数：

| | |
|---|---|
| `createLab(opts)` | **唯一**的启动入口 → `Lab`：`agentDir` / `cwd` 必填（环境），另有 `modelNetwork` / `catalogBaseUrl` / `modelRuntime` |
| `lab.createAgent(spec?)` | **唯一**的 agent 创建入口 → `Agent`（七个面 + 句柄 + 观测） |
| `lab.inspectEnv()` | 环境自检（模型 / 扩展 / 技能 / 上下文文件 / 警告），只读，不建 agent |

`Agent` 上是**七个面**：`io`（`prompt` / `queue` / `steer` / **`interrupt` 截断输入** / `abort` / `waitIdle` / 结算 `RunResult`）、`context`（`history` / 逐轮覆盖 / 追改与抹除 / **整段 `reset`** / 压缩）、`tools`（有哪些工具存在 / 工具结果拦截 `onResult`）、`permissions`（`only` / `allow` / `deny` + 审批门 `gate`）、`extensions`、`skills`、`model`。此外只有句柄（`id` / `usage` / `status` / `dispose`）、观测（`on` / `onAny`，直接镜像 pi 的 `ExtensionEvent`）与 raw 逃生口。逐面怎么用见 [`docs/GUIDE.md`](docs/GUIDE.md)。

`spec` 字段与运行期面一一对应（契约见 `src/agent/types.ts` 的 `AgentSpec`）：`context.autoCompact` / `tools.custom` / `permissions.only` / `permissions.deny` / `permissions.gate` / `extensions` / `skills` / `model` / `thinking`，外加 `id` / `role`。**`agentDir` / `cwd` / `modelNetwork` / `catalogBaseUrl` 不在 `spec` 里**——它们是实验室的环境声明，写进 spec 会被拒。**不写 `permissions.only` 就是 pi 的默认工具集**；白名单会自动并入你在同一 spec 里显式声明的工具名。

## demo：实验脚手架（完整案例在 `examples/12-team.ts`）

```bash
npm install                          # 装依赖（Node ≥ 24）
node examples/12-team.ts             # 完整案例：多 agent 协作（七个面全出场，本机假 provider，不需要 key）
cp -r demo demo-exp1                 # 实验脚手架：复制即开始你自己的实验（环境 demo/agent/ 跟着走）
node demo-exp1/lab.ts                # 跑它（真模型 opencode-go/space-bunny-free，需 demo/agent/auth.json）
node demo/check.ts                   # 环境自检：八项（环境出问题时来这查）
```

`demo/` 是**实验脚手架**（`lab.ts` 190 行，复制即开始你自己的实验）：环境声明 + 模板 + 七个面各自一次真实调用，
七段各有一个「改这里」的锚点。它**跑真模型**（默认 `opencode-go/space-bunny-free` 免费档），凭证放 `demo/agent/auth.json`。
**完整案例在 [`examples/12-team.ts`](examples/12-team.ts)**（786 行：两个检索分身偏一个写作员，
七个面全出场、跑完打印自证表、每一处设计决策旁边一行「要检验这条，改成 X 再跑」；那个走本机假 provider，零成本）—— 脚手架要短，案例要全，两者服务不同的人。
环境是**仓库里看得见、可手改的目录** `demo/agent/`（**就是** `createLab` 的 `agentDir`：技能与扩展进仓库，
`auth.json` 等动态文件不入库），不读本机 pi 的设置。每一档管什么、怎么自己改见
[`demo/agent/README.md`](demo/agent/README.md)。

### 凭证与模型（demo 跑真模型）

```bash
node demo/lab.ts                                      # 默认：opencode-go/space-bunny-free
AITEAM_DEMO_MODEL=opencode-go/别的模型 node demo/lab.ts   # 换模型
AITEAM_DEMO_AUTH=/path/to/auth.json node demo/lab.ts     # 换凭证（会被复制进 demo/agent/auth.json）
```

- 默认模型是 **`opencode-go/space-bunny-free`（免费档）**；换别的：`AITEAM_DEMO_MODEL=provider/id`。
- **demo 用它自己的 key**（`demo/agent/auth.json`，gitignored），**全程不读也不写宿主 `~/.pi/agent`**——宿主凭证跑完逐字节不变（实测）。
- **真模型下每次输出都不同**：措辞、调几次工具、分几节都会变 —— `demo/lab.ts` 打印的数字（`tokens=`、工具次数、`history=`）每次跑都不一样。要看「完全确定」的样子：`examples/12-team.ts` 与 `demo/check.ts` 的对照。

### 运行结果的标准

三个命令都该以退出码 0 收尾：`node examples/12-team.ts`（**完整案例**）结尾打印七面自证表、七面全部 ≥ 1；
`node demo/lab.ts`（**脚手架**）结尾打印工具调用序列、用量与产物路径；
`node demo/check.ts`（**环境自检**）八项全是「通过」，最后两行必须是：

```
八项全通过 —— 本机可以开始研究 agent 课题了。
下一步：node examples/01-first-agent.ts（最小演示）；失败时怎么读输出见 demo/README.md。
```

并且退出码是 0。八项分别验：

| 项 | 过了意味着 |
|---|---|
| 1–2 环境 | Node 不用任何开关就能直接跑 `.ts`；钉住的 pi 版本可解析 |
| 3 环境 | `agentDir` 真可写、凭证与模型真读得到（走实验室的 `lab.inspectEnv()`） |
| 4–5 起 agent | 拿到 `agent.id` 与当前模型；一轮 `io.prompt` 的 `text` 非空、`error` 为空 |
| 6 工具 | 一个工具的**执行体**真被模型调过（判据是执行体里的闭包计数器）——`tools.list()` 里有它**不**算数，那只说明声明在。提示词让它「在 demo_probe 与 demo_probe_b 里**任选一个**调」：二选一，它没有「不调」这个选项 |
| 7 环境隔离 | **只看得到 demo 自己的技能与插件**（不用跑模型）：既看得到自己那份（证明自动发现这条路是通的），又看不到宿主 `~/.pi/agent` 里的任何一份（证明隔离真的生效）——只有一条成立都说明不了问题 |
| 8 覆盖面 | 七个面各自至少一次读写，能读回状态的都读回校验 |

挂了不会静默：该项行尾打 `… 失败`，下一段跟原始错误（含栈）+ 三个最可能原因与怎么补，退出码 1。失败信息走 stderr、通过信息走 stdout。
`demo/work/` 是**可再生的产物**（`demo/agent/` 是环境目录本身：技能与扩展进仓库，`auth.json` 不进），删掉重跑即可重建。
每一项在检查什么、怎么读失败输出，见 [`demo/README.md`](demo/README.md)。

⑧ 个命令里唯一**不需要 key、不需要联网**的两个是 `node examples/12-team.ts` 与 `npm test`（它们走本机假 provider）——
`demo/lab.ts` 与 `demo/check.ts` 都要真凭证。

`npm test`：144 项测试走本机假 provider，零 API 成本，不碰真模型。

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
npm test            # 144 项测试，本机假 provider，零 API 成本 —— 改完先跑它
npm run typecheck   # tsc --noEmit
node demo/lab.ts    # 实验脚手架：复制即开始你自己的实验（真模型，需 demo/agent/auth.json）
node examples/12-team.ts # 完整案例：七个面全出场的一次多 agent 协作（不需要 key，本机假 provider）
node demo/check.ts  # 八项环境自检（真模型）
```

`npm test` 里没有真 API：`test/helpers.ts` 会起一个本机假 provider（HTTP + SSE），用一个模块级实验室把 `agentDir` 指向它，并设 `PI_OFFLINE=1`。每个测试文件是独立进程，互不污染。

### 改哪儿

| 你要改的东西 | 落点 |
|---|---|
| 创建 / 生命周期 / 句柄接线 | `src/agent/create-agent.ts` |
| 面 = pi 钩子的分组封装（`on` / `onAny` / 槽位 / 忙判据） | `src/agent/bridge.ts` |
| 七个面各自的行为 | `src/surfaces/io.ts` · `src/surfaces/context.ts` · `src/surfaces/tools.ts` · `src/surfaces/resources.ts` · `src/surfaces/model.ts` |
| skills / extensions / role 的注入与解析 | `src/agent/loader.ts` |
| 环境自检 `lab.inspectEnv` | `src/agent/env.ts` |
| 用量累计 | `src/agent/usage.ts` |
| 对外类型（无运行时逻辑） | `src/agent/types.ts` |
| 对外导出（唯一入口，不做逻辑） | `src/index.ts` |
| 设计 / 实测事实 / 用法 | `docs/DESIGN.md` / `docs/FACTS.md` / `docs/GUIDE.md` |

相对 import **必须带 `.ts` 后缀**，只能用**可擦除**的 TS 语法（无 `enum` / `namespace` / 装饰器 / 参数属性）。

### 改代码的五条规矩

这几条是这个库可信度的来源，不是风格偏好：

1. **L1 不做 SDK 已经做了的事。** 加功能前先确认 pi SDK 里没有等价物 —— `node_modules/@earendil-works/pi-coding-agent/docs/` 是第一手资料。
2. **只说实测过的。** 任何「已实现 / 已修复」都要配一个能跑出结果的检查：`npm test` 里的一条断言、`examples/` 下某个文件的实际输出，或 `node demo/check.ts` 的一项。
3. **类型不重定义。** `Skill` / `ToolDefinition` / `AgentSession` / `Message` / `Usage` / `ThinkingLevel` 一律从 pi 的包 import。
4. **唯一创建入口。** 环境只能在 `createLab` 声明、agent 只能经 `lab.createAgent` 起，不加第二条造 agent 的路径（v1 那种顶层 `createAgent()` 已经不导出）；库不给 agent 附带任何提权工具——委派、收窄工具集都是使用者代码，见 `examples/10-spawn.ts` 与 `examples/11-redline.ts`。
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

`test/helpers.ts` 里有现成的 ground truth：`sentTools()`（模型**实际**收到的工具名）、`sentMessages()`（**实际**发出的消息条数）、`echoTool()`（现成的回显工具）、`captureSystemPrompt()`（**实际**发出的 system）、`faux.calls`（假服务收到的一切）。

### 不花钱验证一个能力

不确定 SDK 的某个行为时**不要猜**，写一个一次性探针 —— 探针基建现在是 `examples/lib/`
（本机假 provider（HTTP + SSE）+ 临时 agentDir / cwd）与它的离线 harness，起一个文件就能跑：

```bash
node examples/03-context.ts   # 一个面一个文件；输出里自带判别力，跑一遍就知道它说的是不是真的
node demo/check.ts            # 八项环境自检（真模型，需 demo/agent/auth.json）
npm test                      # 全部断言，本机假 provider，零 API 成本
```

探针跑出来的结论：被验证的**决策**写进 `docs/FACTS.md`（带编号与出处），**用法**写进 `docs/GUIDE.md`。
真模型实验先跑 1 次记下实际 token 与花费，再决定样本量；费用从 `agent.usage.cost.total` 累加。

### 提交

Conventional Commits + 中文描述（照 `git log` 的风格）：`feat:` / `fix:` / `docs:` / `chore:`。
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

**下面四条是 v1 时期一轮能力与极限审计的结论（约 50 个探测脚本、600+ 条实测项、约 400 次真实模型调用）。**
机制层的坏的在 v2 已修；「配置层静默失效」是仍在根除的课题，v2 的对策是**不静默**：写错的模型名抛错、非法思考档抛错、加载不出技能的路径抛错、钩子异常转成带前缀的 `console.error`。

- **机制层可靠**：钩子、工具通道、事件、`abort`、`dispose`、子进程并发，测下来基本没有坏的。
- **配置层不可靠而且静默**：写错一个字段名就能把功能关掉、把工具集清空、把审批门废掉，全程零信号。
- **归属层不可靠而且静默**（**v2 已修**）：v1 的 `RunResult` 不跟调用绑定，重叠投递下会把别人的答案给你——**包括 `spawn_agent`**。v2 的 `RunResult` **与调用绑定**：`io.prompt` 起手时同步记下消息下标，各自持自己的区间，并发投递不会串台（`src/surfaces/io.ts`）。
- **长跑状态层**：上下文超限会让分身永久静默返回空；预算对主要成本来源是盲的；回收不还配额。

细节与复现脚本见 [`docs/research/`](docs/research/)。

**明确不承诺**：pi 没有内置沙箱，`tools` 白名单只是工具集裁剪，扩展与 `bash` 可以绕过它。真正的隔离只能靠容器 / VM。本库提供的是**能力裁剪 + 审批门**，不是安全边界。

## 目录

```
src/index.ts    唯一导出入口（不做逻辑）：createLab + 对外类型
src/agent/      实验室与单 agent 的创建接线
  lab.ts            createLab：环境所有者与唯一启动入口
  create-agent.ts   agent 的创建路径（只经 lab.createAgent 到达）→ Agent（七面 + 句柄 + 观测）
  bridge.ts         面 = pi 钩子的分组封装；忙判据；R47 形状守卫
  loader.ts         skills / extensions / role 的配置收敛
  env.ts            环境自检的实现（lab.inspectEnv）：模型/插件/技能，只读
  usage.ts          用量累计（本次 vs 全生命周期）
  types.ts          全部对外类型（无运行时逻辑）
src/surfaces/   七个面：io / context / tools（含 permissions）/ resources（extensions + skills）/ model
test/           node:test，全部走本机假 provider，零 API 成本
examples/       能 node 直接跑的示例 + 离线基建（examples/lib/）
demo/           实验脚手架：lab.ts（起点）+ agent/（环境，= agentDir）+ check.ts（八项自检）；完整案例是 examples/12-team.ts
docs/           设计文档 + 用法讲解
```

## 文档

- [`AGENTS.md`](AGENTS.md) —— 项目是什么（快速全貌）
- [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) —— **使用指导**：第一次接手的人从哪开始（环境、自检、示例、改哪儿、三条纪律）
- [`docs/GUIDE.md`](docs/GUIDE.md) —— **用法讲解**：先跑起来、创建、结算、七个面、观测、要求空闲的动作、环境自检、raw 逃生口（代码引用 `examples/lib/snippets.ts` 的同源片段）
- [`docs/DESIGN.md`](docs/DESIGN.md) —— 宏观设计（唯一设计源）：操控面理想与现状、对外接口、能力边界
- [`docs/FACTS.md`](docs/FACTS.md) —— 已实测核对的实现决策
- [`docs/research/`](docs/research/) —— 能力与极限审计报告 · [研究问题清单（26 条 / 7 家族）](docs/research/2026-10-01-research-questions.md)

## 许可

MIT，见 [LICENSE](LICENSE)。
