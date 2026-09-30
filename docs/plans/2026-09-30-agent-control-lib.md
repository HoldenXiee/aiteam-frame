# aiteam 阶段 1（Agent 操控库）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 做一个本地 TypeScript 库，用声明式的「成员定义」起任意多个配置异构的 pi agent，它们能通过自定义工具挑选成员、派活、互投消息。

**架构：** 单层薄封装。`MemberSpec/AgentSpec`（数据）→ `DefaultResourceLoader` + `createAgentSession`（实例）→ `ControlledAgent`（归一化的事件/生命周期/用量）。`AgentHost` 持有花名册、共享资源与护栏计数。能力以「工厂式自定义工具」的形式挂上来。

**技术栈：** Node 24（原生跑 .ts，无构建步骤）+ `@earendil-works/pi-coding-agent@0.99.1` + `typebox@1.3.27` + `node:test`。

**规格：** `docs/specs/2026-09-30-agent-control-lib-design.md` —— **执行者两份都读**。规格第 11 节是已实跑核对的结论（含与旧文档的漂移），实现时以此为准，不要照 0.84.2 文档写。

---

## 全局约束

- Node ≥ 24。**无构建步骤**，直接跑 `.ts`
- 只用**可擦除**的 TS 语法：不用 `enum` / `namespace` / 装饰器 / 构造函数参数属性；相对 import 必须写显式 `.ts` 后缀
- 依赖：`@earendil-works/pi-coding-agent@0.99.1`、`typebox@1.3.27`。**只有真的要 `Usage` / `calculateCost` 时才加 `@earendil-works/pi-ai`**（决策 #29）
- 测试命令（已实测）：`node --test "test/**/*.test.ts"` —— **必须用通配**，`node --test test/` 不认 `.ts`
- 测试**零真实 API 调用**，全部走本机假 provider
- 类型检查：`npx tsc --noEmit`
- 对外类型一律从 pi 的包 import，**不自己重定义** `Skill` / `ToolDefinition` / `AgentSession` / `Usage` / `ThinkingLevel`
- 平台：Windows（路径拼接用 `node:path`，临时目录用 `os.tmpdir()`）
- commit 前缀：`feat:` / `test:` / `chore:` / `docs:`

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 唯一导出入口，不做逻辑 |
| `src/agent/types.ts` | 全部对外类型，无运行时代码 |
| `src/agent/loader.ts` | 由 `MemberSpec` 造 `ResourceLoader`：注入技能、扩展、角色 |
| `src/agent/events.ts` | 原始事件 → 7 个归一化事件的**纯映射** |
| `src/agent/usage.ts` | 用量累加 |
| `src/agent/create-agent.ts` | `spec → ControlledAgent`：生命周期、投递、订阅 |
| `src/agent/host.ts` | `createAgentHost`：花名册、护栏计数、宿主事件、寻址与回收 |
| `src/tools/define-agent-tool.ts` | 工具地基：工厂式工具 + 调用者上下文注入 |
| `src/tools/spawn-agent.ts` | `spawn_agent`：挑选成员 + 派活 + 拿结果 |
| `src/tools/send-message.ts` | `send_message`：给后代分身追加消息 |
| `test/faux-server.ts` | 本机 HTTP 假 LLM（零成本、按脚本响应） |
| `test/faux-models.ts` | 写 `models.json` + 造 `ModelRuntime` 的测试助手 |
| `test/helpers.ts` | 测试公共助手（见下） |
| `test/*.test.ts` | 各任务的测试 |
| `demo/demo.ts` | 真模型端到端 |

**测试助手**（由任务 1 建立，后续任务直接用，不要各自重写）：

```ts
// test/faux-models.ts
export const FAUX_MODEL_REF: string;              // "faux/echo"
export async function makeFauxRuntime(baseUrl: string): Promise<{ runtime: ModelRuntime; agentDir: string; cwd: string }>;
export function assistantTexts(session: any): string[];
export function lastAssistant(session: any): any;

// test/helpers.ts
export function seenTools(faux: Faux, index?: number): string[];   // 假服务收到的工具名
export async function captureSystemPrompt(spec: MemberSpec): Promise<string>;  // 起 agent 跑一轮，返回 system
export const echoTool: ToolDefinition;              // 一个只回显的静态工具，名字固定叫 probe_echo
export async function runTool(name: string, args: unknown, ctx: AgentToolContext): Promise<AgentToolResult>;
  // 直接调工具的 execute，绕过 LLM，用于测护栏与错误路径
```

`captureSystemPrompt` 与 `runTool` 内部自建 faux + host + agent，调用方只需传 spec / ctx。

**关键签名**（各任务以此为准，不再重复）：

```ts
// src/agent/types.ts —— 完整定义见规格 §4，此处只列任务间要对接的
export interface MemberSpec { description?: string; cwd?: string; agentDir?: string; role?: string;
  skills?: (string | Skill)[]; extensions?: (string | InlineExtension)[]; tools?: string[];
  excludeTools?: string[]; customTools?: AgentTool[]; model?: string; thinking?: ThinkingLevel;
  onToolCall?: ToolGate }
export interface AgentSpec extends MemberSpec { id?: string }
export interface AgentToolContext { agent: ControlledAgent; signal?: AbortSignal; host?: AgentHost }
export type AgentToolFactory = (ctx: AgentToolContext) => ToolDefinition
export type AgentTool = ToolDefinition | AgentToolFactory
export interface RunResult { text: string; usage: Usage; error?: string }
export interface SendOpts { mode?: "next" | "interrupt" }
export interface SendResult { delivered: "ran" | "queued" }

export interface ControlledAgent {
  readonly id: string; readonly session: AgentSession;
  readonly status: "idle" | "running" | "aborted" | "error" | "disposed";
  readonly isStreaming: boolean; readonly usage: Usage; readonly lastResult: RunResult | undefined;
  readonly parentId: string | undefined; readonly member: string | undefined;
  prompt(text: string, opts?: PromptOpts): Promise<RunResult>;
  send(text: string, opts?: SendOpts): Promise<SendResult>;
  steer(text: string): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  on<E extends AgentEventName>(event: E, fn: (p: AgentEventMap[E]) => void): () => void;
  dispose(): void;
}

export interface HostOptions { members?: Record<string, MemberSpec>; maxAgents?: number;
  maxDepth?: number; budgetTokens?: number; modelRuntime?: ModelRuntime;
  defaults?: Partial<MemberSpec> }
export interface AgentHost {
  readonly usage: Usage; readonly activeCount: number; readonly maxAgents: number;
  readonly maxDepth: number; readonly budgetTokens: number | undefined;
  list(): ControlledAgent[]; get(id: string): ControlledAgent | undefined;
  on<E extends keyof HostEventMap>(event: E, fn: (p: HostEventMap[E]) => void): () => void;
  dispose(): void;
}
export function createAgent(spec: AgentSpec, deps?: CreateAgentDeps): Promise<ControlledAgent>;
export function createAgentHost(opts?: HostOptions): AgentHost;
export function defineAgentTool<P>(def: {...}): AgentToolFactory;
```

## 审查重点（Review Focus）

规格没说、但一定会被用户碰到、弄坏了最伤人的五类输入。每一行都必须在它所属任务的测试里钉住：

1. **`host.dispose()` 时还有分身正在跑** —— 用户期待的是干净关闭；实际可能留下悬挂的 LLM 请求与永不 settle 的 promise。正确行为：先 `abort()` 所有在跑的分身，等它们 settle，再 dispose。
2. **重复或冲突的 `id`** —— `host.get()` 与 `send_message` 会静默寻址到错的人。正确行为：创建时检测到重复立刻抛错。
3. **对已 `dispose` 的分身调 `prompt` / `send`** —— 正确行为：抛带上下文的明确错误，不静默、不抛晦涩的 SDK 内部错误。
4. **`maxAgents` / `maxDepth` / `budgetTokens` 的边界** —— `maxAgents: 0` 意味着「一个分身都不许」，不是「无限」。必须定义并钉住。
5. **`spawn_agent` 收到花名册里不存在的成员名** —— 类型层用字面量联合挡了，但手写的 tool call 仍能绕过。正确行为：返回错误文本，不崩。

---

### 任务 1：零成本测试地基

**文件：**
- 创建：`test/faux-server.ts`、`test/faux-models.ts`、`test/helpers.ts`、`test/smoke.test.ts`
- 修改：`package.json`（加 `"test": "node --test \"test/**/*.test.ts\""`）

`probe/_support.ts` 与 `probe/_sdk.ts` 已经把这两块跑通过，**直接搬**，不要重写。

- [ ] **步骤 1：写失败的测试** `test/smoke.test.ts`

```ts
test("假 provider 能跑通一次完整 prompt", async () => {
  const faux = await startFaux();
  const { runtime, agentDir, cwd } = await makeFauxRuntime(faux.baseUrl);
  const { session } = await createAgentSession({ cwd, agentDir, model: runtime.getModel("faux", "echo")!,
    modelRuntime: runtime, sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({}) });
  await session.prompt("hi");
  assert.match(assistantTexts(session).join(""), /echo:hi/);
  assert.ok(lastAssistant(session).usage.totalTokens > 0);
  await faux.close();
});
```

- [ ] **步骤 2：运行确认失败**

运行：`node --test "test/**/*.test.ts"`
预期：FAIL，`Cannot find module './faux-server.ts'`

- [ ] **步骤 3：实现**

搬 `probe/_support.ts` → `test/faux-server.ts`（保留 `startFaux`、脚本约定 `[[tool:]]`/`[[sleep:]]`/`[[fail:]]`、请求记录），搬 `probe/_sdk.ts` → `test/faux-models.ts`（提供 `makeFauxRuntime`、`FAUX_MODEL_REF`、`assistantTexts`、`lastAssistant`）。建 `test/helpers.ts` 放 `seenTools` / `captureSystemPrompt` / `echoTool` / `runTool`（签名见文件结构节）。harness 的 `check/section/finish` 不要搬 —— 测试改用 `node:assert`。`startFaux` 的 `close()` 必须无条件可用（失败路径也要能关）。

`captureSystemPrompt` / `runTool` 此刻还依赖 `src/agent/*`，在本任务里先用最小可用实现（直接 `createAgentSession` + 手写 loader），到任务 4/7 落地后再改成走库的 `createAgent`。如果这一步改不动，分成两个任务拆到任务 4 之后做——**不要让任务 1 依赖还没写的东西而卡住**。

- [ ] **步骤 4：运行确认通过**

运行：`node --test "test/**/*.test.ts"`
预期：`pass 1` / `fail 0`

- [ ] **步骤 5：Commit**

```bash
git add test/ package.json
git commit -m "test: 零成本假 provider 测试地基"
```

---

### 任务 2：类型骨架与配置收敛

**文件：**
- 创建：`src/agent/types.ts`、`src/agent/loader.ts`、`test/loader.test.ts`

- [ ] **步骤 1：写失败的测试** `test/loader.test.ts`

```ts
test("role 走 appendSystemPrompt，保留 pi 默认提示词与 <tools> 段", async () => {
  const { system } = await captureSystemPrompt({ role: "我是审查员" });
  assert.match(system, /我是审查员/);
  assert.match(system, /<tools>/);
  assert.ok(system.indexOf("我是审查员") > system.indexOf("<tools>"));
});

test("技能名解析失败必须抛错，错误信息含名字", async () => {
  await assert.rejects(() => buildLoader({ skills: ["没有这个技能"] }, deps), /没有这个技能/);
});

test("Skill 对象指向不存在的文件时抛错", async () => {
  await assert.rejects(() => buildLoader({ skills: [{ name: "x", description: "d", filePath: "D:/nope/SKILL.md", baseDir: "D:/nope", source: "custom" }] }, deps));
});
```

`captureSystemPrompt(spec)` 是测试助手：起一个 agent 跑一轮，返回假服务记录的 system 字符串。

- [ ] **步骤 2：运行确认失败**

运行：`node --test "test/**/*.test.ts"`
预期：FAIL，`src/agent/loader.ts` 不存在

- [ ] **步骤 3：实现**

`src/agent/types.ts`：按签名清单与规格 §4 写全类型，无运行时代码。

`src/agent/loader.ts` 导出：

```ts
export async function buildLoader(spec: MemberSpec, deps: {
  cwd: string; agentDir: string; settingsManager: SettingsManager;
  extensionFactories?: InlineExtension[];
}): Promise<DefaultResourceLoader>
```

实现要点（决策 #1/#2/#25/#27）：`new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories, appendSystemPrompt: spec.role ? [spec.role] : [], additionalSkillPaths })` → `await reload()` → 用 `loader.getSkills().skills` 建名字表解析 `skills` 里的字符串引用（**找不到抛错**）；Skill 对象要校验 `filePath` 存在。`spec.extensions` 里的字符串走 `additionalExtensionPaths`。

- [ ] **步骤 4：运行确认通过**

运行：`node --test "test/**/*.test.ts"`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/types.ts src/agent/loader.ts test/loader.test.ts
git commit -m "feat: 成员规格类型与 ResourceLoader 配置收敛"
```

---

### 任务 3：事件归一化（纯映射）

**文件：**
- 创建：`src/agent/events.ts`、`test/events.test.ts`

- [ ] **步骤 1：写失败的测试** `test/events.test.ts`

```ts
test("message_update.text_delta → text", () => {
  assert.deepEqual(normalizeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } } as any),
    { type: "text", delta: "a" });
});
test("tool_execution_end → tool_end 带 isError", () => { /* ... */ });
test("turn_end → turn 带 message 与 usage", () => { /* ... */ });
test("agent_end → done 带本次 usage", () => { /* ... */ });
test("无关事件返回 undefined", () => {
  assert.equal(normalizeEvent({ type: "message_start" } as any), undefined);
});
```

- [ ] **步骤 2：运行确认失败** → FAIL，模块不存在

- [ ] **步骤 3：实现** `src/agent/events.ts`

导出 `normalizeEvent(raw: AgentSessionEvent): NormalizedEvent | undefined`，把原始事件映射成 `AgentEventMap` 里的 7 种之一；同时导出 `AgentEventMap` / `AgentEventName`。只看原始事件形状，不碰会话状态 —— 因此可纯函数单测（探路 07 已记录全部原始事件字段）。

- [ ] **步骤 4：运行确认通过** → PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/events.ts test/events.test.ts
git commit -m "feat: 事件归一化纯映射"
```

---

### 任务 4：createAgent 核心

**文件：**
- 创建：`src/agent/create-agent.ts`、`src/agent/usage.ts`、`src/index.ts`、`test/create-agent.test.ts`

- [ ] **步骤 1：写失败的测试** `test/create-agent.test.ts`

```ts
test("prompt 返回文本与本次用量", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const run = await agent.prompt("hi");
  assert.match(run.text, /echo:hi/);
  assert.ok(run.usage.totalTokens > 0);
});

test("模型报错时 RunResult.error 被填充且不 reject", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const run = await agent.prompt("[[fail]]");
  assert.ok(run.error, "应当有 error");
});

test("RunResult.usage 是本次，agent.usage 是累计", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  const first = await agent.prompt("一");
  const second = await agent.prompt("二");
  assert.equal(agent.usage.totalTokens, first.usage.totalTokens + second.usage.totalTokens);
});

test("dispose 后 status 为 disposed，再调 prompt 抛明确错误", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF });
  agent.dispose();
  assert.equal(agent.status, "disposed");
  await assert.rejects(() => agent.prompt("x"), /disposed/);
});

test("未提供 tools 时 customTools 自动生效", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF, customTools: [echoTool] });
  await agent.prompt("[[tool:probe_echo]]");
  assert.ok(seenTools().includes("probe_echo"));
});

test("提供了 tools 但未列出 customTool 时它不生效", async () => {
  const agent = await createAgent({ model: FAUX_MODEL_REF, customTools: [echoTool], tools: ["read"] });
  await agent.prompt("[[tool:probe_echo]]");
  assert.ok(!seenTools().includes("probe_echo"));
});

test("onToolCall 返回 block 时工具不执行", async () => { /* ... */ });
test("on() 能收到 text / tool_end / done", async () => { /* ... */ });
```

`seenTools()` 读假服务记录的最近一次请求的工具名（决策 #4 的 ground truth）。

- [ ] **步骤 2：运行确认失败** → FAIL

- [ ] **步骤 3：实现**

`src/agent/usage.ts`：`addUsage(a, b)`、`emptyUsage()`（跨 agent 累计用）。

`src/agent/create-agent.ts`：

```ts
export interface CreateAgentDeps { host?: AgentHost; modelRuntime?: ModelRuntime; parent?: ControlledAgent }
export async function createAgent(spec: AgentSpec, deps?: CreateAgentDeps): Promise<ControlledAgent>
export function registerAgentTools(agent: ControlledAgent): void   // 内部：把工具工厂接进来
```

要点：
- `modelRuntime` 从 `deps.host` / `deps.modelRuntime` / 模块级懒单例取；`model` 走 `resolveCliModel`，**warning 非空时抛错**（决策 #28）
- `tools` 白名单：仅当 `spec.tools` 提供时才把 customTools 与扩展工具名并入（决策 #4）
- `onToolCall` 包成 `extensionFactories: [pi => pi.on("tool_call", …)]`
- `usage` 累加用 `session.messages` 里 assistant 的 `usage`；`RunResult.usage` 取本次新增部分
- `RunResult.error` 取本次最后一条 assistant 的 `errorMessage`（决策 #5）
- `dispose()` 置 `disposed` 并调 `session.dispose()`；此后任何操作抛含 `disposed` 的错误

- [ ] **步骤 4：运行确认通过** → PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/create-agent.ts src/agent/usage.ts src/index.ts test/create-agent.test.ts
git commit -m "feat: createAgent 核心（prompt/用量/状态/工具接线/审批门）"
```

---

### 任务 5：投递与等待

**文件：**
- 修改：`src/agent/create-agent.ts`
- 创建：`test/send.test.ts`

- [ ] **步骤 1：写失败的测试** `test/send.test.ts`

```ts
test("空闲时 send 返回 ran 并真的跑了一轮", async () => {
  const before = faux.calls.length;
  const r = await agent.send("空闲投递");
  assert.equal(r.delivered, "ran");
  assert.ok(faux.calls.length > before);      // 空闲 steer 会静默丢弃，这条锁住没走 steer
  await agent.waitForIdle();
  assert.match(agent.lastResult!.text, /echo:空闲投递/);
});

test("忙时 send 返回 queued 且不抛错", async () => {
  const slow = agent.prompt("[[sleep:600]] 慢");
  await sleep(150);
  assert.equal((await agent.send("插队")).delivered, "queued");
  await slow; await agent.waitForIdle();
});

test("忙时 prompt() 抛错（锁住 SDK 行为）", async () => {
  const slow = agent.prompt("[[sleep:600]] 慢");
  await sleep(150);
  await assert.rejects(() => agent.prompt("插队"), /already processing/);
  await slow;
});

test("waitForIdle 在忙时会等待", async () => {
  void agent.prompt("[[sleep:400]] 慢");
  await agent.waitForIdle();
  assert.equal(agent.isStreaming, false);
});

test("已 dispose 后 send/waitForIdle 的行为已定义", async () => {
  const dead = await createAgent({ model: FAUX_MODEL_REF });
  dead.dispose();
  await assert.rejects(() => dead.send("x"), /disposed/);
  await dead.waitForIdle();          // 已回收的分身直接 resolve，不抛错（决策 #21）
});
```

- [ ] **步骤 2：运行确认失败**

运行：`node --test "test/send.test.ts"`
预期：FAIL，`agent.send is not a function`

- [ ] **步骤 3：实现**（决策 #19/#26）

`send()` 按 `isStreaming` 分派：忙 → `mode === "interrupt" ? steer : followUp` 并返回 `{delivered:"queued"}`；空闲 → `void prompt(text).catch(把错误送进 error 事件)` 并返回 `{delivered:"ran"}` —— **必须不 await**，否则 `send` 就变成同步 `ask`。`waitForIdle()` 包 `session.agent.waitForIdle()`，已 dispose 时直接 resolve（决策 #21）。`abort()` 置 `aborted` 并调 `session.abort()`。

- [ ] **步骤 4：运行确认通过** → PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/create-agent.ts test/send.test.ts
git commit -m "feat: 投递原语 send/waitForIdle，忙闲分派"
```

---

### 任务 6：AgentHost（花名册、护栏、宿主事件、回收）

**文件：**
- 创建：`src/agent/host.ts`、`test/host.test.ts`

- [ ] **步骤 1：写失败的测试** `test/host.test.ts`

```ts
test("宿主事件在正确时机各触发一次", async () => { /* agent_created / round_completed / agent_disposed */ });
test("重复 id 创建时抛错", async () => {
  const host = createAgentHost({});
  await createAgent({ id: "dup", model: FAUX_MODEL_REF }, { host });
  await assert.rejects(() => createAgent({ id: "dup", model: FAUX_MODEL_REF }, { host }), /dup/);
});
test("maxAgents: 0 表示一个都不许", async () => {
  const host = createAgentHost({ maxAgents: 0 });
  await assert.rejects(() => createAgent({ model: FAUX_MODEL_REF }, { host }), /maxAgents|0/);
});
test("maxDepth: 0 表示顶层 agent 可以有，但不许它再 spawn", async () => { /* ... */ });
test("budgetTokens: 0 表示任何一轮都不许跑", async () => { /* ... */ });
test("预算耗尽后 host.usage 仍可读，只是不再接新活", async () => { /* ... */ });
test("dispose 会先 abort 正在跑的分身，再回收", async () => {
  const host = createAgentHost({});
  const a = await createAgent({ model: FAUX_MODEL_REF }, { host });
  void a.prompt("[[sleep:800]] 慢");
  await sleep(100);
  assert.equal(a.isStreaming, true);
  host.dispose();
  assert.equal(host.list().length, 0);
  assert.equal(a.status, "disposed");
  await assert.rejects(() => a.prompt("x"), /disposed/);
});
test("host.usage 汇总所有分身用量", async () => { /* ... */ });
```

- [ ] **步骤 2：运行确认失败** → FAIL

- [ ] **步骤 3：实现** `src/agent/host.ts`

内部状态：`Map<string, ControlledAgent>`、出于本宿主创建的 agent 计数、累计 usage、`members` 与 `defaults`。

`createAgent` 经 `deps.host` 完成登记、计数校验与 `agent_created` 派发。这个登记入口**用模块内部的 symbol 键挂在 host 对象上**，不要加到公开的 `AgentHost` 接口里（否则会出现第二条创建路径，与规格「已定」条款矛盾）。`round_completed` 由 agent 每次跑完一轮时回调宿主。

`dispose()` 必须**先 `abort()` 所有 `isStreaming` 的分身**，等 `waitForIdle` 后再逐个 `dispose()`，最后清空表并派发 `agent_disposed`。

三个上限的边界必须一致：`0` 一律表示「一个都不许」，不表示「无限」；`undefined` 才表示不限制。

- [ ] **步骤 4：运行确认通过** → PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/host.ts test/host.test.ts
git commit -m "feat: AgentHost 花名册、护栏、宿主事件与级联回收"
```

---

### 任务 7：工具地基

**文件：**
- 创建：`src/tools/define-agent-tool.ts`、`test/define-agent-tool.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
test("工厂式工具在 execute 时拿到持有它的 agent", async () => {
  let seen: ControlledAgent | undefined;
  const factory = defineAgentTool({ name: "whoami", label: "Who", description: "d",
    parameters: Type.Object({}), execute: async (_id, _p, ctx) => { seen = ctx.agent; return { content: [{ type: "text", text: ctx.agent.id }], details: {} }; } });
  const agent = await createAgent({ model: FAUX_MODEL_REF, customTools: [factory] });
  await agent.prompt("[[tool:whoami]]");
  assert.equal(seen?.id, agent.id);
});
test("工厂在 createAgent 期间不被调用（惰性）", async () => {
  let calls = 0;
  const factory = defineAgentTool({ /* ... */ execute: async () => { calls++; /* ... */ } });
  await createAgent({ model: FAUX_MODEL_REF, customTools: [factory] });
  assert.equal(calls, 0);
});
test("静态 ToolDefinition 也能直接用", async () => { /* ... */ });
test("ctx.host 在带宿主时可用", async () => { /* ... */ });
```

- [ ] **步骤 2：运行确认失败** → FAIL

- [ ] **步骤 3：实现** `src/tools/define-agent-tool.ts`

```ts
export interface AgentToolDef<P> { name: string; label: string; description: string;
  parameters: TSchema; execute(params: P, ctx: AgentToolContext): Promise<AgentToolResult> }
export function defineAgentTool<P>(def: AgentToolDef<P>): AgentToolFactory
```

工厂式工具**必须**接受 `ctx`（决策 #11）。实现靠可变 holder：`createAgent` 先建 holder，把 `customTools` 里的工厂在**首次 `execute` 时**求值（决策 #12、探路实证 `execute` 的 `ctx` 是 `ExtensionToolContext`，不含 agent 引用）。要求工厂产出的 `ToolDefinition` 里 `execute` 的签名是 SDK 的 `(toolCallId, params, signal, onUpdate, sdkCtx)`，内部再包成我们自己的 `AgentToolContext` 传给用户的 `execute(params, ctx)`。

- [ ] **步骤 4：运行确认通过** → PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/define-agent-tool.ts test/define-agent-tool.test.ts
git commit -m "feat: 工厂式自定义工具地基与调用者上下文注入"
```

---

### 任务 8：`spawn_agent`

**文件：**
- 创建：`src/tools/spawn-agent.ts`、`test/spawn-agent.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
test("工具描述列出花名册全部成员及其职责", async () => { /* 断言 description 含 "reviewer" 与它的 description */ });
test("member 参数是花名册成员名的字面量联合", async () => { /* 断言 parameters 里 member 的 enum 等于 Object.keys(members) */ });
test("spawn 后分身留在宿主里，member 字段正确", async () => {
  const host = createAgentHost({ members: { reviewer: { tools: ["read"] } } });
  const lead = await createAgent({ model: FAUX_MODEL_REF, tools: ["spawn_agent"], customTools: spawnAgentTools }, { host });
  await lead.prompt("[[tool:spawn_agent]]");
  const child = host.list().find((a) => a.member === "reviewer");
  assert.ok(child, "分身应当留在宿主里");
  assert.equal(child.parentId, lead.id);
});
test("结果文本含 agentId，details.agentId 一致", async () => { /* ... */ });
test("同一成员两次 spawn 得到两个独立分身", async () => { /* ... */ });
test("三道护栏各自返回错误文本而非抛异常", async () => { /* maxDepth / maxAgents / budgetTokens */ });
test("运行时传不存在的成员名返回错误文本，不崩", async () => {
  const out = await runTool("spawn_agent", { member: "nope", task: "x" }, { host, agent });
  assert.match(textOf(out), /nope/);
});
```

- [ ] **步骤 2：运行确认失败** → FAIL

- [ ] **步骤 3：实现** `src/tools/spawn-agent.ts`

导出 `createSpawnAgentTool(ctx: AgentToolContext): ToolDefinition`。要点（决策 #15/#16，规格 §4.5）：`member` 用 `Type.Union` 字面量联合；描述动态列出花名册「名字 + description」；分身用 `member` 定义 + `host.defaults` 合成 spec，**不接受父 agent 的 `cwd`/`agentDir`/配置覆盖**；护栏按「成员存在 → 深度 → 总数 → 预算」顺序检查，触发时返回错误文本；`content` 写自然语言含 agentId，`details` 放 `{ agentId }`。

- [ ] **步骤 4：运行确认通过** → PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/spawn-agent.ts test/spawn-agent.test.ts
git commit -m "feat: spawn_agent 挑选成员与派活工具"
```

---

### 任务 9：`send_message`

**文件：**
- 创建：`src/tools/send-message.ts`、`test/send-message.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
test("可以给自己的后代分身投递", async () => { /* 成功，且后代确实跑了 */ });
test("给非后代（兄弟或祖先）投递被拒", async () => {
  const out = await runTool("send_message", { agentId: sibling.id, message: "x" }, { host, agent: child });
  assert.match(textOf(out), /后代|descendant/);
});
test("给已 dispose 的分身投递返回错误文本", async () => { /* ... */ });
test("给不存在的 agentId 投递返回错误文本", async () => { /* ... */ });
```

- [ ] **步骤 2：运行确认失败** → FAIL

- [ ] **步骤 3：实现** `src/tools/send-message.ts`（决策 #20）

沿 `parentId` 链判断目标是否为调用者的后代；是则 `target.send(message)`，并按 `delivered` 返回不同的中文文案（"已开始处理" / "已排队"）。

- [ ] **步骤 4：运行确认通过** → PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/send-message.ts test/send-message.test.ts
git commit -m "feat: send_message 后代投递工具"
```

---

### 任务 10：集群形态脚本化验证

**文件：**
- 创建：`test/shapes.test.ts`

假 provider 的脚本约定支持 `[[tool:NAME]]` 让模型发起工具调用；`spawn_agent` / `send_message` 的规格由假服务按最后一条 user 消息决定即可。分身的返回文本要能让主持人"看到"成员观点，因此假服务对带特定前缀的消息回可区分的文本。

- [ ] **步骤 1：把测试助手改走库的真实入口**

任务 1 里 `test/helpers.ts` 的 `captureSystemPrompt` / `runTool` 是临时实现（直接 `createAgentSession` + 手写 loader）。现在 `buildLoader`（任务 2）、`createAgent`（任务 4）、`defineAgentTool`（任务 7）都已就位，把它们改成走库的真实入口。跑 `npm test` 确认全绿 —— 这一步能顺便暴露前几个任务接口没对齐的地方。

- [ ] **步骤 2：写形态测试**（规格 §10 的形态 2/3/4/5/6/7/8/9/10 —— 除形态 1 外**全部**要在假 provider 下脚本化验证，形态 11 属阶段 2）

```ts
test("形态 2 并行扇出：一条消息里多个 spawn_agent 并发执行", async () => { /* 断言并发耗时 < 串行和 */ });
test("形态 3 流水线：A 的输出喂给 B", async () => { /* b.prompt(a 的文本) */ });
test("形态 4 监督者 + 工人池：manager 派活、分身复用", async () => { /* 断言分身数不随轮次增长 */ });
test("形态 5 团队探讨直到收敛：多轮 + 分身复用", async () => {
  // 主持人 spawn 两名成员 → 拿到观点 → send_message 把他人观点转发给每个成员 → 再一轮
  // 断言：分身数不变（复用），请求数 ≥ 5
});
test("形态 6 两团队争辩：子树嵌套 + 跨团队转发 + judge 裁决", async () => { /* 断言两棵子树的 parentId 正确 */ });
test("形态 7 共享黑板：全队同一 cwd，成员读写同一文件", async () => { /* ... */ });
test("形态 8 竞标/择优：同一任务扇出给多个成员再选优", async () => { /* ... */ });
test("形态 9 反思-修订循环：写手与审阅者反复复用同一对分身", async () => { /* 断言两分身 id 全程不变 */ });
test("形态 10 层级汇报：每个主持人先汇总队员结论再上报", async () => { /* ... */ });
```

- [ ] **步骤 3：运行确认失败** → FAIL

- [ ] **步骤 4：修实现直到通过**

这一步**不新增产品代码**。如果某个形态表达不出来，说明 L1 的接缝漏了 —— 回到对应任务补，不要在这里加临时机制。

- [ ] **步骤 5：运行确认通过** → PASS

- [ ] **步骤 6：Commit**

```bash
git add test/shapes.test.ts src/
git commit -m "test: 五种集群形态的脚本化验证"
```

---

### 任务 11：真模型 demo

**文件：**
- 创建：`demo/demo.ts`
- 修改：`package.json`（加 `"demo": "node demo/demo.ts"`）

- [ ] **步骤 1：写 demo**（真模型，跑形态 5）

花名册至少三个成员（`moderator` / `reviewer` / `summarizer` 之类），顶层 agent 挑成员、派活、把观点转发、最后出结论。每个成员配置要**明显不同**（不同 tools / role / model），否则验证不了异构。

- [ ] **步骤 2：跑一次**

运行：`npm run demo`
预期：打印出多轮对话过程与最终结论；`host.usage.cost.total` 有值

- [ ] **步骤 3：跑全部测试确认没跑偏**

运行：`npm test` —— 预期 `fail 0`，且**不产生真实 API 调用**
运行：`npx tsc --noEmit` —— 预期无输出

- [ ] **步骤 4：Commit**

```bash
git add demo/ package.json
git commit -m "feat: 真模型多轮协作 demo"
```

---

## 完成后

对照规格第 8 节验收标准逐条核对，任何一条不过就是没做完。
