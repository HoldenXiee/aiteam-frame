# aiteam

**一个 Agent 操控库。**

给设计者的代码一双手，在运行期**读、改、拦截**一个 agent 的每个面：它收什么（上下文）、能干什么（工具）、被允许干什么（权限）、用谁（模型）、怎么投递与结算（io）、装了什么（扩展与技能）。

薄，是刻意的：它建在 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK 之上，只做「面的组织」与「运行的结算」，不重写 pi 已有的任何东西。**库不含策略**——花名册、委派、护栏、红线都是**使用者代码**。

它的定位是**研究工具**，不是产品。所以两条要求贯穿全库：**操控能力要够绝对**（凡是 pi 能做的，你的代码都能拧到），**材料要能取出来**（上下文、事件、工具调用、用量，都能编程取用）。另外两条禁令：别过度封装（包一层就少一个旋钮）、别产品化（产品替用户决定，研究工具不替）。

> **第一次接手？** [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) —— 30 分钟跑起来、看懂、开始改。
> **想看它到底能操控什么？** `npm install && node examples/12-team.ts` —— 七个面全出场的一次多 agent 协作（不需要 key）。
> **想动手做实验？** `cp -r demo demo-exp1 && node demo-exp1/lab.ts` —— 实验脚手架，复制即用。

---

## 装

```bash
npm install
```

Node ≥ 24（直接跑 `.ts`，靠 Node 原生类型剥离）。没有构建步骤、没有打包器、没有 lint 器。
peer 依赖是 `@earendil-works/pi-coding-agent@0.99.1`（精确等值，`demo/check.ts` 会验）。库不发布，按本地路径引用或直接读源码。

## 用

对外**只有一个函数**：

```ts
import { createLab } from "./src/index.ts";

const lab = await createLab({
  agentDir: "./my-pi",   // 环境：凭证、模型、技能、扩展都从这里找。必填
  cwd: "./work",         // 工作目录：这个实验室起的 agent 共用。必填
});

const agent = await lab.createAgent({          // 唯一的 agent 创建入口
  id: "检索员",
  model: "opencode-go/deepseek-v4.1-flash",   // demo 用的（收费）；见下文「模型怎么选」
  tools: { custom: [mySearchTool] },           // 自定义工具
  permissions: { only: ["my_search"] },        // 能力裁剪
});

const result = await agent.io.prompt("……");     // 一次运行 = agent_start → agent_settled
console.log(result.text, result.usage);
```

**环境必须显式声明**：缺 `agentDir` 或缺 `cwd` 直接抛错，没有默认值，也不会回落到本机 pi 目录（`~/.pi/agent`）。换成你自己的目录，就完全脱离本机 pi 设置——这是「实验环境必须可复现」的前提。

`spec`（`createAgent` 的入参）与运行期的七个面一一对应：

| 面 | 创建期（`spec`） | 运行期（`agent.<面>`） |
|---|---|---|
| `io` 投递与结算 | —— | `prompt` / `queue` / `steer` / `interrupt` / `abort` / `waitIdle`；读数 `pending` / `isRunning` |
| `context` 上下文 | `context.autoCompact` | `history` / `entries` / `replace` / `erase` / `reset` / `override` / `compact` / `usage` |
| `tools` 有哪些工具 | `tools.custom` | `list` / `add` / `remove` / `onResult` |
| `permissions` 允许哪些 | `permissions.only` / `deny` / `gate` | `only` / `allow` / `deny` / `gate` |
| `extensions` 插件 | `extensions` | `list` / `add` / `remove` / `errors` |
| `skills` 技能 | `skills` | `list` / `add` / `remove` |
| `model` 模型与档位 | `model` / `thinking` | `current` / `thinking` / `available` / `set` / `setThinking` |

此外只有四样：**句柄**（`id` / `usage` / `status` / `dispose`）、**观测**（`on` 按名收窄 / `onAny` 全量，直接镜像 pi 的 `ExtensionEvent`，返回退订函数）、**结算**（`RunResult`：`runId` / `text` / `usage` / `error` / `messages`）、**raw 逃生口**（除 `permissions` 外每个面都有 `agent.<面>.raw`，指向对应的 pi 对象；全权、无护栏）。

逐面的取舍与代码片段见 [`docs/GUIDE.md`](docs/GUIDE.md)。

### 环境就是一个目录

`agentDir` 里有什么，agent 就能用什么——不写在代码里，就是目录里有哪些文件（**环境即目录、目录即配置**）：

```
my-pi/
  auth.json          凭证
  models.json        模型目录（也可只用环境变量凭证）
  skills/<名>/SKILL.md   技能
  extensions/<名>.ts     插件
  SYSTEM.md          系统提示词（有就是**整体替换**）
```

技能与扩展走 pi 的**自动发现**：放着就生效，不用写进 `spec`。所以「改环境 = 改文件」「review 环境 = 看 diff」。

`lab.inspectEnv()` 把这套环境里**实际生效**的东西摊平给你看——`models`（只列配好凭证的 provider）/ `extensions`（路径、来源、注册了哪些工具名）/ `skills` / `contextFiles` / `warnings`（目录不存在、扩展加载失败、`SYSTEM.md` 会整体替换提示词…）。它只读、不建 agent、不写盘，回答的是「为什么我一个模型都没有」这类问题。

### 三个库不提供的概念（它们是使用者代码）

| 概念 | 含义 | 谁定义 |
|---|---|---|
| **成员（Member）** | 一种预定义好的 agent 类型：职责、技能、插件、工具集、模型 | **你**——就是你代码里的一个对象（[`examples/09-roster.ts`](examples/09-roster.ts)） |
| **分身（Instance）** | 某个成员的一个运行实例，同一成员可起多个 | **你的代码**在运行时调 `lab.createAgent`（[`examples/10-spawn.ts`](examples/10-spawn.ts)） |
| **红线** | 「agent 不能设计、不能配置 agent」这类约束 | **你的代码**——库把它降成一条可被推翻的假设（[`examples/11-redline.ts`](examples/11-redline.ts)） |

这三个文件头部都标着「⚠️ 这是一个【假设】，不是推荐做法」——因为**库不该替你想这件事**。要检验某条假设，改那段使用者代码、重跑、看结果。

## 示例与脚手架

```bash
node examples/01-first-agent.ts      # 最小：起 agent、交办、拿 RunResult
node examples/02-events.ts           # 观测：on 按名收窄 / onAny 全量
node examples/03-context.ts          # 上下文：读 / 改本轮 / 压缩 / 整段重置
node examples/04-tools.ts            # 工具：运行期加 / 结果拦截
node examples/05-permissions.ts      # 权限：精确白名单 + 审批门
node examples/06-resources.ts        # 扩展与技能：运行期加载
node examples/07-model.ts            # 模型与思考档
node examples/08-raw-escape.ts       # raw 逃生口
node examples/12-team.ts             # 完整案例：七个面全出场的一次多 agent 协作
```

`01`–`08` 一面一事，每个文件只演示一件事并自带判别力；`09`–`11` 是上面三条约定的可被推翻写法；`12-team.ts` 是完整案例（786 行、结尾自证七个面各出场 ≥ 1、每处设计决策旁一行「要检验这条，改成 X 再跑」）。

它们全部走**本机假 provider**（`examples/lib/`）：离线、零 API 成本、结果确定、不需要 key。

### `demo/` 是实验脚手架，不是示例

```bash
cp -r demo demo-exp1        # 复制：环境（demo/agent/）跟着一起走
# 改 demo-exp1/lab.ts      # 七段各有一个「改这里」的锚点
node demo-exp1/lab.ts       # 跑
```

`lab.ts` 是**一份实验一个文件**：环境声明 → 模板 → 起分身 → 自定义工具 → 交办 → 观测 → 打印。它**跑真模型**（`demo/env.ts` 里 `MODEL` 那一行直接赋值，当前是 `opencode-go/deepseek-v4.1-flash`，**收费档约 $0.0002/轮**），凭证放 `demo/agent/auth.json`；换模型、换凭证都是改 `demo/env.ts`，不走环境变量。

**模型怎么选（两个位置，职责不同）**：

| 位置 | 谁定 | 该用什么 |
|---|---|---|
| `demo/env.ts` 的 `MODEL` | **研究员自己** | 随你。收费也行 —— 你自己跑、自己知道花了多少 |
| `AGENTS.md` 规则② | **AI 替项目配默认值** | **必须免费档** —— 否则额度会在没人察觉时流走 |

所以示例代码里写 `deepseek-v4.1-flash` 是可以的（那是给人看的演示）；
但 AI 自己新建 agent 集群 / 示例时，默认得走 `longcat-2.5-preview-free`。

- **环境跟着副本走**：`demo/env.ts` 里的 `agentDir()` 相对本文件解析，所以 `demo-exp1/` 用 `demo-exp1/agent/`，不是原 demo 的。
- **真模型下不保证调工具**：提示词是自然语言（`[[tool:…]]` 那套是假 provider 的脚本约定，真模型只会当正文回你），所以「它一定调了某工具」不能当断言用。想看它实际调了什么，用 `on("tool_call")` 观测——那是一等接口。
- `demo/exp-io-*.ts` 是两个已经写好的实验，示范「一个实验一个文件」的形态。
- `node demo/check.ts` 是八项环境自检（真模型），怀疑环境出问题时来这里，失败输出带「三个最可能原因与怎么补」。

细节见 [`demo/README.md`](demo/README.md) 与 [`demo/agent/README.md`](demo/agent/README.md)（环境规范：每一档管什么、哪些能删）。

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

## 库不做的事

| 不做 | 为什么 |
|---|---|
| **不含策略**：没有花名册、没有委派、没有护栏、没有红线 | 库替你做决定，你就少一个旋钮。它们都在 `examples/09`–`11` 里作为**使用者代码**演示 |
| **不做 pi 已经做了的事** | 加功能前先确认 SDK 没有等价物（`node_modules/@earendil-works/pi-coding-agent/docs/` 是第一手资料） |
| **不是安全边界** | pi 没有内置沙箱；`permissions.only` 是**工具集裁剪**，扩展与 `bash` 可以绕过它。本库提供的是**能力裁剪 + 审批门**，真正的隔离只能靠容器 / VM |
| **不落盘** | 会话在内存里（`SessionManager.inMemory`）。要导出走 `raw`（pi 有 `exportToJsonl` / `exportToHtml` / `getSessionStats`） |
| **不发布** | 按本地路径引用或直接读源码 |

**明确不承诺**：上下文超限、预算、长跑状态恢复这些**长跑状态层**的能力还没有；`permissions` 是唯一没有 `raw` 出口的面（pi 的白名单是私有字段，没有公开对象可指）。

## 开发

```bash
npm test            # 144 项断言，本机假 provider，零 API 成本 —— 改完先跑它
npm run typecheck   # tsc --noEmit
```

**测试里没有真 API**：`test/helpers.ts` 起一个本机假 provider（HTTP + SSE），用一个模块级实验室把 `agentDir` 指向它，并设 `PI_OFFLINE=1`；每个测试文件是独立进程。`test/helpers.ts` 提供了现成的 ground truth：`sentTools()`（模型**实际**收到的工具名）、`sentMessages()`（**实际**发出的消息条数）、`captureSystemPrompt()`（**实际**发出的 system）、`faux.calls`（假服务收到的一切）。

### 改哪儿

| 你要改的东西 | 落点 |
|---|---|
| 创建 / 生命周期 / 句柄接线 | `src/agent/create-agent.ts` |
| 面 = pi 钩子的分组封装（`on` / `onAny` / 专属槽位 / 忙判据） | `src/agent/bridge.ts` |
| 七个面各自的行为 | `src/surfaces/{io,context,tools,resources,model}.ts` |
| 环境声明与唯一启动入口 | `src/agent/lab.ts` |
| 技能 / 扩展 / role 的注入与解析 | `src/agent/loader.ts` |
| 环境自检 `lab.inspectEnv` | `src/agent/env.ts` |
| 用量累计（本次 vs 全生命周期） | `src/agent/usage.ts` |
| 对外类型（无运行时逻辑） | `src/agent/types.ts` |
| 对外导出（唯一入口，不做逻辑） | `src/index.ts` |
| 设计 / 实测事实 / 用法 | `docs/DESIGN.md` / `docs/FACTS.md` / `docs/GUIDE.md` |
| 自定义工具 | `docs/TOOLS-BASICS.md`（基础）/ `docs/TOOLS.md`（高级） |

相对 import **必须带 `.ts` 后缀**；只能用**可擦除**的 TS 语法（无 `enum` / `namespace` / 装饰器 / 参数属性）。

### 五条纪律

这几条是这个库可信度的来源，不是风格偏好：

1. **只做 pi 没做的事**（L1）。加功能前先确认 SDK 里没有等价物。
2. **只说实测过的。** 任何「已实现 / 已修复」都要配一个能跑出结果的检查：`npm test` 的一条断言、`examples/` 某个文件的实际输出，或 `demo/check.ts` 的一项。
3. **类型不重定义。** `Skill` / `ToolDefinition` / `AgentSession` / `Message` / `Usage` / `ThinkingLevel` 一律从 pi 的包 import。
4. **唯一创建入口。** 环境只能在 `createLab` 声明、agent 只能经 `lab.createAgent` 起，不加第二条造 agent 的路径。
5. **接口变了就同步三份文档**：`DESIGN.md`（接口与现状）→ `FACTS.md`（带编号的决策与理由）→ `GUIDE.md`（怎么用）。

### 不花钱验证一个能力

不确定 SDK 的某个行为时**不要猜**，写一个一次性探针 —— 探针基建在 `examples/lib/`（本机假 provider + 临时 agentDir / cwd），起一个文件就能跑：

```bash
node examples/03-context.ts   # 一个面一个文件，输出自带判别力
npm test                      # 全部断言，零 API 成本
```

探针跑出来的结论：被验证的**决策**写进 [`docs/FACTS.md`](docs/FACTS.md)（带编号与出处），**用法**写进 [`docs/GUIDE.md`](docs/GUIDE.md)。

### 提交

Conventional Commits + 中文描述：`feat:` / `fix:` / `docs:` / `chore:`。
`demo/work/`、`demo/agent/auth.json` 等是运行产物与凭证，已在 `.gitignore` 里。

## 仓库地图

```
src/index.ts    唯一导出入口（不做逻辑）：createLab + 对外类型
src/agent/      lab.ts（环境所有者与唯一启动入口）· create-agent.ts（创建路径）· bridge.ts（面 = pi 钩子分组）· loader.ts（资源注入）· env.ts（自检）· usage.ts · types.ts
src/surfaces/   七个面：io · context · tools（含 permissions）· resources（extensions + skills）· model
test/           node:test，全部走本机假 provider，零 API 成本
examples/       12 个能 node 直接跑的示例 + 离线基建（examples/lib/）
demo/           实验脚手架：lab.ts（起点）+ agent/（环境 = agentDir）+ check.ts（八项自检）+ exp-*.ts（两个写好的实验）
docs/           设计源、用法讲解、实测事实、研究
```

## 文档

- [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) —— **使用指导**：第一次接手的人从哪开始
- [`docs/GUIDE.md`](docs/GUIDE.md) —— **用法讲解**：逐面讲每个面怎么用、每个取舍的代价（代码引用 `examples/lib/snippets.ts` 的同源片段，会被 `tsc` 检查）
- [`docs/DESIGN.md`](docs/DESIGN.md) —— **唯一设计源**：操控面理想与现状、对外接口、能力边界
- [`docs/FACTS.md`](docs/FACTS.md) —— 已实测核对的实现决策（带编号与出处）
- [`AGENTS.md`](AGENTS.md) —— 项目是什么（快速全貌，给接手的人/agent）
- [`docs/research/`](docs/research/) —— 能力与极限审计报告 · 研究问题清单

## 许可

MIT，见 [LICENSE](LICENSE)。
