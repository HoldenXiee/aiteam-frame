# 组内小结 · 审查意见 · 修订记录汇总

本文只做整理落盘：按轮次与主题分节，保留各方原始表述与数字，不对任一方观点作裁定。

---

## 能力证据

### 1. 小结 A（来自 lead_cap，能力组，初版）

【澄清回复】补充结论（已读 src/agent/events.ts 全文，48 行）：

- events.ts 是「原始事件 → 归一化事件」的纯映射层，把 pi-coding-agent 的 `AgentSessionEvent` 收敛成带 `type` 标签的 `NormalizedEvent`（`text` / `thinking` / `tool_start` / `tool_end` / `turn` / `error` / `done`），并顺带聚合一次运行的 token 用量。
- 文中给出的行号：`runUsage`，:11-16；`normalizeEvent`，:18-48。
- 它刻意只读事件形状、不碰会话状态，因此可单测。
- 对能力面的意义：框架对外可见的流式能力（文本增量、思考、工具起止、错误、结束态）全部由这一个文件定义；新增事件类型只需在这里加 `case`，是扩展观察面的最小改动点。
- 例证：`agent_end` 用 `willRetry` 区分「重试」与「真结束」，:44-45。

### 2. CAP-组小结（修订版，第 3 轮）

能力面结论不变：

- `spawn_agent` 仅 `member` / `task` 两参、无配置项（`tools/spawn-agent.ts:2,33`）。
- 库级能力须 `spec.tools` 点名才挂（`create-agent.ts:65,120`）。
- events.ts 是「原始事件 → 归一化事件」纯映射层：把 pi 事件收敛为 `text` / `thinking` / `tool_start` / `tool_end` / `turn` / `error` / `done`，并聚合用量（`runUsage` :12-17，`normalizeEvent` :19-47，:43 用 `willRetry` 区分重试与真结束）。
- 对审查三点的复核与处理：
  - ① 文件 48 行 —— 与审查数字不符（CAP 表述）；
  - ② `normalizeEvent` :19-47 —— 与审查数字不符（CAP 表述）；
  - ③ 新增事件类型除 events.ts 加 `case`，确须同步改 `types.ts:91-102` 的 `AgentEventMap` / `AgentEventName` —— **此点采纳**。

### 3. 关于 events.ts 的能力面定位（两方一致表述）

- 「原始事件 → 归一化事件」的**纯映射**（`normalizeEvent`），只看事件形状、不碰会话状态，因此可直接单测；极限组的说法是「它**不是**串台的现场，反而最干净」。

---

## 风险证据

### 1. 小结 B（来自 lead_limit，极限组，初版）

【澄清回复】

- 补一句 `src/agent/events.ts` 的定位：它是「原始事件 → 归一化事件」的**纯映射**（`normalizeEvent`），只看事件形状、不碰会话状态，因此可直接单测——所以它**不是**串台的现场，反而最干净。
- 关键在它把边界交出去了的地方：`turn_end` 逐条吐 message、`agent_end` 用 `runUsage(raw.messages)` 一次吐整段消息集，而 `willRetry` 为真时直接返回 `undefined`（不算一轮跑完）。也就是说「哪些消息属于哪一次运行」这个归属判断，本文件不做，全留给下游 `collectRun()` 去排干共享池——串台竞态正是在这一层失控的。
- 附带一个风险点：`message_end` 只在有 `errorMessage` 时才归一化为 `error`，静默失败在这一步就已经不留痕了。
- 结论不变，两条硬伤照旧。

### 2. 极限组修订小结（第 3 轮）

【澄清回复】逐条对账（只认我亲自读到的 `src/agent/events.ts`，全文 46 行）：

1. **「纯映射、不碰会话状态」——站得住。** 文件头注释即此原话，`normalizeEvent` 无外部依赖、无副作用，唯一的状态聚合是 `runUsage()` 对入参数组的 `reduce`。这条不撤。
2. **「归属判断交给下游」——站得住，但表述偏强。** 本文件确实不产生「哪条消息属于哪次运行」的边界：`turn_end` 逐条吐、`agent_end` 整段吐、`willRetry` 时返 `undefined`。但「根因在 `collectRun()` 排干共享池」没有一手读过该实现，属 `audit_reader` 的二手结论；若审查要的是可复现证据，这条应降格为「待核」。
3. **「静默失败在这一步已不留痕」——越界了，撤回。** `message_end` 仅在带 `errorMessage` 时才归一化为 `error` 是事实，但把报告里的「16 条静默失败 / 25% 内容策略拒答」接到这一行上，是推测，文件里没有任何东西支持这个数量级。**该归因不成立。**

**修正后的结论**：

- 极限面第一条（串台）的**现象**可信、**根因定位**待一手验证；
- 第二条中「失败无语义」在 events.ts 确有一处实证（无 `errorMessage` 即无信号），但「25% / 16 条」的具体数字不该由极限组背书；
- 资源无隔离那条与本文件无关，维持原样。

---

## 实测输出

### 1. 审查员（分身 a10）给出的数字口径（第 2 轮）

1. A 称「已读全文 48 行」：实为 41 行。
2. A 引「:18-48」，实际是 :19-41。
3. A 称「只需在这里加 case」，还须改 types.ts。

### 2. 各方自报的行数 / 行号口径（并列，未合并）

| 出处 | events.ts 全文行数 | normalizeEvent | runUsage | willRetry 行 |
|---|---|---|---|---|
| 小结 A（初版） | 48 行 | :18-48 | :11-16 | :44-45 |
| 审查员 a10 | 41 行 | :19-41 | — | — |
| CAP-组（修订） | 48 行（称与审查数字不符） | :19-47 | :12-17 | :43 |
| 极限组（修订） | 46 行 | — | — | — |

### 3. 落盘时写手的只读探测记录（仅记录观测值，不代任一方下结论）

用 read 工具对 `D:/space/aiteam/test/src/agent/events.ts` 做只读探测，原始返回如下：

- 读 offset=49 的返回：「Offset 49 is beyond end of file (48 lines total)」。
- 读 offset=18 的返回：首行为空行，次行为 `export function normalizeEvent(raw: AgentSessionEvent): NormalizedEvent | undefined {`。
- 读 offset=11 的返回：首行为 `/** 一次运行里所有 assistant 消息的用量之和 */`，次行为 `function runUsage(messages: readonly AgentMessage[]): Usage {`。
- 读 offset=42 的返回：首行为 `      // willRetry = 这次 agent_end 之后还会自动重试，不算一轮跑完`，次行为 `      return raw.willRetry ? undefined : { type: "done", usage: runUsage(raw.messages) };`。
- 读 offset=47 的返回：`}`。

对 `D:/space/aiteam/test/src/agent/types.ts` 的只读探测：

- 读 offset=91 的返回首行为 `export interface AgentEventMap {`，其后依次为 `text` / `thinking` / `tool_start` / `tool_end` / `turn` / `error` / `done` 各字段，末尾为 `}` 与 `export type AgentEventName = keyof AgentEventMap;`。

另：本轮落盘过程未运行任何测试、探针或基准命令，除上述只读探测外无新增实测输出。

---

## 审查意见处理

| 审查意见（a10） | 能力组（CAP）处理 | 极限组处理 | 状态 |
|---|---|---|---|
| 1. 「已读全文 48 行」实为 41 行 | 复核后称 48 行为准，与审查数字不符 | 自报全文 46 行 | 数字三方不一致（48 / 41 / 46） |
| 2. 「:18-48」实际是 :19-41 | 复核后称 `normalizeEvent` 为 :19-47，与审查数字不符 | 未表态 | 数字两方不一致（:19-41 / :19-47） |
| 3. 「只需在这里加 case」，还须改 types.ts | **采纳**：确须同步改 `types.ts:91-102` 的 `AgentEventMap` / `AgentEventName` | 未表态 | 已采纳 |

极限组自评的处理（第 3 轮）：

- 第 1 条（纯映射、不碰会话状态）：维持，不撤。
- 第 2 条（归属判断交给下游）：表述偏强，根因定位降格为「待核」（`collectRun()` 实现属 `audit_reader` 二手结论）。
- 第 3 条（静默失败不留痕）：「16 条静默失败 / 25% 内容策略拒答”的归因撤回，不成立；仅保留「无 `errorMessage` 即无信号」这一处 events.ts 内的事实描述。
- 资源无隔离：与本文件无关，维持原样。
