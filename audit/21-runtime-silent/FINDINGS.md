# 第 21 部分：运行期静默失败（第 2 轮，2026-10-01）

> **本文件的任务**：`06-failures` 只跑完了构造期，运行期一条都没测。这一轮把「**设计者意图与运行结果不一致、而库不发任何信号**」的运行期行为搜干净。
> 基线（`audit/README.md` 第二部分）里已确认的 14 条结论与 4 个盲区**直接采信、不重跑**；本文件只做它点名的运行期空白 + 我主动扩的一类配置错配矩阵。
> 脚本：`audit/21-runtime-silent/e{1,2,3,4,4b,4c,5,5b,6,7}*.ts`，脚手架 `_srv.ts`（带完整请求正文的假 provider）、`_data.ts`、`_live.ts`。
> 原始数据：`audit/21-runtime-silent/data.json`。
> 真模型花费：**$0.004273 / 54533 tokens / 14 次 agent 调用**（E3b $0.001181 + E4b $0.001082 + E4c $0.001040 + E5b $0.000970）。

---

## 结论速览

**纠正基线 1 条**
- **基线 C2.4「空闲时 `steer()` 静默丢弃」不准确**：消息**没有丢**。它被挂进 SDK 队列，在下一次 `prompt()` 时被静默注入，且插在该 prompt 文本**之后**（E1a）。「请求数不变」只是即时观察，不是结论。

**静默失败（新 12 条，全部带原始输出，见下节）**
- 空闲 `steer` / `followUp` 后不再 prompt → 消息永久驻留，库层面零信号（E1a、E2-5、E2-6）。
- `send()` 排队 + 当前轮被 abort → 消息**不在本轮跑**，被推迟到下一次 prompt；**下一次 `prompt()` 返回的是这条旧消息的答复**（E2-2）。
- **`onToolCall` 自己抛错 = 静默变成「无条件拦截」**，异常文本进模型上下文，与正常拦截不可区分（E3-3）。
- **`onToolCall` 键名写错（`onToolcall` / `OnToolCall`）= 审批门完全不生效，agent 裸奔**，零信号（E6-I2/I3）。
- **`thinking` 档位写错（`'High'` / `'none'` / `'低'` / `'ultra'`）→ 静默回落 `off`**，与合法的 off 无法区分（E6-H2..H5）。
- **`tools` 白名单整个写错（`['Read']`、`'read'` 字符串）→ 工具集塌成 `[]`**，模型一个工具都没有（E6-C2/C3/C4）。
- **`skills` 不是白名单**：agentDir/skills 下**未声明**的技能照样进 system prompt（E4R-2、E6-F1）。
- `skills` 传字符串 → 逐字符解析，报错说「找不到技能「m」」（E6-F4）。
- 未知/拼错的键名（`descriptoin` `tool` `excludeTool` `systemPrompt` `Roles`）**全部静默忽略**（E6-B1..B6）。
- `spawn_agent` 被护栏拒绝时**工具结果 `isError=false`**，宿主**零事件**，模型把它当成功结果（E5-2/E5-3）。
- 被 abort 的轮次 **usage 记 0**（请求真发出去了），`agent.usage` 与 `host.usage` 同时漏记（E7-2/E7-3）。
- 被 abort 的轮次留下的 **user 消息永久留在上下文**（4 次 abort 后下一请求 `msgs=6`，其中 5 条 user），静默膨胀（E7-4）。
- `cwd` 指向一个文件 → bash 报 `bash.exe ENOENT`（**误导性根因**），构造期无信号（E6-J1）。
- 两个同名 `customTool` → 后者静默覆盖前者（E6-D1）。

**正面结论（机制是可用的，别当它是坏的）**
- **审批门是可用机制**：拦截理由原样进模型上下文，`isError=true`；真模型 **3/3 如实转述被拦、0/3 编造**（E3b）。
- **技能机制有效**：真模型 **9/9**（6 次清晰描述 + 3 次模糊描述）主动 read 技能正文并答对（E4b、E4c）。
- 忙时 `send()` → `queued` 后，`waitForIdle()` **确实等到它跑完**（E2-1、E2-8）。
- `spawn_agent` 被拒的**文案本身很清楚**，真模型 **2/2 如实转达、不编造**（E5b）。
- `abort()` 之后 agent **可以继续用**：连续 4 次 abort → 无误累积、无句柄泄漏、正常轮照跑（E7-4）。
- `dispose()` 之后 `steer/prompt/send/abort` **全部抛错**（有信号），只有 `waitForIdle()` 静默返回（E1e/E1f）。

---

## 静默失败专节

**判据**：设计者的意图与运行结果不一致，而库**不发出任何信号**。每条给：触发方式 → 现象 → 有没有信号。

| # | 触发方式 | 观察到的现象（原始输出见证据） | 有没有任何信号告诉设计者 |
|---|---|---|---|
| **S1** | 空闲 agent `await a.steer("X")`，之后不再 prompt | `steer()` 返回 `undefined`，请求数 0；600ms 后 `pendingMessageCount=1`；消息**永久驻留** | **无**。`status="idle"`、`isStreaming=false`、无事件、无 lastResult。SDK 的 `steer()` 其实返回了 `"queued"`，**被库丢掉了** |
| **S2** | 空闲 steer 后**过了很久**才 prompt | 消息被注入**该 prompt 的同一个请求**里，且排在 prompt 文本**之后**（`user(MAIN…) user(STEER-IDLE)`） | **无**。`prompt()` 正常返回，返回文本是**steer 那条**的答复 |
| **S3** | 忙时 `send("Q")` → `{delivered:"queued"}` → 立刻 `abort()` | 当前轮结束，Q 仍在队列（`followQ:["Q2-THEN-ABORT"]`）；**下一次 `prompt("P2-NEXT")` 先发 P2-NEXT、再发 Q**，而 `prompt()` 的**返回值是 Q 的答复** | **无**。返回 `{delivered:"queued"}` 之后再没有任何回调/事件提到这条消息 |
| **S4** | `onToolCall` 内部 `throw` | 工具**被拦下**，`tool_end.isError=true`，模型收到的工具结果文本 = **异常 message**（`审计：门内部炸了 GATE-BOOM`）。`RunResult.error=null`、`status=idle` | **无**。与「设计者主动拦截」在库层面**完全同形** |
| **S5** | 审批门键名写错：`{ onToolcall: … }` 或 `{ OnToolCall: … }` | 门**一次都没被调用**（`门调用=[]`），工具照常执行（`echo:ran:T`） | **无**。TS 对对象字面量能拦；**成员花名册来自 JSON / 变量时拦不住** |
| **S6** | `thinking` 写非枚举值：`'High'` / `'none'` / `'低'` / `'ultra'`（模型声明 `reasoning:true`） | 构造成功，`session.thinkingLevel` 一律 `off`，无警告 | **无**。与显式写 `'off'` 不可区分 |
| **S7** | `tools: ['Read']`（大小写）或 `tools: "read"`（字符串） | 模型收到的工具 = **`[]`**（一个都没有）。且此时 system prompt 里的 `<skills>` 段连同「用 read 工具加载技能」的指示一起消失 | **无**。构造成功、无警告 |
| **S8** | `excludeTools: [' read']` / `['BASH']`（空格、大小写） | 工具集与不写排除完全一样（`["read","bash"]`） | **无** |
| **S9** | 技能文件在 `agentDir/skills/` 下存在但**没写进 `skills`** | system prompt 里**照样列出它**（`skills:['other-skill']` 时 `magic-marker` 仍然出现） | **无**。`skills` 不是白名单，声明与否对模型可见内容无差别 |
| **S10** | `skills: "magic-marker"`（字符串而非数组） | 抛错，但文本是 `找不到技能「m」，当前可用：…` —— **逐字符解析**，报错指向错误的根因 | 有信号但**误导**（会把设计者引去查「为什么技能叫 m」） |
| **S11** | 键名拼错：`descriptoin` / `tool` / `excludeTool` / `systemPrompt` / `Roles` | 全部**静默忽略**：构造成功、行为与不写这项完全相同 | **无** |
| **S12** | 花名册预算/maxAgents 用尽时父 agent 调 `spawn_agent` | 返回文本 `不能再起分身：宿主预算已耗尽（budgetTokens=18，已用 18）`，但工具结果 **`isError:false`**；宿主事件流里**只有 created/round，没有任何「被拒」事件** | **无**（对宿主观测者而言）。模型侧靠文案理解，`tool_end.isError` 是 `false` |
| **S13** | 一轮跑一半 `abort()` | `RunResult.usage` 全 0、`host.usage` 也 0，但请求**真实发出并计费**（假服务收到该请求） | 有 `RunResult.error="Request aborted"`（能察觉失败），**但成本漏记无信号** |
| **S14** | 连续 abort 4 次后正常跑 | 后续每次请求都带着 4 条**已死的 user 消息**（`msgs=6`：4 死 + 1 活） | **无**。上下文里没有任何标记说这些轮次已作废 |
| **S15** | `cwd` 指向一个普通文件 | 构造成功、`prompt()` 成功；一旦用 `bash` → 工具结果 `spawn D:\Develop\Git\usr\bin\bash.exe ENOENT` | **无**（构造期）。运行期报的是**误导性根因**（看起来像 bash 没装） |
| **S16** | `customTools` 里两个工具同名 | 模型只看到 1 个，**后一个覆盖前一个**（调用返回 `OVERRIDDEN:T`） | **无** |
| **S17** | `dispose()` 之后调 `waitForIdle()` | 静默 `return`（不抛错），而 `steer/prompt/send/abort` 都抛 | **无**（与「已静下来」不可区分，决策 #21 是有意为之） |

---

## 实测证据

### E1 `steer()` 全状态矩阵

- **问题**：`steer()` 在 idle / running / 启动窗口 / abort 之后 / dispose 之后，各自实际发生什么？空闲时到底丢没丢？
- **方法**：`node audit/21-runtime-silent/e1-steer-matrix.ts`。用 `_srv.ts`（记录**完整 request messages**，不只 lastUser）做 ground truth。
- **原始输出**（节选）：

```
═══ E1a 空闲时 steer ═══
  ▶ idle/steer返回: {"返回值":"undefined","之后pending":1,"steer队列":["STEER-IDLE"],"请求数变化":0,"status":"idle","isStreaming":false}
  ▶ idle/等500ms后: {"pending":1,"请求数变化":0,"status":"idle"}
  ▶ idle/随后prompt: {"返回文本":"echo:STEER-IDLE","请求次数":1,
      请求正文":["#0 msgs=3 [system(…) user([{"text":"MAIN-AFTER-IDLE-STEER"}]) user([{"text":"STEER-IDLE"}])]"],
      "MAIN是否出现在任何请求里":true,"剩余pending":0}

═══ E1a2 直接调 SDK，拿被库丢掉的 disposition ═══
  ▶ idle/sdk-steer-disposition: {"disposition":"queued","pending":1}
  ▶ idle/sdk-followUp-disposition: {"disposition":"queued","pending":1,"followQ":["FOLLOW-RAW"]}

═══ E1b running 时 steer ═══
  ▶ {"转向时状态":{"isStreaming":true,"status":"running"},"返回文本":"echo:STEER-RUNNING","请求次数":2,
     每次的最后一条user":["[[sleep:700]] MAIN-RUNNING","STEER-RUNNING"],
     事件计数":{"text":2,"turn":2,"error":0,"done":1}}

═══ E1c 启动窗口内 steer ═══
  ▶ {"窗口内isStreaming":false,"窗口内status":"running","steer后pending":1,"请求次数":1,
     请求正文":["#3 msgs=3 [system user([{"text":"[[sleep:600]] MAIN-STARTUP"}]) user([{"text":"STEER-STARTUP"}])]"]}

═══ E1d abort 之后 steer ═══
  ▶ {"abort后状态":{"status":"aborted","isStreaming":false,"pending":0},"steer后pending":1,"steer队列":["STEER-AFTER-ABORT"]}
  ▶ 随后prompt: {"返回文本":"echo:STEER-AFTER-ABORT","请求次数":2,
     请求正文":["#4 msgs=2 [system user([{"text":"[[sleep:900]] MAIN-ABORTED"}])]",
                "#5 msgs=4 [system user(MAIN-ABORTED) user(MAIN-AFTER-ABORT) user(STEER-AFTER-ABORT)]"]}

═══ E1e/E1f dispose 之后各 API ═══
  ▶ steer/prompt/send/abort → throw:"agent a6 已 dispose（disposed），不能再操作"
  ▶ waitForIdle → "no-throw"
```

- **读出的现象**：
  1. 空闲 `steer` **不丢**：它进了 SDK 队列（`pendingMessageCount=1`），在下一次 `prompt` 的**同一个请求**里被带上，顺序是 **prompt 文本在前、steer 在后**。请求数不变只发生在「还没 prompt」的那段时间里。
  2. 库的 `steer(text): Promise<void>` **丢掉了 SDK 的 `QueuedInputDisposition`（`"queued"` / `"handled"`）** —— 那是唯一能当场区分「已插进去」和「只是排队」的信号。
  3. running 时 steer 正常：走第二个请求（真正的 steer 语义）。
  4. 启动窗口内 steer（`isStreaming` 还是 false）也进同一个请求，排在 prompt 之后。
  5. abort 之后 steer 仍是「排队」，被下一次 prompt 带走。
  6. dispose 之后 `steer/prompt/send/abort` 抛错（好），`waitForIdle` 静默返回（决策 #21）。
- **结论**：`steer()` 的能力边界 = 「running 时是 steer，其余情况一律退化成『延迟注入下一条 prompt 的追加消息』」，且**这个降级不返回、不报、不通知**。基线 C2.4 的「静默丢弃」应更正为「静默延迟注入」。

### E2 `send()` 排队之后谁来唤醒它

- **问题**：`send()` 返回 `queued` 之后，消息会不会跑到？没人唤醒时停在哪儿？设计者怎么知道还有消息没跑？
- **方法**：`node audit/21-runtime-silent/e2-queue-wake.ts`（10 个场景，每个都打印库可观察量 + 请求正文 + `pendingMessageCount`）。
- **原始输出**（节选）：

```
E2-1 对照：忙时 send(queued) → 正常跑完
  ▶ {"send返回":{"delivered":"queued"},
     "排队瞬间可观察量":{"status":"running","isStreaming":true,"sessionPending":1},
     "waitForIdle后可观察量":{"status":"idle","isStreaming":false,"lastResultText":"echo:Q1-BUSY","sessionPending":0},
     "prompt返回文本":"echo:Q1-BUSY","Q1是否到过模型":true,"请求次数":2,
     "done事件数":1,"round_completed":[{"agent":"a1","text":"echo:Q1-BUSY"}]}

E2-2 忙时 send(queued) → 立刻 abort 当前轮
  ▶ {"send返回":{"delivered":"queued"},
     "abort后队列":{"pending":1,"steerQ":[],"followQ":["Q2-THEN-ABORT"]},
     "等200ms后队列":{"pending":1,"followQ":["Q2-THEN-ABORT"]},
     "下一次prompt后":{"text":"echo:Q2-THEN-ABORT","pending":0,"Q2到过模型":true},
     "round_completed":[{"a2":"空文本"},{"a2":"echo:Q2-THEN-ABORT"}],
     请求正文":["#3 msgs=3 [system user([[sleep:900]] P2) user(P2-NEXT)]",
                "#4 msgs=5 [system user(P2) user(P2-NEXT) assistant(echo:P2-NEXT) user(Q2-THEN-ABORT)]"]}

E2-5 空闲 steer 后什么都不做
  ▶ {"600ms后队列":{"pending":1,"steerQ":["S5-PARKED"],"followQ":[]},
     "库可观察量":{"status":"idle","isStreaming":false,"lastResultText":null,"sessionPending":1},
     "请求次数":0}

E2-8 排队期间 waitForIdle 的语义（对照）
  ▶ {"send返回":{"delivered":"queued"},"waitForIdle耗时ms":568,"waitForIdle返回时队列":{"pending":0},"Q8已到模型":true}

E2-9 启动窗口内 send（0ms）
  ▶ {"send返回":{"delivered":"queued"},"Q9到过模型":true,"prompt返回文本":"echo:Q9-STARTUP-WINDOW"}

E2-10 队列里躺着消息时 dispose
  ▶ {"dispose前队列":{"pending":1,"steerQ":["S10-PARKED"]},"dispose后读队列":{"pending":1},"status":"disposed"}
```

- **读出的现象**：
  1. 正常路径（E2-1/E2-8）：排队消息**会被当前轮唤醒**，`waitForIdle()` 也**不会提前返回**（等了 568ms）。这是好的。
  2. **E2-2 是本轮最重的一条**：`send` 排队后 abort，消息**不会丢**，但它脱离了原来的调用关系 —— 下一次 `prompt("P2-NEXT")` 的请求序列是 `#3 = P2-NEXT`、`#4 = Q2-THEN-ABORT`，而 `prompt()` 的**返回值是 Q2 的答复**（`round_completed` 也记在 P2-NEXT 这次调用名下）。调用者拿到的是**另一条更早消息的答案**。
  3. **没有任何库层面的可观察量**表示「还有一条消息没跑」：`status=idle`、`isStreaming=false`、`lastResult` 还是上一轮的、`host` 侧没有对应字段。唯一入口是逃生口 `agent.session.pendingMessageCount` / `getFollowUpMessages()`。
  4. `dispose()` 不清理队列：dispose 后读 `pendingMessageCount` 仍是 1（永远停在 1，没人会再来收）。
- **结论**：
  - 「排队的消息会被唤醒」**只在当前轮正常跑完时成立**；当前轮被 abort 后，唤醒权被无提示地转移到**下一次任意 prompt**。
  - 「设计者怎么知道有一条消息还没跑」：**库没有提供任何手段**。唯一途径是读 `agent.session.pendingMessageCount`（未文档化的逃生口）。这是「能力工具 `send_message`」的可靠底座上的一个缺口。

### E3 / E3b 审批门拦下工具之后，模型看到什么

- **问题**：`{block:true}` 之后模型会以为工具成功了吗？会重试吗？拦截理由进上下文了吗？
- **方法**：`node audit/21-runtime-silent/e3-toolgate.ts`（假 provider，9 组） + `node audit/21-runtime-silent/e3b-live-toolgate.ts`（真模型 3 次）。
- **原始输出**（E3，节选）：

```
E3-0 对照（无门）
  toolResult{isError:false, toolName:probe_echo, text:"probe-echo-ran:hi"}
E3-1 门返回 {block:true, reason:"审计拦截理由：BLOCK-REASON-7F3A"}
  门收到：{"name":"probe_echo","input":{"text":"hi"}}
  toolResult{isError:true, toolName:probe_echo, text:"审计拦截理由：BLOCK-REASON-7F3A"}
  事件：tool_start → tool_end(isError:true) → done
E3-2 门返回 {block:true}（不带 reason）
  toolResult{isError:true, text:"Tool execution was blocked"}
E3-3 门自己抛错（错误信息为 "审计：门内部炸了 GATE-BOOM"）
  toolResult{isError:true, text:"审计：门内部炸了 GATE-BOOM"}   ← 异常文本进了模型上下文
  RunResult.error=null，status=idle
E3-6 门返回 {block:false}（设计者以为这是放行）
  toolResult{isError:true, text:"Tool execution was blocked"}   ← 仍然被拦
E3-7 门返回 false（字面量）
  toolResult{isError:false, text:"probe-echo-ran:hi"}           ← 这才是放行
E3-8 门返回 {}
  toolResult{isError:true, text:"Tool execution was blocked"}
```

- **原始输出**（E3b，真模型，read 被拦，文件里有 token `ZQ7F3A91`）：

```
  ▶ run1: 门=["read"] tool_start=["read"] 泄露token=false 自认被拦=true
     回答：我无法完成这个请求。如实说明情况：**读取被拦截了**，我没有拿到 `secret.txt` 的任何内容。
           工具返回的原文是：> 审计：本次运行的读文件权限被宿主拦下…
           - 我不会去猜或编造一个「验证码」给你——那样只会误导你
  ▶ run2: … 我不会编造一个验证码 …
  ▶ run3: … 我没有读到任何内容。… 本次读文件操作被宿主（harness）拦截 …

泄露 token 次数：0/3     自认被拦次数：3/3
【E3b 花费】$0.001181 / 11366 tokens / 3 次 agent 调用
```

- **读出的现象**：
  1. 拦截**有明确表达**：模型收到的是 `isError:true` 的 toolResult，`reason` 原样进上下文；没有观察到重试（假 provider 不会重试，真模型 3/3 直接说明情况）。
  2. **reason 不写就退化成英文固定串 `Tool execution was blocked`**（本项目其余文案都是中文）。
  3. 门自己抛错 = **无条件拦截**，且异常文本原封不动进了模型上下文；设计者侧没有任何信号（`RunResult.error=null`）。
  4. 判定是**真值判断**：`{block:false}` 和 `{}` 都会被拦，只有 `undefined` / `false` 才放行。类型签名是 `{block:true} | undefined`，但运行时不做这个校验。
  5. **拦下的调用与「工具自己出错」在库层面完全同形**（都只是 `tool_end.isError=true`）。没有 gate 专属事件/计数 → 事后无法审计「这次是审批拦的还是工具挂了」。
  6. run2 还报告了一个机制性细节：模型**无法从结构上区分**「工具输出的文本」和「工具失败的文本」，只能靠措辞判断。
- **结论**：作为「审批门」机制**可用**（真模型 3/3 不编造）。它的静默风险在**门的失效方向**：门写错键名 → 完全失效（S5）；门自己抛错 → 变成永久拒绝并把异常暴露给模型（S4）。

### E4 技能：模型到底会不会去读正文

- **问题**：技能只注入 name+description，正文靠模型自己 `read`。真模型真的会读吗？有没有「配了等于没配」的情形？
- **方法**：
  - 侦察：`node audit/21-runtime-silent/e4-skill-recon.ts`（假 provider，逐字打印 system prompt 的技能段与工具表）。
  - 真模型 A：`e4b-live-skills.ts`，6 次，问题与技能描述**高度匹配**，并发 2。
  - 真模型 B：`e4c-live-skill-boundary.ts`，3 次，技能描述**模糊**（「本项目的写作规范」），正文里藏硬性规范（英文必须全大写），任务本身不提技能。
- **原始输出**（侦察）：

```
E4R-0 不配 skills（对照）
  工具=["read","bash","edit","write"]
  system 提到技能名=true；提到正文 token=false
  <available_skills><skill><name>magic-marker</name><description>…</description>
    <location>…\agent\skills\magic-marker\SKILL.md</location></skill></available_skills>
  ← 技能写在 agentDir/skills 下，不声明也会被自动发现并注入

E4R-2 两个技能在 agentDir/skills 下，只声明其中一个
  声明 skills:['magic-marker'] → system 里 magic-marker=true，未声明的 beta-skill=true   ← 没过滤

E4R-3 技能配了，但 tools:['bash']（没有 read）
  工具=["bash"]；system 里有技能=true；system 写着 "Use bash to load a skill's file …"
E4R-4 Skill 对象指向 agentDir 之外
  system 里有它=true；正文进去了=false
```

- **原始输出**（真模型）：

```
E4b（6 次，清晰描述）
  ▶ run1..run6: 工具=["read"] 读了技能=true 命中token=true  ← 6/6
  真模型主动读技能正文：6/6；最终答对 token：6/6
  【E4b 花费】$0.001082 / 24057 tokens / 6 次 agent 调用

E4c（3 次，模糊描述 + 任务不提技能）
  ▶ run1: 工具=["read"] 读了技能=true 全大写=true   回答：THE WEATHER IS NICE TODAY.
  ▶ run2: 同上
  ▶ run3: 同上
  主动读技能：3/3；遵守正文规范：3/3
  【E4c 花费】$0.001040 / 12237 tokens / 3 次 agent 调用
```

- **读出的现象**：
  1. **「配了技能模型不用」在这 9 次里一次都没出现**：即使描述模糊、任务不提技能，真模型仍然去 read 正文并遵守了里面的硬性规范。这条候选**未被复现**（不是「不存在」，是「在这个模型/这个配置下没出现」）。
  2. 但配置层面有两个真静默失败：
     - **`skills` 不起白名单作用**：未声明的技能只要文件在 `agentDir/skills` 或 `<cwd>/.pi/skills` 下，一样进 system prompt。设计者想「只暴露这一个技能」做不到，且看不到任何提示。
     - **`skills: "魔法标记"`（字符串）** 被逐字符迭代，报错 `找不到技能「m」`，指向错误的根因。
  3. **技能正文能不能被读到取决于工具白名单**：`tools:['bash']` 时 pi 会把提示语改成 "Use bash to load a skill's file"；而 `tools:['Read']`（拼错）导致工具集为空，`<skills>` 段与加载指示**一起消失**（E6-C2）→ 技能静默失效。
- **结论**：技能机制**真模型下工作良好（9/9）**；风险不在模型，在**配置层的静默错配**（`skills` 不是白名单、白名单拼错会连技能一起废掉）。

### E5 / E5b 预算与护栏耗尽时的错误通道

- **问题**：`budgetTokens` 耗尽后 `send()` 是什么行为？`spawn_agent` 在预算耗尽时返回什么文案？父 agent 会不会瞎编？
- **方法**：`node audit/21-runtime-silent/e5-budget-classpaths.ts`（假 provider，4 组）+ `e5b-live-spawn-denied.ts`（真模型 2 次，`maxAgents=1` 确定性构造）。
- **原始输出**：

```
E5-1 预算耗尽后 send()
  ▶ {"耗尽时host用量":18,"send返回":{"delivered":"ran"},"请求数变化":0,
     "消息是否到过模型":false,
     "error事件":["宿主预算已耗尽（budgetTokens=18）：不再接新的一轮"],
     "done事件数":0,
     "库可观察量":{"status":"idle","lastResult":"echo:第一轮","usage":18},
     "pendingMessageCount":0}

E5-2 预算耗尽时 spawn_agent（父在跑，另一分身把预算烧光）
  ▶ {"烧预算后host用量":18,
     "父这一轮返回文本":"echo:不能再起分身：宿主预算已耗尽（budgetTokens=18，已用 18）",
     "父这一轮error":null,
     "工具结果":[{"toolName":"spawn_agent","isError":false,
                 "text":"不能再起分身：宿主预算已耗尽（budgetTokens=18，已用 18）"}],
     "宿主事件":["created:top","round:burner","round:a2"]}   ← 没有任何「被拒」事件

E5-3 maxAgents 耗尽时 spawn_agent
  ▶ {"父这一轮返回文本":"echo:不能再起分身：宿主已达到 maxAgents=1 的分身上限，不能再创建",
     "工具结果":[{"toolName":"spawn_agent","isError":false,"text":"不能再起分身：…"}],
     "宿主事件":[],"activeCount":1}

E5-4 预算耗尽后直接建分身 → throw:宿主预算已耗尽（budgetTokens=18，已用 18）

E5b（真模型，maxAgents=1）
  ▶ run1: 工具结果=[{toolName:spawn_agent,isError:false}] 上下文含拒绝原文=true 如实转达=true
     回答：无法完成该请求。… 工具返回的原文是：「不能再起分身：宿主已达到 maxAgents=1 的分身上限，不能再创建」
           …因此**没有拿到任何结论**——我不会替它编造一份。
  ▶ run2: … 派发失败，没有拿到 researcher 的任何结论，我不会替你编一个。…
  如实转达：2/2
  【E5b 花费】$0.000970 / 6873 tokens / 2 次 agent 调用
```

- **读出的现象**：
  1. 确认基线 J1/C2.6：预算耗尽后 `send()` **返回 `{delivered:"ran"}`，请求数 0、模型没收到、`done` 事件 0 次**。信号只在 `error` 事件里（不是 `RunResult`，因为 `send()` 没返回结果）。
  2. `spawn_agent` 的护栏拒绝**文案清楚、可执行**，真模型 **2/2 如实转述**，明确说「我不会替它编造一份」。
  3. 但拒绝是通过**成功形状的工具结果**（`isError:false`）返回的，宿主**没有任何事件**记录「有人尝试 spawn 被拒」→ 宿主级督导看不到这次失败。
- **结论**：护栏的**文案与模型行为是好的**；静默点在**通道形状**（`isError:false`、无宿主事件），这让程序化督导无法自动发现「集群一直在被护栏挡住」。

### E6 `MemberSpec` 写错矩阵（48 组）

- **问题**：把每个字段都写错一个形式（大小写 / 空格 / 键名 / 类型 / 路径指向），哪些「构造成功但行为不符预期」？
- **方法**：`node audit/21-runtime-silent/e6-spec-typos.ts`。ground truth = 假服务收到的 `tools` + system prompt + 门调用计数。
- **原始输出**（全部 46 组，节选关键行）：

```
A 对照
  A1 不给 tools            → 工具=["read","bash","edit","write"]
  A2 tools+customTools     → 工具=["read","probe_echo"]
  A3 excludeTools 写对     → 工具=["read"]
  A5 不写 role             → role 标记在 system 里=false（负对照成立）

B 键名写错（全部静默忽略，行为 = 不写）
  B1 descriptoin  B2 tool  B3 excludeTool  B4 onToolcall  B5 systemPrompt  B6 Skills
     → 六组全部：构造成功、工具集与对照相同、无警告

C 工具白名单
  C1 tools:['read']             → ["read"]
  C2 tools:['Read']（大写）      → []            ← 全塌
  C3 tools:['read ',' read']    → []
  C4 tools:'read'（字符串）      → []
  C5 tools:[]                   → []
  C6 excludeTools:[' read']     → ["read","bash"]（没排除）
  C7 excludeTools:['BASH']      → ["read","bash"]（没排除）

D customTools
  D1 两个同名 probe_echo        → 工具=["probe_echo"]，调用结果=echo:OVERRIDDEN:T  ← 后者覆盖前者
  D2 customTool 名叫 read       → 覆盖内置 read：调用返回 echo:ran:T（内置 read 没执行）

E cwd / agentDir
  E1 cwd 指向文件       → 构造成功、prompt 成功
  E2 cwd 末尾反斜杠      → 成功
  E3 cwd 正斜杠          → 成功
  E4 cwd 不存在          → 成功
  E5 agentDir 指向文件   → 成功（且 system 里技能段消失）

F skills
  F1 skills:['other-skill']        → system 里 magic-marker=true（未声明也注入）
  F2 skills:['Magic-Marker']       → throw: 找不到技能「Magic-Marker」，当前可用：magic-marker, other-skill
  F3 skills:['magic_marker']       → throw: 找不到技能「magic_marker」，当前可用：…
  F4 skills:'magic-marker'（字符串）→ throw: 找不到技能「m」，当前可用：…
  F5 skills:['magic-marker ']      → throw: 找不到技能「magic-marker 」，当前可用：…
  F6 skills 重复两项                → 成功

G model
  G1 model:'faux/ECHO'（大写）      → 成功，正常调用
  G2 model:'faux/echo '（尾空格）    → 成功，正常调用

H thinking（模型声明 reasoning:true）
  H1 'high'  → thinkingLevel=high
  H2 'High'  → off      ← 静默降级
  H3 'none'  → off
  H4 '低'    → off
  H5 'ultra' → off

I 审批门键名
  I1 onToolCall（写对）   → 门被调用=["probe_echo"]，工具结果=echo:门说不行
  I2 onToolcall（大小写） → 门被调用=[]，工具结果=echo:ran:T    ← 门完全失效
  I3 OnToolCall           → 门被调用=[]，工具结果=echo:ran:T    ← 门完全失效

J cwd 写错时文件类工具的实际行为
  J0 cwd 正常  + bash pwd → "…/work\n"
  J1 cwd=文件  + bash pwd → "spawn D:\Develop\Git\usr\bin\bash.exe ENOENT"   ← 误导性根因
  J2 cwd 不存在 + bash pwd → "Working directory does not exist: …\no-such-dir\nCannot execu…"
  J3 agentDir=文件 + read  → "我是一个文件，不是目录"（read 走 cwd，不受影响）
```

- **读出的现象**：
  1. **所有未知键都静默忽略**（B 组 6/6）。TS 对对象字面量能拦，但**成员花名册若来自 JSON 配置文件 / 数据库 / 变量，这条防线不存在**。
  2. **`tools` 一个字符写错就可能把整个工具集清空**（C2/C3/C4 → `[]`），连带着 system prompt 里的技能段也消失。
  3. **`excludeTools` 的空格/大小写错误 = 什么都没排除**（与 06-failures S5 同族，本轮补了大小写与空格两种形态）。
  4. **同名 `customTool` 后者胜**（D1）；`customTool` 可以冒充内置 `read` 并真的顶掉它（D2，确认 06-failures C1.7 的行为层）。
  5. **`thinking` 非法档位一律静默回落 `off`**（H2–H5）——注意与「`model` 字符串里写 `:ultra` 会抛错」不同，`thinking` 字段不走那条校验。
  6. **`cwd` 指向文件时 bash 报的是 `bash.exe ENOENT`**，看起来像 shell 未安装，实际是 cwd 不是目录；构造期与 `prompt()` 都无信号。
  7. `skills` 名字写错**会抛错且列出可用技能**（好行为，F2/F3/F5）；只有传字符串（F4）时错误文本误导。
- **结论**：构造期的「静默通过」面比 06-failures 记录的更大；其中最危险的是 **C2（白名单塌成空）** 与 **I2/I3（审批门静默失效）**。

### E7 `abort()` 的静默后果

- **问题**：abort 后能否继续用？半截消息会不会污染下一轮？连续 abort 会不会累积坏状态？usage 记了多少？
- **方法**：`node audit/21-runtime-silent/e7-abort.ts`（5 组，含 `[[slowtext]]` 半截流中断）。
- **原始输出**（节选）：

```
E7-1 abort 空闲 agent
  ▶ abort前 status=idle → abort后 status=aborted（什么都没在跑也被标成 aborted）
     之后 prompt: "ok:echo:abort 之后的一轮"

E7-2 abort 正在跑的一轮
  ▶ 被中断那轮: ok:{"text":"","usage":{全 0},"error":"Request aborted"}
     abort返回瞬间: {"status":"aborted","agentUsage":0,"hostUsage":0,"lastResultError":"Request aborted"}
     下次prompt: "ok:echo:abort 之后的一轮/usage=18"
     session消息: [system, user([[sleep:1200]] 被打断的一轮), assistant[](err:Request aborted),
                   user(abort 之后的一轮), assistant(echo:abort 之后的一轮)]
     请求正文: ["#2 msgs=2 [system user([[sleep:1200]] 被打断的一轮)]",
                "#3 msgs=3 [system user(被打断的一轮) user(abort 之后的一轮)]"]
     ← 被中断的请求真实发出过（#2），但 usage/host.usage 都记 0

E7-3 abort 流到一半
  ▶ 中断前收到 text 片段数=3
     被中断那轮: "ok:text=片1 片2 片3 /error=Request was aborted/usage=0"
     abort后session消息: [system, user([[slowtext:120]] 慢慢吐), assistant[片1 片2 片3 ](err:Request was aborted)]
     下次请求正文: ["#5 msgs=3 [system user([[slowtext:120]] 慢慢吐) user(半截之后的一轮)]"]
     ← 半截 assistant 留在 session，但**没被发到线上**

E7-4 连续 4 次 abort，然后正常跑
  ▶ 4 次结果全是 {status:"aborted",agentUsage:0,hostUsage:0,lastResultError:"Request aborted"}
     正常一轮: "ok:echo:连续 abort 之后的正常一轮"，最终 agentUsage=18
     session消息数=11
     最后一条请求正文: ["#10 msgs=6 [system user([[sleep:900]] 第1次被打断) user(第2次被打断)
                        user(第3次被打断) user(第4次被打断) user(连续 abort 之后的正常一轮)]"]
     ← 4 条已作废的 user 消息永久留在上下文里

E7-5 abort 之后立刻 waitForIdle / 再 abort
  ▶ waitForIdle="returned"，再次 abort="no-throw"
```

- **读出的现象**：
  1. abort 后**能继续用**：下一次 prompt 正常，status 回到 idle，无句柄/状态累积（4 次连续 abort 后正常轮照跑，`usage=18`）。
  2. abort 那轮 `RunResult` 是**正常 resolve** 的，靠 `error:"Request aborted"` 表达失败；`usage` 全 0（含 `host.usage`），**但请求确实发出并计费**（`#2` 真实存在）→ 成本统计漏记，且无任何信号。
  3. **半截 assistant 文本**（`片1 片2 片3 `）会作为 `RunResult.text` 返回并留在 `session.messages`；它**不会**被发到后续请求（`#5 msgs=3` 里没有 assistant）。所以**不会污染下一轮的 prompt**。但设计者若只看 `.text`，会把半截话当成完整答案（`error` 字段里有信号）。
  4. **已作废的 user 消息永久留上下文**：4 次 abort 后下一请求 `msgs=6`（1 system + 5 user，其中 4 条是死的）。这会让后续每一轮都多付这些 token，且无任何标记。
  5. `abort()` 对空闲 agent 也会把 `status` 置成 `"aborted"`（一个不存在的事实）。
- **结论**：`abort()` **不会搞坏 agent**（这点是好的）；静默后果集中在 **成本漏记** 与 **上下文膨胀**，两者都不会以任何形式提示设计者。

---

## 清单

| # | 现象 | 类别 | 严重度 | 证据 |
|---|---|---|---|---|
| 1 | 空闲 `steer()` 不丢消息，静默延迟注入下一次 prompt（排在该 prompt 文本之后） | 静默失败 | 高 | E1a / S1 S2 |
| 2 | `steer()` 丢弃 SDK 的 `"queued"\|"handled"` disposition，调用者无法当场知道是否生效 | 缺口 | 中 | E1a2 |
| 3 | `send()` 排队 + 当前轮 abort → 消息推迟到下一次 prompt，且**那次 prompt 返回这条旧消息的答复** | 静默失败 | 高 | E2-2 / S3 |
| 4 | 排队消息「还有几条没跑」在 `host` / `agent` 上**没有任何可观察量**（只能读 `session.pendingMessageCount`） | 缺口 | 高 | E2-5 / E2-6 |
| 5 | 空闲 steer/followUp 后不再 prompt → 消息永久驻留，零信号 | 静默失败 | 中 | E2-5 / E2-6 / S1 |
| 6 | 正常路径下 `waitForIdle()` 确实等到排队消息跑完（正面） | 能力 | — | E2-1 / E2-8 |
| 7 | 审批门拦截理由原样进上下文、`isError=true`；真模型 3/3 如实转述、0/3 编造（正面） | 能力 | — | E3-1 / E3b |
| 8 | 门内抛错 = 无条件拦截 + 异常文本进模型上下文，设计者侧零信号 | 静默失败 | 高 | E3-3 / S4 |
| 9 | 门的判定是真值判断：`{block:false}` / `{}` 都会被拦（只有 `false`/`undefined` 放行） | 极限 | 中 | E3-6/E3-7/E3-8 |
| 10 | 拦截与「工具自身出错」在库层面完全同形，无 gate 专属事件/计数 | 缺口 | 中 | E3-1/E3-3 |
| 11 | reason 不写时退化成英文 `Tool execution was blocked` | 缺口 | 低 | E3-2 |
| 12 | `onToolCall` 键名写错（`onToolcall` / `OnToolCall`）→ 门完全不生效，agent 裸奔，零信号 | 静默失败 | **高** | E6-I2/I3 / S5 |
| 13 | 真模型主动 read 技能正文：9/9（6 次清晰+3 次模糊描述），「配了不用」未复现 | 能力 | — | E4b / E4c |
| 14 | `skills` **不是白名单**：`agentDir/skills` 下未声明的技能照样进 system prompt | 静默失败 | 中 | E4R-2 / E6-F1 / S9 |
| 15 | `skills: "名字"`（字符串）→ 逐字符解析，报错 `找不到技能「m」` | 静默失败（误导） | 低 | E6-F4 / S10 |
| 16 | `tools` 一个字符写错（`['Read']` / `'read'` 字符串）→ 工具集塌成 `[]`，且技能段一并消失 | 静默失败 | **高** | E6-C2/C3/C4 / S7 |
| 17 | `excludeTools` 空格/大小写写错 → 完全无效 | 静默失败 | 中 | E6-C6/C7 / S8 |
| 18 | `thinking` 非枚举值（`'High'`/`'none'`/`'低'`/`'ultra'`）→ 静默回落 `off` | 静默失败 | 中 | E6-H2..H5 / S6 |
| 19 | 未知/拼错键名（`descriptoin` `tool` `excludeTool` `systemPrompt` `Roles`）全部静默忽略 | 静默失败 | 中 | E6-B1..B6 / S11 |
| 20 | 两个同名 `customTool` → 后者静默覆盖前者 | 静默失败 | 低 | E6-D1 / S16 |
| 21 | `customTool` 可冒充内置 `read` 并真的顶掉它 | 极限 | 中 | E6-D2（确认 06-failures C1.7） |
| 22 | `cwd` 指向文件：构造与 prompt 都成功；用 bash 时报 `bash.exe ENOENT`（误导性根因） | 静默失败 | 中 | E6-J1 / S15 |
| 23 | 预算耗尽后 `send()` 返回 `{delivered:"ran"}` 实际没跑；信号只在 `error` 事件 | 静默失败 | 高 | E5-1 / S12（确认 J1/C2.6） |
| 24 | `spawn_agent` 被护栏拒绝时工具结果 `isError:false`，宿主零事件 | 静默失败 | 中 | E5-2/E5-3 / S12 |
| 25 | 护栏拒绝文案清楚；真模型父 agent 2/2 如实转达、不编造（正面） | 能力 | — | E5b |
| 26 | abort 那轮 usage 记 0（`agent` 与 `host` 同），但请求真实计费 | 静默失败 | 中 | E7-2/E7-3 / S13 |
| 27 | 被 abort 的轮次留下 user 消息永久占上下文（4 次后 `msgs=6`） | 静默失败 | 中 | E7-4 / S14 |
| 28 | 半截 assistant 文本作为 `RunResult.text` 返回，但不进线上请求（不污染下一轮） | 极限 | 低 | E7-3 |
| 29 | `abort()` 对空闲 agent 也把 status 置为 `"aborted"` | 缺口 | 低 | E7-1 |
| 30 | 连续 4 次 abort 无状态累积、无句柄泄漏，之后照常工作（正面） | 能力 | — | E7-4 |
| 31 | `dispose()` 之后 `steer/prompt/send/abort` 抛错，`waitForIdle()` 静默返回 | 极限 | 低 | E1e/E1f / S17 |
| 32 | `dispose()` 不清理待投递队列，`pendingMessageCount` 永远停在 N | 缺口 | 低 | E2-10 |
| 33 | 真模型在审批门/护栏拒绝下均不编造（E3b 3/3、E5b 2/2） | 能力 | — | E3b / E5b |

---

## 未做完 / 跑不通

- **未测：内容拒答的静默性**（既有报告 C2.9）。本轮真模型任务都不敏感，没触发拒答，无新增样本。
- **未测：真实 provider 侧的 `steer` 时序**。E1 全部用假 provider：假 provider 一次吐完，看不到「真流式下 steer 打在哪个 turn 边界」。`[[slowtext]]` 只用来测 abort。
- **未测：`onToolCall` 与 skip/permission 类语义**。pi 的 `tool_call` 钩子可能还支持 skip/改写参数，本轮只测了 `block`。
- **未测：`spawn_agent` 在预算耗尽时的真模型反应**（用 `maxAgents` 代替）。原因：预算耗尽的时刻需要竞态构造（先烧预算再让父调用工具），真模型下无法精确控制时序；`maxAgents=1` 是确定性的等价构造。**两者错误通道形状相同**（都是 `isError:false` 的工具结果文本），故用后者代表。
- **样本量偏小**：E3b 3 次、E4c 3 次、E5b 2 次。真模型只看 `opencode-go/deepseek-v4.1-flash` 一个（用户指定），结论不能外推到其他模型。
- **E7 的「半截消息」只测了文本流**，没测「工具调用参数流到一半被 abort」的形态（假 provider 的工具调用是一次性发的）。
- **`02-topology` / 真模型按 id 寻址 / 花名册选人**（基线盲区 3）本轮未碰 —— 与本任务无交集。

## 数据

- `audit/21-runtime-silent/data.json` → 键 `e1`(15) `e2`(11) `e3`(9) `e3b`(3 次真模型) `e4recon`(5) `e4b`(6 次真模型) `e4c`(3 次真模型) `e5`(4) `e5b`(2 次真模型) `e6`(48) `e7`(5)。
- 脚手架：`_srv.ts`（记录**完整 request messages** 的假 provider + 逐步重建的 marker 子集）、`_data.ts`（data.json 累加器）、`_live.ts`（真模型花费累计）。
- 真模型花费：**$0.004273 / 54533 tokens / 14 次调用**；假 provider 部分 **$0**。
