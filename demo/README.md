# demo —— 实验脚手架：复制它，开始你自己的实验

**这是脚手架，不是展示品。** 它短（`lab.ts` 190 行）、能跑、七个操控面各有一次真实调用；它的用法是**复制、改、跑**。

**它跑真模型**（默认 `opencode-go/space-bunny-free`，免费档）—— 每次运行都真的调一次 provider，所以需要凭证：放 `demo/agent/auth.json`（见下面的「凭证」一节）。

## 三条命令

```bash
cp -r demo demo-exp1        # 1. 复制：环境（demo/agent/）跟着一起走
# 2. 改它 —— lab.ts 七段各有一个「改这里」的锚点
node demo-exp1/lab.ts       # 3. 跑
```

只想看原版跑一次：`node demo/lab.ts`。

**环境在副本自己的 `agent/` 里。** `cp -r demo demo-exp1` 之后，`demo-exp1/lab.ts` 用的是 `demo-exp1/agent/`，不是原 demo 的 —— `demo/env.ts` 里 `agentDir()` 相对本文件解析，这就是「复制即用」的全部机关。

实跑实录（机器路径会不同，模型措辞每次也不同）。**第一段**是跑原版：

```text
$ node demo/lab.ts
[0] 环境 = D:\space\aiteam\test\demo\agent
    cwd = D:\space\aiteam\test\demo\work  model = opencode-go/space-bunny-free
[2] 起了 2 个分身：检索员(space-bunny-free)、写作员(space-bunny-free)
[4] 检索员说：**命中 1 条：** | id | 原文 | |---|---| | C3 | 工具集分两层：创建期声明有哪些，运行期按白名单决定哪些**允许被调用** | 这条正对应 `age…
    io.queue → {"queued":true}
    写作员升档：space-bunny-free/medium → space-bunny-free/high（可用档：low、medium、high、xhigh、max）
    写作员说：已写入 `D:/space/aiteam/test/demo/work/notes.md`（原文件不存在，新建）。 按 `env-style` 规范：标题用 `## `，小节末尾单…
[5] override 生效：这一轮只发最后 1 条（`slice(-1)`），而 history 照常增长 8 → 12
    entries() 可寻址条目 13 条（带 id，能拿去 replace/erase）：e27464fb(system)、f267cddd(user)、8304e7a4(assistant)…
    事件（监听自第 4 段之前就在位，所以这几轮全在）：tool_call 6 次 [检索员:tool_search, 检索员:tool_search, 写作员:read, 写作员:read, 写作员:write, 检索员:tool_search]；agent_settled 3 次

[6] 结果
    检索员：model=space-bunny-free 累计 tokens=14440 状态=idle
    写作员：model=space-bunny-free 累计 tokens=11934 状态=idle
    检索员这轮文本（RunResult.text）：**命中 1 条：** | id | 原文 | |---|---| | C3 | 工具集分两层：创建期声明有哪些，运行期按白名单决定哪些**允许被调用** | 这条正对应 `age…
    工具调用序列（on("tool_call") 收到）：检索员:tool_search → 检索员:tool_search → 写作员:read → 写作员:read → 写作员:write → 检索员:tool_search
    审批门看过的调用：拦下 0 次 [没触发] —— 模型不写危险路径时门不会响，那是正常的
    检索员可寻址条目（context.entries()）：13 条
    产物：D:\space\aiteam\test\demo\work\notes.md —— 写作员的 write 工具用了实验室的 cwd

改这里：把你的分析写在这；下一个实验：cp -r demo demo-exp1 && node demo-exp1/lab.ts
```

**第二段**是复制一份再跑 —— 只有路径不同，但那就是「复制即用」的全部证据：

```text
$ cp -r demo demo-exp1 && node demo-exp1/lab.ts
[0] 环境 = D:\space\aiteam\test\demo-exp1\agent
    cwd = D:\space\aiteam\test\demo-exp1\work  model = opencode-go/space-bunny-free
[2] 起了 2 个分身：检索员(space-bunny-free)、写作员(space-bunny-free)
...
```

（其余各段与第一段同形，只有路径里多一层 `demo-exp1`。**这一段的判别力就在路径上**：副本用的是它自己的环境。

## `lab.ts` 的七段

| 段 | 是什么 | 「改这里」改什么 |
|---|---|---|
| 0 环境 | `ensureEnv()` + `createLab({ agentDir, cwd })` | 换环境目录 / 工作目录 |
| 1 模板 | `interface Member` + 两个**普通对象**（检索员、写作员） | 加成员；改它的 `model` / `tools` / `only` |
| 2 起分身 | `lab.createAgent(spec)` ×2；写作员装一个审批门 | 起几个分身；门拦什么 |
| 3 自定义工具 | `tool_search`：在 6 条内联语料里按关键词找 | 换成你的检索 / 统计 / 评测工具 |
| 4 跑 | `io.prompt`、`io.queue`（排队投递）、换思考档、两个分身之间怎么交接 | 交办什么、怎么把上游结论喂给下游 |
| 5 观测 | `on("tool_call")` / `onAny`、`context.override`、`context.entries()` | 收什么材料 |
| 6 打印 | 结果 + 「读什么」的样板 | **把你的分析写在这** |

**七个面没有全出场**（刻意）：`interrupt` / `reset` / `compact` / `skills.add` / `extensions.add` / `onResult` 都不在 `lab.ts` 里 —— 一份实验只关心自己那几个面，这本身就是示范。

### 自己写的实验：`exp-*.ts`

`demo/exp-io-queue.ts` 与 `demo/exp-io-interrupt.ts` 是**两个已经写好的实验**，示范「复制即用」之后长什么样：每个都是独立文件，各自只验一件事（queue 忙时并进当前这轮；interrupt 真的 abort 在飞那轮且不吞排队消息）。它们跟 `lab.ts` 共用同一个环境，但**互不干扰** —— 这就是「一个实验一个文件」的形态。

## 环境：`demo/agent/` 就是 `agentDir`

环境不是脚本里的字符串，是**仓库里这个看得见的目录**：技能（`skills/env-style/SKILL.md`）与扩展（`extensions/env-tools.ts`）是仓库里的真文件，走 pi 的**自动发现**（放着就生效，不用写进 `createLab` 的 spec）。改环境 = 改文件；review 环境 = 看 diff。

- **每一档管什么、哪些能删、为什么不放 `SYSTEM.md`** → [`demo/agent/README.md`](agent/README.md)
- 改了环境不生效：删**可再生的产物**再跑 —— `rm -rf demo/work`。`demo/agent/auth.json` 是你的凭证，**不要删**。

`demo/work/` 是 `cwd`：agent 在哪干活、产物落哪（上面那次的 `notes.md` 就是写作员的 `write` 工具用它落的）。`demo/work/*` 不进 git。

> 里面出现 `skills/demo-check-skill/` 时别困惑：那是 `node demo/check.ts` 第 8 项自己写的（它要真加一个技能来验 skills 面），不是你的东西。

## 凭证（跑 demo 必须有）

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `AITEAM_DEMO_MODEL` | 用哪个模型 | `opencode-go/space-bunny-free`（免费档） |
| `AITEAM_DEMO_AUTH` | 用哪份凭证（会被**复制**进 `demo/agent/auth.json`，原件只读） | `demo/agent/auth.json` |

```bash
node demo/lab.ts                                     # 默认：space-bunny-free
AITEAM_DEMO_MODEL=opencode-go/别的模型 node demo/lab.ts
AITEAM_DEMO_AUTH=/path/to/auth.json node demo/lab.ts # 换一份凭证
```

**demo 用它自己的 key**（`demo/agent/auth.json`，gitignored），**全程不读也不写宿主 `~/.pi/agent`**。没有凭证时**明确报错**（不静默），文案里给出出路：写进 `demo/agent/auth.json` / `AITEAM_DEMO_AUTH=` / **别指向宿主**。

> ⚠️ 「别指向宿主」是血教训：pi 的 auth 存储是**读-改-写整个 `auth.json`**（`auth-storage.js` 的 `withLock` 把 `fn(current)` 出的完整 `next` 整文件写回）。实测把 agentDir 指到宿主目录跑一次，宿主从 `{opencode-go, openrouter, opencode}` 被重写成只剩 `{opencode-go}` —— **另外两个 provider 的凭证被抹掉**。
> 所以真模式用 `demo/agent/auth.json`（demo 自己的账号），宿主目录**一个字节都不碰**。

### 真模型下，哪些东西和「脚本化模型」不一样

这个 demo 以前跑本机假 provider（**按提示词里的 `[[tool:…]]` 指令回话**）。切成真模型之后，四件事必须知道：

1. **提示词是自然语言**：`[[tool:tool_search]]` 那种脚本标记真模型只会当正文回你一句「我没执行它」。所以要什么就直接说（「请用 tool_search 搜『白名单』」）。
2. **它不保证调工具**：模型可以只用文字回答。所以「它一定调了某工具」不能当断言用 —— `lab.ts` 第 5 段的事件收集记的是**观测到的事实**（`tool_call N 次 [序列]`），不是期望。
3. **每次输出都不同**：措辞、调几次工具、分几节，都会变。上面那份实录只是**一次**运行；`tokens=`、工具次数、`history=` 这些数字每次都不一样。
4. **`demo/check.ts` 可能偶发单项失败**：它的判据是硬的（工具**执行体**的计数器、真跑一遍读写），但“模型会配合”这件事本身不可保证 —— 实测第 6 项首次跑就红过一次、重跑就绿。**它的 hints 里写着这条**；要完全确定、随时可重跑的东西，用 `npm test` 与 `examples/12-team.ts`（走本机假 provider）。

> 想要「零成本、结果完全确定、不需要 key」的对照物：`examples/01`–`12`（走本机假 provider），以及 `npm test`（144 项，同样零 API 成本）。

## 完整案例在别处

| 想看什么 | 去哪 |
|---|---|
| **七面全出场**的完整案例（786 行、自证表、每一处设计决策旁边一行「要检验这条，改成 X 再跑」） | [`examples/12-team.ts`](../examples/12-team.ts)（走本机假 provider，零成本） |
| 环境自检八项（真调用、失败三段式） | `node demo/check.ts` |
| 一面一事的 11 个最小示例 | [`examples/`](../examples/)（从 `01-first-agent.ts` 起） |

**为什么它们不在 `demo/` 里**：脚手架要**短**（给人改），案例要**全**（给人读），两者服务不同的人。所以 `lab.ts` 是起点、`12-team.ts` 是案例、`check.ts` 是排查工具，各就各位。

`demo/check.ts` 八项一览（判据都在脚本自己的 hints 里）：

| 项 | 检查什么 |
|---|---|
| 1 | Node 版本与原生执行 `.ts` |
| 2 | `@earendil-works/pi-coding-agent` 可解析且版本恰好是 **0.99.1** |
| 3 | `agentDir` 可写、模型可读（真写一个文件再读回来） |
| 4 | 用实验室起 agent（`lab.createAgent`） |
| 5 | 一轮 `io.prompt` 拿到非空文本 |
| 6 | **一个工具真被模型调用**（判据是工具**执行体**里的闭包计数器；提示词让它「在 demo_probe 与 demo_probe_b 里任选一个调」—— 二选一，它没有「不调」这个选项） |
| 7 | **环境隔离：只认自己的技能与插件**（看得到自己的那份，且读不到宿主 `~/.pi/agent` 的任何一份） |
| 8 | 七个面各自至少一次读写 |

第 7 项判的是 `lab.inspectEnv()` 的**加载结果**（技能与扩展的路径），它**不建 agent**（`demo/check.ts` 里自己写着这句话）；某个 agent 运行时看不看得见那些工具是**另一件事**，那件由 `permissions.only` 决定 —— 实测对照表见 [`demo/agent/README.md`](agent/README.md) 的 R41 段。

## 目录

| 路径 | 是什么 | 进 git |
|---|---|---|
| `demo/lab.ts` | **实验起点**：环境声明 + 模板 + 七个面的用法，一份实验一个文件 | 进 |
| `demo/exp-io-queue.ts` · `demo/exp-io-interrupt.ts` | **两个写好的实验**：各自只验一件事，示范「一个实验一个文件」 | 进 |
| `demo/agent/` | **环境（= agentDir）**：技能与扩展是仓库里的真文件，规范见里面的 `README.md` | 技能/扩展/README 进；动态文件不进 |
| `demo/env.ts` | 环境在哪（幂等）：解析 `agentDir` / `cwd`、把凭证就位 | 进 |
| `demo/check.ts` | 环境自检（八项）：怀疑环境出问题时来这里 | 进 |
| `demo/work/` | `cwd` 与产物落点（上面那次的 `notes.md`） | 不进（`.gitignore`） |
| `demo/agent/auth.json` · `models-store.json` · `settings.json` | 凭证 · pi 的两份缓存 | 不进 |
