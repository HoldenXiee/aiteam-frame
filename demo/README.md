# demo —— 实验脚手架：复制它，开始你自己的实验

**这是脚手架，不是展示品。** 它短（`lab.ts` 161 行）、能跑、七个操控面各有一次真实调用；它的用法是**复制、改、跑**。

## 三条命令

```bash
cp -r demo demo-exp1        # 1. 复制：环境（demo/agent/）跟着一起走
# 2. 改它 —— lab.ts 七段各有一个「改这里」的锚点
node demo-exp1/lab.ts       # 3. 跑
```

只想看原版跑一次：`node demo/lab.ts`（离线、零成本、不需要 key）。

**环境在副本自己的 `agent/` 里。** `cp -r demo demo-exp1` 之后，`demo-exp1/lab.ts` 用的是 `demo-exp1/agent/`，不是原 demo 的 —— `demo/env.ts` 里 `agentDir()` 相对本文件解析，这就是「复制即用」的全部机关。

实跑实录（机器路径会不同）。**第一段**是跑原版：

```text
$ node demo/lab.ts
[0] 环境 = D:\space\aiteam\test\demo\agent
    cwd = D:\space\aiteam\test\demo\work  provider = 假（离线、零成本）
[2] 起了 2 个分身：检索员(echo)、写作员(echo)
[4] 检索员说：echo:C3: 工具集分两层：创建期声明有哪些，运行期按白名单决定哪些**允许被调用**
    io.queue → {"queued":true}
    写作员升档：echo → echo-alt（检索员仍是 echo）
    [门] 拦下 bash：{"block":true,"reason":"写作员不许清空东西；要清空请改设计者代码，不要在会话里试"}
    被拦后模型读到的是：echo:写作员不许清空东西；要清空请改设计者代码，不要在会话里试
[5] override 期间模型只收到最后 1 条，而 history 照常增长 8 → 12
    entries() 可寻址条目 13 条（带 id，能拿去 replace/erase）：158bc51d(system)、d6dc9128(user)、8922c40f(assistant)…
    事件：tool_call 2 次 [检索员:tool_search, 写作员:write]；agent_settled 1 次

[6] 结果
    检索员：model=echo 累计 tokens=108 状态=idle
    写作员：model=echo-alt 累计 tokens=72 状态=idle
    检索员这轮文本（RunResult.text）：echo:C3: 工具集分两层：创建期声明有哪些，运行期按白名单决定哪些**允许被调用**
    工具调用序列（on("tool_call") 收到）：检索员:tool_search → 写作员:write
    检索员 agent_settled 次数（onAny 收到）：1
    审批门拦下 1 次 [bash]（gate 的 {block:true, reason} 见上面第 4 段）
    检索员可寻址条目（context.entries()）：13 条
    产物：D:\space\aiteam\test\demo\work\notes.md —— 写作员的 write 工具用了实验室的 cwd

改这里：把你的分析写在这；下一个实验：cp -r demo demo-exp1 && node demo-exp1/lab.ts
```

**第二段**是复制一份再跑 —— 只有路径不同，但那就是「复制即用」的全部证据：

```text
$ cp -r demo demo-exp1 && node demo-exp1/lab.ts
[0] 环境 = D:\space\aiteam\test\demo-exp1\agent
    cwd = D:\space\aiteam\test\demo-exp1\work  provider = 假（离线、零成本）
[2] 起了 2 个分身：检索员(echo)、写作员(echo)
[4] 检索员说：echo:C3: 工具集分两层：创建期声明有哪些，运行期按白名单决定哪些**允许被调用**
    io.queue → {"queued":true}
    写作员升档：echo → echo-alt（检索员仍是 echo）
    [门] 拦下 bash：{"block":true,"reason":"写作员不许清空东西；要清空请改设计者代码，不要在会话里试"}
    被拦后模型读到的是：echo:写作员不许清空东西；要清空请改设计者代码，不要在会话里试
[5] override 期间模型只收到最后 1 条，而 history 照常增长 8 → 12
    entries() 可寻址条目 13 条（带 id，能拿去 replace/erase）：395dd335(system)、e797437b(user)、e5213931(assistant)…
    事件：tool_call 2 次 [检索员:tool_search, 写作员:write]；agent_settled 1 次

[6] 结果
    检索员：model=echo 累计 tokens=108 状态=idle
    写作员：model=echo-alt 累计 tokens=72 状态=idle
    检索员这轮文本（RunResult.text）：echo:C3: 工具集分两层：创建期声明有哪些，运行期按白名单决定哪些**允许被调用**
    工具调用序列（on("tool_call") 收到）：检索员:tool_search → 写作员:write
    检索员 agent_settled 次数（onAny 收到）：1
    审批门拦下 1 次 [bash]（gate 的 {block:true, reason} 见上面第 4 段）
    检索员可寻址条目（context.entries()）：13 条
    产物：D:\space\aiteam\test\demo-exp1\work\notes.md —— 写作员的 write 工具用了实验室的 cwd

改这里：把你的分析写在这；下一个实验：cp -r demo demo-exp1 && node demo-exp1/lab.ts
```

## `lab.ts` 的七段

| 段 | 是什么 | 「改这里」改什么 |
|---|---|---|
| 0 环境 | `ensureEnv()` + `createLab({ agentDir, cwd })` | 换环境目录 / 工作目录 / 联网开关 |
| 1 模板 | `interface Member` + 两个**普通对象**（检索员、写作员） | 加成员；改它的 `model` / `tools` / `only` |
| 2 起分身 | `lab.createAgent(spec)` ×2；写作员装一个审批门 | 起几个分身；门拦什么 |
| 3 自定义工具 | `tool_search`：在 6 条内联语料里按关键词找 | 换成你的检索 / 统计 / 评测工具 |
| 4 跑 | `io.prompt`、`io.queue`（排队投递）、升档、被门拦的那一轮 | 交办什么 |
| 5 观测 | `on("tool_call")` / `onAny`、`context.override`、`context.entries()` | 收什么材料 |
| 6 打印 | 结果 + 「读什么」的样板 | **把你的分析写在这** |

**七个面没有全出场**（刻意）：`interrupt` / `reset` / `compact` / `skills.add` / `extensions.add` / `onResult` 都不在 `lab.ts` 里 —— 一份实验只关心自己那几个面，这本身就是示范。

## 环境：`demo/agent/` 就是 `agentDir`

环境不是脚本里的字符串，是**仓库里这个看得见的目录**：技能（`skills/env-style/SKILL.md`）与扩展（`extensions/env-tools.ts`）是仓库里的真文件，走 pi 的**自动发现**（放着就生效，不用写进 `createLab` 的 spec）。改环境 = 改文件；review 环境 = 看 diff。

- **每一档管什么、哪些能删、为什么不放 `SYSTEM.md`、两种模式共用一个目录的代价** → [`demo/agent/README.md`](agent/README.md)
- 改了环境不生效：删**可再生的产物**再跑 —— `rm -rf demo/agent/models.json demo/work`。`demo/agent/auth.json` 是你的凭证，**不要删**。

`demo/work/` 是 `cwd`：agent 在哪干活、产物落哪（上面那次的 `notes.md` 就是写作员的 `write` 工具用它落的）。`demo/work/*` 不进 git。

## 换成真模型（可选；默认本机假 provider）

```bash
AITEAM_DEMO_REAL=1 node demo/lab.ts      # 脚手架走真模型
AITEAM_DEMO_REAL=1 node demo/check.ts    # 环境自检走真模型
```

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `AITEAM_DEMO_REAL=1` | 切到真模型（**demo 自己的**凭证） | 关（本机假 provider） |
| `AITEAM_DEMO_MODEL` | 真模型用哪个 | `opencode-go/space-bunny-free`（免费档） |
| `AITEAM_DEMO_AUTH` | 真模式用哪份凭证（会被**复制**进 `demo/agent/auth.json`，原件只读） | `demo/agent/auth.json` |

**demo 用它自己的 key**（`demo/agent/auth.json`，gitignored），**全程不读也不写宿主 `~/.pi/agent`**。两处都没有凭证时**明确报错**（不静默），文案里给出出路：写进 `demo/agent/auth.json` / `AITEAM_DEMO_AUTH=` / 干脆跑离线 / **别指向宿主**。

> ⚠️ 这一条反着改过两次，每次都是真事故：
> 1. 最初真模式直接指宿主目录（理由「不复制密钥」）⇒ **pi 的 auth 存储是读-改-写整个 `auth.json`**
>    （`auth-storage.js` 的 `withLock` 把 `fn(current)` 出的完整 `next` 整文件写回）。实测跑一次，宿主从
>    `{opencode-go, openrouter, opencode}` 被重写成只剩 `{opencode-go}`——**另外两个 provider 的凭证被抹掉**。
> 2. 改成「复制宿主凭证」⇒ 不再破坏宿主，但仍不符合 demo 的定位：跑 demo 会烧**你自己的**额度、用**你本机 pi 的账号**。
>
> 现在：真模式用 `demo/agent/auth.json`（demo 自己的免费账号），宿主目录**一个字节都不碰**。

## 完整案例在别处

| 想看什么 | 去哪 |
|---|---|
| **七面全出场**的完整案例（786 行、自证表、每一处设计决策旁边一行「要检验这条，改成 X 再跑」） | [`examples/12-team.ts`](../examples/12-team.ts) |
| 环境自检八项（真调用、失败三段式、不需要 key） | `node demo/check.ts` |
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
| 6 | **一个工具真被模型调用**（执行体里的闭包计数器，不是 `tools.list()` 里有它） |
| 7 | **环境隔离：只认自己的技能与插件**（看得到自己的那份，且读不到宿主 `~/.pi/agent` 的任何一份） |
| 8 | 七个面各自至少一次读写 |

第 7 项的判据与本环境里那份扩展注册的工具能不能被某个 agent 看见（`permissions.only` 决定）—— 实测对照表见 [`demo/agent/README.md`](agent/README.md) 的 R41 段。

## 目录

| 路径 | 是什么 | 进 git |
|---|---|---|
| `demo/lab.ts` | **实验起点**：环境声明 + 模板 + 七个面的用法，一份实验一个文件 | 进 |
| `demo/agent/` | **环境（= agentDir）**：技能与扩展是仓库里的真文件，规范见里面的 `README.md` | 技能/扩展/README 进；动态文件不进 |
| `demo/env.ts` | 环境在哪（幂等）：起假 provider 并写 `models.json`，或把凭证放进 `demo/agent/auth.json` | 进 |
| `demo/check.ts` | 环境自检（八项）：怀疑环境出问题时来这里 | 进 |
| `demo/work/` | `cwd` 与产物落点（上面那次的 `notes.md`） | 不进（`.gitignore`） |
| `demo/agent/auth.json` · `models.json` · `models-store.json` · `settings.json` | 凭证 · 假 provider 地址（端口随机 ⇒ 只能是生成物）· pi 的两份缓存 | 不进 |
| `demo/run/` | **遗留**：v2 早先的运行产物目录，不再写入（旧 checkout 的残留仍被 `.gitignore` 与 `tsconfig.json` 忽略） | 不进 |
