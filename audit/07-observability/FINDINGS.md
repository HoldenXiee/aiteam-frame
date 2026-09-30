# 第 7 部分：观测与归因（独立复测轮 · 中途叫停）

> **状态说明（先读这一段）**
> 本目录是第 7 部分的**独立复测**。收到「停止调研」指令时，本轮只完成了 **2 次真实运行**：
> `e0-smoke.ts`（成功，真模型 1 次调用）与 `e1-live-reconstruct.ts`（**跑通 S1–S3、在 S4 崩溃**）。
> 已提交的报告是 `docs/research/2026-09-30-phase1-capability-audit-report.md`，本文件**不**复述它的结论。
> 因此：
> - **7.1 的可重建性对照实验没跑成**，本文件不给 7.1 结论（崩溃点与原因见 E1）。
> - **7.2 / 7.3 / 7.4（多样本）/ 7.5 本轮没有独立数据**，只有静态阅读得到的假设（标 ⚪，与实测严格分开）。
> - 下面每条结论都标注了它是**实测**还是**静态阅读**，以及是否有原始输出。

## 结论速览

- **E0（实测）**：真模型单次零工具调用 = 845 token / $0.0000148（input 75 + output 2 + cacheRead 768）；`input+output+cacheRead+cacheWrite === totalTokens` 与 `Σcost 各分量 === cost.total` 两条恒等式在原始返回上**都精确成立**。
- **E0（实测）**：**全新顶层 agent 的第一次调用就命中缓存**（cacheRead=768，cacheWrite=0），且 `cacheRead` 占总量 90.9%，`input` 只占 8.9% —— 与已提交报告「只看 input 会低估一个数量级」（§4.4）方向一致，可作为其独立佐证。
- **E1（实测，崩溃）**：对一个 `session.isStreaming === true` 的分身调用 `prompt()` 会抛 SDK 原始错误 `Agent is already processing...`，**并且这一个失败不产生任何事件、不产生 round_completed**（`create-agent.ts` 的 `prompt()` 在 catch 里直接 rethrow，不 emit `error`）。这是本轮唯一一条"新"的、有原始输出的观测面结论。
- **⚪ 假设 H1（未实测，最高价值）**：`prompt()` 在 `_isEmittingAgentSettled` 窗口内会**静默退化** —— 消息被塞进 `_deferredSettledActions` 后**立即 return**，调用方拿到 `{text:"", usage: 全 0}` 的 `RunResult`，`round_completed` 记 0 token，而消息实际由稍后的一次 settle 执行、用量记到**下一轮**的 `round_completed` 上。若成立，这是「静默失败 + 归因错轮」复合问题，且正好能解释 E1 的崩溃（`spawn_agent` 已 await 返回，子分身却仍在 streaming）。
- **⚪ 假设 H2（未实测）**：`collectRun()` 的 `WeakSet` 去重依赖**消息对象身份**；SDK 在 `context_edit` 命中或 `content == null` 两个分支上会 `{...message}` 克隆消息 → 身份丢失 → **重复计费**。compaction 摘要是 `role:"compactionSummary"`，被 `role !== "assistant"` 过滤掉，这条方向是**安全**的。
- 未完成：7.1 / 7.2 / 7.3 / 7.4 / 7.5 均无本轮独立实测数据（原因：叫停 + E1 崩溃）。

---

## 实测证据

### E0 真模型单次调用（本轮的冒烟与用量基线）

- **问题**：真模型是否可用；单次调用花多少；`usage` 的字段之间是否有可验证的算术关系。
- **方法**：`node audit/07-observability/e0-smoke.ts` → `createAgent({ model: "opencode-go/deepseek-v4.1-flash", tools: [] })` + `prompt("只回答两个字：收到")`。不传 `agentDir` / `modelRuntime`（走 `~/.pi/agent`），**没有** import `test/helpers.ts` 或 `audit/_faux.ts`。
- **原始输出**（终端原文，亦见 `data.json`）：

```
═══ E0 真模型冒烟 ═══
·INFO [E0] 真模型可用性与单次调用成本
    现象：model=opencode-go/deepseek-v4.1-flash 耗时=2294ms text="收到" usage={"input":75,"output":2,"cacheRead":768,"cacheWrite":0,"totalTokens":845,"cost":{"input":0.000011249999999999999,"output":0.0000012,"cacheRead":0.000002304,"cacheWrite":0,"total":0.000014754}}
    结论：可用；后续真模型实验的样本量按此单价外推。
```

- **读出的现象**：
  - `75 + 2 + 768 + 0 = 845`，与 `totalTokens` 逐位相等。
  - `0.00001125 + 0.0000012 + 0.000002304 + 0 = 0.000014754`，与 `cost.total` 逐位相等。
  - `cacheWrite = 0`、`cacheRead = 768`：这个全新 agent 的第一次请求已经在读缓存（本机 `~/.pi/agent` 的模型/工具前缀早被前几轮审计烫过）。
  - `input` 只占总量的 8.9%，`cacheRead` 占 90.9%。
- **结论**：**能**。用量字段自洽（两条恒等式成立），单次成本 $0.0000148 量级。`input` 字段名会被误读为"这次请求的输入"，实际它只是未命中缓存的新增部分。

### E1 真模型对照实验：**崩溃，未取得观测面数据**（同样是有价值的结果）

- **问题**：设计一个真模型多轮多 agent 场景（S1 单轮 → S2 spawn analyst → S3 spawn checker → S4 两个分身并发 → S5 父给子 `send_message`），同时记录 (a) 观测面与 (b) 事实面，回答"只看 (a) 能不能重建发生了什么"。
- **方法**：`node audit/07-observability/e1-live-reconstruct.ts`（脚本保留在本目录，未再复跑）。
- **原始输出**（完整 stderr 见 `raw/e1-abort-stderr.txt`）：

```
Error: Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.
    at AgentSession.prompt (.../pi-coding-agent/dist/core/agent-session.js:1485:23)
    at async Object.prompt (.../src/agent/create-agent.ts:216:7)
    at async Promise.all (index 1)
    at async file:///D:/space/aiteam/test/audit/07-observability/e1-live-reconstruct.ts:169:19
```

- **读出的现象**：
  1. 崩溃点是脚本第 169 行 = S4 里 `kids.map(k => k.prompt(...))` 的 `Promise.all`；`index 1` 即第二个分身，也就是 S3 创建的那个。
  2. 执行能走到 169 行，说明 **S1、S2、S3 都跑通了**（真模型确实调用了 `spawn_agent`）。
  3. 抛错发生在 `session.prompt()`（SDK 第 1485 行，判据是 `this.isStreaming`），**不是** `aiteam` 的 `running` 计数器；`create-agent.ts:216` 的 `catch` 只改状态后 `throw err`，**不 emit `error` 事件**。
  4. 脚本在 `dump()` 之前就抛了，所以**本次真模型调用消耗的 token 与花费没有落盘**（不能说"大约多少"）。
  5. 崩溃的具体诱因（那个分身为什么还在 streaming）**本轮未查明**。`spawn_agent` 的 `execute` 是 `await child.prompt(task)`，按代码读完应已 idle；候选解释见下面的 H1 与 H3。
- **结论**：**失败照写**。三条可确定的结论 ——
  ① 忙时 `prompt()` 抛的是 SDK 原始错误串（与规格 §5 决策表、`test/send.test.ts:48` 一致，不是新 bug）；
  ② 但**这个失败在观测面上完全不可见**：没有 `error` 事件、没有 `round_completed`、`lastResult` 不变，唯一的信号是调用方 catch 到的 JS 异常 —— 只订阅 10 种事件的监控看到的是"什么都没发生"；
  ③ 并发跑一支队伍时最自然的写法 `Promise.all(kids.map(k => k.prompt(x)))` 会在任意一个成员忙时**整体 reject 并丢掉其余成功结果**，库没有 `tryPrompt` / 批量安全投递入口（`send()` 是唯一不抛错的路径，但它不返回结果）。

---

## 静态阅读得到的假设（**未实测**，与上面的实测严格区分）

### ⚪ H1 `prompt()` 的 settle 窗口会静默退化并把用量记到下一轮

- 依据：`agent-session.js:1449-1452` —— `if (this._isEmittingAgentSettled) { this._deferredSettledActions.push(async () => await this.prompt(text, options)); return; }`，以及 `:672-680` 在 `_emitAgentSettled` 末尾统一执行 deferred 动作。
- 推断的后果链：`prompt()` 立即 resolve（返回 `undefined`）→ `create-agent.ts` 的 `prompt()` 继续执行 `collectRun()` → 拿到**空文本 + 全 0 usage** → `state.lastResult` 被这个空结果**覆盖** → `round_completed` 记 0 token → 消息在稍后的 settle 里真正执行，其 token 记进**下一次** `round_completed`。
- 为什么重要：这正是 README 里最危险的一类（不报错但不按预期工作），而且同时污染 7.3 的"每次 run 的用量"口径。`spawn_agent` 直接 `await child.prompt(task)`，所以**它拿到的 `run.text` 可能是空串**，而 agent 会把"已让成员 X 处理…\n\n"（后面没有结论）当成子分身的结果 —— 与已提交报告 §4.6「错误会被包成文本如实汇报」不矛盾，但补上了另一个通道。
- **这条也能解释 E1**：若 S3 的 `spawn_agent` 撞上这个窗口，它会"成功返回空结论"（S3 完成），而子分身仍在跑 → S4 的 `prompt()` 在 `isStreaming === true` 上抛错。与 H3 是竞争解释，需要用下面的实验区分。
- 一行可复跑的实验：在 `spawn_agent` 前后打印 `child.status / child.isStreaming / child.lastResult`，跑 N=20 次真模型 spawn，统计"返回文本为空 / 子分身返回时 isStreaming 仍为 true"的发生率。

### ⚪ H2 `WeakSet` 去重的保证范围：只在消息对象身份不变时成立

- 依据（`agent/create-agent.ts`）：`const counted = new WeakSet<object>()`，`collectRun()` 遍历 `session.messages`，`if (message.role !== "assistant" || counted.has(message)) continue; counted.add(message);`。去重键是**对象身份**，不是 `(role, timestamp)` 或消息 id。
- 正常路径身份是保住的：`session-manager.js:166-178` 对 `entry.type === "message"` 直接 `return [message]`（同一对象）；`_refreshFinalizedContext()` 只是把投影结果数组赋回 `agent.state.messages`（`agent-session.js:549-556`）。
- **两个会丢身份的分支**（同一函数内）：
  - `message.content == null` → `return [{ ...message, content: [] }]`（第 175 行，新对象）；
  - 命中 `context_edit` → `{ ...message, content }`（第 252 行，新对象）。
  两个新对象都仍是 `role:"assistant"` 且**带着原 usage** → 下一次 `collectRun()` 会把它当成新消息**再加一遍** → `RunResult.usage` / `agent.usage` / `host.usage` 三方**同步虚高**（所以对账仍然"自洽"，查不出来）。
- 一个方向是**安全**的：compaction 摘要的 `role` 是 `"compactionSummary"`（`messages.js:48-55`），被 `role !== "assistant"` 过滤，不会误计。
- 未验证的具体问题：**被重排/被重建的历史消息会不会重复计费**。最省的实验（假 provider，零成本）：跑 2 轮（每轮 18 token）→ 原地重排 `session.messages` → 再跑 1 轮，期望仍为 18；再把 assistant 消息替换成 `{...m}` 克隆后跑 1 轮，若得到 18 + 36 即坐实 H2。
- 与既有报告的关系：**既有报告与 `audit/findings/07-observability.json` 都没有测过这一点**（grep `WeakSet` / `压缩` 无命中），这是本轮唯一还没人碰过的 7.3 子问题。

### ⚪ S1 `host.usage` 无分解、事件无 agent id（静态确认，与既有报告同向）

- `host.ts`：`let usage: Usage = emptyUsage()` 只在 `roundCompleted` 里 `addUsage`，对外只有一个 `get usage()`；`list()` 只返回**未回收**的分身。→ "按成员/按分支花了多少"必须自己订阅 `round_completed` 实时累加，回收后不可补算。
- `events.ts`：7 种归一化事件的载荷分别是 `{delta}` / `{delta}` / `{toolName,callId}` / `{toolName,callId,isError}` / `{message,usage}` / `{message}` / `{usage}` —— **没有任何一种带 agent id**，身份只能由"你 `on` 了谁"隐式携带；只有 `turn` 带 `message.timestamp`（毫秒）。
- 这两条与已提交报告 §4 / 附录缺口 #7 #8 一致，**没有分歧**，仅作为独立静态确认记录。

---

## 与已提交报告的一致性 / 差异

| 项 | 本轮独立结果 | 已提交报告 | 判定 |
|---|---|---|---|
| 零工具单轮的量级 | 845 token（input 75 / cacheRead 768） | 865 token（input 16–118 / cacheRead 768–3200） | **一致**（我的提问更短，差 20 token 属正常） |
| `cacheRead` 主导、`input` 误导 | cacheRead 占 90.9% | 「只看 input 会低估 28 倍」 | **一致** |
| `input+output+cacheRead+cacheWrite === totalTokens` | 成立（845） | 三轮全部成立 | **一致**（n=1 独立复现） |
| `Σ cost 各分量 === cost.total` | 成立 | 报告未单列 | **新增**：成本分量也精确自洽 |
| `prompt()` 忙时抛 SDK 原始错 | 实测复现 | 规格 §5 决策表 + 单测已覆盖 | **一致**，但报告未提"该失败不产生任何事件" |
| `context_edit` / `content==null` 导致的 WeakSet 去重失效 | ⚪ 假设，未实测 | **未覆盖** | **待验证的新问题** |
| `prompt()` settle 窗口静默退化 | ⚪ 假设，未实测 | **未覆盖** | **待验证的新问题** |

**没有发现与已提交报告相矛盾的结论。** 本轮的价值在交叉验证（3 条独立复现 + 1 条新增恒等式）与 2 条未覆盖的待验证问题。

---

## 本轮未做 / 下一步

| 缺什么 | 卡在哪 | 最小可跑法 |
|---|---|---|
| 7.1 真模型可重建性对照（观测面 vs `session.messages`） | E1 在 S4 因"忙时 prompt"崩溃且未落盘 | 把 S4 的 `k.prompt(x)` 换成 `k.send(x)` + `await Promise.all(kids.map(k => k.waitForIdle()))`；S4 前先打印每个 `kid.status/isStreaming` |
| 7.2 归因胶水行数 / API 清单 | 未开始 | 既有 `audit/07-observability.ts` 的 7.2a 已给出 36 行口径，可复核 |
| 7.3 四情形对账 + WeakSet 压缩场景 | 未开始 | 见 H2 的"最省的实验"（假 provider，零成本，约 20 行） |
| 7.4 真模型 usage 抽样 5–10 次 | 只完成 1 次（E0） | 重复 E0 的调用形态并变上下文长度，检查 `totalTokens` 的线性与 `cacheRead` 出现条件 |
| 7.5 盲区清单 | 未开始 | E1 的两条实测（无 agent id / 失败无事件）+ H1/H2 足够起头 |

真模型花费：**$0.0000148**（E0；E1 的花费因脚本崩溃未落盘，无法给出数字）。

---

## 清单

| # | 现象 | 类别 | 严重度 | 证据 |
|---|---|---|---|---|
| 1 | 忙时 `prompt()` 抛 SDK 原始错误，且**不产生任何事件**（无 `error`、无 `round_completed`），只订阅 10 种事件的监控完全看不到这次失败 | 缺口 | 高 | E1 |
| 2 | `Promise.all(agents.map(a => a.prompt(x)))` 是跑一支队伍的自然写法，但任一成员忙就会整体 reject 并丢掉其余结果；无 `tryPrompt`/批量安全入口 | 极限 | 中 | E1 |
| 3 | `collectRun()` 用 `WeakSet` 按**对象身份**去重；SDK 在 `context_edit` 与 `content == null` 分支克隆 assistant 消息 → 三方用量同步虚高（对账自洽所以查不出来） | 静默失败（待验证） | 高 | ⚪ H2 |
| 4 | `prompt()` 在 settle 窗口内立即 return，调用方拿到空文本 + 全 0 usage 的 `RunResult`，用量记到下一轮 | 静默失败（待验证） | 高 | ⚪ H1 |
| 5 | 7 种归一化事件无 agent id、6 种无时间字段；`host.usage` 只有一个总数 | 缺口 | 中 | ⚪ S1（与既有报告一致） |
| 6 | 用量字段自洽：两条恒等式（token 与 cost 分量）在真模型原始返回上精确成立 | 能力 | — | E0 |
