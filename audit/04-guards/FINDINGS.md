# 第 4 部分：护栏与预算（04-guards 独立复核）

> 状态：**被叫停，只完成 4.1（三道护栏边界）与预算耗尽的假 provider 机制层。**
> 4.2 真模型预算耗尽、4.3 锁死轮次量化、4.4 分支预算、4.5 汇总 —— **我没有跑**（下方「未完成」写明）。
> 本文件只写我亲手跑出原始输出的部分。脚本：`audit/04-guards/e1-guards-boundary.ts`、`e2-budget-boundary.ts`（假 provider，零花费；原始数据 `audit/04-guards/data.json`）。
> 既有报告（`docs/research/2026-09-30-phase1-capability-audit-report.md`）已覆盖大部分结论；下文逐条标注 **一致 / 补充 / 分歧**，分歧项在「结论速览」里加 ⚠。

## 结论速览

- **[一致]** `maxAgents` 是**全生命周期累计创建数**（含顶层 agent），回收不还配额：`maxAgents=3` 建满后回收 2 个、存活只剩 1 个，spawn 仍被拒（E1-A3）。
- **[一致]** `budgetTokens=0` 或负数时**连顶层 agent 都建不起来**，register 直接抛错，不是「一轮都不许跑」（E2-F1）。
- **[一致]** 预算检查发生在**轮开始前**：`budget=17 < 一轮 18 token` 时仍放行整轮，跑完 usage=18 > 17（E2-F1）。
- **[一致]** 预算耗尽后 `send()` **谎报 `delivered:"ran"`**，模型请求 0 次，消息只走 `error` 事件；无监听者时完全无感（E2-F3/F4）。
- **[一致]** 并发 8 个 `spawn_agent`、`maxAgents=3` → 成功 2、**抛异常 6**（不是返回错误文本）；上限数值没被击穿，但工具层的「只返文本」契约破了（E1-A4）。
- ⚠ **[分歧/补充]** 预算并未真正「冻结全宿主」：**忙时 `send()`（走 `followUp`）与直接 `steer()` 完全绕过预算检查**，耗尽后仍能把 usage 从 18 推到 36（E2-F5/F7）。既有报告只说 idle 那条路径被拦。
- ⚠ **[分歧/补充]** `maxDepth` 可被绕过：**回收中间层使后代变孤儿 → `depthOf` 按 1 层算 → 原本卡在边界上的子树又能继续往下长**（E1-B2/B3）。既有报告只记了「拓扑静默变形」，没记护栏失效。
- **[补充]** 单轮超支**上不封顶**：一轮含工具往返时中途不检查预算；`budget=1` 的一轮花掉 36 token（2 次往返，超支 36×）（E2-F2）。既有报告给的是并发维度（5×），这是单轮维度。
- **[补充]** 多条护栏同时违反时只报**检查顺序里最靠前**的那条（深度→名额→预算），不含「你还违反了另外 N 条」（E2-F8）。
- **[补充]** `checkCanCreate`（预检）与 `register`（登记）是**两份实现**：都不判同一组事实，预检不判 id 唯一性 —— 这就是 A4 竞态的机制根因（E2-F9）。

## 与既有报告对照（重点）

| 我的发现 | 既有报告 | 判定 |
|---|---|---|
| maxAgents 终身累计、回收不还 | §4.3「全生命周期累计创建数」、4.3a「只跑 4 轮」 | 一致（独立复现） |
| maxAgents=0 / budget=0 连顶层都建不起来 | §4.3 边界语义（4.3c） | 一致（独立复现） |
| budget 轮前检查、单轮可超支 | §4.3「检查时机：轮开始前」 | 一致，我补了单轮 36× 的数字 |
| send 谎报 ran | C2.6 / 4.2b | 一致（独立复现） |
| 并发超限抛异常 | 只存在于 `audit/findings/04-guards.json` 的 4.1b，**报告正文未列** | 补进正文 |
| **忙时 send/steer 绕过预算** | 报告未提；只说「耗尽后全宿主冻结」 | ⚠ 分歧：护栏有洞 |
| **孤儿使 maxDepth 失效** | 报告只说「拓扑静默变形」（2.6c/5.1e） | ⚠ 补充：同一现象的另一后果 |
| 预检/登记双实现 | 报告未提 | 补充（机制根因） |
| maxDepth=-1 拒绝顶层 | 报告未提（只说 maxDepth=N 允许深度 N） | 补充（小） |

---

## 实测证据

### E1 maxAgents / maxDepth 边界

- **问题**：三道护栏在临界点是否误触发/漏触发。
- **方法**：`node audit/04-guards/e1-guards-boundary.ts`（假 provider 固定每请求 18 token；`maxAgents`/`maxDepth` 逐项构造临界场景，ground truth 用 `host.list()`/`host.activeCount` 与 spawn 返回文本）。

**原始输出（E1-A3 误触发）**
```
maxAgents=3；建满 3 个（created=3）→ 回收其中 2 个 → 此刻存活 1 个、随后 spawn
→ 返回文本「不能再起分身：宿主已达到 maxAgents=3 的分身上限，不能再创建」
```
**E1-A4（并发漏出异常）**
```
maxAgents=3（顶层占 1，只能再建 2 个）；同时发起 8 个 spawn_agent
→ 成功 2 个，返回错误文本 0 个，抛异常 6 个：
[宿主已达到 maxAgents=3 的分身上限，不能再创建 ×6]；最终 host.list()=3
```
**E1-B1（深度边界）**
```
深度0=top 建成功；深度1=允许；深度2=允许；
深度2 再 spawn → 「不能再起分身：分身深度 3 超过 maxDepth=2，不能再往下一层」
```
**E1-B2（孤儿绕过 maxDepth）**
```
完整链 top→mid→leaf 时 leaf 再 spawn → 「分身深度 3 超过 maxDepth=2，不能再往下一层」
回收中层 mid 后，同一个 leaf 再 spawn → 「已让成员「leaf」处理，它的分身 id 是 a27」
host 里 leaf 的 parentId=a25，host.get(leaf.parentId)=undefined
```
**E1-B4（边界值）**
```
maxDepth=0  → 顶层可建，spawn 深度1 拒「分身深度 1 超过 maxDepth=0」
maxDepth=1  → 顶层可建，spawn 深度1 允许
maxDepth=-1 → 连顶层都被拒：「分身深度 0 超过 maxDepth=-1，不能再往下一层」
```
- **读出的现象**：`maxAgents` 判据是 `created >= maxAgents`，`created` 只增不减；`maxDepth` 判据是 `depth > maxDepth`，`depthOf` 遇「父不在本宿主」直接返回 `depth+1`。并发时预检与登记之间有窗口。
- **结论**：边界条件本身正确（`≤maxDepth` 放行），但存在**两类误/漏触发**：回收后误触发（A3）、孤儿漏触发（B2/B3）；并发时护栏数值守住但**错误通道破裂**（A4，抛异常）。

### E2 budgetTokens 边界 + send() 的预算旁路

- **问题**：预算耗尽的精确语义；`send()` 承诺「永不抛错」时消息去哪了；护栏检查顺序是否导致理由不准。
- **方法**：`node audit/04-guards/e2-budget-boundary.ts`（每轮脚本化固定花 18 token，可精确对账；用假服务请求数当 ground truth）。

**原始输出（E2-F1 边界值）**
```
budget=undefined → 1:ok(usage=18) 2:ok(18) 3:ok(18)（host.usage=54）
budget=-1 → 连顶层都建不起来，抛错「宿主预算已耗尽（budgetTokens=-1，已用 0）」
budget=0  → 连顶层都建不起来，抛错「宿主预算已耗尽（budgetTokens=0，已用 0）」
budget=17 → 1:ok(18) 2:抛错「宿主预算已耗尽（budgetTokens=17）：不再接新的一轮」（host.usage=18）
budget=18 → 1:ok(18) 2:抛错「…（budgetTokens=18）…」（host.usage=18）
budget=19 → 1:ok(18) 2:ok(18) 3:抛错「…（budgetTokens=19）…」（host.usage=36）
```
**E2-F2（单轮超支）**
```
budgetTokens=1；一轮「带一次工具调用」的 prompt → ok(usage=36)
这一轮假服务收到 2 次请求；host.usage=36（预算 1）
```
**E2-F3（idle send，谎报）**
```
send() 返回 {"delivered":"ran"}；error 事件=["宿主预算已耗尽（budgetTokens=18）：不再接新的一轮"]
假服务新增请求=0；send 后 isStreaming=false，status=idle
lastResult 文本仍是上一轮「echo:先把预算花光」
```
**E2-F5（busy send，绕过）**
```
budgetTokens=18；第一轮还在跑（isStreaming=true）时 send() → {"delivered":"queued"}
投递时 host.usage=0；两轮都跑完后 host.usage=36（预算 18）
```
**E2-F7（直接 steer）**
```
budget=18；第一轮进行中直接 await a.steer(...) → 未抛错；结束后 host.usage=36
```
**E2-F8（检查顺序）**
```
(a) 深度超+预算耗尽 → 报「分身深度 2 超过 maxDepth=1」
(b) 名额超+预算耗尽 → 报「已达到 maxAgents=2 的分身上限」
(c) 深度+名额+预算全超 → 报「分身深度 1 超过 maxDepth=0」
```
**E2-F9（预检 vs 登记）**
```
checkCanCreate(child) → undefined（放行）
register(child) → 抛错「宿主里已经有 id=a19 的分身，id 必须唯一」
```
- **读出的现象**：预算这一道只在 `prompt()`（空闲投递路径）与 `spawn_agent` 预检里；`followUp`/`steer` 路径没有检查。`send()` 是 fire-and-forget，错误只通过 `error` 事件。
- **结论**：预算是**开放式的软约束**：轮前判、单轮不封顶、队列通道不设防。`send()`「永不抛错」的代价是**谎报 `ran` + 静默吞消息**。护栏触发理由受固定检查顺序限制，只会给出第一条。

### 4.2 真模型预算耗尽 —— 未做

- 我没有跑真模型。可用的只有**假 provider 的机制层**（E2）。既有报告 §4.3/`F1a` 已有真模型完整过程（`budgetTokens=12000`：前 4 轮成功、第 5 轮抛错、超支 1.23×、已完成的 `lastResult` 可读）。**那部分原始输出不在我手里，不予复述。**

### 4.3 / 4.4 / 4.5 —— 未做

- 4.3 锁死轮次量化：我只有 E1-A3 的「回收后仍被拒」单项，没有跑「长驻起→收→再起」的轮次曲线。
- 4.4 按分支分配预算：一行代码都没写。
- 4.5 汇总：见上方对照表。

## 清单

| # | 现象 | 类别 | 严重度 | 证据 |
|---|---|---|---|---|
| 1 | `maxAgents` 是终身累计数，回收后仍误触发 | 极限 | 中 | E1-A3 |
| 2 | 并发触发 maxAgents 时 `spawn_agent` 抛异常（契约是返文本） | 静默失败/缺口 | 中 | E1-A4 |
| 3 | 回收中间层使后代变孤儿，`depthOf` 复位到 1，`maxDepth` 失效 | 极限 | 中 | E1-B2/B3 |
| 4 | `maxDepth=0`/负数把顶层也拦下（负数），语义易误读 | 缺口 | 低 | E1-B4 |
| 5 | `budget=0`/负数时连顶层都建不起来 | 能力 | 低 | E2-F1 |
| 6 | 预算轮前检查，单轮中途不设限，单轮超支上不封顶（实测 36×） | 极限 | 高 | E2-F2 |
| 7 | 预算耗尽后 `send()` 谎报 `delivered:"ran"`、消息静默吞掉、无监听者完全无感 | **静默失败** | 高 | E2-F3/F4 |
| 8 | 忙时 `send()`（followUp）与 `steer()` **完全绕过预算检查**，耗尽后仍可继续花 | 缺口 | 高 | E2-F5/F7 |
| 9 | 同 API 在 idle/busy 下对预算反应相反，语义不可预测 | 缺口 | 中 | E2-F6 |
| 10 | 多护栏同时违反只报第一条，不含其余违反项 | 缺口 | 低 | E2-F8 |
| 11 | 预检与登记两份实现，判断集合不一致 → 竞态根因 | 缺口 | 中 | E2-F9 |
