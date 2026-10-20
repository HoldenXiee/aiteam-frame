# aiteam 用法

> 这个库怎么装、怎么起 agent、怎么用七个面。
> 研究方向的说明在仓库根 [`README.md`](../README.md)。

---

## 装

```bash
npm install
```

Node ≥ 24（直接跑 `.ts`，靠 Node 原生类型剥离）。没有构建步骤、没有打包器、没有 lint 器。
peer 依赖是 `@earendil-works/pi-coding-agent@0.99.1`（精确等值，`dev/demo/check.ts` 会验）。库不发布，按本地路径引用或直接读源码。

---

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
  model: "opencode-go/deepseek-v4.1-flash",
  tools: { custom: [mySearchTool] },           // 自定义工具
  permissions: { only: ["my_search"] },        // 能力裁剪
});

const result = await agent.io.prompt("……");     // 一次运行 = agent_start → agent_settled
console.log(result.text, result.usage);
```

**环境必须显式声明**：缺 `agentDir` 或缺 `cwd` 直接抛错，没有默认值，也不会回落到本机 pi 目录（`~/.pi/agent`）。换成你自己的目录，就完全脱离本机 pi 设置——这是「实验环境必须可复现」的前提。

`spec`（`createAgent` 的入参）与运行期的八个面一一对应：

| 面 | 创建期（`spec`） | 运行期（`agent.<面>`） |
|---|---|---|
| `io` 投递与结算 | —— | `prompt` / `queue` / `steer` / `interrupt` / `abort` / `waitIdle`；读数 `pending` / `isRunning` |
| `context` 上下文 | `context.autoCompact` | `history` / `entries` / `replace` / `erase` / `reset` / `override` / `compact` / `usage` |
| `tools` 有哪些工具 | `tools.custom` | `list` / `add` / `remove` / `onResult` |
| `permissions` 允许哪些 | `permissions.only` / `deny` / `gate` | `only` / `allow` / `deny` / `gate` |
| `extensions` 插件 | `extensions` | `list` / `add` / `remove` / `errors` |
| `skills` 技能 | `skills` | `list` / `add` / `remove` |
| `model` 模型与档位 | `model` / `thinking` | `current` / `thinking` / `available` / `set` / `setThinking` |
| `observe` 观测 | —— | `messages`（每轮真正发给模型的 messages，含 system）/ `tokens` / `injections` |

此外还有四样：**句柄**（`id` / `usage` / `status` / `dispose`）、**观测**（`on` 按名收窄 / `onAny` 全量，直接镜像 pi 的 `ExtensionEvent`，返回退订函数）、**结算**（`RunResult`：`runId` / `text` / `usage` / `error` / `messages`）、**raw 逃生口**（除 `permissions` 外每个面都有 `agent.<面>.raw`，指向对应的 pi 对象；全权、无护栏）。

逐面的取舍与代码片段见 [`GUIDE.md`](../dev/docs/GUIDE.md)。

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
| **成员（Member）** | 一种预定义好的 agent 类型：职责、技能、插件、工具集、模型 | **你**——就是你代码里的一个对象（[`dev/examples/09-roster.ts`](../dev/examples/09-roster.ts)） |
| **分身（Instance）** | 某个成员的一个运行实例，同一成员可起多个 | **你的代码**在运行时调 `lab.createAgent`（[`dev/examples/10-spawn.ts`](../dev/examples/10-spawn.ts)） |
| **红线** | 「agent 不能设计、不能配置 agent」这类约束 | **你的代码**——库把它降成一条可被推翻的假设（[`dev/examples/11-redline.ts`](../dev/examples/11-redline.ts)） |

这三个文件头部都标着「⚠️ 这是一个【假设】，不是推荐做法」——因为**库不该替你想这件事**。要检验某条假设，改那段使用者代码、重跑、看结果。

---

## 示例与脚手架

```bash
node dev/examples/01-first-agent.ts      # 最小：起 agent、交办、拿 RunResult
node dev/examples/02-events.ts           # 观测：on 按名收窄 / onAny 全量
node dev/examples/03-context.ts          # 上下文：读 / 改本轮 / 压缩 / 整段重置
node dev/examples/04-tools.ts            # 工具：运行期加 / 结果拦截
node dev/examples/05-permissions.ts      # 权限：精确白名单 + 审批门
node dev/examples/06-resources.ts        # 扩展与技能：运行期加载
node dev/examples/07-model.ts            # 模型与思考档
node dev/examples/08-raw-escape.ts       # raw 逃生口
node dev/examples/12-team.ts             # 完整案例：七个面全出场的一次多 agent 协作
```

`01`–`08` 一面一事，每个文件只演示一件事并自带判别力；`09`–`11` 是上面三条约定的可被推翻写法；`12-team.ts` 是完整案例，结尾自证七个面各出场 ≥ 1，每处设计决策旁一行「要检验这条，改成 X 再跑」。

它们全部走**本机假 provider**（`dev/examples/lib/`）：离线、零 API 成本、结果确定、不需要 key。

### `dev/demo/` 是实验脚手架，不是示例

```bash
cp -r dev/demo dev/demo-exp1        # 复制：环境（dev/demo/agent/）跟着一起走
# 改 dev/demo-exp1/lab.ts            # 七段各有一个「改这里」的锚点
node dev/demo-exp1/lab.ts            # 跑
```

`lab.ts` 是**一份实验一个文件**：环境声明 → 模板 → 起分身 → 自定义工具 → 交办 → 观测 → 打印。它**跑真模型**（`dev/demo/env.ts` 里 `MODEL` 那一行直接赋值，当前是 `opencode-go/deepseek-v4.1-flash`，**按量计费**约 $0.0002/轮），凭证放 `dev/demo/agent/auth.json`；换模型、换凭证都是改 `dev/demo/env.ts`，不走环境变量。

**模型怎么选**：研究员没说用什么模型时，默认 `(opencode-go) deepseek-v4.1-flash`（`AGENTS.md` 规则②）。想换直接改 `MODEL` 那一行。

> 「启动 subagent」是另一条规则（①）：**一律不传模型名**，用会话默认。两者别混。

- **环境跟着副本走**：`dev/demo/env.ts` 里的 `agentDir()` 相对本文件解析，所以 `demo-exp1/` 用 `demo-exp1/agent/`，不是原 demo 的。
- **真模型下不保证调工具**：提示词是自然语言（`[[tool:…]]` 那套是假 provider 的脚本约定，真模型只会当正文回你），所以「它一定调了某工具」不能当断言用。想看它实际调了什么，用 `on("tool_call")` 观测——那是一等接口。
- `dev/demo/exp-io-*.ts` 是两个已经写好的实验，示范「一个实验一个文件」的形态。
- `node dev/demo/check.ts` 是八项环境自检（真模型），怀疑环境出问题时来这里，失败输出带「三个最可能原因与怎么补」。

细节见 [`dev/demo/教学.md`](../dev/demo/教学.md) 与 [`dev/demo/agent/README.md`](../dev/demo/agent/README.md)（环境规范：每一档管什么、哪些能删）。

---

## 库不做的事

| 不做 | 为什么 |
|---|---|
| **不含策略**：没有花名册、没有委派、没有护栏、没有红线 | 库替你做决定，你就少一个旋钮。它们都在 `dev/examples/09`–`11` 里作为**使用者代码**演示 |
| **不做 pi 已经做了的事** | 加功能前先确认 SDK 没有等价物（`node_modules/@earendil-works/pi-coding-agent/docs/` 是第一手资料） |
| **不是安全边界** | pi 没有内置沙箱；`permissions.only` 是**工具集裁剪**，扩展与 `bash` 可以绕过它。本库提供的是**能力裁剪 + 审批门**，真正的隔离只能靠容器 / VM |
| **不落盘** | 会话在内存里（`SessionManager.inMemory`）。要导出走 `raw`（pi 有 `exportToJsonl` / `exportToHtml` / `getSessionStats`） |
| **不发布** | 按本地路径引用或直接读源码 |

**明确不承诺**：上下文超限、预算、长跑状态恢复这些**长跑状态层**的能力还没有；`permissions` 是唯一没有 `raw` 出口的面（pi 的白名单是私有字段，没有公开对象可指）。

---

## 开发

```bash
npm test            # 206 项断言，本机假 provider，零 API 成本 —— 改完先跑它
npm run typecheck   # tsc --noEmit
```

**测试里没有真 API**：`dev/test/helpers.ts` 起一个本机假 provider（HTTP + SSE），用一个模块级实验室把 `agentDir` 指向它，并设 `PI_OFFLINE=1`；每个测试文件是独立进程。`dev/test/helpers.ts` 提供了现成的 ground truth：`sentTools()`（模型**实际**收到的工具名）、`sentMessages()`（**实际**发出的消息条数）、`captureSystemPrompt()`（**实际**发出的 system）、`faux.calls`（假服务收到的一切）。

### 改哪儿

| 你要改的东西 | 落点 |
|---|---|
| 创建 / 生命周期 / 句柄接线 | `src/agent/create-agent.ts` |
| 面 = pi 钩子的分组封装（`on` / `onAny` / 专属槽位 / 忙判据） | `src/agent/bridge.ts` |
| 八个面各自的行为 | `src/surfaces/{io,context,tools,resources,model,observe}.ts` |
| 环境声明与唯一启动入口 | `src/agent/lab.ts` |
| 技能 / 扩展 / role 的注入与解析 | `src/agent/loader.ts` |
| 环境自检 `lab.inspectEnv` | `src/agent/env.ts` |
| 用量累计（本次 vs 全生命周期） | `src/agent/usage.ts` |
| 对外类型（无运行时逻辑） | `src/agent/types.ts` |
| 对外导出（唯一入口，不做逻辑） | `src/index.ts` |
| 设计 / 实测事实 / 用法 | `dev/docs/DESIGN.md` / `dev/docs/FACTS.md` / `dev/docs/GUIDE.md` |
| 自定义工具 | `dev/docs/TOOLS-BASICS.md`（基础）/ `dev/docs/TOOLS.md`（高级） |

相对 import **必须带 `.ts` 后缀**；只能用**可擦除**的 TS 语法（无 `enum` / `namespace` / 装饰器 / 参数属性）。

### 五条纪律

这几条是这个库可信度的来源，不是风格偏好：

1. **只做 pi 没做的事**（L1）。加功能前先确认 SDK 里没有等价物。
2. **只说实测过的。** 任何「已实现 / 已修复」都要配一个能跑出结果的检查：`npm test` 的一条断言、`dev/examples/` 某个文件的实际输出，或 `dev/demo/check.ts` 的一项。
3. **类型不重定义。** `Skill` / `ToolDefinition` / `AgentSession` / `Message` / `Usage` / `ThinkingLevel` 一律从 pi 的包 import。
4. **唯一创建入口。** 环境只能在 `createLab` 声明、agent 只能经 `lab.createAgent` 起，不加第二条造 agent 的路径。
5. **接口变了就同步三份文档**：`DESIGN.md`（接口与现状）→ `FACTS.md`（带编号的决策与理由）→ `GUIDE.md`（怎么用）。

### 不花钱验证一个能力

不确定 SDK 的某个行为时**不要猜**，写一个一次性探针 —— 探针基建在 `dev/examples/lib/`（本机假 provider + 临时 agentDir / cwd），起一个文件就能跑：

```bash
node dev/examples/03-context.ts   # 一个面一个文件，输出自带判别力
npm test                          # 全部断言，零 API 成本
```

探针跑出来的结论：被验证的**决策**写进 [`FACTS.md`](../dev/docs/FACTS.md)（带编号与出处），**用法**写进 [`GUIDE.md`](../dev/docs/GUIDE.md)。

### 提交

Conventional Commits + 中文描述：`feat:` / `fix:` / `docs:` / `chore:`。
`dev/demo/work/`、`dev/demo/agent/auth.json` 等是运行产物与凭证，已在 `.gitignore` 里。
