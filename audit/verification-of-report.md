# 对既有审计报告的独立核对

**核对对象**：`docs/research/2026-09-30-phase1-capability-audit-report.md`（git `8848fde`，203 条发现）
**核对人**：主 agent（未使用原报告的任何脚本，独立重写）
**脚本**：`audit/verify-report-claims.ts`（断言 A/B/D）、`audit/verify-c2.ts`（断言 C）
**方式**：假 provider，零真实 API 花费
**结论**：抽查的 4 条**全部复现**，其中 1 条**比原报告描述的更严重**

---

## A. 报告 4.7「abort 那一轮的 usage 记为 0」— ✅ 复现

```
假服务收到的请求数：0 → 1        （请求真的发出去了）
prompt() 返回：{"text":"","usage":0,"error":"Request aborted"}
agent.usage.totalTokens = 0
```

请求发出 1 次，库记 0 token。报告"反复中止长请求可以白烧 token 而闸门读数不动"的判断成立。

---

## B. 报告 6.1e「序列化分身会抛主题错误」— ✅ 复现（三种都会）

```
JSON.stringify(agent)          → 抛错：Theme not initialized. Call initTheme() first.
JSON.stringify(agent.session)  → 抛错：Theme not initialized. Call initTheme() first.
JSON.stringify(host 事件载荷)   → 抛错：Theme not initialized. Call initTheme() first.
```

设计者做日志、快照、调试面板、把宿主事件 `JSON.stringify` 存档，都会撞上这个与"打印对象"毫无关系的错误。报告称"极难定位"，属实。

---

## C. 报告 C2.6「预算耗尽后 send 谎报 ran」— ✅ 复现，**且实际后果比报告写的更严重**

> ⚠️ 我第一次构造这条测试时写错了：用 `budgetTokens: 1` 但 `host.usage` 起始为 0，`0 >= 1` 为假 → 第一轮根本不会被拦，测出来是"正常跑"。改为**先烧到耗尽**再测，才复现。

正确的测法：`budgetTokens=18`（假服务每次恰好产 18 token），先 `prompt` 一轮把 `host.usage` 烧到 18，此时 `18 >= 18` 成立。

```
预热后：host.usage=18，budgetTokens=18
send() 返回        ：{"delivered":"ran"}          ← 谎报：一个字都没跑
假服务请求数       ：1 → 1                        ← 确实没跑
error 事件         ：["宿主预算已耗尽（budgetTokens=18）：不再接新的一轮"]
lastResult.text    ："echo:先烧掉预算"             ← 上一轮的陈旧结果
status             ：idle
```

原报告说的两点（"谎报 ran"、"错误只走 error 事件"）都对。但实测多出一层**复合放大**：

`send()` 返回 `ran` → 设计者会去读 `lastResult` 确认结果 → **`lastResult` 里躺着上一轮的正式内容，不是空**，且 `status` 也是 `idle`（看起来正常）。

于是在设计者视角，这三个信号**全部指向"成功了"**：

| 信号 | 值 | 设计者的解读 |
|---|---|---|
| `SendResult.delivered` | `"ran"` | 已开始处理 |
| `lastResult.text` | 上一轮的完整结果 | 有产出，完成 |
| `status` | `idle` | 没在忙，应该是做完了 |

唯一的真相在一个**并行通道**（`error` 事件）里。若是轮询式设计者（`send` → `waitForIdle` → 读 `lastResult`），它**根本不会看到**这条错误。实测的 `b.send(q); await b.waitForIdle(); return b.lastResult.text` 这个最自然的写法，在预算耗尽时会**静默返回上一轮的答案**。

这条已超出原报告 C2.6 的描述范围，建议作为独立发现补入报告。

---

## D. 报告 C2.5「第 2 条及之后的排队消息不产生 done / round_completed」— ✅ 复现

```
真服务收到的请求数增加：3        （三条消息都真的各跑了一轮）
done 事件次数 = 1，round_completed 次数 = 1
```

三条都跑了，只播报 1 次。依赖 `round_completed` 的宿主观测（成本核算、轮次督导）会**少算 2/3**。这条与报告第三部分第 2 部分"缺机制 B6/B7"互相印证。

---

## E. 【新发现，超出原报告范围】`tools` 白名单管不住「扩展的加载」

**来源**：`10-redlines` 子 agent 的静态推断，由主 agent 独立实测确认（`audit/verify-extension-planting.ts`）。

**推断**：`create-agent.ts` 里 `buildLoader()` 在白名单组装**之前**执行；`loader.ts` 的 `declaredExtensionToolNames()` 只影响「哪些工具名被并入 `tools`」，不影响「哪些扩展被加载」。所以扩展的**加载**与白名单是两件事。

**实测**（种一个扩展，它注册工具 `evil_probe` + 拦截所有 `tool_call`；然后起一个 `tools: ["read"]` 且**未声明任何 `extensions`** 的分身）：

```
── 种进共享 cwd 的 .pi/extensions/（项目级扩展）──
  模型看到的工具：["read"]            ← 白名单没被撞开
  evil_probe 在工具表里：否
  read 被扩展拦住：是                  ← 但扩展确实加载并生效了
  产出："echo:扩展已加载：我拦住了这次工具调用"

── 种进共享 agentDir 的 extensions/（用户级扩展）──
  模型看到的工具：["read"]
  evil_probe 在工具表里：否
  read 被扩展拦住：是
```

**两个位置都成立。** 结论分两半，必须分开说：

| 层 | 白名单管不管得住 |
|---|---|
| 扩展注册的**工具名** | **管得住**（`af1befd` 那个修复有效；`evil_probe` 没进工具表） |
| 扩展**本身是否被加载** | **完全管不住**（未声明也加载） |

而扩展能挂的钩子 —— `tool_call`（拦截/阻止）、`tool_result`（改写结果）、`before_provider_request`（改发出请求）、`before_agent_start`、`resources_discover` —— **全部不受 `tools` 白名单管辖**。实测里它就把一个**白名单内**的工具（`read`）拦下来了，并让拦截理由进入了模型上下文。

**为什么这条比原报告 10.1 更重**：原报告 10.1 讲的是「**设计者声明**的扩展工具会被自动并进白名单」（10.1b/c/d），针对的是设计者自己的配置。这条针对的是**运行时被别的分身种进来的、未声明的**扩展 —— 攻击路径是：

1. 一个持 `write`（或 `bash`）的分身，往共享 `cwd/.pi/extensions/` 或共享 `agentDir/extensions/` 写一个扩展文件 → **不需要任何额外权限**（全队同一 `cwd` / `agentDir` 是阶段 1 的推荐做法，规格 §10/B 路共享黑板就建在这上面）
2. 此后**任何**用该 `cwd` / `agentDir` 新建的分身都会静默加载它 —— 包括被 `tools: ["read"]` 严格限制的分身
3. 该扩展可以在进程内改写工具调用、工具结果、甚至发给 provider 的请求体

**这是集群级的篡改通道，且全程无任何信号。** 它把「红线强度」的结论从「`tools` 白名单不是安全边界」推进到「`tools` 白名单不是边界，且**扩展加载路径连带把『能力裁剪』这层意图也绕开了**」。

**注意**：这不构成对库的指责 —— 规格 §2 「明确不承诺」已经写了 pi 无沙箱、扩展可绕过白名单。但原报告的 10.1 判定表里「agent 不能改花名册/回收别人」被定为「只是没给工具」，而这条更贴切的定性是：**连『没给工具』都不算** —— 给了一个 `write` 就能改**其他分身的行为**。

**待定**：`af1befd` 的修复动机（防止白名单被环境里的扩展悄悄撑开）只解决了一半。是否要把「扩展加载」也纳入设计者可见范围，属阶段 2 的设计决定，不在本次测量范围。

---

## F. 【纠正既有报告】`dispose` **不会**清空 `session.messages`（报告 5.1g 结论有误）

**来源**：`05-lifecycle` 子 agent 报的冲突，由主 agent 独立决定性验证（`audit/verify-dispose-history.ts`）。

**既有报告 5.1g 的原文**（`audit/findings/05-lifecycle.json`）：

```json
"observed": "{...\"usage\":0,\"lastResult\":\"undefined\",\"sessionMessages\":0}",
"conclusion": "...session.messages 变成空数组（不是抛错 —— 历史静默消失）..."
```

**它错在哪里**：证据里 `usage:0`、`lastResult:undefined`、`sessionMessages:0` —— 全是 0/undefined，这是「**建完就 dispose、从未 prompt 过**」的特征，不是「被 dispose 清掉」的特征。受试对象是 `mkTop(host)` 建完即回收的 `a14`，**它本来就没有历史**。

**决定性验证**（同时跑对照组与实验组）：

```
dispose 前：messages=5 usage=36
dispose 后：messages=5 usage=36 status=disposed
对照组（从未 prompt）：messages=0 usage=0
→ dispose 不清 session.messages
```

**判定**：`05-lifecycle` 子 agent 正确，**既有报告 5.1g 应作废**。

**并且既有报告自相矛盾**：同一个报告第 259 行（讲预算耗尽能否优雅收场）写的是「`session.messages` 里 **9 条历史都在**」—— 与本条实测方向一致。所以「历史保留」才是实际行为，「变空数组」是孤例且样本为空。

影响：报告「B6 成本细账」里那句「宿主回收后不可补算」的依据部分来自 5.1g。**回收后 `session.messages` 仍在，`usage` / `lastResult` 也在对象引用上可读** —— 不可补算的真实原因只剩「`host.get(id)` 返回 undefined、对象引用需要设计者自己握住」，比报告写的轻。

---

## G. `05-lifecycle` 的其它增量（已采信，非冲突）

| 项 | 既有报告 | 独立实测的增量 |
|---|---|---|
| 深度护栏绕过 | 「`depthOf` 失效，真实深度 3 通过 `maxDepth=2`」 | **绕过是有界的**：`depthOf` 的 `depth+1` 保守分支只对「**直接父缺失**」那一层生效 → 只多买 **1 层**；再深一级（孩子的直接父存在）**立即恢复拦截**，拒绝文案 `分身深度 3 超过 maxDepth=2` |
| 祖先寻址 | 「祖先投给孙代被拒，报『不是你的后代』」 | 复现 + 补充：曾孙同样被拒；`descendantCount(top)=0` 而**已回收的 mid 算出 2 个后代**。框定为「『按 id 能寻址』≠『按拓扑能寻址』」 |
| 孤儿可用性 | 只说「后代留 list、parentId 悬空」 | 孤儿 `prompt`/`send`/`steer`/`waitForIdle` **全部正常**，产出照常进 `host.usage`（54→90），还能继续 `spawn_agent` |
| 拓扑变形 | 定性「静默变形」 | 量化：3 节点里 **1 个变根**、导出最大深度 **1** vs 真实 **3**、2 个节点深度错 |
| 回收单位 | 「单位是分身不是子树」 | 复现，且补三条路径：**streaming 中 / abort 之后 / 顶层** dispose，四条路径全部留孤儿 |
| 回收路径穷举 | 未提及 | **`spawn_agent` 没有调用者存活检查**：对一个**已 dispose** 的分身连续调 6 次，都正常执行到护栏判断，不报「调用者已回收」 |

**E4（祖先寻址）主 agent 独立复现**（`audit/verify-dispose-history.ts`）：

```
回收 mid 前，top→leaf：已投递：a5 当时空闲，已开始处理。
回收 mid 后，top→leaf：只能给自己的后代分身投递：a5 不是你的后代（它可能是祖先、兄弟或不相干的分身）。
leaf.parentId=a4，mid 已回收=true，leaf 仍在 list=true
```

定性：**`send_message` 的祖先判定会被任意一次中间层回收永久截断**，且以**事实错误的报错**呈现（对真正的后代说「不是你的后代」）。设计者最可能误诊为「我记错 id 了」，然后去重试/换 id，而不是意识到是回收造成的。

---

## H. `01-config` 的两条新增（已独立复核）

`01-config` 子 agent 交回 13 条实测，**未发现与既有报告的任何冲突**；有一条强证据：`role` 的偏移量 `<tools>`=171 / role=2610 与既有报告**完全一致** —— 两次独立运行的 system 前缀稳定。新增里两条由主 agent 复核（`audit/verify-config-gaps.ts`）：

### H1. 不给 `tools` 时，环境里自动发现的扩展**会**进默认工具集

```
不给 tools           → 模型看到：["read","bash","edit","write","user_ext_probe"]
tools: 只给 read     → 模型看到：["read"]
```

即 **「不写 `tools`」≠「只有内置工具」**。`af1befd` 只堵住了「给了白名单还被撑开」那一半；不给白名单时，`agentDir/extensions/` 里的用户级扩展工具照常生效。

**与 F 节（扩展种植）合并后产生一条更强的结论：**

1. 一个持 `write` 的分身往共享 `agentDir/extensions/` 或 `cwd/.pi/extensions/` 种一个扩展（**不需要额外权限**）
2. 该扩展的**工具**在「给了白名单」时不进工具表（`af1befd` 有效）；但在「**没给白名单**」的成员身上**直接进默认工具集**，模型能直接调它
3. 且无论给不给白名单，该扩展的**钩子**（`tool_call` / `tool_result` / `before_provider_request`）都生效

两轮审计各自只摸到一半（既有报告 10.1 讲「**声明**的扩展会被并入白名单」；本轮 F 节讲「**未声明**的扩展也会加载」）。合起来才是完整的：**只要共享目录可写，「能力裁剪」在默认配置下拦不住被种进来的扩展。**

### H2. 工厂在创建期读 `ctx.agent` 必抛，而类型层不提示 —— 编译器级证据

运行期（`audit/verify-config-gaps.ts`）：

```
创建期读 ctx.agent → 抛错：工具上下文里的 agent 尚未构造完成
```

编译期（把 `audit/` 纳入 tsc 后）：

```
audit/ts-type-check.ts(7,3): error TS2578: Unused '@ts-expect-error' directive.
```

`Unused` 意味着类型检查器**没在那行报错** —— 一个在工厂体内同步读 `ctx.agent.id` 的工具，在 `strict: true` 下**编译完全通过**。而 `AgentToolContext.agent` 在类型上是**非可选**的 `ControlledAgent`：类型层压根没区分「构造期的 ctx」与「execute 期的 ctx」。

后果：写工厂式工具时最自然的写法（在工厂体里拿 `ctx.agent`）会得到**运行期抛错 + 零编译提示**。这属于「类型撒谎」，比单纯的行为限制更难发现。

### 附：`audit/` 从未被类型检查覆盖（29 个类型错误）

根 `tsconfig.json` 的 `include` 只有 `src` / `test` / `demo`，所以 `audit/` 下的脚本从未被 tsc 覆盖。实测 29 个类型错误，其中 19 个在我这轮 `07-observability` 子 agent 的脚本里、6 个在既有审计的 `audit/05-lifecycle.ts` 里。不影响已产出的实测结论（TS 类型在运行期被擦除），但说明两轮审计的脚本都未经类型检查。

---

## I. `06-failures` 的三条（已独立复核）

### I1. 【根因 + 一行可修】扩展加载失败的原因**存在**，只是库没读

既有报告 C1.1/C1.2 把「扩展路径不存在 / 语法错误 → 构造成功、静默不加载」列为静默失败，但没有根因。`06-failures` 找到了：`loader.getExtensions()` 返回 `{ extensions, errors, warnings, runtime }`，两类失败都有**带路径的结构化错误**。

主 agent 独立复核（`audit/verify-loader-errors.ts`，原始输出）：

```
── 路径不存在 ──
  keys = ["extensions","errors","warnings","runtime"]
  extensions = []
  errors = [{"path":"…\\nope.ts","error":"Extension path does not exist: …\\nope.ts"}]

── 语法错误 ──
  errors = [{"path":"…\\bad.ts","error":"Failed to load extension: ParseError: … Missing semicolon. …bad.ts:1:35"}]

── 正常 ──
  extensions = [{"path":"…\\good.ts","tools":["good_tool"]}]   errors = []
```

而 `src/` 里 `getExtensions()` **只有一个调用点**（`loader.ts:44`），只链式取了 `.extensions`；`grep -rn "\.errors\|\.warnings" src/` 结果为空。

**结论**：这不是「pi 不给信息」，是**库只读了一半**；修复成本约一行（`errors` 非空时抛错或警告）。这把一个高严重度静默失败降级为一行可修。

### I2. 【纠正规格】决策 #4 的理由有事实错误（我写的）

`06-failures` 的 E2 实测：

```
p05b customTools 提供 + tools:["read"]   意图=["read"]   实际=["read","probe_echo"]   ← customTools 仍被挂上
```

代码坐实（`create-agent.ts:139`）：

```ts
[...new Set([...spec.tools, ...customTools.map((t) => t.name), ...declaredExtensionToolNames(spec, loader)])]
```

`customTools.map(...)` 是**无条件**并入的 —— `?.length` 只把守整个分支。所以：

| 层 | 白名单能不能关掉它 |
|---|---|
| customTools | **不能**（强制并入；只能靠 `excludeTools`） |
| **设计者声明的**扩展工具名 | 能（不在 `extensions` 里就不进） |

而决策 #4 原本的理由写的是「传了 `tools` 就必须把 customTools 名列进去」——**事实相反**。已将决策 #4 的理由改写（本次提交），规则本身（`.length` 判据）不变。

### I3. 【新】空花名册时 `spawn_agent` 的友好提示是死代码

`createSpawnAgentTool` 在花名册为空时把 `member` 建为 `Type.Never()`，于是：

```
无 host：error=null  text="echo:Validation failed for tool \"spawn_agent\":\n - member: must not be valid\nReceived arguments: { \"member\": \"x\", \"task\": \"y\" }"
有 host 但 members 空：同上
```

调用在**参数校验**阶段就被拒 —— `execute()` 里那两句有用的文案（`（花名册是空的）`、`spawn_agent 需要一个宿主：…`）**永远执行不到**。且 `RunResult.error = null`，顶层没有任何错误信号。设计者看到的是 schema 级错误 `member: must not be valid`，不是「你没配 members」。

### I4. `06-failures` 的其它实测（采信，不单独复核）

- **构造期 22 组输入，13 组静默成功**（9 组抛错）；抛错信息全是 `Error: <自由文本>`，无 `code`/`type`/`stage`，且会自相矛盾（`model` 不存在时报的是「解析**有警告**」，真实原因在附带文本里）
- **构造期完全离线**：provider 端口没人听（`http://127.0.0.1:1`）构造照样成功，首次 `prompt()` 才炸
- 🆕 **`excludeTools` 拼错名字 → 静默无效**（与不写完全一样）。既有报告只覆盖了写对的正例
- 🆕 **`skills` 里同一名字写两遍 → 静默**
- 🆕 **不写 `model` → 静默回落全局默认**（可能是真实 provider）
- ✅ **正面**：构造失败**不占 `maxAgents` 名额**（连败 3 次后 `activeCount=0`，宿主仍可用）—— 与 4.3「不回收会被吃满」是两件事，前者是干净的
- ✅ **`tools: []` 确实拿到零工具**（`af1befd` 修复有效）

---

## J. `04-guards` 的两条（已独立复核）

### J1. 【与既有报告分歧】预算**不是天花板** —— 忙时通道完全绕过检查

既有报告 §4.3 的措辞是「预算耗尽后**全宿主冻结**：连新建分身都被拒」。这句话本身没错（`prompt` 与 `spawn_agent` 预检会拦），但它掩盖了一个更基础的事实：**耗尽的检查只在空闲投递路径上跑**，`followUp` / `steer` 完全不设防。

**主 agent 独立复核**（`audit/verify-budget-bypass.ts`）：

```
第一轮进行中：isStreaming=true，host.usage=0（上限 18，此刻尚未结算）
忙时 send → {"delivered":"queued"}
两轮结束后：host.usage=36，假服务新增请求=2 次
→ 预算被击穿（36/18，超 2.0×）

直接 steer → no-throw；结束后 被击穿（36）
```

> ⚠️ **我第一次测这条时测错了**，值得记下来：我先用「先跑一轮把预算花光」来造场景 —— 结果第二次 `prompt()` **在预算检查处就抛错了**，根本没进入忙碌态（`isStreaming=false`），于是 `send()` 走的是**空闲**路径，测出来是「守住了」。正确构造是：`budget=18`、`usage` 起始 0（第一轮放行），在**第一轮正在跑**时投递。这个陷阱本身也是报告应该记的。

**机制**：预算检查只存在于 `create-agent.ts` 的 `prompt()` 开头与 `spawn-agent.ts` 的预检；`send()` 忙时分派到 `session.followUp()` / `session.steer()`，这两条路径不经过库的任何检查。

结合报告中已有的「单轮超支不封顶」（本文件 J2），预算的真实性质是：

> **一个开放环的软约束，不是天花板** —— 轮前判、单轮不封顶、队列通道不设防。三道护栏里只有 `maxDepth` 是硬边界。

### J2. 其它已复核 / 采信的条目

**已由主 agent 复核：**

```
═══ 并发触发 maxAgents ═══
  成功=2  返回错误文本=0  抛异常=6
  抛异常样例：宿主已达到 maxAgents=3 的分身上限，不能再创建
  最终 host.list()=3
```

即：并发下**护栏数值守住了（`list()=3`）、但错误通道破裂** —— `spawn_agent` 的契约是「触发护栏返回错误文本、不抛异常」，实测 6/8 是抛异常。既有报告只在 `audit/findings/04-guards.json` 的 4.1b 里有这条，**正文未列**。

**采信（未单独复核）：**

| # | 现象 | 数字 |
|---|---|---|
| 1 | `maxAgents` 回收后仍误触发 | `maxAgents=3`，建满 → 回收 2 个（存活 1）→ spawn 仍被拒 |
| 2 | 单轮超支**上不封顶** | `budget=1`，一轮带一次工具往返（2 次请求）→ 实花 **36 token（36×）**。既有报告给的是并发维度（5×），这是单轮维度 |
| 3 | 孤儿使 `maxDepth` 失效 | 同一个 `leaf`，完整链时 spawn 被拒；回收 `mid` 后再 spawn **成功** |
| 4 | 预检与登记是**两份实现** | `checkCanCreate` → `undefined`（放行）；`register` → 抛「id 必须唯一」。预检不判 id 唯一性 —— 这就是并发竞态的机制根因 |
| 5 | 多护栏同时违反只报检查顺序最靠前的那条 | 深度→名额→预算；不含「你还违反了另外 N 条」 |
| 6 | `maxDepth=-1` 连顶层都拒 | 而 `maxDepth=0` 允许顶层 |
| 7 | 同一 API 在 idle / busy 下对预算反应相反 | 不可预测性本身 |

---

## K. 【本次核对的量重发现】`RunResult` 不跟调用绑定 —— 重叠投递时结果串台

### K1. 症状（实测，`audit/verify-result-misattribution.ts`）

**打中了 `spawn_agent` 本身**：子分身正在跑 `spawn_agent` 派的任务时，给它再投一条消息（`send_message` / `send` 都行），`spawn_agent` 返回给父的文本会变成**后一条消息的答案**：

```
spawn_agent 返回给父的文本："已让成员「w」处理，它的分身 id 是 a5。\n\necho:追加的第二条"
→ 里面是**追加的第二条**（子任务原文是「子任务原文」）
追加投递返回：{"delivered":"queued"}
```

父 agent 会以为「w 处理了子任务原文并给出了结论」，实际拿到的是无关消息的答案。**全程无任何信号。**

更直接的对照（在 `agent_settled` 窗口内并发两次 `prompt()`）：

```
外层 prompt() 返回：text="echo:窗口内投递的消息"   ← 拿到内层那条的答案
窗口内 prompt() 返回：text="echo:外层第一轮"       ← 拿到外层那条的答案
假服务请求 2 次；round_completed 播报 2 次、文本都对；agent.usage=36（正确）
```

### K2. 根因（读 `create-agent.ts` 的 `collectRun()`）

```ts
for (const message of session.messages) {
  if (message.role !== "assistant" || counted.has(message)) continue;
  counted.add(message);
  ...
  if (chunk) text = chunk;          // ← 循环里被覆盖：最终取的是**最后一个**未计过的
}
return { text, usage: fresh, ... };
```

`collectRun()` 不是「收集**本次调用**的消息」，而是「**排干共享池里所有未计过的 assistant 消息**」，返回最后一者的文本与它们的用量**之和**。谁先调 `collectRun()` 谁抓到当时池里有什么。

所以 `RunResult` 的真实语义是：

> 「我调用 `collectRun()` 那一刻，还没被任何人计过的那些消息里最后一个的文本 + 它们的用量之和」。

**只在 run 严格串行时**才等价于「本次运行」。重叠就串台。

### K3. 为什么两轮审计都没抓到

- 既有报告验证的「三方对账 `host.usage = Σ agent.usage` 差额为 0」**恰好查不出它** —— 三方都从同一个 `collectRun()` 派生，串台时它们**同步错误**，所以自洽。
- `07-observability` 的子 agent 提出的假设 ⚪H1 预测的是「空文本 + 全 0 用量 + 用量记到下一轮」—— **症状方向对，机理错**。实测没有出现空/0，而是**互换**（各拿到对方的消息），且用量是对的。它没抓到的原因是它只看了窗口内那一侧（**我第一遍也只看了那一侧，差点误判 H1 不成立**）。
- 报告 §2/§3 的所有并发实验都是「**多个不同 agent 并发**」（那个确实没问题）；而这条需要「**同一个 agent 在被跑期间又被投递**」。

### K4. 影响（对阶段 2 最重）

| 受影响的东西 | 后果 |
|---|---|
| `spawn_agent` 的 `run.text` | **主力委派原语会报错人/错轮的结果** |
| `RunResult.usage` 的「本次」语义 | 只在串行下成立 |
| `agent.lastResult` | 同上 |
| `host.on("round_completed")` 的 `result` | 同上（用它做成本细账会错归） |
| 形态 4/5/9（专家复用、继续投递） | 这些形态恰好都在「同一个分身被反复投递」，是主要风险面 |

### K5. 附带发现：`send()` 之后紧跟 `prompt()` 必抛

```
第1次：send→{"delivered":"ran"}  prompt("任务B")→"THROW:Agent is already processing a prompt. Us…"
第2次：同上
第3次：同上
```

`send()` 空闲时返回 `{delivered:"ran"}`（fire-and-forget 起了一轮），但随后的 `prompt()` **不会排队**，直接抛。于是设计者最自然的写法 `send(A); await prompt(B)` **3/3 全抛**。要混用只能 `send` + `waitForIdle`。（`send` 的返回文案「已开始处理」暗示它可以接着用，实际不行。）

---

## L. `20-delivery`：串台是确定性的，且基线被修正两处

第二波里最有价值的一份（`audit/20-delivery/FINDINGS.md`，真模型花费 $0.00299）。它把 K 从「一次观察」做成了「确定性规律 + 安全纪律」，并**修正了我基线的两处**。两处修正均由主 agent 独立复核（`audit/verify-idle-steer.ts`）。

### L1. 串台是确定性的，不是偶发

```
[投递] #1..#20  spawn文本含子任务=false 含追加=true
[对照] 不投递的 20 次里 spawn 文本不含子任务原文的次数 = 0
→ 投递组串台率 = 20/20；对照组 = 0/20
```

真模型下同样 **2/2** 复现，且原子任务的 120 行输出**整段消失**：

```
【投递组】spawn_agent 返回给父的 = "已让成员「w」处理，它的分身 id 是 a2。\n\n日元"
【对照组】开头="…\n\n1\n2\n3…" 结尾="…119\n120\n完"
```

### L2. 【修正基线】per-call 用量也错，不只是文本

基线 K 写的是「用量是对的」。实测（主 agent 复核）：

```
对照组 RunResult.usage = 18
串台组 主干 RunResult.usage = 36  text="echo:追加"
a2.usage（累计）= 36
→ per-call 错（并入了别人一轮）；累计 正确
```

**正确表述**：三方**累计**（`agent.usage` / `host.usage`）都对；**per-call `RunResult.usage` 错**；而且因为三方累计同步正确，既有报告验证的「对账差额为 0」**永远查不出 per-call 错**。

### L3. 【修正基线】空闲 `steer` 不是「静默丢弃」，是「静默停放 + 顶替下次 prompt 的返回」

这一条动摇的是**规格决策 #26 的依据**（它从探路期就一直写的是「空闲时 steer 静默丢弃」）。主 agent 复核：

```
steer 返回后 600ms 内，假服务新增请求 = 0（0 = 没有立刻跑）
随后 prompt("我自己的 prompt") 返回 = "echo:停放的消息"
→ 被暂停放的消息顶替了；自己那句文本**没有**出现在返回里
lastResult = "echo:停放的消息"
```

探路的观测（请求数不变）是对的，**推论错了**。正确语义是：**停放 + 下一次 `prompt()` 被唤醒并顶替其返回文本 + 自己的文本消失**。

为什么这比「丢弃」更糟：丢弃至少是立即的、可复现的；停放是**延时的、跨业务分支的** —— 那条消息会在几秒后（或另一个逻辑分支里）偷走一次无关 prompt 的返回，而设计者那时早已忘记自己调过 `steer`。

已修正规格决策 #26 的依据（本次提交）。

### L4. 「抛错」只覆盖 2/25 格

它把 5 种状态 × 5 种方法 = 25 格全填了（`e2-state-method-matrix.ts`）。核心观察：

> **「抛错」只覆盖 `disposed` 与忙时 `prompt`；其余 15 格全是「返回成功字样但语义不是调用者以为的那样」。**

（另 8 格是真能跑。）这是对「为什么这个库难用对」最凝练的一句概括。

### L5. 【关键产出】经过实测的「安全投递纪律」

它把纪律做成了可验证的，每种写法各跑 8 次 × 2 种重叠形态：

```
M1-prompt            concurrent 8/8   settle 8/8
M2-send              concurrent 0/8   settle 0/8
M3-send+waitForIdle  concurrent 8/8   settle 8/8
M4-send+自读messages  concurrent 8/8   settle 0/8
```

委派层的纪律（每种 6 次）：

```
busy        ：spawn_agent 返回的文本仍含原子任务 = 0/6
spawn 后投   ：6/6
when-idle   ：6/6
```

三条硬结论：

1. **委派期间（`spawn_agent` 在飞）绝不向该子分身投递** —— 互斥链救不了它（`child.prompt(task)` 在工具实现里，消费者拦不到）。要「专家复用」只能：委派一问一答完再投，或自己在编排层建长期分身 + 套互斥链。
2. **同一 agent 上任何时刻只允许一次飞行中的投递**（`prompt` 链 或 `send`+`waitForIdle`，`WeakMap` 每 agent 一条链）。只 `send` 不等 = **0/8**。
3. **拿不准就自读 `session.messages`**（按「自己的 user 消息之后、下一个 user 之前」聚合）—— 双投递者并发下仍 **8/8**，而且它是唯一不需要互斥链的办法。`i < 0`（找不到自己的 user 消息）还是信号：**说明这条消息被静默停放了**，把本来无声的失败程序化地暴露出来。

### L6. 并发本身没问题（重要：把问题面收窄了）

```
N= 1 跑 237ms   N= 8 跑 154ms   N=16 跑 145ms   N=32 跑 183ms（库内零闸门）
真模型 cap=2：N=8 → 8/8 成功零 429；N=16 → 16/16 成功零 429
单 agent 12 轮接力：12/12 正确，无退化（上下文 3.3k → 42.3k）
```

即：**问题全在「同一个 agent 被重叠投递」这一个面上**，不在「多 agent 并发」。这解释了为什么两轮审计都漏了它 —— 所有并发实验都打在了没问题的那一面。

### L7. 它自己修正的其它基线

| 项 | 修正后的说法 |
|---|---|
| 盲区 2「空闲 steer 丢弃 / followUp 永不被唤醒」 | → 「静默停放 + 下次 prompt 顶替其返回」（L3） |
| K「用量是对的」 | → 「累计对、per-call 错」（L2） |
| 兄弟工具调用的并发度 | 默认 `executionMode` 就是 **parallel**（3 个 342ms ≈ 1 个），`sequential` 才串行（935ms）；这是**可配置的 per-tool 开关** |
| `round_completed` 在队列积压下 | **少算**：11 次模型生成 → 只播报 1 次（`tok=198`）。对照的 10 个独立 agent 则是 10 次播报、各 18 |

---

## M. `21-runtime-silent`：运行期静默失败搜出的新东西

第二波第二份（`audit/21-runtime-silent/FINDINGS.md`，真模型 $0.0043）。它把 `06-failures` 没做完的运行期空白补完了，**新 12 条静默失败**，并**第三次独立复现了空闲 `steer` 的修正**。三条高严重度的由主 agent 复核（`audit/verify-typo-failures.ts`）。

### M1. 【高严重度】`onToolCall` 键名写错一个字母 → 审批门静默失效、agent 裸奔

```
onToolCall（写对）       门被调用 1 次，工具结果="echo:拦下"
onToolcall（小写 c）     门被调用 0 次，工具结果="echo:ENOENT: no such file…"   ← 门没跑，工具裸执行
OnToolCall              门被调用 0 次，工具结果="echo:ENOENT…"               ← 同上
```

对比第三条：`tools: ['Read']`（不应跑的）。这里工具**真的执行了**（试图读一个不存在的文件）。

关键限定（子 agent 自己指出的）：**TS 对对象字面量能拦这个错，但成员花名册若来自 JSON 配置文件 / 数据库 / 变量，这条防线就不存在** —— 而“从配置生成成员”恰好是当集群变大时最自然的做法。

### M2. 【补充】`tools` 一个字符写错 → 工具集塌成 `[]`（且技能段一并消失）

主 agent 复核：

```
['read']（写对）        模型看到 ["read"]
['Read']（大写）        模型看到 []
'read'（字符串不是数组）  模型看到 []
```

子 agent 还发现：工具集为空时，system prompt 里的 `<skills>` 段连同“用 read 工具加载技能”的指示**一起消失** → 技能静默失效。即一个拼写错误能级联废掉两个特性。

### M3. 【补充】`skills` 不是白名单（与扩展加载同族）

```
不声明 skills        system 里出现未声明的 magic-marker：true
只声明别的技能        system 里出现未声明的 magic-marker：true
未声明的技能**正文**进 system 了吗：false
```

即：只要文件在 `agentDir/skills/` 或 `<cwd>/.pi/skills/` 下，它就会进 system prompt 的 `<available_skills>`（名字 + 描述 + 路径），**声明与否无差别**；但正文不预载（要模型自己 read）。

**统一结论**：`MemberSpec` 里**只有 `tools` 是白名单**；`extensions`（加载）与 `skills`（注入）都**不受声明控制**。设计者想“只暴露这一个技能/扩展”做不到，且零信号。

### M4. 【新路径】`send()` 排队 + 当前轮 abort → 下一次 `prompt()` 返回这条旧消息的答复

```
E2-2 忙时 send(queued) → 立刻 abort 当前轮
  请求正文："#3 msgs=3 [system user([[sleep:900]] P2) user(P2-NEXT)]"
            "#4 msgs=5 [system user(P2) user(P2-NEXT) assistant(echo:P2-NEXT) user(Q2-THEN-ABORT)]"
  下一次 prompt 后：{"text":"echo:Q2-THEN-ABORT", …}
```

消息不丢，但它**脱离了原来的调用关系** —— 唤醒权被无提示地转移到下一次**任意** `prompt`。这是与 K（`spawn_agent` 期间投递）**不同的第二条串台路径**。

### M5. 【缺口】“还有几条消息没跑”在库层面零可观察量

`status=idle`、`isStreaming=false`、`lastResult` 还是上一轮的、`host` 侧无字段。**唯一入口是逃生口 `session.pendingMessageCount`**（未文档化）。且 `dispose()` **不清理队列**（dispose 后 `pending` 永远停在 N）。

对于以 `send_message` 为底座的能力工具，这是可靠性基础的缺口。

### M6. `steer()` 丢掉了唯一的即时信号

```
▶ idle/sdk-steer-disposition: {"disposition":"queued","pending":1}
```

SDK 的 `steer()` 返回 `QueuedInputDisposition`（`"queued"` / `"handled"`）—— 那是**唯一能当场区分“已插进去”和“只是排队”的信号**，而库的 `steer(text): Promise<void>` 把它丢掉了。

### M7. 其它新静默失败（采信）

| 现象 | 后果 |
|---|---|
| `onToolCall` 内部 `throw` = **无条件拦截**，异常文本原封不动进模型上下文；库侧 `RunResult.error=null`、`status=idle`，与“设计者主动拦截”**完全同形** | 门里的 bug 会变成“所有工具永久失败”且无处定位 |
| 门的判定是**真值判断**：`{block:false}` / `{}` 都会被拦，只有 `false` / `undefined` 放行 | 类型签名是 `{block:true}｜undefined`，运行时不校验 |
| 拦截与“工具自身出错”在库层面**完全同形**（都只是 `tool_end.isError=true`），无 gate 专属事件/计数 | 事后无法审计“这次是拦的还是工具挂了” |
| `thinking` 非枚举值（`'High'`/`'none'`/`'低'`/`'ultra'`）→ **静默回落 `off`**（与显式写 `off` 不可区分） | 与 `model` 字符串里写 `:ultra` 会抛错**不一致** |
| 未知/拼错键名（`descriptoin` `tool` `excludeTool` `systemPrompt` `Roles`）**6/6 静默忽略** | 来自 JSON 的配置没有任何防护 |
| `excludeTools` 空格/大小写写错 → 完全无效 | 与不写排除一样 |
| 两个同名 `customTool` → **后者静默覆盖前者**；`customTool` 可冒充内置 `read` 并**真的顶掉它** | 与“能力裁剪”意图相反 |
| `cwd` 指向文件 → 构造与 `prompt` 都成功；用 `bash` 时报 `bash.exe ENOENT`（**误导性根因**，看起来像 shell 没装） | 难定位 |
| `spawn_agent` 被护栏拒绝时工具结果 **`isError:false`**、宿主**零事件** | 程序化督导无法自动发现“集群一直在被护栏挡住” |
| `abort` 那轮：`usage` 记 0（`agent` 与 `host` 同）**但请求真实计费** | 成本漏记，无信号 |
| 被 abort 的轮次留下 **user 消息永久占上下文**（4 次后 `msgs=6`） | 后续每轮多付这些 token，无任何标记 |
| `abort()` 对**空闲** agent 也把 `status` 置为 `"aborted"` | 一个不存在的事实 |

### M8. 【重要正面】机制本身是可用的 —— 不要把它当坏的

这一轮**真正的价值之一是测出了哪些东西是好的**，纠正了“样样都坏”的误判：

| 项 | 实测 |
|---|---|
| **审批门** | 拦截理由原样进上下文、`isError=true`；**真模型 3/3 如实转述被拦、0/3 编造**（明确说“我不会去猜或编造一个验证码给你”） |
| **技能机制** | 真模型主动 read 正文 **9/9**（6 次清晰描述 + **3 次模糊描述且任务不提技能**）；“配了不用”**未被复现** |
| **护栏拒绝** | 文案清楚可执行；真模型父 agent **2/2 如实转达**、明确说“我不会替它编造一份” |
| **`abort()`** | **不会搞坏 agent**：连续 4 次 abort → 状态无累积、无句柄泄漏、正常轮照跑 |
| **`waitForIdle()`** | 忙时 `send` 排队后**确实等到它跑完**（等了 568ms，不提前返回） |
| **`dispose()` 后的 API** | `steer/prompt/send/abort` **全部抛错**（有信号） |

**模式**：**机制层（钩子、工具通道、事件）是可靠的；静默失败集中在“配置层”与“结果归属层”。** 这个分工对阶段 2 的设计方向很有用 —— 不需要重做机制，需要补配置校验与结果绑定。

---

## N. `22-topology-live`：真模型寻址的大样本 + 三条结构层

第二波第三份（`audit/22-topology-live/FINDINGS.md`，**$0.1447 / 254 万 token / 126 次真模型调用** —— 本轮最大花费，但换来了本次审计里最好的统计实践）。

### N1. 【方法标杆】44/44，但主动标出置信区间下界只有 70.1%

既有报告的 2.6 写「按 id 寻址 **3/3**」。这一轮跑了 **44 次**（5 个变体：id 在 prompt / 只在工具结果 / 同时 4 个 id / 隔 5 轮复用 / **给一个不存在的 id**）：

```
E1-V1 id在prompt        9/9 （95%CI [70.1%–100.0%]）
E1-V2 只在工具结果       9/9 （95%CI [70.1%–100.0%]）
E1-V3 同时区分4个id      9/9 （95%CI [70.1%–100.0%]）
E1-V4 隔5轮后复用        8/8 （95%CI [67.6%–100.0%]）
E1-V5 不存在的id         9/9 全部「照发→工具拒绝→如实汇报」
```

其自评：“**44 次里没有一次编造 id、没有一次不调用工具**。但 9/9 的区间下界只有 70%，所以准确表述是「在这套 prompt 形态下可靠性不低于 70%，观测点估计 100%」。要断言 ≥99% 需 ~300 次同形运行。”

这是全部六份里唯一一份**主动给结论强度设上限**的。建议作为后续所有「N/N」类结论的书写规范。

**V5 尤其有价值**：给一个不存在的 id，**9/9 都把原样的假 id 发出去**，从不“猜到”一个真 id 顶替；工具拒绝原文进上下文并如实转述。→ **错误不会静默，模型不会编。**

### N2. 【高价值】花名册描述模糊时，失败是“就近选择”且**不说“不确定”**

```
E2-A 清晰6人   严格 12/12   宽松 12/12
E2-B 清晰8人   严格 16/16   宽松 16/16（6→8 人无退化）
E2-C 故意模糊   严格  4/8    宽松  6/8   失败分布 {"命中同义成员":2,"严格命中":4,"选错":2}
```

关键不是 4/8 这个数字，是**失败模式**：题3 期望 `workerA`（“把这份任务执行掉”），**两次都选了专家**（`expertA`/`expertC`）—— 因为“任务/交付”在描述里更接近“给出专业意见”而非“完成任务”。

> **“按语义距离就近” + 从不说“我不确定” = 静默选错人。**

对阶段 2 的直接含义：成员契约（输入/输出）不只是为了“组合校验”，也是为了**让选人不再只能靠一段散文描述**。

### N3. 【真模型下的新发现】形态 4：机制全对、协议失真

主持人 **4 次都以为工人还在跑**（实际只跑了最后一次），于是汇报“1 件已完成、3 件尚无回音”。

但实测：**3 个答案其实全对、分身数不增长** —— 错的不在机制，在**库没有回执通道**。

与它自己的 C5 互相印证：`send_message` 只回投递状态、不回内容；**真模型 4/4 明确回答“我只看到『已投递』这一行，没有回执”**（不编造）。

→ 这正好是阶段 2 `ask_agent` 要填的那个坑，而且**现在有了真模型行为的证据**：模型会诚实说“我看不到回执”，但它的**汇报会因此不实**（不实发生在它往上总结的时候，不在工具层）。

### N4. 【主 agent 复核】跨宿主挂父无人校验 ↔ 报告成立

> ⚠️ 我第一次测这条时**写错了**：把 `parent` 放进了 spec 而不是 deps，得到 `parentId=undefined` 并误判“被拒绝”。修正后：

```
alien.id=a1 属于 hostA；child.id=a2 属于 hostB
child.parentId = a1
hostB.get(child.parentId) = undefined（父不在本宿主）
→ 跨宿主挂父**被接受，无人校验**
```

后果：`depthOf()` 在本宿主找不到父 → 走 `return depth + 1` 保守分支 → **深度记账失真**。

### N5. 【主 agent 复核】`parentId` 是普通字段，强改能造环且护栏不拦 ↔ 报告成立

```
强改 top.parentId → a4（无报错）
环上再建一层：**建成，护栏没拦住**
```

但注意：`depthOf` 有 `seen` 集合，环**不会死循环**，而是**静默把深度算短**（子 agent 的原描述准确）。

### N6. 【主 agent 修正报告】`depthOf` 的 O(n²) 是真的，但**在 512 层都看不出来**

> ⚠️ 我第一次跑这条时忘了 `maxAgents` 默认 16，建 64 层就撞上限。修正后：

```
n= 64  总耗时   109ms  每层 1.703ms
n=128  总耗时   187ms  每层 1.461ms
n=256  总耗时   363ms  每层 1.418ms
n=512  总耗时   721ms  每层 1.408ms
```

**前沿结论**：总耗时随 n **线性**（每层恒 1.4ms），不是 O(n²)。子 agent 的“单次预检 512 层是 1 层的 201×”是**微基准下的事实**（`checkCanCreate` 单独计时），但**实践影响为零** —— 每层的实际开销由 `createAgentSession` 的常数项（~1.3ms）主导，`depthOf` 那点链式遍历完全被淹没。它自己也写了“工程上不致命”，但同一句里又说“32+ 层后每层可见变慢” —— **后半句未被复现**。

### N7. 其它采信（未单独复核）

| 项 | 数字 |
|---|---|
| 深链 1→256 层全部建成，零错误 | — |
| 宽扇出 200 子 | 260ms |
| 并存 500 分身 | 807ms，堆 +15.2MB，RSS 218MB |
| 运行时扩编对已挂载 `spawn_agent` 的可见性 | **0%（一定漏，不是偶发）**，且模型真实请求里的 tools schema 也看不到；四条绕法只有两条完整可用 |
| 红线 | 给 `spawn_agent` 多塞 `tools`/`model`/`cwd` 参数**被完全忽略** |
| K5 在真模型下 | **稳定复现**（忙时 `send` 后紧跟 `prompt` → 抛） |
| 普通时序能否抓到 spawn 串台 | **不能**（5/5 都是正确答案）—— 串台需要特定重叠，这也解释了为何普通回归测试漏了它 |
| 并发 1/2/4 | 零错误零 429 |

---

## O. `23-aggregation`：结构化输出、可复现性、采样旋钮

第二波第四份（`audit/23-aggregation/FINDINGS.md`，**149 次真调用 / $0.095**）。

### O1. 【高价值】深层嵌套 schema 是最先坏的，而且**坏得静默**

```
S1 扁平三字段   20/20 parse-ok、字段全对、0 围栏 0 解说（原报告的 8/8 成立并加强）
S2–S7 逐步难化  全部 5/5
S8 深层混合     **3/5**
```

两次失败**都不是语法错**：模型把 `verdict` 塞进了内层 `review` 对象，**顶层的 `verdict` 直接消失**：

```json
{"review":{"id":"R1",…,"verdict":"approve"},"notes":"…"}
```

**`JSON.parse` 照样成功** → 只 parse 不校验字段的消费者会静默接受错形状。

### O2. 【主 agent 复核】硬约束（工具提交）的结构化结果**不进 `RunResult.text`**

```
工具收到参数    = {"verdict":"pass"}
RunResult.text  = "echo:已收"          ← 是工具自己的返回文本
→ 设计者能从 RunResult 拿到结构化结果吗：**不能（只在工具闭包里）**
```

子 agent 的对照数字：软约束（题目里写“只输出 JSON”）10/10、硬约束（工具提交）10/10 —— **成功率并列满分**，但硬约束贵 **2.16× 时间 / 2.05× 输出 token / 2.26× 花费**，而且结果**0/10 进 `RunResult.text`**。

### O3. 【高严重度・静默失败】两套契约会同时被满足且可能矛盾

题目说“只输出 JSON”但环境里挂着提交工具时：模型 **9/10 调了工具**，同时 **10/10 又输出了合格的文本 JSON**。

**工具的存在本身就会改变行为；两条路都不是“强制”。** 若两者不一致，设计者不知道该信哪一个 —— 且无任何信号。

### O4. 自由散文的真实代价

```
真模型在“自由散文”下写 JSON：**0/10**
既有 audit/08 的原版抽取器：两个字段各拿到 1/10
任务感知正则（方案[A-Z] / 评分 N 分）：10/10
散文臂单次花费 $0.0021 vs JSON 臂 $0.000156 —— **约 13 倍**
```

即：原报告的“2/5”真相是“**那个正则本来就是为 JSON 写的**”。散文不是“抽不出来”，是“**抽取器必须为每个题面定制**”。

### O5. 【修正我早先的结论】`temperature` 是**可达的** —— 只是库没接

我前面报过“`temperature` 无法按成员配”。这一点仍然对（`MemberSpec` 无此字段），但子 agent 找出了**四条实测通到请求体的绕法**：

| 绕法 | 是否可行 |
|---|---|
| ① `models.json` 的 `Model.samplingParams` | 可行，但按**模型条目**生效，而条目 id = 线上 model 名 → **无法给真模型复制两份** |
| ② `registerProvider` 增/改模型条目 | 可行 |
| ③ **克隆 provider + `streamSimple` 包装注入 temperature** | **对真 provider 也跑通**（0.05 / 0.95 均返回正常） |
| ④ `onPayload` 钩子改写原始 payload | 可行 |

底座事实：`modelRuntime.completeSimple(model, ctx, { temperature: 0.5 })` 能把 0.5 送进请求体。

**所以正确的说法是：旋钮在 SDK 上，库没接。** 这把它从“做不到”降级为“要接”。

附带坑：克隆 provider 会掉 `x-opencode-session` 归属头 → 真 API 400；自建模型条目的 cost 表默认 0 → **用量记账变 $0**（静默失败）。

### O6. 【主 agent 复核 + 修正机理】`off` 不是 `off`，而且**不传 `thinking` 就是 `high`**

子 agent 报“档位在 map 上失真”。我读了模型库原文：

```
thinkingLevelMap = {"off":null,"minimal":null,"low":"low","medium":null,"high":"high","xhigh":null,"max":"max"}
reasoning = true
```

即：**只有 low / high / max 三个档存在**，其余全是 `null`。pi 对未映射档位**向上夹制**。实测（主 agent 跑）：

```
── 真模型 opencode-go/deepseek-v4.1-flash ──
  请求 undefined → session.thinkingLevel = high     ← 不传就是 high！
  请求 off      → low      ← "off" 不是 off
  请求 minimal  → low
  请求 medium   → high     ← pi 默认档是 medium，也变 high
  请求 xhigh    → max
── 假 provider 模型（reasoning:false）── 8 档全部 → off
```

**实际后果**：

1. 在这类模型上**无法关掉推理** —— `off` 被向上的夹到 `low`。
2. **什么都不写 = `high`** —— 因为 pi 的默认是 `medium`，而 `medium` 夹到 `high`。设计者不配 `thinking` 就拿到次贵的档。
3. 有效阶梯只有 `{low, high, max}` 三级，而类型上写的是七档 —— **类型与实效不符**。

### O7. 真模型方差：单次采样不能当成本基准

同输入 10 次：**10/10 文本不同**；字数 66–87（1.32×）；耗时 2179–5316ms（**2.44×**）；**输出 token 45–483（10.7×）**；总 token 3391–3829（1.13×）。

→ **最噪的是 output**。拿单次样本估集群成本会错一个数量级。

### O8. `thinking` 的质量收益**测不出来**（天花板效应）

两道需要真推理的计数题（正解 66969 / 304598，均经暴力校验），四档 × 5 + 三档 × 4 共 **32 次全部答对**。同档内 output 极差 10×，比档间差异还大。

→ 该模型在这类题上哪档都对，**无法测出档位的质量收益**；要测需要一道它做不到的题或换弱模型（超出“只用 flash”的约束）。

---

## P. `24-uncovered`：四项补测 —— 超限静默卡死最重

第二波第五份（`audit/24-uncovered/FINDINGS.md`，真模型 ≈$0.038）。它把既有报告自己承认没覆盖的四项补掉了。三条关键前提由主 agent 复核。

### P1. 【最重】上下文超限 = **静默空结果 + 分身永久卡死**

```
超限时：RunResult = {error: null, text: "", usage 全 0}   ← 与「跑成功但没说话」完全一致
        status 停在 idle
        失败的 assistant 消息被 SDK 从 session.messages 里剔除
        唯一痕迹：一次 error 事件
```

并且**那条超大 user 消息留在历史里** → 之后**每一次** prompt 都静默返回空；`session.compact()` 报 `Nothing to compact`；**没有 `dispose` 之外的恢复手段**。

**为什么这条分量重**：它把「一个分身坏掉」变成了「这个分身从此每次都静默失败」。若一个分身在循环里被反复投递（形态 4/5/9），它会**静默地永远返回空**，而调用方只会看到空文本。

### P2. 【复核】库层没有任何输入侧 token 预检

25 倍于声明窗口的输入被**原样发出**（声明 2000、实发 50000 token）：不拒绍、不截断、不提示。唯一本地长度计算只用于压缩阈值判断，而它用的 `chars/4` 估算**低估约 2.5 倍**（实测该模型 1.5–1.6 字符/token）。

### P3. 【主 agent 复核】压缩**不可配置**，而且**不可见**

两条代码级事实：

1. `src/agent/create-agent.ts:97` 是 `SettingsManager.inMemory({})` → **`agentDir/settings.json` 里的 compaction 设置完全不生效**，也关不掉。
   → **这是决策 #1（显式注入求确定性）的一笔代价**：库换来了可预测，代价是**设计者失去了通过 settings.json 调参的口子**。值得记入阶段 2 的设计权衡。
2. `grep compaction src/agent/events.ts` **结果为空**（SDK 侧确实有 `compaction_start` / `compaction_end`）→ 归一化事件把它们全丢了。

叠加子 agent 的用量测量：**压缩用的摘要调用不计入 `agent.usage`**（provider 侧 prompt token 367838 vs 设计者看到 295337，**差 7.2 万**）。

→ 与 J1（预算被忙时路径绕过）合并：**`budgetTokens` 这道护栏对一个主要成本来源是盲的**。

### P4. 【数字修正】超限错误分类走的是「正则匹配散文」

子 agent 说“pi-ai 有 **20 条**正则”。主 agent 实测：针对上下文超限这一类，正则**去重后是 8 条**（`context window exceeds limit` / `exceeds the maximum context length…` / `prompt too long; exceeded context length` 等）。

**机制确认**（这就是为何同一模型两种可观测性）：命中 → 被当成「可恢复超限」→ 消息被剔除 → `error=null`；不命中 → 消息保留 → `RunResult.error` 有原文。**“20 条”这个数字需限定口径**（可能含其他错误类），但“靠措辞分类”这个机理性结论成立。

### P5. 【高严重度・静默失败】拒答与「跑了但没说话」在 API 层不可区分

```
拒答率 = 4/30（13%），配合率 26/30（87%）；同批非敏感事实对照 3/3 答出（证明技能通道本身是通的）
拒答 vs 沉默：stopReason 全 30 次都是 stop；RunResult.error 全空；事件种类集合完全一致；
             用量/耗时/消息数两组区间完全重叠
```

既有报告 C2.9 的“8 次里 2 次拒答”得到大样本确认（13%），并且**从“不确定触发率”推进到“不可区分”**。

### P6. 其它（采信）

| 项 | 数字 |
|---|---|
| 自动压缩何时有效 | `contextWindow ≳ 36384` 才有效；小窗口上**结构性失效**（`reserveTokens=16384` 与 `keepRecentTokens=20000` 矛盾） |
| 强制 GC 后的泄漏 | 仍有 **8.65 KB/迭代**（240 次 ≈2.03MB），**句柄零增长**；曲线衰减（后/前 = 0.61）→ 像“会饱和的缓存 + 碎片”而非无界线性泄漏；仅凭 `heapUsed` 不能定案 |
| 1000 次起收（50 并发×20 轮） | ≈4.4KB/分身，`host.activeCount` 归零（正面） |
| 50 并发批量扇出 | 每轮墙钟 150ms → 438ms（**3.0× 漂移**） |
| `reasoning:false` 模型上 `thinking` | 7 档（含 `max`）**全部夹到 `off`**，请求体无推理字段、无警告 |
| 本机 `opencode-go` 的 reasoning 位 | **29/29 全是 true**；84 个 `false` 全在 openrouter |

**诚实披露**：它的 E1L2 重跑时 openrouter 免费额度耗尽（402）；引用的数据来自额度充足时的首次成功运行，原始输出另存 `raw-live-e1l2-success.txt`，并明确标出哪几项未受影响。

---

## 核对总结

| 断言 | 结果 | 备注 |
|---|---|---|
| 4.7 abort 记账为 0 | 复现 | — |
| 6.1e 序列化抛主题错误 | 复现（3/3 场景） | — |
| C2.6 预算耗尽 send 谎报 | 复现 | **比报告严重**：`lastResult` 陈旧 + `status:idle` 使三信号一致误导 |
| C2.5 排队消息不播报 | 复现 | 少算 2/3 |
| 【新】扩展加载绕过 tools 白名单 | 复现（2/2 位置） | **超出原报告范围**：白名单管工具名，不管扩展加载 |
| 5.1g `dispose` 清空 `session.messages` | ❌ **被推翻** | 报告样本从未 prompt 过；同一报告第 259 行自相矛盾 |
| 5.1e 深度护栏「失效」 | 复现但需修正措辞 | 不是失效，是**只多买 1 层** |
| 5.1e 祖先投孙代被拒 | 复现 | 增量：曾孙同拒、`descendantCount` 不对称 |
| 【新】不给 `tools` 时扩展工具进默认工具集 | 复现 | 与扩展种植合并 = **默认配置下能力裁剪拦不住被种进来的扩展** |
| 【新】工厂创建期读 `ctx.agent` 必抛、类型不提示 | 复现（运行期 + 编译器级） | TS2578 `Unused '@ts-expect-error'` |
| 决策 #4 理由「漏列 customTools 就静默不生效」 | ❌ **被推翻** | 白名单非空时 customTools 强制并入；规格已更正 |
| 【新】扩展失败的根因（`loader.errors` 被丢） | 复现（原始输出） | 修复成本约一行 |
| 报告 §4.3「预算耗尽后全宿主冻结」 | ⚠️ **框定不完整** | 空闲路径确实被拦；**忙时 `send`/`steer` 完全绕过**，实测击穿 2.0× |
| 并发触发 `maxAgents` 抛异常 | 复现 | 成功 2 / 错误文本 0 / **抛异常 6**；契约破裂 |
| 【新·最重】`RunResult` 串台 | **复现，打中 `spawn_agent`** | 重叠投递时 `collectRun()` 排干共享池 → 结果互换；三方对账自洽所以查不出 |
| 忙时 `prompt()` 抛错无任何事件 | 复现 | 10 种事件里一个都不发 |
| ⚪H2 `WeakSet` 去重失效 → 用量虚高 | **成立** | 克隆 assistant 消息后第三轮 `RunResult.usage=54`（应 18），累计 90（应 54） |
| ⚪H1 settle 窗口静默退化 | 症状部分成立、**机理错** | 不是空/0，是**互换**；我第一遍也只看了窗口内那侧 |
| 【修正】空闲 `steer` 是「丢弃」还是「停放」 | ❌ **基线错了** | 是**停放 + 顶替下次 prompt 的返回**；规格决策 #26 依据已更正 |
| 【修正】串台时用量 | ❌ **基线错了** | per-call **错**（18→36）；累计对 |
| 串台发生率 | 确定性 **20/20**（对照 0/20）；真模型 2/2 | `audit/20-delivery` |
| 【新·高】`onToolCall` 键名写错 → 门静默失效、agent 裸奔 | 复现（`onToolcall` / `OnToolCall` 门调用 0 次，工具真执行） | JSON 来源的花名册无 TS 防护 |
| 【新·高】`tools` 写错一字符 → 工具集塌成 `[]` | 复现（`['Read']`、`'read'` 都 → `[]`） | 且技能段一并消失 |
| 【新】`skills` 不是白名单 | 复现 | 与 F（扩展加载）同族：**只有 `tools` 是白名单** |
| 【新】跨宿主挂父无人校验 | 复现（修正我自己的脚本后） | 深度记账失真 |
| 【新】`parentId` 强改可造环，护栏不拦 | 复现 | `seen` 集合保证不死循环，但静默把深度算短 |
| 【修正】`depthOf` 的 O(n²) | **实践为零** | 每层恒 1.4ms（n=64→512），被 `createAgentSession` 常数项淹没 |
| 【新·方法标杆】按 id 寻址 44/44 | 采信 | 但主动标出 95%CI 下界 70.1%，不声称 100% |
| 【新·高】深层嵌套 schema 静默错形（parse 仍成功） | 采信（真模型 20+5×7 次） | 只 parse 不校验字段就会静默接受 |
| 【新】硬约束结果不进 `RunResult.text` | 复现 | 只能从工具闭包拿 |
| 【修正】`temperature` 不可配 | ⚠️ **降级为“库没接”** | 四条绕法实测通到请求体，含对真 provider 可行的一条 |
| 【修正+新】`thinking` 档位 | 机理修正 + 后果更重 | 只有 3 档；**不传就是 `high`**；**`off` 不可达** |
| 【新·重】上下文超限 = 静默空结果 + 分身**永久卡死** | 采信（真假 provider 双侧一致） | 与“跑成功但没说话”不可区分；`compact()` 也救不了 |
| 【新】压缩不可配置（`SettingsManager.inMemory({})`） | **代码复核确认** | `settings.json` 被忽略；决策 #1 的代价 |
| 【新】压缩事件被丢弃 + 摘要 token 不计入 `agent.usage` | **代码复核确认** + 差 **7.2 万 token** | 预算护栏对主要成本来源是盲的 |
| 【修正】pi-ai 超限正则“20 条” | 上限**实测为 8 条** | 机制（靠措辞分类）成立，数字需限定口径 |

**对原报告的整体评价**：抽查 6 条中 5 条复现、**1 条被推翻**（5.1g，且报告自相矛盾）；附带 1 条超出范围的**新发现**（扩展加载）。结论大部分可回查（每条带 id、原始数据在 `audit/findings/_all.json`），但**至少有一条结论来自空样本，建议全量复查所有样本量为 0 / 全 undefined 的条目**。
