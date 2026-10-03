# demo —— 安装自检

给**没装过 pi、但想研究 agent 课题的人**：先跑这条命令。退出码 0 + 七项全「通过」= 这台机器可以开始研究了。

```bash
node demo/check.ts
```

要求：Node **v22.18+**（或 v23.6+）—— 足够新的 Node 才能免开关直接跑 `.ts`。
不需要 API key，demo 自带本机假 provider（`examples/lib/faux-server.ts`），全程离线、零成本。

## 预期输出（真实跑出来的）

```text
$ PI_OFFLINE=1 node demo/check.ts
[1/7] Node 与原生 .ts               … 通过（v24.18.0）
[2/7] pi-coding-agent 可解析        … 通过（0.99.1）
[3/7] agentDir 可写、模型可读       … 通过（agentDir 可写；读到 2 个模型）
        D:\space\aiteam\test\demo\env\agent\models.json → faux: echo、echo-alt（离线，modelNetwork:false）
[4/7] createAgent 能起 agent        … 通过（id=demo-check，model=echo/off）
        agentDir=D:\space\aiteam\test\demo\env\agent
        cwd=D:\space\aiteam\test\demo\work
        假 provider=http://127.0.0.1:54691/v1
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
        permissions（写 gate 且真被调用 1 次；写 only/deny/allow 各一次，都用 tools.list() 读回）

七项全通过 —— 本机可以开始研究 agent 课题了。
下一步：node examples/01-first-agent.ts（最小演示）；失败时怎么读输出见 demo/README.md。
```

端口、路径、`history=8`、字符数这些每次跑都会略不同，其余一致。`PI_OFFLINE=1` 可以加也可以不加：demo 自己就管离线（见 `demo/env.ts` 的注释）。

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

## 失败了怎么办

失败时输出是固定三段式 —— **不许只说「失败」**（下面是第 5 项失败时的真实形状，栈略）：

```text
[5/7] 一轮 io.prompt 拿到非空文本   … 失败
    原始错误：RunResult.text 是空的：""          ← 原始错误（含栈，便于贴给维护者）
      at Object.run (file:///.../demo/check.ts:193:35)
      ...
    最可能的三个原因与怎么补：                     ← 三个原因，每条都带动作
      1. 假 provider 没起来或端口被占 ⇒ 重跑一次；连续失败就查本机回环 …
      2. 这一轮模型侧报错了（`result.error` 里就是原始错误）⇒ 按 error 文本查 …
      3. pi 版本变了、SSE 解析不兼容 ⇒ 装回 0.99.1（见第 2 项）
```

读法：看 `[i/7]` 是哪一项 → 看原始错误 → 按三个原因里最像的那条动手。
退出码是 **1**；全通过才是 **0**（适合写进 CI / 脚本）。

最常见的两类失败：

- **第 1、2 项**：环境问题。跑 `node --version` 与 `npm ls @earendil-works/pi-coding-agent`；依赖没装就在仓库根目录 `npm install`。
- **第 3 项之后**：环境产物被改坏。`demo/env/agent/` 与 `demo/work/` 都是**可再生的产物**：
  `rm -rf demo/env/agent demo/work`（Windows 用资源管理器删掉）再重跑，`ensureEnv()` 会重建。

## 目录说明

| 路径 | 是什么 | 进 git 吗 |
|---|---|---|
| `demo/env.ts` | 幂等自建环境：写 `models.json`、起本机假 provider | 进 |
| `demo/check.ts` | 这个自检 | 进 |
| `demo/env/agent/` | 自检产物：`models.json`（假 provider，`apiKey` 是写死的 `"faux-key"`） | 不进（`.gitignore`） |
| `demo/work/` | agent 的工作目录与产物落点 | 不进（`.gitignore`） |

`demo/env/` 下还有两份 v1 遗留文件（`auth.json` 含**真实 API 密钥**、`models-store.json` 是旧结构缓存）。
demo **不读**它们（自检用的 `agentDir` 是子目录 `demo/env/agent/`），它们也只是被 gitignore 排除，不会进仓库。
要清理请自行删除，别把它们的内容贴进任何地方。

## 想用真模型

自检的存在意义就是离线可复现，所以它钉死了假 provider（`demo/env.ts` 里 `PI_OFFLINE=1` + `modelNetwork:false`）。
想接真模型：改 `demo/env.ts` 的 `writeModelsJson` 调用与 `process.env.PI_OFFLINE` 那一行，
再把 `demo/check.ts` 第 4 项里的 `model` 换成 `<provider>/<id>`。
各面怎么用见 `examples/`（`01-first-agent.ts` 起，每个文件演示一件事）。
