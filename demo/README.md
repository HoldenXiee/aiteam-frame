# demo —— 安装自检

给**没装过 pi、但想研究 agent 课题的人**：先跑这条命令。退出码 0 + 八项全「通过」= 这台机器可以开始研究了。

```bash
node demo/check.ts
```

要求：Node **v22.18+**（或 v23.6+）—— 足够新的 Node 才能免开关直接跑 `.ts`。
不需要 API key，demo 自带本机假 provider（`examples/lib/faux-server.ts`），全程离线、零成本。

## 预期输出（真实跑出来的）

```text
$ PI_OFFLINE=1 node demo/check.ts
[1/7] Node 与原生 .ts               … 通过（v24.18.0）
        node=D:\Develop\nodejs\node.exe
[2/7] pi-coding-agent 可解析        … 通过（0.99.1）
        入口=D:\space\aiteam\test\node_modules\@earendil-works\pi-coding-agent\dist\index.js
[3/7] agentDir 可写、模型可读       … 通过（agentDir 可写；读到 2 个模型）
        D:\space\aiteam\test\demo\env\agent\models.json → faux: echo、echo-alt（离线，modelNetwork:false）
[4/7] createAgent 能起 agent        … 通过（id=demo-check，model=echo/off）
        agentDir=D:\space\aiteam\test\demo\env\agent
        cwd=D:\space\aiteam\test\demo\work
        假 provider=http://127.0.0.1:30096/v1
[5/7] 一轮 io.prompt 拿到非空文本   … 通过（拿到 18 字符）
        模型说：echo:自检第 5 项：请回一句话
[6/7] 工具真被模型执行              … 通过（demo_probe 的执行体真跑了 1 次）
        模型这一轮回读：echo:probe 收到：自检工具链
        对照（不判别）：pi 注册表里有它的定义 = 有
[7/7] 七面各至少一次读写            … 通过（7 个面各至少一次读写）
        io（读 pending=0 / isRunning=false；写 queue + waitIdle）
        context（读 history=8、autoCompact=false；写 autoCompact + override 并清除；compact：会话太小、无需压缩（Nothing to compact (session too small)）—— 正常路径）
        tools（读 list=0 个；写 add=demo_probe_extra → 1 个）
        model（读 current=echo/off、thinking、available=2 个；写 set=echo-alt + setThinking=high，再还原为 echo/off）
        extensions（读 list=1 个 + errors=0；写 add → 2 个）
        skills（读 list=0 个；写 add=demo-check-skill（真 SKILL.md）→ 1 个）
        permissions（写 gate 且真被调用 1 次；only 后活跃集只剩它，deny/allow 用 tools.list() 读回）

八项全通过 —— 本机可以开始研究 agent 课题了。
下一步：node examples/01-first-agent.ts（最小演示）；失败时怎么读输出见 demo/README.md。
```

端口、路径、`history=8`、字符数、`node=` 与 `入口=` 这些每次跑都会略不同，其余一致。
`PI_OFFLINE=1` 可以加也可以不加：demo 自己就管离线（见 `demo/env.ts` 的注释）。

## 每项在检查什么

| 项 | 检查什么 | 判据（怎么算通过） |
|---|---|---|
| 1 | Node 版本与原生执行 `.ts` | 版本 ≥ v22.18 / v23.6；这个文件本身能被 `node` 跑起来就是证据 |
| 2 | `@earendil-works/pi-coding-agent` 可解析且版本匹配 | 解析到它的 `package.json`，版本恰好是 **0.99.1**（本仓库钉的） |
| 3 | `agentDir` 可写、模型可读 | 真写一个文件再读回来；再用库自己的 `inspectEnv` 读到 `faux/echo` |
| 4 | `createAgent` 能起 agent | 拿到 `agent.id`、`model.current`，没抛错 |
| 5 | 一轮 `io.prompt` 拿到非空文本 | `RunResult.text` 非空且 `result.error` 为空 |
| 6 | **一个工具真被模型调用** | 工具**执行体**里的闭包计数器 +1（`tools.list()` 里有它**不**算数：那只说明声明在） |
| 7 | 七个面各自至少一次读写 | 每个面都真的调用过：io `queue`/`waitIdle`、context `history`/`autoCompact`/`override`/`compact`、tools `list`/`add`、model `set`/`setThinking`、extensions `list`/`errors`/`add`、skills `list`/`add`、permissions `gate`/`only`/`deny`/`allow`，能读回状态的都读回校验 |

### 环境自动发现的技能与插件：不只是「能看见」，还要「真被用上」

`demo/env.ts` 会往自己的 agentDir 里 seed 一份技能（`env-style`）与一份扩展（`env-tools.ts`，
注册 `env_checklist` 工具），两者都**不在 spec 里** —— 走的是「环境自动发现」这条路。
`agent-team.ts` 里它们被**真的用上**：

| 资源 | 怎么被用上 | 判据 |
|---|---|---|
| 技能 `env-style` | `role` 里要求按它写（每节末尾一行「依据：」） | 报告小节里出现那行 |
| 扩展工具 `env_checklist` | 让一个**干净的**探针 agent 调它 | 返回值里含「由环境扩展」那句 |

**一个真实取舍**（demo 专门演示）：环境自动发现的扩展所注册的工具，**只在没写 `permissions.only` 时可见** ——
白名单不该被环境里碰巧存在的扩展悄悄撑开（R41）。写作员是 demo 里唯一没写 `only` 的 agent。

**真模型 vs 假 provider 的差异**（实测，不是猜测）：
- 假 provider 照提示词里的脚本必调工具；真模型有自己的取舍，可能直接回文字、不调工具。
- 所以那个工具调用用一个**新建的**探针 agent，而不是复用写作员 —— 实测：写作员上下文里堆了十几轮
  「不许动黑板」的对话之后，面对新指令会**延续原有行为模式**，回空文本、连工具调用都不产生
  （`text=""`、`error=undefined`、消息里只有 user+assistant 各一条）。换干净上下文就正常。
- 同理 `draft_section` / `cite_check` 在真模型下可能不被调用 —— demo 会**如实打印**「模型没调用」
  并区分它与「扩展没生效」（后者要看 `extensions.errors()`），不静默也不误诊。

### 第 7 项为什么单列：隔离要「两边都成立」才叫隔离

`agentDir` 只要没被填过东西，`skills.list()` / `extensions.list()` 返回空**说明不了任何事**——
空可能是因为隔离做对了，也可能是因为这条发现路径压根没被走到。
所以 demo 往自己的 agentDir 里 seed 了一份技能（`demo-skill`）和一份扩展（`demo-ext.ts`），判据变成：

1. **看得到自己的** ⇒ 自动发现这条路是通的；
2. **看不到宿主 `~/.pi/agent` 里的任何一份** ⇒ 隔离真的生效。

> 这一条最初写成「与 `env.agentDir` 比对」，被 mutation 打回来了：
> 如果 agentDir **就是**宿主目录（= 用了电脑的设置），那宿主的一切都算「自己的」，这一项会**通过**。
> 改成「与**宿主目录**比对」，并加一条硬断言「agentDir 不许落在宿主目录里」。

**这一项不跑模型**，纯粹查环境里有什么——便宜、确定、不需要 provider。

## 失败了怎么办

失败时输出是固定三段式 —— **不许只说「失败」**（下面是第 5 项失败时的真实形状，栈略）：

```text
[5/7] 一轮 io.prompt 拿到非空文本   … 失败
    原始错误：RunResult.text 是空的：""                                ← 原始错误（含栈，便于贴给维护者）
      at Object.run (file:///.../demo/check.ts:202:25)
      ...
    最可能的三个原因与怎么补：                     ← 三个原因，每条都带动作
      1. 假 provider 没起来或端口被占 ⇒ 重跑一次；连续失败就查本机回环 …
      2. 这一轮模型侧报错了（`result.error` 里就是原始错误）⇒ 按 error 文本查 …
      3. pi 版本变了、SSE 解析不兼容 ⇒ 装回 0.99.1（见第 2 项）
```

读法：看 `[i/7]` 是哪一项 → 看原始错误 → 按三个原因里最像的那条动手。
退出码是 **1**；全通过才是 **0**（适合写进 CI / 脚本）。
失败信息走 **stderr**、通过信息走 stdout —— 脚本里用 `2>&1` 一起抓，或只把 stderr 当告警。

最常见的两类失败：

- **第 1、2 项**：环境问题。跑 `node --version` 与 `npm ls @earendil-works/pi-coding-agent`；依赖没装就在仓库根目录 `npm install`。
- **第 3 项之后**：环境产物被改坏。`demo/env/agent/` 与 `demo/work/` 都是**可再生的产物**：
  `rm -rf demo/env/agent demo/work`（Windows 用资源管理器删掉）再重跑，`ensureEnv()` 会重建。

## 跑 agent-team 这个例子：多 agent 分工协作写一份报告

自检通过之后，下一个要跑的是这个 —— 它把七个操控面串成一件真事：两个检索分身查语料、把采信的记进黑板，
一个写作分身读完黑板、拟定大纲、被审批门拦下一次「清空黑板」，最后报告由脚本的代码从黑板 + 语料拼出。

```bash
PI_OFFLINE=1 node demo/agent-team.ts
```

退出码 **0**。跑完会打印七面各自被调用了几次，并**断言每一项 ≥ 1**（哪个面没出场就退出码 1，报「那是设计缺陷，修设计，不要删断言」）。

## agent-team 的预期输出（真实跑出来的）

```text
$ PI_OFFLINE=1 node demo/agent-team.ts
[1] 环境（demo 自己的 agentDir / cwd，离线假 provider）
    agentDir = D:\space\aiteam\test\demo\env\agent
    cwd      = D:\space\aiteam\test\demo\work
    语料     = 6 条（C1、C2、C3、C4、C5、C6）
[2] 成员与分身：检索员 ×2 + 写作员 ×1 = 3 个分身 —— 起几个是使用者代码的决定
    检索员-1  model=echo  技能=[research-style]  检索线=「上下文 白名单」/ 标签 tools
    检索员-2  model=echo  技能=[research-style]  检索线=「审批门 分工 分身 装载」/ 标签 装载
    写作员  model=echo  技能=[writing-style]  extensions=1  工具白名单=[read_blackboard、draft_section、clear_blackboard]
[3] 检索阶段：每个检索分身各查一轮，采信记进黑板
    [检索员-1] 第一问命中：C1、C2
    [检索员-1] tools 面：运行期 add(search_by_tag) → 模型现在看得到 [note、search、search_by_tag]
    [检索员-1] 采信：C1、C2
    [检索员-2] 第一问命中：C2、C3、C4、C5、C6
    [检索员-2] 采信：C3、C4、C5、C6
    context 钩子实测（pi 交给 override 的条数 → 它返回、真发出去的条数）：
      检索员-1  1 → 1
      检索员-1  3 → 3
      检索员-1  5 → 1  ← 裁掉了
      检索员-1  8 → 4  ← 裁掉了
      检索员-2  1 → 1
      检索员-2  3 → 3
      检索员-2  5 → 1  ← 裁掉了
      检索员-2  7 → 3  ← 裁掉了
[4] 写作阶段：便宜的检索 → 强的写作
    model 面：echo/off → echo-alt/high
    extensions 面：运行期 add(引用检查) → 1 → 2 个（errors=0）
    大纲：一、上下文预算：裁的是这一轮，不是历史 ｜ 二、工具集与审批门：先裁能力，再拦动作 ｜ 三、分工与装载：便宜的检索、强的写作
    cite_check（运行期扩展注册的工具真跑了）：echo:引用检查：3 条 不在语料里：C9
    审批门：看过 6 次调用，拦下 1 次
    被拦后模型读到的是：echo:写作员不许做这类会抹掉别人成果的操作；要清空黑板请改设计者代码，不要在会话里试
[5] 汇总：报告由代码拼（黑板 + 语料），写到 demo/work/report.md
    D:\space\aiteam\test\demo\work\report.md：91 行；采信语料 6 条；黑板流水 16 条
[6] 自证：七个面各自被调用了几次（数据来自计数代理，不是手写的数字）
    io            9  █████████
    context       2  ██
    tools         1  █
    permissions   1  █
    extensions    1  █
    skills        2  ██
    model         2  ██
    七面全部 ≥ 1 ✓

全部跑通 —— 报告在 demo/work/report.md。改一处设计决策、再跑一次，就能检验那条假设。
```

机器路径会不同，其余一致（本机连跑两次的 `report.md` md5 相同，产物可复现）。

**产物在 `demo/work/`**（gitignored，可随时删掉重跑）：

| 文件 | 是什么 |
|---|---|
| `demo/work/report.md` | 报告本体：由 `demo/agent-team.ts` 的 `writeReport()` 从黑板 + 语料拼出 |
| `demo/work/blackboard.jsonl` | 黑板：这次协作的每一笔（检索 / 采信 / 读板 / 起草 / 门 / 引用检查） |
| `demo/work/skills/{research-style,writing-style}/SKILL.md` | 两个角色各自的技能（脚本自己写的，真实存在的 SKILL.md） |

两件必须先知道的事：

1. **报告里的每一句话都是代码拼的，不是「模型」写的。** 假 provider 只会回 `echo:<原文截断>`，所以
   `agent-team.ts` 里那些 `[[tool:…]]` / `[[call:…]]` 是**给假 provider 的脚本指令**（约定见
   `examples/lib/faux-server.ts` 顶部），「模型」负责的是调用顺序与取舍（查什么、采信哪几条、分几节），
   报告正文由代码按 id 从语料取值。要让它真的写字：`AITEAM_DEMO_REAL=1` + 把 `writeReport()` 里「按 id 取语料正文」
   换成「取模型写的段落」（见下面「换成真模型」一节与 `agent-team.ts` 头部的改法）。
2. **它是一个可改造的起点，不是推荐架构。** 「几个 agent、怎么分工、要不要护栏、审批门拦什么」
   全是使用者代码，每一处设计决策旁边都有一行「要检验这条，改成 X 再跑」——具体到能照着改、改完重跑就能看结果。
   例：把 `RESEARCH_LINES` 减到 1 条、把审批门的判据改成只拦 `rm_`、把写作员的 `permissions.only` 删掉。

## 目录说明

| 路径 | 是什么 | 进 git 吗 |
|---|---|---|
| `demo/env.ts` | 幂等自建环境：写 `models.json`、起本机假 provider | 进 |
| `demo/check.ts` | 这个自检 | 进 |
| `demo/agent-team.ts` | 完整例子：多 agent 协作写报告（七面全出场 + 自证表） | 进 |
| `demo/env/auth.json` | **配置源**：demo 自己的凭证（与宿主无关）。没有它 `AITEAM_DEMO_REAL=1` 会明确报错 | 不进（`.gitignore`） |
| `demo/env/models-store.json` | **配置源**：模型目录缓存（可选） | 不进（`.gitignore`） |
| `demo/run/faux/` | **产物**：假模式的 agentDir（`models.json` + 自己 seed 的 `skills/`、`extensions/`） | 不进（`.gitignore`） |
| `demo/run/real/` | **产物**：真模式的 agentDir（凭证**副本**，pi 会对它读改写，所以不能是原件） | 不进（`.gitignore`） |

**配置源与产物分两层**：`demo/env/` 放你给的（不常变，脚本只读），`demo/run/` 是脚本生成的（**整个可以随时删**）。
必须分，是因为 pi 会在任何 agentDir 里自己造 `auth.json` / `models-store.json`——放同一层时，空壳产物会和你的配置源混在一起，分不清哪个能删。
| `demo/work/` | agent 的工作目录与产物落点：`report.md` / `blackboard.jsonl` / `skills/` | 不进（`.gitignore`） |

`demo/env/` 下还有两份 v1 遗留文件（`auth.json` 含**真实 API 密钥**、`models-store.json` 是旧结构缓存）。
demo **不读**它们（自检用的 `agentDir` 是子目录 `demo/env/agent/`），它们也只是被 gitignore 排除，不会进仓库。
要清理请自行删除，别把它们的内容贴进任何地方。

## 换成真模型（一个环境变量）

**两种模式跑的是同一份 demo、同一套流程**，差别只在 provider：

```bash
AITEAM_DEMO_REAL=1 node demo/check.ts        # 安装自检走真模型
AITEAM_DEMO_REAL=1 node demo/agent-team.ts   # 完整例子走真模型
```

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `AITEAM_DEMO_REAL=1` | 切到真模型（宿主 `~/.pi/agent` 的凭证） | 关（用本机假 provider） |
| `AITEAM_DEMO_MODEL` | 真模型用哪个 | `opencode-go/space-bunny-free`（免费档） |
| `AITEAM_DEMO_AUTH` | 真模式用哪份凭证 | `demo/env/auth.json`（demo 自己的，gitignored） |

**demo 用它自己的 key**（`demo/env/auth.json`，gitignored），**全程不读也不写宿主 `~/.pi/agent`**。

> ⚠️ 这一条反着改过两次，每次都是真事故：
> 1. 最初真模式直接指宿主目录（理由「不复制密钥」）⇒ **pi 的 auth 存储是读-改-写整个 `auth.json`**
>    （`auth-storage.js` 的 `withLock` 会把 `fn(current)` 出的完整 `next` 整文件写回，
>    且 `ensureFileExists()` 在每次 withLock 里都先建文件）。实测跑一次，宿主从
>    `{opencode-go, openrouter, opencode}` 被重写成只剩 `{opencode-go}`——**另外两个 provider 的凭证被抹掉**。
> 2. 改成「复制宿主凭证」⇒ 不再破坏宿主了，但仍**不符合 demo 的定位**：
>    跑 demo 会烧**你自己的**额度、用**你本机 pi 的账号**，与 demo 要演示的东西无关。
>
> 现在：真模式用 `demo/env/auth.json`（demo 自己的免费账号），宿主目录**一个字节都不碰**。
> 想换成自己的 key：写进 `demo/env/auth.json`，或 `AITEAM_DEMO_AUTH=/path/to/auth.json`。
> **别指向宿主**——见上面第 1 条。

### 提示词的两套说法

假 provider **只会照脚本回话**，所以要靠 `[[tool:…]]` / `[[call:…]]` 指令告诉它调哪个工具；真模型得说人话。
这个分叉点在 `demo/agent-team.ts` 的 `ask(fauxText, realText)` 一处收口——**流程（谁先跑、哪一步升档、门拦什么）两边完全一样**，
所以「换真模型」检验的是**模型**，不是被改写的流程。

### ⚠️ 真模型下两处实测差异（不是 bug，是真发现）

**1. 审批门可能一次都没机会拦。** 真模型读了 `role` 里的边界（「不动黑板」），**自己在会话里就拒绝了**，
压根没调 `clear_blackboard`——于是「拦下 0 次」不是门坏了，而是**护栏顺序**这件事变得可观察了：

- `role` 里的边界是**软约束**（靠模型配合）；
- `permissions.gate` 是**硬约束**（靠代码，模型不配合也拦得住）。

想看到门真的拦下：把 `role` 里的「不动黑板」删掉再跑。`agent-team.ts` 在真模式遇到「拦下 0 次」时会打印这条提示。

**2. 模型可能自行增删小节。** 你要求三节，它可能给你五节——真模型比假 provider 灵活。
`draft_section` 是**留痕**，所以提示词在真模式下说死「每一节都要调一次工具」（否则它直接在回复里写，黑板没留痕、大纲一行是空的——实测踩到过）。

### 报告正文由谁来写

假 provider 不会写字，所以 `writeReport()` 是**按 id 从语料取值**拼出报告正文的。
真模型会写字，但 `writeReport()` 仍走同一条路（保证两种模式产物可比）——想让它用模型写的段落，
改 `writeReport()` 里那一段（该文件头部写了改法）。

各面怎么用见 `examples/`（`01-first-agent.ts` 起，每个文件演示一件事）。
