# 第 3 部分：投递、并发与时序 —— 第二轮能力与极限审计

审计目标：攻既有报告 §3「投递与并发」的已证实盲区 —— **同一个 agent 在被跑期间又被投递**。
基线采信 README 第二部分（14 条已确认结论 + 4 个盲区），不重复发现。

- 脚本：`e1-k-boundary.ts` / `e2-state-method-matrix.ts` / `e3-concurrency.ts` / `e4-live.ts` / `e4d-live-spawn.ts` / `e5-discipline.ts`
- 原始数据：`data.json`（= `data-e1..e5.json` 合并）+ `data-e4d.json`
- 真模型总花费：**158 298 token / \$0.00296**（+ E4 冒烟 3 326 tok / \$0.000029，合计 **\$0.00299**）

---

## 结论速览

1. **`RunResult` 串台是确定性的，不是偶发**：`spawn_agent` 等待期间给子分身投一条 → 父拿到的是**后一条**的答案，**20/20**；不给子投的对照 **0/20**（E1a）。真模型 **2/2** 复现，对照 **2/2** 正确（E4d）。
2. **串台时「本轮用量」也错**：单独一轮 `RunResult.usage=18`，被投一条后主干那次的 `RunResult.usage=36`（并入了别人的一轮）；`agent.usage`/`host.usage` 累计值仍正确（E5a、E1c、E3c）。基线 K「用量是对的」需修正为**累计对、per-call 错**。
3. **`send()` 在 settle 窗口里返回 `{delivered:"queued"}`，但队列没人排空** —— 那条消息不跑，直到下一次 `prompt()` 才醒；醒来时**顶替掉那次 prompt 的返回文本**。空闲 `steer`/`followUp` 完全同病（E1b、E1d、E2）。
4. **`RunResult` 只在「同一 agent 上严格串行」时才等于本次运行**。消费者侧互斥链 `prompt`（或 `send`+`waitForIdle`）→ 8/8 正确；只 `send` 不等 → 0/8（E5b）。互斥链拦不住 `spawn_agent` 内部的 `child.prompt()`，所以委派层纪律是「**子分身忙时绝不向它投递**」：忙时投 0/6 保住原答案，spawn 返回后投 6/6（E5c）。
5. **取结果的唯一无冲突办法是自读 `session.messages`**（按「自己的 user 消息之后、下一个 user 之前」聚合 assistant 文本）：双投递者并发下 8/8 正确（E5b M4）；串台丢掉的原子任务答案仍在 `session.messages` 里，可手工恢复（E1g）。
6. **并发本身没问题**：假 provider 1→32 分身墙钟 237→183ms（E3a）；真模型 cap=2 下 8/8、16/16 成功、**零 429**（E4a）；单 agent 12 轮接力 12/12 正确、无退化（E4b）。**问题全在「同一个 agent 被重叠投递」这一个面上。**

---

## 实测证据

### E1a `spawn_agent` 等待期间投递 → 父拿到错答案（N=20，含对照）

- **问题**：K 的串台在真实委派原语上发生率多少？
- **方法**：`node audit/20-delivery/e1-k-boundary.ts`。`host.list` 抓 `member==="w"` 的子分身，`spawn_agent` 的 task 带 `[[sleep:400]]` 制造忙窗口，200ms 时 `child.send("追加第 i 条")`；对照组完全不投。
- **原始输出**：
  ```
  [投递] #1 返回={"delivered":"queued"} spawn文本含子任务=false 含追加=true | "已让成员「w」处理，它的分身 id 是 a2。\n\necho:追加第1条"
  ...
  [投递] #20 返回={"delivered":"queued"} spawn文本含子任务=false 含追加=true | "已让成员「w」处理，它的分身 id 是 a40。\n\necho:追加第20条"
  [对照] 不投递的 20 次里 spawn 文本不含子任务原文的次数 = 0
  → 投递组串台率 = 20/20；对照组 = 0/20
  ```
  子分身侧：`childUsage=36`（两轮之和，累计正确），`seq=["[[sleep:400]] 子任务原文1","追加第1条"]`（两条都真的跑了）。
- **读出的现象**：投递组每一次，`spawn_agent` 返回给父的 `run.text` 都是**后投那条的答案**，原子任务的答案被整段替换。无任何信号、无 error 事件。两条消息都执行了，只是归属搞反。
- **结论**：**不能**。串台是确定性的（20/20），只有「不给子分身投递」才能避免。这是本轮最重的负面结论。

### E1b settle 窗口注入 —— 四种方法的实际归宿（两侧都打印）

- **方法**：`session.subscribe` 捕获 `agent_settled`，在回调里发第二条；外层 `prompt("外层第一轮")` 与窗口内那条**两侧都打印**。
- **原始输出**：
  ```
  prompt    外层=["echo:窗口内消息"] tok=18 | 窗口内={"ret":"echo:外层第一轮"} | 窗口内实际跑了=true | agent.usage=36 | 请求=2
  send      外层=["echo:外层第一轮"] tok=18 | 窗口内={"ret":"queued"} | 窗口内实际跑了=false | 请求=1
            └ 队列里还留着 1 条；下一次 prompt("之后的无关 prompt") 返回="echo:窗口内消息"
              → 那句无关 prompt **被窗口内消息顶替（返回了它的答案）**；窗口内那条此时跑了=true
  steer     外层=["echo:外层第一轮"] tok=18 | 窗口内={"ret":"(void)"} | 窗口内实际跑了=false | 请求=1
            └ 同上（顶替=true）
  followUp  外层=["echo:外层第一轮"] tok=18 | 窗口内={"ret":"(void)"} | 窗口内实际跑了=false | 请求=1
            └ 同上（顶替=true）
  ```
- **读出的现象**：settle 窗口里 `running` 仍为 1（外层 `finally` 还没跑）。所以 `send` 走 followUp 入队，**返回 queued 却没有排空者**；`prompt` 被 SDK 延后执行，两边结果**互换**。
- **结论**：settle 窗口是第二类串台面；且 `send`/`steer`/`followUp` 在这里**静默停放**，直到下一次 prompt 才醒并且偷走它的返回。

### E1c 忙时投 1/2/5 条（send / steer / followUp）

- **原始输出**：
  ```
  send     k=1: 投递返回=["queued"] 主干返回="echo:追加1" 追加实际跑了=1/1 请求=2 agent.usage=36
  send     k=5: 投递返回=["queued",×5] 主干返回="echo:追加5" 追加实际跑了=5/5 请求=6 agent.usage=108
  steer    k=5: 投递返回=["(void)",×5] 主干返回="echo:追加5" 追加实际跑了=5/5 请求=6 agent.usage=108
  followUp k=5: 投递返回=["(void)",×5] 主干返回="echo:追加5" 追加实际跑了=5/5 请求=6 agent.usage=108
  ```
- **读出的现象**：忙时三种方法都**不丢、不合并**，各跑一轮、FIFO；但**主干那次 `prompt()` 返回的永远是最后一条被投递消息的答案**，且它的 `RunResult.usage` 变成了全部轮次之和。
- **结论**：投递**送达**能力 OK；**取结果**能力在重叠下错。三条路径（send/steer/followUp）在 busy 状态下行为等价（都进同一个队列，只是 steering 先于 follow-up 投递）。

### E1d 空闲 steer / followUp 的真实归宿

- **原始输出**：
  ```
  steer:    返回="(void)" 600ms 内单独跑了 0 次 pending=1 | 之后 prompt 返回="echo:空闲投递的消息"
            空闲那条最终跑了=true | 请求序列=["空闲投递的消息"] | agent.usage=18
  followUp: 返回="(void)" 600ms 内单独跑了 0 次 pending=1 | 之后 prompt 返回="echo:空闲投递的消息"
            空闲那条最终跑了=true | 请求序列=["后续的 prompt","空闲投递的消息"] | agent.usage=36
  ```
- **读出的现象**：空闲 steer/followUp **不会被唤醒**（600ms 内零请求），但**也不是永久丢弃** —— 下一次 `prompt()` 到来时才被投递；steer 与那次 prompt 合并在同一个请求里（`lastUser` 是停放的那条），followUp 在那次 prompt 之后追加一轮。两种情况下，那次 prompt **自己的文本都没出现在返回值里**。
- **结论**：基线盲区 2 的「空闲 steer 丢弃、followUp 永不被唤醒」应修正为「**静默停放 + 下次 prompt 被唤醒 + 顶替那次 prompt 的返回**」。这不是丢失，是**归属错位**。

### E1e 四种「取结果」写法的对错（同一场景，配对）

- **原始输出**：
  ```
  D1 裸 prompt 并发: outer="echo:B" 正确=false | inner="echo:A" 正确=false
  D2 消费者侧互斥链: outer="echo:A" 正确=true  | inner="echo:B" 正确=true
  D3 send+waitForIdle+lastResult（单投递者）: lastResult="echo:X" 正确=true
  D4 send+waitForIdle，两名投递者: 第一个投递者读到的 lastResult="echo:Y" 等于自己的 X=false
  D5 自读 session.messages 切片（双投递者）: 自己那条之后的 assistant 文本=["echo:X"] 正确=true
  ```
- **结论**：`send+waitForIdle+lastResult`（既有报告 B5 推荐写法）**只在单个投递者时安全**；D4 一出现第二个投递者就错。

### E1f 3 个调用者同时投给同一个忙 agent（「专家复用」的真实形态）

- **原始输出**：
  ```
  甲: send→{"delivered":"queued"} 读到的 lastResult="echo:丙的消息"
  乙: send→{"delivered":"queued"} 读到的 lastResult="echo:丙的消息"
  丙: send→{"delivered":"queued"} 读到的 lastResult="echo:丙的消息"
  ```
- **结论**：三个调用者**全部**读到最后一个的答案。2 个投递者时 1/2 错，3 个时 2/3 错 —— 错的是「先投的那几个」。

### E1g 串台后原答案还能不能找回

- **原始输出**：
  ```
  spawn_agent 返回给父的文本 = "已让成员「w」处理，它的分身 id 是 a103。\n\necho:追加"
  子分身 session.messages 里能看到的：["system:","user:[[sleep:400]] 子任务原文",
    "assistant:echo:[[sleep:400]] 子任务原文","user:追加","assistant:echo:追加"]
  → 子任务答案 **仍在 session.messages 里**（可手工恢复）
  ```
- **结论**：数据没丢，只是归属 API 丢了。兜底路径存在（E5b M4 验证了它的正确性）。

### E2 状态 × 方法语义表（5 状态 × 5 方法 = 25 格，每格实测）

脚本 `e2-state-method-matrix.ts`。`send-interrupt` = `send({mode:"interrupt"})`；`followUp` 库**没有**这个公开方法（只走 `session` 逃生口），列出来是为了把语义钉全。

| 方法 | idle | running | settle 窗口 | aborted | disposed |
|---|---|---|---|---|---|
| `prompt` | 跑，返回 `RunResult`，`usage` 更新 | **抛** `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')`，**零事件** | 被 SDK 延后执行；**与窗口内那条互换结果**，`agent.usage` 仍正确 | 正常跑，返回 `RunResult`，status 回 `idle`（aborted 非终态） | **抛** `agent axx 已 dispose（disposed），不能再操作` |
| `send` | 返回 `{delivered:"ran"}`；**不等跑完**（同步可见 `status=running`、`isStreaming=false`）；立刻读 `lastResult` 是陈旧值 | 返回 `{delivered:"queued"}`，同轮 `session.prompt()` 内消化，各跑一轮 | 返回 `{delivered:"queued"}` 但**没人排空**；下次 prompt 才跑，并顶替它 | 返回 `{"ran"}`，正常跑 | **抛**（同上） |
| `send{mode:"interrupt"}` | 同 `send`（空闲无 interrupt 语义） | 返回 queued，效果与 `send` 相同（均是下一轮前改变方向，非硬中断） | 同 `send` | 同 `send` | **抛** |
| `steer` | **静默入队**：`pending=1`，600ms 内 0 请求；下次 prompt 被唤醒并**顶替**其返回 | 入队（返回 `undefined`），同轮消化并各跑一轮 | 静默入队；下次 prompt 才醒并顶替 | 静默入队（`status` 停在 `aborted`），下次 prompt 才醒 | **抛** |
| `followUp`（`session` 逃生口） | 静默入队；下次 prompt 被唤醒，排在那次 prompt **之后**一轮，其返回值仍顶替 | 入队，返回 `"queued"`，同轮消化 | 静默入队；下次 prompt 才醒并顶替 | 静默入队 | **不抛**，返回 `"queued"`，静默入队（逃生口绕过库的 `assertAlive`） |

要点：**「抛错」只覆盖 disposed 与忙时 `prompt`；其余 15 格全是「返回成功字样但语义不是调用者以为的那样」**。

### E3a 并发吞吐曲线（假 provider，各跑 `[[sleep:100]]`，对照串行预期）

```
N= 1 建 12ms 跑 237ms（串行应为 100ms）总 249ms 每个 237.1ms
N= 4 建  8ms 跑 122ms（串行应为 400ms）总 130ms 每个  30.5ms
N= 8 建 20ms 跑 154ms（串行应为 800ms）总 174ms 每个  19.3ms
N=16 建 30ms 跑 145ms（串行应为 1600ms）总 174ms 每个 9.0ms
N=32 建 49ms 跑 183ms（串行应为 3200ms）总 231ms 每个 5.7ms
```
- **结论**：真并发、**库内零闸门**（N=32/16 的墙钟几乎不涨）。N=1 的 237ms 是首次模型/运行时惰性初始化开销，不代表串行。

### E3b 同一条 assistant 消息里兄弟工具调用的并发度

```
executionMode=default    k=1 → 355ms（串行应 300ms）  k=3 → 342ms（串行应 900ms）
executionMode=parallel   k=1 → 335ms                  k=3 → 328ms
executionMode=sequential k=1 → 331ms                  k=3 → 935ms
```
- **结论**：默认 `executionMode` 是 **parallel**（3 个兄弟工具 342ms ≈ 1 个）；`executionMode:"sequential"` 才串行（935ms）。既有报告 3.2b 的 `spawn_agent` 并发结论成立，并补上：这是**可配置的 per-tool 开关**。

### E3c 同一个 agent 排队 10 条（配对：10 个独立 agent）

```
投递返回：["queued"×10]
主干 prompt() 返回："echo:积压10" tok=198
实际请求数=11（期望 11）  顺序=["[[sleep:300]] 主干","积压1".."积压10"]
积压顺序是否 FIFO：是
lastResult="echo:积压10"  agent.usage=198（11×18=198，累计正确）
round_completed 播报 1 次：[198]
对照（10 个独立 agent 各一条）：请求数=10，round_completed=10，各 agent.usage=[18×10]
```
- **结论**：积压不丢、FIFO、`agent.usage` 累计正确；但 **(a)** 主干调用者的 `RunResult.text` 与 `usage` 都被最后一条顶替/并入（198≠18）；**(b)** 11 次模型生成只播报 **1 次** `round_completed`（`tok=198`）—— 按轮计数与按轮归因在积压下少算 10/11。对照的 10 个独立 agent 则是 10 次播报、各 18。

### E4a 真模型并发（cap=2，`opencode-go/deepseek-v4.1-flash`）

```
N=8 （cap=2）：成功 8/8  错误 0  疑似 429 = 0；墙钟 11708ms；延迟 min/med/max=1712/2277/4414ms；tokens=26989
N=16（cap=2）：成功 16/16 错误 0  疑似 429 = 0；墙钟 14464ms；延迟 min/med/max=1340/1697/2771ms；tokens=53219
逐个：全部 ok
```
- **结论**：cap=2 下 16 路完全稳定、**无 429**（本轮的 429 数为 0，没有任何错误样本需要标注「可能由并发争用引起」）。局限：**cap 是本轮人为设的上限，不是 provider 的实测上限** —— 不测更高并发就不知道限流点在哪（本轮任务书要求 ≤2）。

### E4b 单 agent 连续 12 轮接力（多轮传送可靠性）

```
第 1轮 期望=2  得到="2"  OK 1765ms ctx累计=3339
第 6轮 期望=7  得到="7"  OK 1501ms ctx累计=20571
第12轮 期望=13 得到="13" OK 2444ms ctx累计=42330
12 轮里格式/数值正确 = 12/12
```
- **结论**：12 轮无退化、**零串台**（因为严格串行 `await prompt`）。这也反证：**多轮投递本身没问题，问题只在重叠**。上下文从 3.3k 线性涨到 42.3k。

### E4c 真模型 settle 窗口重叠（配对：裸并发 vs 互斥链，各 2 次）

```
naive 第1次：外层="B"(正确=false)  窗口内="A"(正确=false)
naive 第2次：外层="B"(正确=false)  窗口内="A"(正确=false)
mutex 第1次：外层="A"(正确=true)   窗口内="B"(正确=true)
mutex 第2次：外层="A"(正确=true)   窗口内="B"(正确=true)
```
- **结论**：真模型下串台**一样是确定性互换**（不是假 provider 的伪影）；互斥链在真模型下同样修好。

### E4d 真模型下 `spawn_agent` 串台（配对：投 / 不投，各 2 次）

任务：让子分身「逐行写出 1..120」；投递组等子分身 `isStreaming` 后投「日本货币是什么」。

```
【投递组】第1次 等子分身忙等了 50ms 投递返回={"delivered":"queued"}
   spawn_agent 返回给父的 = "已让成员「w」处理，它的分身 id 是 a2。\n\n日元"
   含「日元」(=后投那题答案)=true   含数字接力(=原子任务)=false
【投递组】第2次 …同（日元）
【对照组】第1次 … 开头="…\n\n1\n2\n3…" 结尾="…119\n120\n完"  含「日元」=false 含数字接力=true
【对照组】第2次 …同上
```
- **结论**：真模型 **2/2** 复现，且原任务的 120 行输出**整段消失**在 `spawn_agent` 的返回里。委派原语的失败模式在生产里就是「父以为专家答了 A，其实拿到的是 B」。

### E5a 串台时 per-call 用量是否错（配对）

```
对照组（无并发）：RunResult.usage=18
投递组：主干 RunResult.usage=36（自己只花 18）  text="echo:追加"  agent.usage=36（累计正确）
```
- **结论**：`RunResult.usage` **错**（把别人的一轮并进来）；`agent.usage` / `host.usage` 累计**对**。基线 K「用量是对的」应精确化为：**三方累计对、per-call 错、且三方累计同步正确所以对账查不出 per-call 错**。

### E5b 四种消费者侧纪律（各 8 次 × 2 种重叠形态）

```
M1-prompt            concurrent 8/8   settle 8/8
M2-send              concurrent 0/8   settle 0/8
M3-send+waitForIdle  concurrent 8/8   settle 8/8
M4-send+自读messages  concurrent 8/8   settle 0/8（乙那条被静默停放、从未跑、故找不到自己的 user 消息）
```
- **结论**：可行纪律有 3 条：`prompt`（链内）、`send`+`waitForIdle`（链内）、自读 `session.messages`（不需要链）。**只 `send` 不等 = 0/8**。M4 在 settle 场景的 0/8 不是取错，而是**那句消息根本没跑**（诚实失败）。

### E5c 委派层纪律（各 6 次）

```
busy        ：spawn_agent 返回的文本仍含原子任务 = 0/6   样例="…\n\necho:追加"
after-spawn ：spawn_agent 返回的文本仍含原子任务 = 6/6   样例="…\n\necho:[[sleep:400]] 子任务原文"
when-idle   ：spawn_agent 返回的文本仍含原子任务 = 6/6   样例="…\n\necho:[[sleep:400]] 子任务原文"
```
- **结论**：**不许在子分身忙时投递**，是唯一能保住 `spawn_agent` 结果的纪律。互斥链救不了它 —— `spawn_agent` 内部的 `child.prompt(task)` 在工具实现里，消费者拦不到。

---

## 安全的投递纪律（设计者该这么写）

> 前提事实：`RunResult`（`prompt()` 返回值 / `lastResult` / `round_completed.result`）的真实语义是
> **「调用 `collectRun()` 那一刻，共享消息池里所有还没被任何人计过的 assistant 消息中最后一条的文本 + 它们的用量之和」**，
> **不跟调用绑定**。所以「本次运行」这个语义只在**该 agent 上严格串行**时成立。

### 规则 1（硬规则）—— 委派期间绝不向被委派者投递

`spawn_agent` 的 `run.text` 是**唯一**能拿回子任务答案的通道，它没有别的副产品（`details` 只有 agentId，没有 usage）。一旦子分身忙时被投递，这个通道就废了，而且**不报错**。

```ts
// 反例（E1a：20/20 报废）
const spawnP = spawn_agent({ member, task });
const child = host.list().find(a => a.member === member);
await child.send("再补充一句");        // ← 父拿到的会是这句的答案
```

要做「专家复用」（多次追问同一个分身），只有两条路：
- **在 `spawn_agent` 返回之后**再投（E5c 6/6 正确），即：委派 = 一问一答，复用 = 多轮独立 Q&A；
- 或者不经过 `spawn_agent`，自己在编排层 `createAgent` 建一个长期分身，并给它套规则 2 的互斥链。

### 规则 2 —— 同一 agent 上，任何时刻只允许一次飞行中的投递

给每个 agent 配一条 promise 链，**链内必须等到这一轮真正结束**：

```ts
// 每个 agent 一份链（这里用 WeakMap 保证是「每个 agent」而不是全局一条）
const chains = new WeakMap<ControlledAgent, Promise<unknown>>();
const ask = (a: ControlledAgent, text: string): Promise<string> => {
  const prev = chains.get(a) ?? Promise.resolve();
  const p = prev.then(async () => {
    const r = await a.prompt(text);      // ← prompt 链：8/8 正确（E5b M1、E4c mutex 2/2）
    return r.text;
  });
  chains.set(a, p.catch(() => {}));      // 失败也要放链，否则后续全被卡住
  return p;
};
```

用 `send` 的等价写法（**必须**有 `waitForIdle`）：

```ts
const ask = (a: ControlledAgent, text: string): Promise<string> => {
  const prev = chains.get(a) ?? Promise.resolve();
  const p = prev.then(async () => {
    await a.send(text);
    await a.waitForIdle();                 // ← 必须；8/8 正确（E5b M3）
    return a.lastResult!.text;
  });
  chains.set(a, p.catch(() => {}));
  return p;
};
```

> `ask` 里的链条声明见上一段，此处只展开链内那一步。

**`await a.send(text)` 之后直接读 `lastResult` = 0/8（E5b M2）** —— `send` 返回 `{delivered:"ran"}` 只表示「已开始跑」。

### 规则 3 —— 别用 `steer` / `followUp` 做「投递」

- `followUp` 库根本没暴露；走 `session` 逃生口在 `disposed` 后还会静默入队（E2）。
- **目标空闲时**调 `steer`/`followUp`：消息静默停放，下次 `prompt()` 才被唤醒，并**顶替那次 prompt 的返回**（E1d、E2）。这比串台更难查 —— 因为「下一次 prompt」可能发生在几秒后、另一个业务分支里。
- 已误投的补救：`(agent.session as any).clearQueue()` 清掉再继续。

### 规则 4 —— 拿不准就用「自读 messages」兜底

唯一不受冲突影响的取结果方式（E5b M4 并发场景 8/8）：

```ts
const flat = (c: any) => typeof c === "string" ? c : (c ?? []).map((x: any) => x.text ?? "").join("");
async function readOwn(a: ControlledAgent, mine: string): Promise<string> {
  await a.send(mine);
  await a.waitForIdle();
  const msgs = a.session.messages as any[];
  const i = msgs.findIndex(m => m.role === "user" && flat(m.content) === mine);
  if (i < 0) return "";                    // 没找到 = 这条根本没跑（不是猜，是事实）
  const out: string[] = [];
  for (let k = i + 1; k < msgs.length; k++) {
    if (msgs[k].role === "user") break;
    if (msgs[k].role === "assistant") out.push(flat(msgs[k].content));
  }
  return out.join("");
}
```
`i < 0` 也是信号：说明这条消息被静默停放了（规则 3 的场景），程序化地暴露了本来无声的失败。

### 规则 5 —— 用量与轮次计数不要信 per-call

- per-call `RunResult.usage` 在重叠下虚高（18→36）；`agent.usage` / `host.usage` 累计正确，**成本上报用累计值**（E5a、E1c）。
- `round_completed` 在队列积压下**少算**（11 次生成 → 1 次播报，E3c）；要按轮记账就自己订阅 `session` 原始事件或按 `session.messages` 数 assistant 消息。

### 一句话版本

> **一个 agent = 一条串行队列。所有投递都从这一条队列走，并等到这一轮结束再走下一轮；委派期间（`spawn_agent` 在飞）对该子分身一律禁投。**

---

## 清单

| # | 现象 | 类别 | 严重度 | 证据 |
|---|---|---|---|---|
| 1 | `spawn_agent` 等待期间子分身被投递 → 父拿到后一条的答案，20/20，对称对照 0/20 | **静默失败** | 高 | E1a、E4d |
| 2 | 真模型下同样 2/2 复现，原任务答案整段消失 | **静默失败** | 高 | E4d |
| 3 | 串台时 `RunResult.usage` 被并入他人一轮（18→36）；累计值仍对 | **静默失败** | 中 | E5a、E1c |
| 4 | `prompt()` 与 settle 窗口内 `prompt()` 结果互换（假 provider 与真模型均确定性） | **静默失败** | 高 | E1b、E4c |
| 5 | settle 窗口 `send` 返回 `{delivered:"queued"}` 但无人排空，消息不跑 | **静默失败** | 高 | E1b、E2 |
| 6 | 空闲 `steer`/`followUp` 静默停放，下次 prompt 才醒并顶替其返回 | **静默失败** | 高 | E1d、E2 |
| 7 | 3 个调用者同时投同一 agent，全部读到最后一个的答案 | **静默失败** | 高 | E1f |
| 8 | 队列积压 11 条消息只播报 1 次 `round_completed`（tok=198），按轮计数少算 10/11 | **静默失败** | 中 | E3c（复核基线 3.2a） |
| 9 | 忙时 `prompt()` 抛 SDK 原始错且零事件 | **静默失败** | 中 | E1、E2 |
| 10 | `session.followUp` 在 `disposed` 后不抛错、静默入队（逃生口绕过 `assertAlive`） | 缺口 | 低 | E2 |
| 11 | `prompt`+`send` 混用无排队语义；`send` 空闲返回 `ran` 后立刻读 `lastResult` 是陈旧值 | 极限 | 中 | E2、E5b |
| 12 | 1→32 分身真并发且库内零闸门（N=16 与 N=32 墙钟 174→231ms） | 能力 | — | E3a |
| 13 | 同一 assistant 消息内兄弟工具调用默认并发（3 个 342ms）；`executionMode:"sequential"` 可强制串行 | 能力 | — | E3b |
| 14 | 同 agent 积压 10 条不丢、FIFO、累计用量正确 | 能力 | — | E3c |
| 15 | 真模型 cap=2 下 8/8、16/16 成功、零 429；12 轮接力 12/12 无退化 | 能力 | — | E4a、E4b |
| 16 | `session.messages` 自读可无冲突取回自己的结果（并发场景 8/8） | 能力 | — | E5b M4、E1g |
| 17 | 消费者侧互斥链（prompt 或 send+waitForIdle）在两种重叠形态下均 8/8 正确 | 能力 | — | E5b M1/M3、E4c |
| 18 | 委派层纪律「子分身忙时不投」可完全保住 spawn 结果（0/6 vs 6/6） | 能力 | — | E5c |
| 19 | 库不暴露 `followUp`，`steer` 无 returned disposition（void）；`send` 只有 `ran`/`queued` 两态，无法区分「已跑完」 | 缺口 | 中 | E2 |
| 20 | provider 真实限流点未测（本轮人为 cap=2），429 阈值仍未知 | 缺口（未覆盖） | 低 | E4a 局限说明 |

---

## 未做完 / 跑不通

- **provider 真实限流点**：本轮按任务书把真模型并发压在 ≤2，因此 429 阈值、退避行为、错误文本形状**未测**。8/16 路在 cap=2 下零错误，不能外推为「无限流」（既有报告 R9a 的 16 路无 429 仍未被证伪，但也没被加强）。
- **跨层重叠（父→子→孙同时被投递）**只测了单层；多层链路下的归属错位是否会叠乘，未测。
- **`abort` 与投递的竞态**（在 `abort()` 飞行中投递）未单独立项：`abort()` 会 `await waitForIdle`，投递落在其前后语义不同，本轮只覆盖了 abort 完成之后的状态（E2 aborted 行）。
- **真模型下 `steer` 的「改变方向」实效**未测（假 provider 只能证明它入队并各跑一轮）。
