# aiteam v2 核心库 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 aiteam 从「创建时定型、库含策略」的 v1 重写为「七个运行期句柄、库不含策略」的 v2 核心库。

**架构：** `createAgent(spec)` 建一个 `Agent`，上面挂七个面（`io` / `context` / `tools` / `permissions` / `extensions` / `skills` / `model`）。七面共用**一个常驻桥接扩展**：它把内存里的三张表（工具表、监听表、门）在每次 `session.reload()` 时整体接回 pi。运行期增删工具/插件/技能 = 改表 + 一次 reload；事件观测走 pi 的 41 个扩展钩子全量透传。库不含花名册、内置工具、护栏、红线、寻址。

**技术栈：** TypeScript（`erasableSyntaxOnly`，Node 24 原生跑 `.ts`），`@earendil-works/pi-coding-agent@0.99.1`，`typebox`，`node:test`。

**规格：** [`docs/superpowers/specs/2026-10-02-runtime-surfaces-design.md`](../specs/2026-10-02-runtime-surfaces-design.md)（rev.3）
**证据链：** [`spike/FINDINGS.md`](../../../spike/FINDINGS.md)

---

## 全局约束

- 依赖版本固定 `@earendil-works/pi-coding-agent@0.99.1`；类型一律从 pi 直接 import，**不自己重定义**。
- **L1 不做任何 SDK 已经做了的事**；不改变未使用面的 pi 行为。
- 测试一律走本机假 provider，`PI_OFFLINE=1`，**零 API 成本**。
- **凡是碰「声明面」的都是 async**（`tools.add/remove`、`extensions.add/remove`、`skills.add/remove`），因为它们走 `session.reload()`；`permissions.allow/deny/only`、`context.*`、`model.*` 是同步的。
- 增删类操作**必须 idle**（`!session.isStreaming && pendingMessageCount === 0`），否则抛错。实测 pi 自己**不抛**（`spike/s3-reload-while-running.ts`），这个守卫是库的责任。
- `createAgent(spec)` 遇到**未知字段名必须抛错**并列出可用字段（消灭 v1 的头号失败模式：写错一个字符、功能静默消失）。
- 提交：Conventional Commits + 中文描述。

## 审查重点（Review Focus）

以下 5 条是规格隐含、最容易静默伤到使用者的输入类别。每条都必须有测试钉住（括号内是负责它的任务）。

1. **事件名拼错**（`agent.on("tool_calls", fn)`）：JS 运行期必须立刻抛错并列出可用事件名，而不是静默永不触发。（任务 1）
2. **spec 字段名拼错**（`{ permisions: {...} }`）：`createAgent` 必须抛错并指出未知字段，而不是静默忽略。（任务 1）
3. **忙时调 `io.prompt`**：必须抛错并把调用者导向 `io.queue`，不能像 v1 那样留下「没跑却报成功」的路径。（任务 2）
4. **`model.set` 写错模型名 / 非法 thinking 值**：必须抛错（v1 决策 #28 的教训：`resolveCliModel` 只给 warning，非法 thinking 会静默回落）。（任务 7）
5. **`dispose()` 之后继续操作**：必须抛错（`status === "disposed"`），不静默。（任务 2）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/agent/types.ts` | 全部对外类型，无运行时代码 |
| `src/agent/bridge.ts` | 三张表（工具/监听/门）+ 41 个钩子的派发 + idle 守卫 + reload + `AgentContext` 包装 |
| `src/agent/create-agent.ts` | `createAgent(spec)`：配置校验、loader、session、桥接、七面装配、生命周期 |
| `src/agent/loader.ts` | **保留**：skills / extensions / role 收敛（签名不变） |
| `src/agent/usage.ts` | **保留不动**：用量累加 |
| `src/agent/env.ts` | **保留**：`inspectEnv` 只读自检（入参类型改为新的 `AgentInit` 子集） |
| `src/surfaces/io.ts` | 驱动 + **结算**（runId、`agent_start`→`agent_settled` 区间） |
| `src/surfaces/context.ts` | `history` / `usage` / `override` / `compact` / `autoCompact` |
| `src/surfaces/tools.ts` | `tools`（表 + reload）与 `permissions`（门 + 工具集）两个面 |
| `src/surfaces/resources.ts` | `extensions` 与 `skills` 两个面（同为「改 loader + reload」） |
| `src/surfaces/model.ts` | 模型与思考档 |
| `src/index.ts` | 唯一导出入口 |
| `test/helpers.ts` | 假 provider 装置 + `makeAgent()` |
| `test/*.test.ts` | 每个任务一个新测试文件 |

`tools` 与 `permissions` 同文件、`extensions` 与 `skills` 同文件，是因为它们的**机制同形**（共用 reload / 共用 loader）；对外的对象仍是四个独立的面。

## 本计划不覆盖（另立 Plan 2）

规格 §6 的迁移部分：`examples/`（花名册 / spawn / send / 护栏 / 红线用七面重写）、`docs/` 重写、`demo/` 重做、`audit/` 标注冻结。它们依赖核心的最终 API 形状，等 Plan 1 落地后再立。

---

### 任务 1：骨架与桥接机制

**文件：**
- 创建：`src/agent/types.ts`（重写）、`src/agent/bridge.ts`、`src/agent/create-agent.ts`（重写）、`src/index.ts`（重写）、`test/helpers.ts`（重写）、`test/bridge.test.ts`
- 删除：v1 测试 `test/{agent-dir,create-agent,define-agent-tool,events,host,send-message,send,shapes,smoke,spawn-agent,tool-whitelist,model-network}.test.ts`
- 保留：`test/{loader,env}.test.ts`（它们测的模块在 v2 仍然存在）

- [ ] **步骤 1：删掉 v1 测试（git 历史保留），重写 `test/helpers.ts`**

```bash
git rm test/agent-dir.test.ts test/create-agent.test.ts test/define-agent-tool.test.ts \
       test/events.test.ts test/host.test.ts test/send-message.test.ts test/send.test.ts \
       test/shapes.test.ts test/smoke.test.ts test/spawn-agent.test.ts test/tool-whitelist.test.ts \
       test/model-network.test.ts
```

`test/helpers.ts` 必须**保留这些导出名**（`test/env.test.ts` 依赖它们）：`faux`、`fauxAgentDir`、`fauxCwd`、`FAUX_MODEL_REF`。新增：

```ts
export async function makeAgent(spec: AgentInit = {}): Promise<Agent>
export function sentTools(index?: number): string[]     // 模型实际收到的工具名
export function sentMessages(index?: number): number    // 模型实际收到的消息条数
export function echoTool(name = "probe_echo"): AgentTool // 一个只回显的静态工具
```

`makeAgent` 内部：`createAgent({ agentDir: fauxAgentDir, cwd: fauxCwd, model: FAUX_MODEL_REF, ...spec })`。

`makeFauxRuntime` 内部：`makeFauxRuntime` 现在要**写两个模型**（`echo` 与 `echo-alt`），并导出 `FAUX_MODEL_ALT_REF = "faux/echo-alt"`。改动方式：`writeModelsJson(agentDir, baseUrl, modelIds: string | string[] = FAUX_MODEL_ID)` —— 默认值不变，`test/env.test.ts` 不受影响。

- [ ] **步骤 2：编写失败的测试 `test/bridge.test.ts`**

```ts
test("默认 agent 的声明面 = pi 的四个内置工具（桥接不改变基线行为）", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("hi");
    assert.deepEqual(sentTools(), ["read", "bash", "edit", "write"]);
    assert.equal(sentMessages(), 2);
  } finally { a.dispose(); }
});

test("agent.on 收到 pi 的原始事件，ctx 里挂着 agent 与 runId", async () => {
  const a = await makeAgent();
  const seen: { type: string; cwd?: string; isIdle?: string; agent?: string; runId?: string }[] = [];
  const off = a.on("agent_settled", (e, ctx) => {
    seen.push({ type: e.type, cwd: ctx.cwd, isIdle: typeof ctx.isIdle, agent: ctx.agent.id, runId: ctx.runId });
  });
  try {
    await a.io.prompt("hi");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "agent_settled");
    assert.equal(seen[0].agent, a.id);
    assert.equal(seen[0].isIdle, "function");
    assert.equal(typeof seen[0].cwd, "string");
  } finally { a.dispose(); }
});

test("on 返回的退订函数生效", async () => { /* 退订后再跑一轮，计数不再增长 */ });

test("事件名拼错 → 立刻抛错并列出可用事件名", async () => {
  const a = await makeAgent();
  try {
    assert.throws(() => a.on("tool_calls" as never, () => {}), /tool_calls/);
  } finally { a.dispose(); }
});

test("spec 未知字段 → 抛错并指出字段名", async () => {
  await assert.rejects(() => makeAgent({ permisions: {} } as never), /permisions/);
});

test("dispose 之后操作 → 抛错", async () => {
  const a = await makeAgent();
  a.dispose();
  assert.equal(a.status, "disposed");
  await assert.rejects(() => a.io.prompt("x"), /disposed/);
});
```

- [ ] **步骤 3：运行测试确认失败**

运行：`npm test -- --test-name-pattern="声明面|agent.on|退订|拼错|未知字段|dispose 之后"` → 预期：全部 FAIL（`a.io` 不存在 / `createAgent` 仍是 v1 签名）。

- [ ] **步骤 4：实现 `src/agent/types.ts`**

锁死这些名字与签名（类型从 pi import，不重定义）：

```ts
export type ThinkingLevel = AgentSession["thinkingLevel"];
export type AgentMessage = AgentSession["messages"][number];
export type AgentContext = ExtensionContext & { readonly agent: Agent; readonly runId: string | undefined };

export interface AgentInit {
  id?: string; cwd?: string; agentDir?: string;
  modelNetwork?: boolean; catalogBaseUrl?: string; role?: string;
  model?: string; thinking?: ThinkingLevel;
  permissions?: { only?: string[]; deny?: string[]; gate?: ToolGate };
  tools?: { custom?: AgentTool[] };
  context?: { autoCompact?: boolean };
  skills?: (string | Skill)[];
  extensions?: (string | InlineExtension)[];
}

export interface Agent { /* 见规格 §4.1：id/usage/status + 七个面 + on/onAny/dispose */ }
export interface RunResult { runId: string; text: string; usage: Usage; error?: string; messages: AgentMessage[] }
export interface ToolContext { readonly agent: Agent; signal?: AbortSignal }
export type AgentTool = ToolDefinition | ((ctx: ToolContext) => ToolDefinition);
export type ToolGate = (call: { name: string; input: unknown; callId: string }, ctx: AgentContext) => Promise<{ block: true; reason?: string } | undefined>;
```

`permissions` 里**没有 `allow`**：创建时最常说的是「只给它这几个」，所以创建期用 `only`（精确白名单）+ `deny`；运行期三者都有（`allow` = 并集启用、`deny` = 移除、`only` = 精确设置）。

**读写形式统一约定**（避免每个面各一套）：

- **简单状态用 getter/accessor**：`context.autoCompact`（可读写）、`context.history`（只读）、`context.usage`（只读）、`model.current` / `model.thinking` / `model.available`（只读）、`io.pending` / `io.isRunning`（只读）。
- **要计算或返回新数组的用方法**：`tools.list()`、`extensions.list()`、`extensions.errors()`、`skills.list()`。
- **有副作用的用方法**：`io.*`、`context.override/compact`、`tools.add/remove/onResult`、`permissions.*`、`extensions.add/remove`、`skills.add/remove`、`model.set/setThinking`。
- `permissions.gate(fn)` **只写不读**（读当前门没有使用场景）。

- [ ] **步骤 5：实现 `src/agent/bridge.ts`**

三个要点，其余照签名写：

1. **41 个事件名硬编码成数组**（`EVENT_NAMES`），桥接工厂里逐个 `pi.on(name, dispatcher)`；派发器把事件交给监听表，合并规则**照搬 pi**：最后一个非空结果生效（pi 用**真值判据** `if (handlerResult)`，所以 `undefined` / `null` / `0` / `''` 都不覆盖前一个有效结果），返回 `{block:true}` 立即短路。数组旁写明它对应 `ExtensionEvent["type"]`。

**注意（rev.2 修正）**：本计划早版曾写成「取第一个非 `undefined` 的返回值」，那是错的——pi 的 `emitToolCall` / `emitContext` 实测都是 **last-wins**（`runner.js:951-969`：`if (handlerResult) { result = handlerResult; if (result.block) return result }`）。以实际实现与 pi 源码为准。

另外：桥接是 pi 的**单个**扩展，**无法复刻 pi 跨扩展的链式传递**（后一个 handler 看到前一个处理后的结果）。所以桥接内部监听器拿到的是**原始事件**；因此**同一个事件上只允许一个监听器返回变换结果**——第二个非 `undefined` 的返回值必须**抛错**，而不是静默丢弃前一个的结果。
2. **`wrapCtx`**：`{ ...piCtx, agent, runId }`。实测展开安全（S5），**不要**用 Proxy。
3. **`reload()` 守卫**：`if (session.isStreaming || session.pendingMessageCount > 0) throw new Error("…必须等 agent 空闲…")`，然后 `await session.reload()`。

```ts
export interface Bridge {
  readonly tools: Map<string, AgentTool>;          // 名称 → 工具（工厂或定义）
  readonly listeners: Map<string, Set<Handler>>;   // 事件名 → 监听器（含门、onResult、override）
  readonly factory: InlineExtension;                // 每次 reload 重跑：三张表接回 pi
  gate: ToolGate | undefined;
  contextOverride: ((messages: AgentMessage[]) => AgentMessage[]) | undefined;
  setRunId(id: string | undefined): void;
  reload(): Promise<void>;                          // 带 idle 守卫
  eventNames(): string[];
}
export function createBridge(deps: { session: () => AgentSession; agent: () => Agent }): Bridge;
```

- [ ] **步骤 6：实现 `src/agent/create-agent.ts`**

保留 v1 的 `getSharedRuntime`（按 agentDir+开关缓存，决策 #8/#30）、`resolveModel`（warning 转抛错，决策 #28）、`nextId`。新增：**spec 未知字段校验**（顶层键 + 每个面对象内的键，逐面白名单，未知即抛）。

本任务只建 **`io` 的最小驱动版**（`prompt` = `assertAlive()` + `await session.prompt(text)`，加上 `waitIdle` / `isRunning` / `status`），其他六个面先留空对象占位。真正的结算（`runId` / 区间 / `usage` 归属）与 `queue` / `steer` / `abort` / `pending` 是任务 2 的事。

顺手改两处 import（因为本任务重写了 `types.ts`，删掉了 `MemberSpec`）：`src/agent/loader.ts` 的 `MemberSpec` → `ResourceSpec`（在 types.ts 里定义为 `{ skills?, extensions?, role? }`），`src/agent/env.ts` 的 `MemberSpec` → `Partial<AgentInit>`。**不改这两个文件的其余内容**（env 的完整适配归任务 8）。

- [ ] **步骤 7：运行测试确认通过**

运行：`npm test` → 预期：新增 6 个用例 PASS，`loader.test.ts` / `env.test.ts` 仍 PASS。

- [ ] **步骤 8：Commit**

```bash
git add -A && git commit -m "feat(v2): 七面骨架 + 常驻桥接扩展 + 原始事件透传"
```

---

### 任务 2：io 面与结算

**文件：**
- 创建：`src/surfaces/io.ts`、`test/io.test.ts`
- 修改：`src/agent/create-agent.ts`（把任务 1 的最小驱动版换成真结算）

- [ ] **步骤 1：编写失败的测试 `test/io.test.ts`**

```ts
test("prompt 返回与本次运行绑定的 RunResult", async () => {
  const a = await makeAgent();
  try {
    const r = await a.io.prompt("hello");
    assert.equal(r.text, "echo:hello");
    assert.equal(r.usage.totalTokens, 18);
    assert.equal(r.usage.cost.total, 0);
    assert.match(r.runId, /^r\d+$/);
    assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant"]);
  } finally { a.dispose(); }
});

test("连续两次 prompt 不串台（v1 的排干式 bug 的回归）", async () => {
  const a = await makeAgent();
  try {
    const r1 = await a.io.prompt("aaa");
    const r2 = await a.io.prompt("bbb");
    assert.equal(r1.text, "echo:aaa");
    assert.equal(r2.text, "echo:bbb");
    assert.notEqual(r1.runId, r2.runId);
    assert.equal(r1.messages.length, 2);          // 只含本次
  } finally { a.dispose(); }
});

test("agent.usage 是累计值", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("one"); await a.io.prompt("two");
    assert.equal(a.usage.totalTokens, 36);
  } finally { a.dispose(); }
});

test("忙时 queue：返回 {queued:true}，消息被并进同一次运行", async () => {
  const a = await makeAgent();
  try {
    const p = a.io.prompt("[[sleep:400]] slow");
    const q = await a.io.queue("追加");
    assert.deepEqual(q, { queued: true });
    const r = await p;
    assert.equal(r.messages.filter((m) => m.role === "user").length, 2);   // 明说它属于同一次
  } finally { a.dispose(); }
});

test("空闲时 queue 也返回 {queued:true}，不谎报 ran", async () => {
  const a = await makeAgent();
  try {
    assert.deepEqual(await a.io.queue("hi"), { queued: true });
    await a.io.waitIdle();
    assert.equal(a.usage.totalTokens, 18);
  } finally { a.dispose(); }
});

test("忙时 prompt → 抛错并指向 queue", async () => {
  const a = await makeAgent();
  try {
    const p = a.io.prompt("[[sleep:400]] slow");
    await assert.rejects(() => a.io.prompt("x"), /queue/);
    await p;
  } finally { a.dispose(); }
});

test("abort 之后能静下来", async () => {
  const a = await makeAgent();
  try {
    const p = a.io.prompt("[[sleep:800]] slow").catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    await a.io.abort();
    await a.io.waitIdle();
    assert.notEqual(a.status, "running");
  } finally { a.dispose(); }
});
```

- [ ] **步骤 2：运行测试确认失败**
运行：`node --test test/io.test.ts` → 预期：FAIL（`Cannot read properties of undefined (reading 'prompt')`）。

- [ ] **步骤 3：实现 `src/surfaces/io.ts`**

结算算法（规格 §5，这是本任务唯一需要写清的非显然部分）：

```ts
// prompt(text):
//   1. assertAlive(); if (isRunning) throw new Error("正在运行：请用 io.queue() 投递")
//   2. const from = session.messages.length
//   3. const runId = nextRunId(); bridge.setRunId(runId); status = "running"
//   4. await session.prompt(text)
//   5. 必然在 agent_settled 之后返回 → 取 session.messages.slice(from) 作为本次区间
//   6. 文本 = 区间内最后一条有文本的 assistant；usage = 区间内各 assistant 消息 usage 之和
//      （用 WeakSet 记已计入累计的对象身份，避免重复计数 —— v1 决策）
//   7. bridge.setRunId(undefined); status = "idle"；返回 RunResult
// queue(text): 忙 → session.followUp(text)；闲 → 起一次 prompt 但不 await（结果只从事件可见）；都返回 {queued:true}
// steer(text): session.steer(text)
// abort(): session.abort()
// waitIdle(): awaiting session.waitForIdle()，且 running 计数为 0 才算静下来
// pending: session.pendingMessageCount
// isRunning: bridge 维护的 running 计数 > 0
```

`runId` 用**模块级全局计数器**（`r1, r2, …`），跨 agent 唯一，便于 trace 关联。

- [ ] **步骤 4：运行测试确认通过**
运行：`node --test test/io.test.ts` → 预期：7 个用例全 PASS。

- [ ] **步骤 5：Commit**
```bash
git add -A && git commit -m "feat(v2): io 面与调用绑定的结算（runId / 区间 / 不再排干共享池）"
```

---

### 任务 3：context 面

**文件：** 创建 `src/surfaces/context.ts`、`test/context.test.ts`；修改 `create-agent.ts`

- [ ] **步骤 1：编写失败的测试 `test/context.test.ts`**

```ts
test("history 是会话里存的历史（只读快照）", async () => {
  const a = await makeAgent();
  try { await a.io.prompt("hi"); assert.deepEqual(a.context.history.map((m) => m.role), ["user", "assistant"]); }
  finally { a.dispose(); }
});

test("override 只改这一轮发给模型的，不动历史", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("one");
    const h1 = a.context.history.length;
    a.context.override((m) => m.slice(-1));
    await a.io.prompt("two");
    assert.equal(sentMessages(), 2);            // system + 1 条
    assert.ok(a.context.history.length > h1);   // 历史照常增长
    a.context.override(undefined);              // 清除
    await a.io.prompt("three");
    assert.ok(sentMessages() > 2);              // 恢复完整
  } finally { a.dispose(); }
});

test("compact() 成功，且 session_before_compact / session_compact 被触发", async () => {
  const a = await makeAgent();
  const fired: string[] = [];
  a.onAny((e) => { if (e.type.includes("compact")) fired.push(e.type); });
  try {
    await a.io.prompt("one");
    await a.context.compact("压成一句");
    assert.ok(fired.includes("session_before_compact"));
    assert.ok(fired.includes("session_compact"));
  } finally { a.dispose(); }
});

test("autoCompact 可读写，且反映到 session", async () => {
  const a = await makeAgent();
  try {
    a.context.autoCompact = true;
    assert.equal(a.context.autoCompact, true);
    assert.equal(a.context.raw.session.autoCompactionEnabled, true);
  } finally { a.dispose(); }
});

test("usage 是上下文占用，读不到时返回 undefined（不抛错）", async () => {
  const a = await makeAgent();
  try { await a.io.prompt("one"); assert.doesNotThrow(() => a.context.usage); }
  finally { a.dispose(); }
});

test("override 也接受直接给一组消息", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("one");
    const keep = a.context.history.slice(-1);
    a.context.override(keep);
    await a.io.prompt("two");
    assert.equal(sentMessages(), 2);
  } finally { a.dispose(); }
});
```

- [ ] **步骤 2：运行确认失败** → `node --test test/context.test.ts` → FAIL。
- [ ] **步骤 3：实现 `src/surfaces/context.ts`**

`override(next)`：把 `next` 归一成函数存入 `bridge.contextOverride`；桥接的 `context` 派发器返回 `{ messages: fn(piMessages) }`。实测（S2）：**只影响本次请求、历史不动、pi 传的是副本**；`context` 钩子拿到的是**不含 system** 的消息。

- [ ] **步骤 4：运行确认通过** → 6 个用例 PASS。
- [ ] **步骤 5：Commit** → `feat(v2): context 面（历史只读 / override 只改本轮 / compact / autoCompact）`

---

### 任务 4：tools 面

**文件：** 创建 `src/surfaces/tools.ts`、`test/tools.test.ts`；修改 `create-agent.ts`

- [ ] **步骤 1：编写失败的测试 `test/tools.test.ts`**

```ts
test("add 之后 reload：模型真的收到新工具的 schema", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());       // await：碰声明面 → reload
    await a.io.prompt("hi");
    assert.ok(sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});

test("加进来的工具真的能被模型调用，且工厂拿得到 ctx.agent", async () => {
  const a = await makeAgent();
  let seenBy: string | undefined;
  try {
    await a.tools.add((ctx) => defineTool({
      name: "probe_echo", label: "Echo", description: "回显",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      execute: async () => {
        seenBy = ctx.agent.id;
        return { content: [{ type: "text" as const, text: "ran" }], details: {} };
      },
    }));
    await a.io.prompt("[[tool:probe_echo]]");
    assert.equal(seenBy, a.id);
  } finally { a.dispose(); }
});

test("创建时给了白名单，add 进来的工具仍然要能用", async () => {
  const a = await makeAgent({ permissions: { only: ["read"] } });
  try {
    await a.tools.add(echoTool());
    await a.io.prompt("hi");
    assert.ok(sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});

test("list 反映注册与活跃状态", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    assert.deepEqual(a.tools.list().find((t) => t.name === "probe_echo"), { name: "probe_echo", active: true });
  } finally { a.dispose(); }
});

test("remove 之后从声明面消失，会话还能继续用", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    await a.tools.remove("probe_echo");
    await a.io.prompt("hi");
    assert.ok(!sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});
test("运行中 add → 抛错（idle 守卫）", async () => {
  const a = await makeAgent();
  try {
    const p = a.io.prompt("[[sleep:400]] slow");
    await assert.rejects(() => a.tools.add(echoTool()), /空闲/);
    await p;
  } finally { a.dispose(); }
});

test("工厂式工具拿得到 ctx.agent", async () => {
  // 已由上面「真的能被调用，且工厂拿得到 ctx.agent」覆盖，此处不重复
});

test("onResult 改工具返回给模型的内容", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    a.tools.onResult(() => ({ content: [{ type: "text", text: "被改过" }] }));
    const r = await a.io.prompt("[[tool:probe_echo]]");
    // 假服务在收到工具结果后会把它回显成文本 —— 所以最终文本能证明模型看到了被改过的结果
    assert.equal(r.text, "echo:被改过");
  } finally { a.dispose(); }
});

test("onResult 的退订函数生效", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    const off = a.tools.onResult(() => ({ content: [{ type: "text", text: "被改过" }] }));
    off();
    const r = await a.io.prompt("[[tool:probe_echo]]");
    assert.notEqual(r.text, "echo:被改过");
  } finally { a.dispose(); }
});
```

- [ ] **步骤 2：运行确认失败** → FAIL。
- [ ] **步骤 3：实现 `src/surfaces/tools.ts` 的 tools 面**

- 注册：`tools.add(tool)` → 存进 `bridge.tools`（键 = `tool.name`；工厂式在 reload 时调用工厂取真名）→ `await bridge.reload()` → **再显式把新工具名并入活跃集**（`setActiveToolsByName([...getActiveToolNames(), name])`）。
  最后这步不能省：实测 S1 只覆盖了「创建时没给白名单」的情形；给了白名单时新注册的扩展工具**不一定会自动 active**（任务 4 的第二个用例就是为这条路钉的钉子）。
- `tools.list()` → `bridge.tools` 的名字 × `session.getActiveToolNames()` 里的活跃状态。
- `tools.remove(name)` → 删表 + reload。
- `tools.onResult(fn)` → 往 `bridge.listeners.get("tool_result")` 加监听器，返回退订。
- 工具执行时 pi 给的 `execute(toolCallId, params, signal)` 已经是最终形态，**不需要 v1 的惰性 holder**（`tools.add` 发生在 agent 构造之后）。

- [ ] **步骤 4：运行确认通过** → 7 个用例 PASS。
- [ ] **步骤 5：Commit** → `feat(v2): tools 面（运行期增删、工厂 ctx.agent、tool_result 拦截）`

---

### 任务 5：permissions 面

**文件：** 修改 `src/surfaces/tools.ts`（加 `permissions`）、创建 `test/permissions.test.ts`

- [ ] **步骤 1：编写失败的测试 `test/permissions.test.ts`**

```ts
test("gate 拦下工具：工具不执行，reason 进上下文", async () => {
  const a = await makeAgent();
  let ran = false;
  try {
    await a.tools.add((ctx) => defineTool({
      name: "probe_echo", label: "Echo", description: "回显",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      execute: async () => { ran = true; return { content: [{ type: "text" as const, text: "ran" }], details: {} }; },
    }));
    a.permissions.gate(async () => ({ block: true, reason: "不许用" }));
    const r = await a.io.prompt("[[tool:probe_echo]]");
    assert.equal(ran, false);
    assert.match(r.text, /不许用/);
  } finally { a.dispose(); }
});

test("gate 原地改 event.input：工具收到改后的参数", async () => {
  const a = await makeAgent();
  let got: unknown;
  try {
    await a.tools.add((ctx) => defineTool({
      name: "probe_echo", label: "Echo", description: "回显",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      execute: async (_id, params) => { got = params; return { content: [{ type: "text" as const, text: "ran" }], details: {} }; },
    }));
    a.permissions.gate(async (call) => { (call.input as { text?: string }).text = "改过"; return undefined; });
    await a.io.prompt("[[call:probe_echo {\"text\":\"原值\"}]]");
    assert.equal((got as { text?: string }).text, "改过");
  } finally { a.dispose(); }
});

test("gate 拦住之后，用户的 on('tool_call') 不会被调用（pi 的短路语义）", async () => {
  const a = await makeAgent();
  let called = 0;
  try {
    await a.tools.add(echoTool());
    a.on("tool_call", () => { called += 1; });
    a.permissions.gate(async () => ({ block: true, reason: "拦" }));
    await a.io.prompt("[[tool:probe_echo]]");
    assert.equal(called, 0);
  } finally { a.dispose(); }
});

test("gate 不拦时，用户的 on('tool_call') 会被调用", async () => {
  const a = await makeAgent();
  let called = 0;
  try {
    await a.tools.add(echoTool());
    a.on("tool_call", () => { called += 1; });
    a.permissions.gate(async () => undefined);
    await a.io.prompt("[[tool:probe_echo]]");
    assert.equal(called, 1);
  } finally { a.dispose(); }
});

test("gate 内 throw → 变成拦截，异常文本进上下文", async () => {
  const a = await makeAgent();
  try {
    await a.tools.add(echoTool());
    a.permissions.gate(async () => { throw new Error("门炸了"); });
    const r = await a.io.prompt("[[tool:probe_echo]]");
    assert.match(r.text, /门炸了/);
  } finally { a.dispose(); }
});

test("only 精确设置工具集", async () => {
  const a = await makeAgent();
  try { a.permissions.only(["read"]); await a.io.prompt("hi"); assert.deepEqual(sentTools(), ["read"]); }
  finally { a.dispose(); }
});

test("allow 是并集、deny 是移除", async () => {
  const a = await makeAgent();
  try {
    a.permissions.only(["read"]);
    a.permissions.allow(["bash"]);
    await a.io.prompt("1");
    assert.deepEqual([...sentTools()].sort(), ["bash", "read"]);
    a.permissions.deny(["bash"]);
    await a.io.prompt("2");
    assert.deepEqual(sentTools(), ["read"]);
  } finally { a.dispose(); }
});

test("创建时 permissions.only 生效", async () => {
  const a = await makeAgent({ permissions: { only: ["read"] } });
  try { await a.io.prompt("hi"); assert.deepEqual(sentTools(), ["read"]); } finally { a.dispose(); }
});
```

- [ ] **步骤 2：运行确认失败** → FAIL。
- [ ] **步骤 3：实现 permissions 面**

- `gate(fn)` → 写 `bridge.gate`；桥接的 `tool_call` 派发器先跑它，返回 `{block, reason}`。`fn` 内 `throw` 时**捕获并转成** `{block:true, reason:String(err)}`（决定 —— 不让异常裸奔）。
- `allow(names)` → `setActiveToolsByName(现有 ∪ names)`；`deny(names)` → `setActiveToolsByName(现有 − names)`；`only(names)` → `setActiveToolsByName(names)`。三者**同步**，不走 reload（实测 S6：`setActiveToolsByName` 是纯内存操作）。
- 创建期 `permissions.only` 直接作为 `createAgentSession` 的 `tools` 选项；`permissions.deny` 作为 `excludeTools`。

- [ ] **步骤 4：运行确认通过** → 8 个用例 PASS。
- [ ] **步骤 5：Commit** → `feat(v2): permissions 面（审批门可改参数、工具集运行期三档语义）`

---

### 任务 6：extensions 与 skills 面

**文件：** 创建 `src/surfaces/resources.ts`、`test/resources.test.ts`；修改 `create-agent.ts`；`test/loader.test.ts` 保持不变（若类型变化导致编译不过，只调 import）

- [ ] **步骤 1：编写失败的测试 `test/resources.test.ts`**

```ts
test("extensions.add(工厂)：其注册的工具出现在声明面", async () => {
  const a = await makeAgent();
  try {
    await a.extensions.add((pi) => pi.registerTool(echoTool()));
    await a.io.prompt("hi");
    assert.ok(sentTools().includes("probe_echo"));
  } finally { a.dispose(); }
});

test("extensions.list() 有 path 与它注册的工具名", async () => {
  const a = await makeAgent();
  try {
    await a.extensions.add((pi) => pi.registerTool(echoTool()));
    const inline = a.extensions.list().find((e) => e.path.startsWith("<inline:"));
    assert.deepEqual(inline?.tools, ["probe_echo"]);
  } finally { a.dispose(); }
});

test("extensions.errors() 可读：坏路径不静默", async () => {
  const a = await makeAgent({ extensions: ["/definitely/not/here.ts"] });
  try { assert.ok(a.extensions.errors().length > 0); } finally { a.dispose(); }
});

test("skills.add(目录)：list() 含它；remove 后消失", async () => {
  const a = await makeAgent();
  const dir = mkdtempSync(join(tmpdir(), "aiteam-skill-"));
  writeFileSync(join(dir, "SKILL.md"), "---\nname: probe-skill\ndescription: 探路技能\n---\n\n正文\n");
  try {
    assert.ok(!a.skills.list().includes("probe-skill"));
    await a.skills.add(dir);
    assert.ok(a.skills.list().includes("probe-skill"));
    await a.skills.remove(dir);
    assert.ok(!a.skills.list().includes("probe-skill"));
  } finally { a.dispose(); }
});

test("skills.add 传裸技能名 → 抛错并指向 list()", async () => {
  const a = await makeAgent();
  try { await assert.rejects(() => a.skills.add("probe-skill"), /list\(\)/); } finally { a.dispose(); }
});

test("skills.add 在运行中 → 抛错（idle 守卫）", async () => {
  const a = await makeAgent();
  try {
    const p = a.io.prompt("[[sleep:400]] slow");
    const dir = mkdtempSync(join(tmpdir(), "aiteam-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "---\nname: probe-skill\ndescription: d\n---\n\n正文\n");
    await assert.rejects(() => a.skills.add(dir), /空闲/);
    await p;
  } finally { a.dispose(); }
});

test("environment 自动发现的技能删不掉（remove 只作用于显式加进来的）", async () => {
  const a = await makeAgent();
  try {
    const before = a.skills.list().length;
    await assert.rejects(() => a.skills.remove("/not/added/by/us"), /显式/);
    assert.equal(a.skills.list().length, before);
  } finally { a.dispose(); }
});
```

- [ ] **步骤 2：运行确认失败** → FAIL。
- [ ] **步骤 3：实现 `src/surfaces/resources.ts`**

- `extensions.add(factory | path)`：内联工厂 → `loader.extensionFactories.push(f)`；路径 → `loader.additionalExtensionPaths.push(p)`；然后 `await bridge.reload()`。
- `extensions.list()` → `loader.getExtensions().extensions.map(e => ({ path: e.path, tools: [...e.tools.keys()] }))`。
- `extensions.errors()` → `loader.getExtensions().errors`（v1 这里是静默点，v2 必须可读）。
- `skills.add(ref: string | Skill)`：字符串 = **路径**（目录或 `SKILL.md`）；`Skill` 对象 → `loader.skillsOverride`。**不接受裸技能名**——运行期「按名字 add」没有意义（技能是被发现的，不是按名注册的），传名字时抛错并指向 `skills.list()`。加完 `await bridge.reload()`。
- `skills.remove(ref)`：只从 `loader.additionalSkillPaths` / `skillsOverride` 里移除**显式加进来的**；环境自动发现的删不掉，文档写明。
- `skills.list()` → `loader.getSkills().skills.map(s => s.name)`。

- [ ] **步骤 4：运行确认通过** → 6 个用例 PASS；`test/loader.test.ts` 仍 PASS。
- [ ] **步骤 5：Commit** → `feat(v2): extensions 与 skills 面（统一 reload 机制、errors 不再静默）`

---

### 任务 7：model 面

**文件：** 创建 `src/surfaces/model.ts`、`test/model.test.ts`、`test/model-network.test.ts`（重写）；修改 `create-agent.ts`

- [ ] **步骤 1：编写失败的测试**

`test/model.test.ts`：

```ts
test("current / thinking / available 可读", async () => {
  const a = await makeAgent();
  try {
    assert.equal(a.model.current, FAUX_MODEL_REF);
    assert.ok(a.model.available.includes(FAUX_MODEL_REF));
    assert.equal(typeof a.model.thinking, "string");
  } finally { a.dispose(); }
});

test("set 换模型（用写进 models.json 的第二个模型）", async () => {
  const a = await makeAgent();
  try {
    a.model.set(FAUX_MODEL_ALT_REF);
    assert.equal(a.model.current, FAUX_MODEL_ALT_REF);
    await a.io.prompt("hi");
    assert.equal(faux.calls.at(-1)!.model, FAUX_MODEL_ALT_REF);
  } finally { a.dispose(); }
});

test("set 写错模型名 → 抛错（v1 决策 #28 的教训）", async () => {
  const a = await makeAgent();
  try { assert.throws(() => a.model.set("nope/nope"), /nope/); } finally { a.dispose(); }
});

test("setThinking 非法值 → 抛错（v1 是静默回落）", async () => {
  const a = await makeAgent();
  try { assert.throws(() => a.model.setThinking("very-high" as never), /very-high/); } finally { a.dispose(); }
});

test("setThinking 合法值生效", async () => {
  const a = await makeAgent();
  try { a.model.setThinking("high"); assert.equal(a.model.thinking, "high"); } finally { a.dispose(); }
});
```

`test/model-network.test.ts`（重写，覆盖保留的 `modelNetwork` / `catalogBaseUrl` 行为）：

```ts
test("modelNetwork:false 不打模型目录请求，但仍可从 models-store.json 恢复", ...);
test("catalogBaseUrl 覆盖目录源", ...);
```

- [ ] **步骤 2：运行确认失败** → FAIL。
- [ ] **步骤 3：实现 `src/surfaces/model.ts`**

- `set(ref)`：复用 v1 的 `resolveModel`（`error` 或 `warning` 一律抛错）→ `await session.setModel(model)`。
- `setThinking(level)`：先校验 `session.getAvailableThinkingLevels().includes(level)`，不在就抛错 → `session.setThinkingLevel(level)`。
- `available`：`modelRuntime.getAvailableSnapshot().map(m => \`${m.provider}/${m.id}\`)`。
- `current`：`` `${session.model.provider}/${session.model.id}` ``。

- [ ] **步骤 4：运行确认通过** → 两个测试文件全 PASS。
- [ ] **步骤 5：Commit** → `feat(v2): model 面（可换模型与思考档、错值抛错、available 可读）`

---

### 任务 8：收尾——env 适配、导出、删除 v1 死代码

**文件：** 修改 `src/agent/env.ts`、`src/index.ts`；删除 `src/agent/host.ts`、`src/agent/events.ts`、`src/tools/*`；保留改造 `test/env.test.ts`

- [ ] **步骤 1：适配 `src/agent/env.ts`**

`inspectEnv(spec?: Partial<AgentInit>, deps?)`：只读 `agentDir` / `cwd` / `modelNetwork` / `catalogBaseUrl` 四个字段。返回值结构不变（`EnvReport`）。加一条断言测试：**报出来的模型与 `agent.model.available` 一致**。

- [ ] **步骤 2：运行 `test/env.test.ts` 确认通过**（v1 用例应原样通过；若 import 变了只调 import）。

- [ ] **步骤 3：重写 `src/index.ts` 并删除 v1 死代码**

```bash
git rm src/agent/host.ts src/agent/events.ts src/tools/spawn-agent.ts src/tools/send-message.ts src/tools/define-agent-tool.ts
```

`src/index.ts` 导出：`createAgent`、`inspectEnv`、全部类型。**不再导出** `createAgentHost` / `defineAgentTool`。

- [ ] **步骤 4：全量验证**

```bash
npm run typecheck
npm test
```
预期：`typecheck` 无错；`npm test` 全绿。若 `tsconfig.json` 的 `include` 需要加 `spike`，**不要加**（探路脚本刻意不进类型检查）。

- [ ] **步骤 5：端到端验证：七面联跑（建成正式回归测试 `test/e2e.test.ts`，不删）**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { FAUX_MODEL_ALT_REF, echoTool, makeAgent, sentMessages, sentTools } from "./helpers.ts";

test("七面联跑：加工具 → 装门 → 改上下文 → 加插件 → 换模型 → 观测 → 回收", async () => {
  const a = await makeAgent({ permissions: { only: ["read"] } });
  const events: string[] = [];
  const off = a.onAny((e) => events.push(e.type));
  try {
    await a.tools.add(echoTool());
    assert.ok(a.tools.list().some((t) => t.name === "probe_echo"));

    a.permissions.gate(async () => undefined);          // 装一个不拦的门
    a.permissions.allow(["read"]);                       // 已含 read，应为幂等
    assert.deepEqual(sentToolsAfterNextRun(), ["read", "probe_echo"]);  // 见下方说明

    a.context.override((m) => m.slice(-1));
    a.model.set(FAUX_MODEL_ALT_REF);
    await a.extensions.add((pi) => pi.registerTool(echoTool("probe_echo2")));
    await a.io.prompt("hello");

    assert.equal(a.model.current, FAUX_MODEL_ALT_REF);
    assert.equal(sentMessages(), 2);                     // system + 1 → override 生效
    assert.ok(events.includes("agent_start"));
    assert.ok(events.includes("agent_settled"));
    a.context.autoCompact = true;
    assert.equal(a.context.autoCompact, true);
  } finally { off(); a.dispose(); }
  assert.equal(a.status, "disposed");
});
```

（实现者注意：把「白名单 + 新加工具」的断言放在 `await a.io.prompt("hello")` 之后，写成 `assert.deepEqual([...sentTools()].sort(), ["probe_echo", "read"])`；这一步必须成立——它是任务 4 那个「给了白名单后 add 进来的工具要 active」的端到端版。只 import 用得到的名字。）

- [ ] **步骤 6：Commit**
```bash
git add -A && git commit -m "feat(v2): 收尾 —— env 适配、导出收敛、删除 v1 死代码（花名册/内置工具/事件归一化）"
```

---

## 计划自检记录

- **规格覆盖**：规格 §3（架构/机制）→ 任务 1；§4（七面）→ 任务 2/3/4/5/6/7；§5（结算）→ 任务 2；§6（迁移）→ **另立 Plan 2**（已在「本计划不覆盖」写明）；§7（探路）已完成；§8（测试策略）→ 贯穿各任务 + 任务 8 全量验证；§9（非目标）→ 全局约束。
- **审查重点 5 条**已各自钉进任务：1 → 任务 1、2 → 任务 1、3 → 任务 2、4 → 任务 7、5 → 任务 1。
- **与规格的偏差（3 处，均为消歧）**：① 创建期用 `permissions.only`（精确白名单）而不是 `allow`，避免「创建时精确、运行期并集」的同名不同义；② 运行期 `allow` 定义为并集启用、新增 `only` 做精确设置；③ `skills.add` 只接受路径 / `Skill` 对象，不接受裸技能名（按名 add 没有意义且会变成静默 no-op）。规格 §4 表格需要同步这三处。