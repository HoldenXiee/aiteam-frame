# 多 Agent 派活能力与极限审查报告（修订版）

> 本报告整合能力组小结（修订版）、极限组小结（据审查意见 + src 复核修订）与审查员意见，并按待办留档第 1 轮原始两份小结。所有结论均按材料原文整理，未增删结论。

## 能力证据

【CAP-组小结】（修订版）

1. **能力真实存在**：`src/agent/create-agent.ts:65` 返回 `spawn_agent`/`send_message` 工具工厂，spec.tools 点名即自动挂载——派活是真实接线。
2. **边界被代码锁死**（路径已修正）：`src/tools/spawn-agent.ts:33` 用 `Type.Union(names.map(name => Type.Literal(name)))`，当花名册为空时退化为 `Type.Never()`；文件首行注明「这个工具没有 tools 参数，也不接受任何配置覆盖」——红线由类型系统落实。
3. **事件契约**：`src/agent/events.ts`（48 行）把 pi 的 `AgentSessionEvent` 归一化为框架稳定的 `NormalizedEvent`（text/thinking/tool_start/tool_end/turn/error/done），并在此累加 `runUsage`，是事件翻译层兼用量统计入口；不碰会话状态，可直接单测。
4. **规模**：src/agent 下 6 个 .ts 共 864 行（create-agent 339、types 183、host 147、loader 116、events 48、usage 31），依赖仅 pi-ai、pi-coding-agent、typebox。

结论：能挑人、能派活、能回收，不能改配置，均有 文件:行号 级证据与实测数字支撑。

另说明：审查意见第 2、3 条（排队/串台、details 回传 agentId）针对的是极限组小结，不在本篇能力组小结的主张范围内，本次不作合并。

## 风险证据

【LIMIT-组小结】（据审查意见 + src 复核修订）

**逐条认错/收紧**

1. 路径错：spawn-agent 工具实现在 `src/tools/spawn-agent.ts`（由 `agent/create-agent.ts:18` 的 `../tools/spawn-agent.ts` 上跳一级证实），不是 `src/agent/tools/`。
2. 原「重叠投递会静默串台」**降级为不可复现**：守卫真实存在——`create-agent.ts:241` 以 `running>0 || session.isStreaming` 判忙，忙时走 `steer`(:242)/`followUp`(:243) 返回 `{delivered:"queued"}`，串行排队不重叠；绕过 `send` 直调 `agent.prompt()` 得到的是 SDK "already-processing" **抛错**(:216-220)，不是串台。K 节所述症状只可能来自绕过 ControlledAgent 直调 session 原语的路径，**在正常工具链上不成立**。
3. 原「无归因」**撤回**：`tools/spawn-agent.ts:56` 回 `details:{agentId}`，`send-message.ts:54` 回 `{agentId, delivered}`。**成立的部分只剩**：无进度、无重试字段——`delivered` 是 ran/queued 二态，`create-agent.ts:246` 的 `void prompt(text)` 是 fire-and-forget。

**修订后的三条真实极限**

- 委派仍是"对话"粒度：无轮次进度、无重试语义、无工作项状态机，多任务跟催只能靠外部记文本（聚合实测 2/5）。
- 失败语义最薄：`src/agent/events.ts` 只把错误压成一种 `error` 事件形状（`:1` 自陈"不碰会话状态"），不携带可决策的错误类别，重试/换人/降级无从判定。
- 结果归属靠 WeakSet 身份差集（`create-agent.ts:162/196`），无 run 级边界；`:180-181` 自陈启动窗口竞态，靠 `running` 计数与双条件判忙补住——即**正确性依赖调用方一律走 send 工具**，一旦绕过，防线从"隔离"退化为"抛错"。

**上限结论**：适合低并发、串行队列、人工可核对的场景；不适合需要进度追踪、失败自动处置、或旁路直调底层的团队化编排。

### 第 1 轮原始小结（留档）

【LIMIT-组小结·原始】

一、静默串台（最硬的极限面）：同一 agent 在被跑期间遭重叠投递时结果会串台，`spawn_agent` 返回父文本变成后一条消息的答案。根因在 `collectRun()` 排干共享池"所有未计过的"消息，仅在严格串行的前提下才等价于"本次运行"。设计者查不出：三方对账同源所以"错得自洽"，并发实验又只测"多个不同 agent"。二、委派单位错位：`{member, task:string} -> text`，是"对话"不是"工作项"——无进度、无重试、无归因，聚合只能靠正则猜散文（实测 2/5）。三、失败无语义：一条字符串、4 条错误通道、16 条静默失败，无法判定重试/换人/降级/放弃。结论：8–10 人团队下，二与三叠加=坏任务既管不住也发现不了；一则让"结果可信"这个前提本身失效。当前上限止于低并发、串行、可目视核对的规模。

【CAP-组小结·原始】能力组调研结论（证据来自 src_reader 与 code_probe）：1. 能力真实存在：`agent/create-agent.ts:65` 返回 `spawn_agent`/`send_message` 的内置工具工厂，spec.tools 点名即自动挂载——「派活」是真实接线，非文档承诺。2. 边界被代码锁死：`agent/tools/spawn-agent.ts:33` 用 `Type.Union(names.map(...Literal))` 把 `member` 限定为花名册枚举，且文件明确「这个工具没有 tools 参数」，不暴露 tools/cwd/模型——「agent 不能设计 agent」的红线由类型系统落实，不是纪律约束。3. 实现规模：src/agent 下 6 个 .ts 文件（create-agent 339、host 147、loader 116、types 183、events 48、usage 31）合计 864 行，仅依赖 pi-ai、pi-coding-agent、typebox。结论：框架「能挑人、能派活、能回收」，但「不能改配置」。

## 实测输出

- 派活接线实测：`src/agent/create-agent.ts:65` 返回 `spawn_agent`/`send_message` 工具工厂，spec.tools 点名即自动挂载。
- 花名册为空时成员枚举退化为 `Type.Never()`（`src/tools/spawn-agent.ts:33`）。
- src/agent 规模：6 个 .ts 共 864 行 = create-agent 339 + types 183 + host 147 + loader 116 + events 48 + usage 31；依赖仅 pi-ai、pi-coding-agent、typebox。
- `src/agent/events.ts` 共 48 行，归一化输出 text/thinking/tool_start/tool_end/turn/error/done，并累加 `runUsage`。
- 多任务跟催聚合实测：2/5（无轮次进度、无重试语义、无工作项状态机，只能靠外部记文本）。
- 忙判定实测：`create-agent.ts:241` 以 `running>0 || session.isStreaming` 判忙；忙时 `steer`(:242)/`followUp`(:243) 返回 `{delivered:"queued"}`；绕过 `send` 直调 `agent.prompt()` 得 SDK "already-processing" 抛错(:216-220)。
- 归因字段实测：`tools/spawn-agent.ts:56` 返回 `details:{agentId}`，`send-message.ts:54` 返回 `{agentId, delivered}`，`delivered` 为 ran/queued 二态。
- fire-and-forget 实测点：`create-agent.ts:246` 的 `void prompt(text)`。
- 失败语义通道计数（原始小结留档数字）：一条字符串、4 条错误通道、16 条静默失败。
- 结果归属实测点：WeakSet 身份差集 `create-agent.ts:162/196`，无 run 级边界；`:180-181` 自陈启动窗口竞态。
- 路径证实：`agent/create-agent.ts:18` 的 `../tools/spawn-agent.ts` 上跳一级，证明实现在 `src/tools/spawn-agent.ts`。

## 审查意见处理

审查员意见：

1. 小结一「agent/tools/spawn-agent.ts:33」路径错，应作 src/tools/。
2. 小结二「遭重叠投递时结果会串台」不成立：send 忙时排队，需直调 prompt。
3. 小结二「无进度、无重试、无归因」不实：结果 details 已回 agentId。

处理结果：

- 意见 1：**采纳**。能力组小结已修正路径为 `src/tools/spawn-agent.ts:33`；极限组小结承认路径错，并由 `agent/create-agent.ts:18` 的 `../tools/spawn-agent.ts` 上跳一级证实。
- 意见 2：**采纳**。原「重叠投递会静默串台」降级为不可复现：`create-agent.ts:241` 忙判定 + `:242/:243` steer/followUp 排队返回 `{delivered:"queued"}`，串行排队不重叠；绕过 `send` 直调 `agent.prompt()` 得到的是 SDK "already-processing" 抛错(:216-220)，不是串台。该症状只可能来自绕过 ControlledAgent 直调 session 原语的路径，在正常工具链上不成立。
- 意见 3：**采纳**。原「无归因」撤回：`tools/spawn-agent.ts:56` 回 `details:{agentId}`，`send-message.ts:54` 回 `{agentId, delivered}`；成立的部分只剩「无进度、无重试字段」——`delivered` 是 ran/queued 二态，`create-agent.ts:246` 的 `void prompt(text)` 是 fire-and-forget。
- 合并范围说明：审查意见第 2、3 条针对的是极限组小结，不在能力组小结的主张范围内，本次不作合并（见「能力证据」节末说明）。
- 修订后保留结论：三条真实极限（对话粒度、失败语义最薄、结果归属靠 WeakSet 身份差集）；上限结论为适合低并发、串行队列、人工可核对的场景，不适合需要进度追踪、失败自动处置、或旁路直调底层的团队化编排。
