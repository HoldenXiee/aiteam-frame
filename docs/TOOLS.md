# 自定义工具：高级用法

面向**已经会写基础工具**的人。基础（`defineTool` 四件套、创建期挂载 vs 运行期 `add`）见
[`GUIDE.md`](GUIDE.md) §3.3 与 `examples/04-tools.ts`；**本文只写那之外的部分**。

> **本文每个断言都实跑核对过**，探针在 `spike/tools-*.ts`，可直接 `node` 跑（离线、零成本）。
> 凡是「我没验过」的，文中会明写。

pi 的 `ToolDefinition` 有十几个字段，`examples/04` 只用了 5 个。剩下里真正能干活的按「解决什么问题」分组：

| 你想做的事 | 用什么 |
|---|---|
| 让工具进 system prompt 的工具清单 | `promptSnippet` / `promptGuidelines` |
| 让工具**编排别的工具** | `execute` 里的 `ctx.executeTool()` |
| 模型传错参数名时兜底 | `prepareArguments` |
| 改工具**返回给模型**的内容（脱敏/裁剪） | `agent.tools.onResult`（库的接口，不是字段） |
| 控制工具怎么呈现给模型 | `exposure` / `outputSchema` / `defaultActive` |
| 控制并发与权限提示 | `executionMode` / `annotations` |

---

## 0. 先建立一张地图：工具的定义在谁手里

```
你写的 ToolDefinition 对象
  │
  ├─ spec.tools.custom ──→ pi 的创建选项 customTools ──→ 注册表
  │                                                      │
  └─ agent.tools.add() ──→ bridge.tools（库的表）──→ reload ──→ 注册表
                                                          │
                            白名单（permissions.only / allowedToolNames）过滤
                                                          │
                                                       活跃集 → 声明给模型
```

**两条路在「白名单」这一步合流**，但行为不同（`test/resources.test.ts` 有用例钉住）：

| | `spec.tools.custom` | `agent.tools.add()` |
|---|---|---|
| 何时生效 | agent 一诞生就在 | 加完之后 |
| 白名单 | **自动并入** `only` | 库替你并入（`registerAllowed`） |
| 忙时能用吗 | 是（还没起） | **否**，先 `io.waitIdle()` |
| `tools.list()` 里有吗 | **没有**（它只记 bridge.tools） | 有 |

> 想知道「这个 agent 现在真能干什么」，永远看 `agent.io.raw.getActiveToolNames()`；
> `tools.list()` 只反映运行期 add/remove 的那张表。

---

## 1. `promptSnippet` / `promptGuidelines` —— 让工具进 system prompt

### 问题

`description` 是给**工具 schema** 用的。但 pi 的 system prompt 里还有一个**独立的工具清单**（`<tools>` 段）。
**没写 `promptSnippet` 的工具不会出现在那里。**

### 实测（`spike/tools-prompt-snippet.ts`）

两个工具，一个写了 `promptSnippet` 一个没写：

```
含 SNIPPET_MARKER_XYZ  : true
含 GUIDELINE_MARKER_ABC: true
含 bare_tool 字面名     : false      ← 没写 snippet 的工具，system 里找不到它

---- <tools> 段 ----
<tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, ...
- write: Create or overwrite files
- rich_tool: rich_tool: SNIPPET_MARKER_XYZ      ← 只有它出现了

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>
```

### 怎么写

```ts
const deployTool = defineTool({
  name: "deploy",
  label: "Deploy",
  description: "把当前分支部署到指定环境。环境名用 staging / prod。",   // 给 schema
  promptSnippet: "deploy: 把分支部署到 staging 或 prod",                // 给 system 清单（一句话）
  promptGuidelines: [                                                    // 追加到 system 的 Guidelines 段
    "部署到 prod 之前必须先跑一次测试。",
    "一次只部署一个环境。",
  ],
  parameters: Type.Object({ env: Type.String() }),
  execute: async (_id, p) => { /* ... */ },
});
```

- `promptSnippet` 是**一行**，出现在 `<tools>` 段（形如 `- 名字: 你的 snippet`）。
- `promptGuidelines` 是**字符串数组**，进 system 的 Guidelines 段，**只在工具活跃时生效**。
- 两者都是**软约束**（写进提示词，靠模型自觉），跟 `role` 同一性质。要硬约束用 `permissions.gate`。

> ⚠️ 未验证：`promptGuidelines` 在 system 里的**确切位置**。我确认了它在 system 内、文本也在，
> 但没逐字比对它在哪一段。要精确位置自己 dump `agent.io.raw.systemPrompt`。

---

## 2. `ctx.executeTool()` —— 编排型工具（最有价值的一个）

### 这是什么

`execute` 的第五个参数 `ctx` 是 pi 的 `ExtensionToolContext`，它有两个额外能力：

```ts
ctx.tools                               // 现在**可调用**的工具列表（readonly AgentTool[]）
ctx.executeTool(name, args, options?)   // 在工具内部调另一个工具
```

这让「工具」从「一个函数」升级成「**一段可以编排别的能力的流程**」—— 这才是 agent 操控库该有的样子。

### 实测（`spike/tools-execute-tool.ts`）

```ts
const inner = defineTool({ name: "inner_step", /* ... */ });

const outer = defineTool({
  name: "outer_step",
  description: "把 inner_step 跑三遍",
  parameters: Type.Object({}),
  execute: async (_id, _p, _sig, _upd, ctx) => {       // ← 第五个参数
    const results: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const out = await ctx.executeTool("inner_step", { n });
      // out: { toolCall, result, isError }
    }
    return { content: [{ type: "text", text: results.join(" | ") }], details: {} };
  },
});
```

输出：

```
  ctx.tools 可调用: read, bash, edit, write, inner_step, outer_step
RunResult.error: undefined
  模型说: outer 收到：{toolCall:{...id:"call_faux_1/1",name:"inner_step",arguments:{n:1}},
                       result:{content:[{text:"inner(1)"}]},isError:false} | ...
```

**三个关键行为**（都实测过）：

1. **返回值形状**是 `{ toolCall, result, isError }`，**不是** `{content, details}`。别搞混。
2. **嵌套调用的 id 是 `<外层 id>/<n>`** —— 上面 `call_faux_1` 调三次得到 `call_faux_1/1`、`/2`、`/3`。
   嵌套调用**不出现在会话记录里**，只在外面那层的结果上留一份 `nestedCalls`。
3. **它不会为了工具失败而 reject**：未知名、参数校验失败、被门拦下、抛异常 —— 全部以 `isError: true` 回来。
   所以 `await ctx.executeTool(...)` **不用 try/catch**，要判 `out.isError`。

### 为什么这个能力重要

它让「能力裁剪」多了新的一层：外层工具可以用 `ctx.tools` **看到当前实际可调用的集合**，
再决定怎么编排 —— 而不是硬编码工具名。配合 R48 的白名单，可以做出
「同一个工具在不同 agent 上跑出不同流程」的效果。

---

## 3. `prepareArguments` —— 参数兼容层

### 问题

模型偶尔会传旧参数名（提示词改版、few-shot 里的例子过时、跨模型迁移）。
默认它会被 schema 校验挡下，模型收到一个「参数错误」然后开始瞎猜。

### 实测（`spike/tools-prepare-args.ts`）

```ts
const compat = defineTool({
  name: "compat_tool",
  parameters: Type.Object({ query: Type.String() }),
  prepareArguments: (args: unknown) => {
    const a = args as Record<string, unknown>;
    return { query: (a.query ?? a.q ?? "（空）") as string };   // ← 兜住旧名 q
  },
  execute: async (_id, p) => ({ content: [{ type: "text", text: `query=${p.query}` }], details: {} }),
});
```

```
-- 传新参数名 --
  prepareArguments 收到: {"query":"hello"}
  error: undefined | text: echo:query=hello
-- 传旧参数名 q --
  prepareArguments 收到: {"q":"old-style"}
  error: undefined | text: echo:query=old-style      ← 兜住了
```

- 它在 **schema 校验之前**跑，返回值必须**符合 `TParams`**（不然校验还是失败）。
- 常见用途：字段改名、单值/数组两种写法兼容、给可选字段补默认值。

### 一个提醒

它**不是**校验层。真正的输入校验该放 `execute` 里（或 JSON Schema 的约束里）。
`prepareArguments` 是**兼容垫片**，别拿它当 `try/catch` 用。

---

## 4. `agent.tools.onResult()` —— 改工具**返回给模型**的内容

这不是 `ToolDefinition` 的字段，是**库的接口**，也是这个库独有的一层。

### 实测（`spike/tools-onresult.ts`）

工具返回 `SECRET_KEY=abc123 其余内容`，拦截后改写给模型：

```ts
const off = a.tools.onResult((result, _ctx) => {
  // result 的形状：{ type, toolName, toolCallId, input, content, details, isError, usage }
  return { content: [{ type: "text", text: "[已脱敏] 内容被 onResult 改写了" }] };
});
```

```
  模型看到: "echo:[已脱敏] 内容被 onResult 改写了"
```

**工具原样返回，模型收到的是改写后的。** 返回 `undefined` 表示不改。

### 适用场景

| 场景 | 怎么做 |
|---|---|
| 脱敏（key、手机号、内部路径） | 正则替换 `content[].text` |
| 裁剪（工具返回太长，超出上下文预算） | 截断 + 加「（已截断）」 |
| 归一化（不同工具返回格式不一，让模型好读） | 重排成统一格式 |
| 审计（不改内容，只记录） | 读到就存，返回 `undefined` |

### 三个细节

- 它**不要求空闲**（走事件，不走 `reload`），运行中随时挂/退。
- 它作用于**这个 agent 的所有工具**（不区分哪个工具）—— 要按工具区分就在回调里判 `result.toolName`。
- 退订函数要接住（`const off = ...`），不然会累积。

---

## 5. 呈现控制：`exposure` / `defaultActive` / `outputSchema`

### `exposure` —— 模型怎么够得着这个工具

```ts
exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden"
```

| 值 | 含义 | 注册时激活？ |
|---|---|---|
| `"direct"`（默认） | 普通工具，声明给模型 | ✅ |
| `"model-only"` | 只声明、只能由模型调 | ✅ |
| `"codemode"` | 供代码模式脚本调用 | ❌ |
| `"deferred"` | 延迟暴露 | ❌ |
| `"hidden"` | 不暴露给模型，但**可被 `ctx.executeTool()` 调用** | ❌ |

**`hidden` 是编排型工具的关键**：把子步骤藏起来，只让外层工具出现在模型面前 ——
模型看到的是一个干净接口，内部实现全在你的控制里。

> ⚠️ 未验证：`exposure` 我**没有逐个值实跑过**。上表来自 pi 的类型注释；
> `hidden` 与 `ctx.executeTool` 的配合是从类型注释 + `executeTool` 可用性**推导**的。
> 要用之前自己验一遍（写个 `exposure: "hidden"` 的工具，看它是否从
> `getActiveToolNames()` 消失但仍能被 `ctx.executeTool` 调到）。

### `defaultActive` —— 注册了但不激活

```ts
defaultActive: false
```

注册了、但**不进活跃集**。要激活它：在白名单里点名，或用 `agent.tools.add()`
（`add` 会**显式激活**，绕过 `defaultActive` 过滤 —— 见 `test/tools.test.ts` 的
「add 一个 defaultActive:false 的工具」用例）。

### `outputSchema` —— 声明结构化返回

```ts
outputSchema: Type.Object({ files: Type.Array(Type.String()) })
```

声明了它，就应该在结果里总是设 `structuredContent`；codemode 脚本会拿到**结构化数据**而不是文本。
不写的话，模式要自己从 `content[].text` 里解析。

---

## 6. 执行语义：`executionMode` / `annotations`

### `executionMode` —— 能不能和别的工具并发

```ts
executionMode?: "sequential" | "parallel"
```

- `"sequential"`：这个工具必须和其他工具调用**一个一个来**。
- `"parallel"`：可以并发。
- 不写：用默认模式。

**什么时候要 `sequential`**：工具有共享副作用（改同一个文件、写同一张表、操作同一个设备）。
模型一轮里可能同时发几个工具调用，并发跑会打架。

> ⚠️ 未验证：**没实跑过**。语义来自 pi 类型注释，我没构造出「并发确实发生/被阻止」的探针。

### `annotations` —— 给权限门看的提示

```ts
annotations?: {
  readOnlyHint?: boolean;      // 不修改环境
  destructiveHint?: boolean;   // 可能删/覆盖
  idempotentHint?: boolean;    // 重复调用无额外效果
  openWorldHint?: boolean;     // 与开放世界交互（如网络）
}
```

**这些是「作者声称」，pi 不验证**（MCP 的同一套语义）。用途是给 `permissions.gate` 的决策用：

```ts
agent.permissions.gate(async (call) => {
  const def = agent.tools.raw.getToolDefinition(call.name);
  if (def?.annotations?.destructiveHint && !(await askHuman(call))) {
    return { block: true, reason: "破坏性操作需要人工确认" };
  }
});
```

`annotations` 只是**元数据**，拦不拦由你的门决定 —— 别把它当护栏。

---

## 7. 还在 `ToolDefinition` 里、但基本用不上的

| 字段 | 是什么 | 为什么通常不用 |
|---|---|---|
| `renderShell` | `"default"` / `"self"`，TUI 渲染外框 | CLI/TUI 的显示，跨 agent 实验用不上 |
| `renderCall` / `renderResult` | 自定义 TUI 渲染组件 | 同上；返回 pi-tui 的 `Component` |
| `namespace` | 工具分组（如 MCP server 名下） | 工具多到要分组时才需要 |
| `prepareLoadout` | 动态改「模型看到的工具清单」 | **未验证**；是给别人写编排框架用的 |

---

## 8. 一个完整的编排型工具示例

把上面几样拼起来：**藏内层 + 脱敏 + 编排**。

```ts
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// 内部步骤：藏起来，模型看不到（exposure: "hidden"）
const readSecretFile = defineTool({
  name: "read_secret_file",
  label: "Read Secret",
  description: "读一个文件（内部步骤，不给模型直接调用）",
  exposure: "hidden",
  parameters: Type.Object({ path: Type.String() }),
  execute: async (_id, p) => ({ content: [{ type: "text", text: await readIt(p.path) }], details: {} }),
});

// 外层：模型只看到这一个，返回已脱敏
const readRedacted = defineTool({
  name: "read_redacted",
  label: "Read Redacted",
  description: "读文件并自动脱敏敏感信息。路径用相对路径。",
  promptSnippet: "read_redacted: 读文件（自动脱敏）",
  promptGuidelines: ["读配置文件时优先用它，而不是 read。"],
  parameters: Type.Object({ path: Type.String({ description: "相对路径，如 config/app.json" }) }),
  prepareArguments: (args) => {
    const a = args as Record<string, unknown>;
    return { path: String(a.path ?? a.file ?? "").replace(/^\.\//, "") };  // 兼容 file / 去掉 ./
  },
  executionMode: "sequential",
  annotations: { readOnlyHint: true, idempotentHint: true },
  execute: async (_id, p, _sig, _upd, ctx) => {
    const out = await ctx.executeTool("read_secret_file", { path: p.path });
    if (out.isError) {
      return { content: [{ type: "text", text: `读不到 ${p.path}` }], details: { isError: true } };
    }
    const raw = String((out.result as any)?.content?.[0]?.text ?? "");
    const safe = raw.replace(/(sk-|oc_sk_)[A-Za-z0-9_-]+/g, "$1<已脱敏>");
    return { content: [{ type: "text", text: safe }], details: { bytes: safe.length } };
  },
});

// 第二道防线：就算内层被直接调到，也脱敏
agent.tools.onResult((result) => {
  if (result.toolName !== "read_secret_file") return undefined;
  return {
    content: result.content.map((c) =>
      c.type === "text" ? { ...c, text: c.text.replace(/(sk-|oc_sk_)[A-Za-z0-9_-]+/g, "$1<已脱敏>") } : c,
    ),
  };
});
```

**每个字段都在干实事**：`exposure` 藏内层、`promptSnippet` 让模型选得对它、
`prepareArguments` 兜参数、`executionMode` 防并发打架、`annotations` 给门看、
`onResult` 是**第二道**防线。

> ⚠️ 这段示例**没整段实跑过**（各字段分别验过，没拼在一起跑）。它是构思，不是已验证的代码。

---

## 9. 三个容易踩的坑

**① `details` 的分支类型必须统一。** 一个工具里 `return` 出几种不同形状的 `details`，
`tsc` 会拿**第一个分支**当契约，后面全报错。标一个类型：

```ts
type MyDetails = { kind: "ok" | "error"; bytes?: number; message?: string };
execute: async (_id, p): Promise<{ content: { type: "text"; text: string }[]; details: MyDetails }> => { /* ... */ }
```

（这是实测撞出来的 —— `demo/lab.ts` 的 `file_stats` 就栽在这上面。）

**② `content` 必须是数组。** 返回 `"文本"` 不行，要 `[{ type: "text", text: "..." }]`。

**③ `signal` 要传下去。** `io.abort()` 时它变 aborted，但**只有你用了它才生效**：

```ts
execute: async (_id, p, signal) => {
  const r = await fetch(url, { signal });          // abort 才真的掐得断
  for (const item of items) {
    if (signal?.aborted) throw new Error("已中断"); // 长循环要自己检查
  }
}
```

---

## 10. 怎么验你的工具真的生效了

三条判据，都要看**模型实际收到了什么**，不能只看代码：

```ts
agent.io.raw.getActiveToolNames()                        // ① 真的在活跃集里
agent.io.raw.systemPrompt.includes("你的工具名")          // ② 进了 system 清单（前提：写了 promptSnippet）
sentTools().includes("你的工具名")                        // ③ 模型这轮真收到了它的 schema
```

**最硬的判据是「工具真的被调用了」**：`agent.on("tool_call", e => ...)` 看事件，
或让假 provider `[[tool:名字]]` 真跑一次。

`examples/04-tools.ts` 的判别力就靠这个顺序：**先起、后加、再看下一轮** ——
创建期就有的工具「不加也在」，看到它说明不了 `add` 做了什么。

---

## 附录：探针清单

本文的每个断言对应一个探针，都在 `spike/` 下，`node` 直接跑：

| 探针 | 验的是什么 |
|---|---|
| `tools-prompt-snippet.ts` | `promptSnippet` / `promptGuidelines` 进不进 system |
| `tools-execute-tool.ts` | `ctx.executeTool()` 编排、返回形状、嵌套 id |
| `tools-prepare-args.ts` | `prepareArguments` 兜旧参数名 |
| `tools-onresult.ts` | `onResult` 改写工具返回给模型的内容 |

**未验证清单**（文中都标了，这里一并说清）：`exposure` 各值的确切行为、
`executionMode` 的并发效果、`prepareLoadout`、以及 §8 那个完整示例。
这些是从 pi 的类型定义与注释读出来的，**有依据但没实跑**。
