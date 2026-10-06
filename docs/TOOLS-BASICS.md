# 自定义工具：基础

从零写出第一个工具，并让它**真的被模型调用**。

> **本文与 [`TOOLS.md`](TOOLS.md) 的分工**：
> 本文讲**最小可用**（怎么写、怎么挂、返回值、参数、错误）；
> `TOOLS.md` 讲**高级操作**（编排别的工具、改写给模型的返回、呈现控制、并发）。
> 读完本文接着读它。
>
> 本文每个断言都实跑核对过（探针在 `spike/tools-basics*.ts`，`node` 直接跑、离线零成本）。

---

## 1. 最小形态：一个工具就是四样东西

```ts
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";   // pi 自带，不用另装

const wordCount = defineTool({
  name: "word_count",                                    // ① 模型调用时用的名字
  label: "Word Count",                                   // ② TUI 上显示的标签
  description: "数一段文本有多少个词。文本按空格分隔。",      // ③ 模型判断「什么时候用它」的唯一依据
  parameters: Type.Object({ text: Type.String() }),      // ④ 参数形状
  execute: async (_id, params) => ({
    content: [{ type: "text", text: String(params.text.split(/\s+/).filter(Boolean).length) }],
    details: {},
  }),
});
```

| 字段 | 谁看 | 写不好的后果 |
|---|---|---|
| `name` | 模型 + 你的代码 | 模型调不到（名字对不上） |
| `label` | 人（TUI） | 只是显示，写错不影响功能 |
| `description` | **模型** | **写含糊 → 模型不知道何时该用 → 永远不调** |
| `parameters` | 模型 + pi | 写错类型 → 模型传的参被挡下 |
| `execute` | —— | 真正跑的函数 |

**`description` 是这一整套里最需要打磨的。** 模型没有别的信息，只有这一句话：

```ts
// ✗ 模型猜不到参数要给什么
description: "查天气"

// ✓ 说清是什么、参数怎么给
description: "查询某个城市的天气。城市名用中文，例如「北京」。"

// ✗ 模型不知道什么时候该用它
description: "处理数据"

// ✓ 给出使用时机
description: "统计一段文本的词数、行数、字符数。当用户问「这段有多少字」时用它。"
```

---

## 2. `parameters` —— 参数 schema

用 `typebox` 的 `Type`，写出来的是 JSON Schema。**`params` 的 TS 类型由它自动推出来** —— 写错字段名 `tsc` 当场报。

```ts
Type.Object({
  text:     Type.String(),                                      // 必填字符串
  times:    Type.Optional(Type.Number()),                       // 可选数字
  mode:     Type.Union([Type.Literal("fast"), Type.Literal("slow")]),  // 枚举
  tags:     Type.Array(Type.String()),                          // 字符串数组
})
```

### 四个常用写法

```ts
// ① 带说明的参数（会进模型看到的 schema，值得写）
Type.String({ description: "文件路径，相对路径即可，如 notes.md" })

// ② 可选 + 默认值（默认值你自己在 execute 里兜）
Type.Optional(Type.Number({ description: "重复次数，默认 1" }))

// ③ 枚举（比 String 强：模型不会瞎编值）
Type.Union([Type.Literal("md"), Type.Literal("txt")])

// ④ 嵌套对象
Type.Object({ opts: Type.Object({ verbose: Type.Boolean() }) })
```

### 校验失败会怎样（实测 `spike/tools-basics.ts`）

pi **自动**把结构化错误回给模型，模型通常能自己纠正重试：

```
① 参数类型不对（传了字符串 "不是数字"）：
   Validation failed for tool "strict":
     - n: must be number
   Received arguments: { "n": "不是数字" }

② 字段名写错（传了 wrong）：
   Validation failed for tool "strict":
     - n: must have required properties n
   Received arguments: { "wrong": "字段名错了" }
```

> 注意：**`result.error` 是 `undefined`**，这段文字是作为工具返回内容给模型的。
> 也就是说「参数错了」在 aiteam 这一层**不算一次错误运行** —— 模型会自己纠。

---

## 3. `execute` —— 参数、返回值、`signal`

签名：

```ts
execute: async (
  toolCallId: string,              // 这次调用的 id
  params: { ...自动推断... },       // 上面 schema 推出来的类型
  signal: AbortSignal | undefined, // 中断信号
) => ({ content: [...], details: {} })
```

### 返回值必须是这个形状

```ts
return {
  content: [{ type: "text", text: "给模型看的文本" }],   // ← 给模型
  details: { /* 任意结构 */ },                          // ← 给你自己（模型看不到）
};
```

**`content` 是数组**（可以文字 + 图片混合）。**返回字符串会炸**（实测）：

```
返回 content: "纯文本"  →  报错 content.some is not a function
```

`details` 是给你自己的结构化数据 —— 做 trace、断言、统计时用它，模型看不到。

**⚠️ `details` 的分支类型必须统一**（实测撞出来的坑）：一个工具里 `return` 出几种不同形状的 `details`，
`tsc` 会拿**第一个分支**当契约，后面全报错。标一个类型：

```ts
type MyDetails = { kind: "ok" | "error"; bytes?: number; message?: string };

execute: async (_id, p): Promise<{ content: { type: "text"; text: string }[]; details: MyDetails }> => {
  if (!p.text) return { content: [...], details: { kind: "error", message: "没给文本" } };
  return { content: [...], details: { kind: "ok", bytes: 42 } };
}
```

（`demo/lab.ts` 的 `file_stats` 就栽在这上面。）

### `signal`：中断要用它才生效

`agent.io.abort()` 时它会变成 aborted，**但只有你用了它才有效**：

```ts
execute: async (_id, p, signal) => {
  const r = await fetch(url, { signal });        // ① 传给 fetch：abort 会真的掐断
  for (const item of bigList) {
    if (signal?.aborted) throw new Error("已中断");  // ② 长循环要自己检查
    await work(item);
  }
}
```

**实测（`spike/tools-basics2.ts`）**：一个 30 步、每步 50ms 的工具，跑到第 8 步时 `abort()` ——
工具在下一次检查点看到了 `signal.aborted === true`。

**不检查 `signal` 的工具会跑到底** —— 库不会替你掐它。

---

## 4. 挂上去：两条路

写好的工具要交给 agent 才生效。两条路：

### 路 A：创建期（`spec.tools.custom`）

```ts
const agent = await lab.createAgent({
  model: MODEL,
  tools: { custom: [wordCount] },
});
```

agent 一诞生就有这个工具。

### 路 B：运行期（`agent.tools.add`）

```ts
await agent.io.waitIdle();        // ← 必须先空闲
await agent.tools.add(wordCount);
```

**什么时候用哪条**：

| | 创建期 | 运行期 |
|---|---|---|
| 时机 | agent 还没起，一次性给全 | agent 已经在跑，中途加 |
| 忙时能用吗 | 是 | **否，先 `io.waitIdle()`** |
| 典型用途 | 固定能力集 | 「跑到一半发现需要新能力」 |

`add` 为什么要求空闲：它碰的是**声明面**，要走 pi 的 `reload()`，而**运行中 reload 会静默不生效** ——
库选择抛错，而不是让你拿到一个假的成功。

### 工厂式：工具需要 agent 句柄时

工具想拿到「我是哪个 agent」这类信息，就把定义写成一个**接受 `ctx` 的函数**：

```ts
const factoryTool = (ctx: { agent: { id: string } }) =>
  defineTool({
    name: "whoami",
    label: "WhoAmI",
    description: "报告自己是哪个 agent",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: `agent id = ${ctx.agent.id}` }],
      details: {},
    }),
  });
```

**实测（`spike/tools-basics2.ts`）**：同一份工厂定义给两个 agent：

```
alpha: agent id = alpha
beta : agent id = beta
```

关键：工厂在**声明时被调一次**，`ctx.agent` 就是那个 agent —— 要用的能力在那一刻取好存进闭包。
（`ctx` 只有 `agent` 与 `signal`；见 `src/agent/types.ts` 的 `ToolContext`。）

---

## 5. 错误处理：抛异常会怎样

**实测（`spike/tools-basics.ts`）**：

```ts
execute: async () => { throw new Error("BOOM-工具内部异常"); }
```

结果：

```
result.error : undefined                              ← 注意！不是错误运行
result.text  : "echo:BOOM-工具内部异常"                 ← 错误文本给了模型
```

**三条要记住的**：

1. `execute` 里抛异常**不会**让 `result.error` 有值 —— pi 把它转成「工具返回了一段错误文本」，模型看得到。
2. **模型知道错了**，通常会自己改参数重试或换个做法。
3. 想让模型更清楚怎么办，**自己包一层**语义：

```ts
execute: async (_id, p) => {
  try {
    const out = await doWork(p);
    return { content: [{ type: "text", text: out }], details: { kind: "ok" } };
  } catch (e) {
    // 给模型一句它能据以行动的话，而不是把原始堆栈甩给它
    return { content: [{ type: "text", text: `处理 ${p.path} 失败：${(e as Error).message}。检查路径是否存在。` }], details: { kind: "error" } };
  }
}
```

**什么时候该抛**：真出了你不希望被模型「聪明地绕过」的问题（内部 bug、前置条件被破坏）。
抛出去 = 把控制权交给模型，它会自己想办法。

---

## 6. 跑起来：怎么确认它真的生效了

**别只看代码**。三条判据，都要看**模型实际收到了什么**：

```ts
// ① 工具在活跃集里
agent.io.raw.getActiveToolNames()          // 应包含 "word_count"

// ② 模型这轮真的收到了它的 schema（用假服务的请求记录）
import { sentTools } from "../examples/lib/harness.ts";
sentTools().includes("word_count")

// ③ 最硬：它真的被调用了
agent.on("tool_call", (e) => console.log("调了", e.toolName));
```

### 一个能直接跑的完整例子

```ts
// node demo/xxx.ts —— 用 demo 的环境跑
import { lab, MODEL } from "./env.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const wordCount = defineTool({
  name: "word_count",
  label: "Word Count",
  description: "数一段文本有多少个词。文本按空格分隔。",
  parameters: Type.Object({ text: Type.String({ description: "要统计的文本" }) }),
  execute: async (_id, p) => ({
    content: [{ type: "text", text: `${p.text.split(/\s+/).filter(Boolean).length} 个词` }],
    details: {},
  }),
});

const agent = await lab.createAgent({ model: MODEL, tools: { custom: [wordCount] } });

console.log("活跃集:", agent.io.raw.getActiveToolNames().join(", "));

let called = false;
const off = agent.on("tool_call", (e) => {
  if (e.toolName === "word_count") called = true;
});

const r = await agent.io.prompt("数一下这句话有几个词：the quick brown fox jumps");
off();
console.log("模型说:", r.text);
console.log("工具真被调了？", called);

agent.dispose();
```

> ⚠️ 真模型下「它一定调了工具」不能当断言用 —— 提示词是自然语言，模型可能自己数完直接回答。
> 上面这个打印是**观察**，不是判据。要做硬判据就用 `spike/` 里那种假 provider 的写法。

---

## 7. 常见错误速查

| 症状 | 原因 | 修法 |
|---|---|---|
| 模型永远不调它 | `description` 太含糊 | 写清「做什么」+「什么时候用」+「参数怎么给」 |
| `content.some is not a function` | `content` 返回了字符串 | 包成 `[{ type: "text", text: "..." }]` |
| `tsc` 报 `details` 一堆类型错 | 分支的 `details` 形状不一致 | 标一个统一的 `details` 类型 |
| 加了工具但模型看不到 | 忙时 `add`（已抛错）/ `permissions.only` 没写它 | 先 `waitIdle()`；创建期声明的会自动并入白名单，运行期 `add` 的库也替你并 |
| `abort()` 之后工具还在跑 | 没用 `signal` | `signal` 传下去，长循环里自己检查 `signal?.aborted` |
| 参数一直校验失败 | schema 与提示词里描述的参数不一致 | 两边对齐；或用 `prepareArguments` 兜（见 `TOOLS.md` §3） |

---

## 8. 下一步

基础到这里就够了。**再往下是 [`TOOLS.md`](TOOLS.md)**：

| 你想做 | 看那里 |
|---|---|
| 让工具进 system prompt 的清单（模型更容易注意到它） | §1 `promptSnippet` / `promptGuidelines` |
| **一个工具里编排别的工具** | §2 `ctx.executeTool()` |
| 模型传旧参数名时兜底 | §3 `prepareArguments` |
| 改工具**返回给模型**的内容（脱敏/裁剪） | §4 `tools.onResult()` |
| 把子步骤藏起来不让模型看到 | §5 `exposure` |
| 有副作用的工具不跟别的并发 | §6 `executionMode` |

---

## 附录：探针

| 探针 | 验的是什么 |
|---|---|
| `spike/tools-basics.ts` | 非数组 `content`、`execute` 抛异常、参数校验失败 |
| `spike/tools-basics2.ts` | 工厂式的 `ctx.agent`、`signal` 在 abort 后可见 |
