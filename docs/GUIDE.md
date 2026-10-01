# aiteam 用法讲解

面向**设计者**（写代码的人）：本文讲这个库怎么用。
配合两个东西读效果最好：可运行的导览 [`demo/tour.ts`](../demo/tour.ts) 和它跑出来的真实日志 [`demo/run-output/tour.log`](../demo/run-output/tour.log)（本文引用的输出都来自那次运行）。

---

## 1. 心智模型：三个概念

| 概念 | 含义 | 谁能定义 |
|---|---|---|
| **成员（Member）** | 一种预定义好的 agent 类型：职责、模型、技能、插件、工具集 | **只有你**（写代码的人） |
| **分身（Instance）** | 某个成员的一个运行实例，同一成员可有多个 | agent 在运行时通过 `spawn_agent` 启动 |
| **花名册（members）** | 你声明的全部成员 | 你 |

**红线：agent 不能设计、不能配置 agent。** 它只能从花名册里挑人、告诉它干什么。
所以 `spawn_agent` 没有 `tools` 参数，也不接受任何配置覆盖 —— 想加一种新 agent，就在花名册里加一个成员。

---

## 2. 三分钟上手

```ts
import { createAgent, createAgentHost } from "../src/index.ts";

const host = createAgentHost({
  members: {
    reviewer: {
      description: "审查员：专挑风险、成本与遗漏",   // 会出现在 spawn_agent 的工具描述里
      role: "你是审查员，只说风险，不说好话。",       // → 追加系统提示词
      model: "opencode-go/deepseek-v4.1-flash",
      tools: ["read"],                              // 白名单
    },
    writer: { description: "撰稿人", role: "你写稿。", model: "opencode-go/qwen3.8-flash" },
  },
  maxAgents: 16,
  maxDepth: 2,
  budgetTokens: 200_000,
});

// 顶层 agent（主持人）
const lead = await createAgent(
  { role: "用 spawn_agent 挑成员派活。", model: "opencode-go/deepseek-v4.1-flash", tools: ["spawn_agent", "send_message"] },
  { host },
);

const result = await lead.prompt("审查 src/index.ts 的风险，然后让 writer 写 300 字简报");
console.log(result.text, result.usage);

host.dispose();   // 级联回收所有分身
```

三件事记住就够用：**你在花名册里声明能力；`createAgent` 起一个分身；`prompt` 交办拿结果。**

---

## 3. 环境：agentDir 里只放三样东西

`agentDir` 决定这个 agent 能用什么。默认是环境变量 `AITEAM_AGENT_DIR` 或本机 pi 目录（`~/.pi/agent`）；换成你自己的目录就完全脱离本机 pi 设置。

```
my-pi/
  models.json + auth.json   模型 api（其实只要 auth.json 也行，见下）
  extensions/               插件
  skills/                   技能
```

**没有 models.json 也能用**：pi 内置了 42 个 provider 的模型目录，`auth.json` 或环境变量凭证就够跑。
导览里就是这么干的（日志第 1 章）：

```
自建环境 C:\Users\Holder\.aiteam-tour-env（本机 pi 目录 C:\Users\Holder\.pi\agent 不参与）
  技能：tour-skill(user)
  插件：(无)
  上下文文件：D:\space\aiteam\test\AGENTS.md
  可用模型：29/29（opencode-go）
  警告：没有 models.json（只用环境变量凭证时可忽略）
```

### 建 agent 之前先验证环境

```ts
import { inspectEnv } from "../src/index.ts";

const env = await inspectEnv({ agentDir: "D:/my-pi", cwd: "./work" });
env.models;       // [{ provider: "opencode-go", total: 29, available: [...] }]  只列配好凭证的
env.extensions;   // [{ path, scope, tools: ["某个工具名"] }]
env.skills;       // [{ name, filePath, scope }]
env.contextFiles; // 跟着 cwd 走的 AGENTS.md 链
env.warnings;     // 目录不存在 / 没有 models.json / 扩展加载失败 / SYSTEM.md 会替换提示词…
```

它只读、不建 agent、不写盘。**为什么需要它**：`agentDir` 与 `cwd` 里的东西是 SDK 自动发现的，会静默生效（尤其：自动发现的扩展工具**不受** `tools` 白名单管辖），而 `SYSTEM.md` 存在时会整体替换系统提示词。`inspectEnv` 把这些变成可读文本。

### 模型目录会自己更新

`modelNetwork` 默认开：库会去 `pi.dev` 拉一份 provider 的模型目录 overlay（带 ETag，4 小时新鲜度窗口），缓存到 `<agentDir>/models-store.json`。所以上游加了新模型，不用等 SDK 发版。

- 只刷新**有凭证的 provider**（没凭证的压根不去拉）。
- `modelNetwork: false` 时**仍然**会从缓存恢复 overlay —— 跟 CLI pi 共用 `agentDir` 就白拿它拉过的更新。
- `PI_OFFLINE=1` 关掉一切模型相关网络请求；`catalogBaseUrl` 可指镜像。

---

## 4. 逐个操控面

### 4.1 身份与归属

```ts
agent.id          // 自动生成（a1、a2…）或你在 spec 里指定
agent.parentId    // 谁起的它；顶层为 undefined
agent.member      // 由哪个成员创建；顶层为 undefined
agent.status      // idle | running | aborted | error | disposed
agent.isStreaming // 直接用 SDK 的值
```

### 4.2 工具集

```ts
tools: ["read", "write"]        // 白名单；[] 表示一个工具都不给；不写 = 不动白名单
excludeTools: ["write"]         // 从最终集合里剔除
customTools: [myToolFactory]    // 你自己的工具
```

三条必须知道的规则：

1. **白名单非空时会强制并入 `customTools` 和你在 `extensions` 里声明的扩展工具名。** 想关掉某个 customTool，只能用 `excludeTools`。
2. **环境里自动发现的扩展工具不受白名单管辖** —— 用 `inspectEnv().extensions[].tools` 看它们是谁。
3. `tools` 写错一个字符不会报错，会静默塌成"没有工具"。

### 4.3 自定义工具：能看见"是谁在调用我"

```ts
import { defineAgentTool } from "../src/index.ts";
import { Type } from "typebox";

const reportSelf = defineAgentTool({
  name: "report_self",
  label: "Report Self",
  description: "上报调用者的身份与宿主状态",
  parameters: Type.Object({}),
  execute: async (_params, ctx) => {
    const text = JSON.stringify({
      id: ctx.agent.id,                 // 谁在调用
      member: ctx.agent.member,
      status: ctx.agent.status,
      alive: ctx.host?.list().map((a) => a.id) ?? [],   // 宿主里还有谁
    });
    return { content: [{ type: "text" as const, text }], details: {} };
  },
});

const agent = await createAgent({ ...spec, tools: ["report_self"], customTools: [reportSelf] }, { host });
```

`ctx.agent` 是**惰性**的：工厂在 `createAgent` 期间被调用一次（模型得先看到 `name`/`parameters`），只有 `execute` 时才取得到持有它的那个 agent。这不是优化 —— SDK 传给工具 `execute` 的上下文里**没有**当前 agent 引用。

导览实测（日志第 3 章）：

```
回复：{"id":"toolsmith","member":"(顶层)","status":"running","tokens":0,"alive":["toolsmith"]} 2026-10-01T13:52:37.199Z
```

（`status` 是 `running`、`tokens: 0` 是正常的：工具在轮次内执行，用量要等这轮结束才结算。）

### 4.4 插件（扩展）：路径或内联工厂

```ts
const inlinePlugin = (pi) => {
  pi.registerTool({ name: "utc_now", /* … */ });
  pi.on("tool_call", (event) => console.log("有工具要被调用了", event.toolName));
};

await createAgent({ ...spec, extensions: [inlinePlugin] });       // 内联工厂，不落盘
await createAgent({ ...spec, extensions: ["./my-plugin.ts"] });   // 文件路径
```

扩展提供了工具、钩子、命令、flag。注意：**扩展加载失败是静默的**（agent 照跑），原因只在 `loader.getExtensions().errors` 里 —— 用 `inspectEnv().warnings` 看。

### 4.5 审批门：拦截工具调用

```ts
onToolCall: async ({ name, input }) => {
  if (name !== "write") return undefined;                   // 放行
  const path = normPath(String(input.path), cwd);            // ← 一定要归一化再比
  return path.startsWith(workDir) ? undefined : { block: true, reason: "只允许写工作目录" };
}
```

导览实测（日志第 4 章）：

```
审批门收到的输入：{"path":"C:/windows-temp-outside.txt","content":"越界"} | {"content":"合规","path":"D:\\…\\run-output\\gate…"}
审批门决策：write(拦截)、write(放行)
回复：第一次(越界)被拒：只允许写 demo/run-output/ 目录内的文件；第二次(合规)写入成功。
```

两个坑：**路径必须 resolve 后比**（模型爱给相对路径，我第一次没归一化就把两次写都拦了）；门内的 `throw` 等于无条件拦截且异常文本会进上下文。

### 4.6 技能

```ts
skills: [
  "by-name",                       // 名字：在 agentDir/skills 或 <cwd>/.pi/skills 下解析
  "D:/my-pi/skills/foo",           // 目录
  "D:/my-pi/skills/foo/SKILL.md",  // 文件
  skillObject,                     // Skill 对象（必须指向真实存在的文件）
]
```

名字解析失败**抛错**，不静默降级。技能会进系统提示词的 `<skills>` 段 —— 但前提是这次给的工具里有 `read` 或 `bash`。

### 4.7 角色与提示词

```ts
role: "你是审查员，只说风险。"   // → appendSystemPrompt
```

保留 pi 的默认提示词（含 `<tools>` 段），角色说明追加在其后。**库不提供整体替换入口**。

⚠️ 环境里若存在 `SYSTEM.md`（`<agentDir>/SYSTEM.md` 或 `<cwd>/.pi/SYSTEM.md`），它会**整体替换** `preamble` —— `<tools>` / `<rules>` / `<docs>` 三段一起消失。`inspectEnv` 会把这件事写进 warnings。

### 4.8 模型与思考档

```ts
model: "opencode-go/deepseek-v4.1-flash"          // "provider/id:thinking"
model: "opencode-go/deepseek-v4.1-flash:high"
thinking: "high"                                   // 也可以单独指定
```

模型不存在会**抛错**（SDK 原本只给 warning，库把它转成异常，避免拼写错误变成静默怪行为）。没有 temperature / top_p / seed 入口。

### 4.9 输入流向

```ts
const r  = await agent.prompt("交办");            // 顶层交办，等它跑完，拿 RunResult
const s  = await agent.send("追加一条");           // 投递：忙时排队，永不抛错，不 await 结果
await agent.steer("停，改做这个");                 // 运行中插话，立刻改向
await agent.waitForIdle();                        // 等它静下来
```

导览实测（日志第 5 章）：

```
第一次 prompt：收到
send 返回：ran / queued                     ← 空闲时 ran；紧接着第二次投递因目标正忙 → queued
waitForIdle 后 lastResult：乙
· steer 是否真的打断了这一轮 → 已打断
```

要点：
- `send` **故意不 await**。await 了就变成同步 `ask`，会把死锁引进来。要结果就 `send` → `waitForIdle()` → 读 `agent.lastResult`。
- `send` 忙时排队（`mode: "interrupt"` 则立刻改向），**永不抛错**。
- 空闲时调用 `steer` 不会丢弃消息，而是**停放**到下一次 `prompt` 时顶替那轮的返回文本 —— 别在空闲时用 steer。

### 4.10 输出

```ts
interface RunResult { text: string; usage: Usage; error?: string }
```

`prompt` 返回本次结果，同时写进 `agent.lastResult`。**`error` 必须看**：pi 的 `prompt()` 在接受之后失败是通过事件流报告的，不 reject —— 不看 `error` 会把失败当成功。

`agent.session` 是逃生口（原始 SDK 对象），消息历史从 `agent.session.messages` 拿。

### 4.11 事件：7 个归一化 + 3 个宿主

```ts
agent.on("text",       ({ delta }) => process.stdout.write(delta));
agent.on("thinking",   ({ delta }) => {});
agent.on("tool_start", ({ toolName, callId }) => {});
agent.on("tool_end",   ({ toolName, callId, isError }) => {});
agent.on("turn",       ({ message, usage }) => {});          // 每一轮
agent.on("error",      ({ message }) => {});
agent.on("done",       ({ usage }) => {});                   // 本次运行结束

host.on("agent_created",   ({ agent, member, parent }) => {});
host.on("agent_disposed",  ({ agent }) => {});
host.on("round_completed", ({ agent, result }) => {});       // 最常用：按轮计费/督导
```

导览实测（日志第 4 章）：

```
事件计数：text=51 thinking=19 tool_start=2 tool_end=2 turn=3 error=0 done=1
```

库只发事件、**不内置任何监控策略** —— 轮次上限、成本报警、进度上报都由你写。

### 4.12 用量与归属

| 读哪里 | 含义 |
|---|---|
| `RunResult.usage` | **本次**运行的用量 |
| `agent.usage` | 这个分身**全生命周期**累计（不含子分身） |
| `host.usage` | 整个宿主（含所有后代） |

导览实测（日志第 9 章）：

```
r1=1886 r2=1897 r3=4035｜agent.usage=7818
✔ agent.usage = 它自己各次 RunResult 之和（不含子分身）
✔ host.usage 把这棵树上所有分身的用量加在一起 → 宿主 9723 vs 顶层 7818
```

记住了：**子分身的钱不算在父分身头上，但一定算在宿主头上。**

### 4.13 花名册与多 agent

顶层 agent 只有拿到 `spawn_agent` / `send_message`（写进 `tools`）才会组队：

```ts
const lead = await createAgent(
  { role: "你是主持人。", tools: ["spawn_agent", "send_message"], model: "…" },
  { host },
);
await lead.prompt("用 spawn_agent 让 scout 把要点写进 D:/out/board.md");
```

导览实测（日志第 7 章）：

```
· 分身就位 lead lead
· 分身就位 scout a1
· scout(a1) 跑完一轮 +8500 tokens
✔ spawn_agent 真的起了 scout 分身 → lead:lead scout:a1 checker:a2
✔ send_message 追加的那一轮确实跑了（分身被复用，不是新建的） → 1 → 2
✔ host.dispose() 级联回收
```

规则：
- `spawn_agent` 的 `member` 是**花名册成员名的字面量联合**，描述里动态列出全部成员 —— 模型无法请求不存在的成员。
- 分身跑完后**保留**在宿主里可寻址（后续 `send_message(id)` 复用同一个上下文）。
- `send_message` 只准投给**自己的后代分身**。这条既防跨分支干扰，也免费消灭了发送环。
- **共享上下文不用框架支持**：全队 `MemberSpec.cwd` 指向同一个目录，读写同一个文件就是黑板。

### 4.14 生命周期

```ts
await agent.abort();   // 中止当前轮：status → "aborted"，之后这个分身还能继续用
agent.dispose();       // 回收（正在跑就先 abort，等 settle 再真回收）
host.dispose();        // 级联回收所有分身
```

导览实测（日志第 6 章）：

```
abort 后 status=aborted，本轮文本长度=0
✔ 被 abort 的分身还能继续用
```

已 `dispose` 的分身再 `prompt` / `send` 会抛错（`waitForIdle` 例外，直接返回）。

### 4.15 护栏

```ts
createAgentHost({ maxAgents: 16, maxDepth: 2, budgetTokens: 200_000 });
```

| 护栏 | 口径 | 触发时 |
|---|---|---|
| `maxAgents` | **终身累计**，回收不返还 | `createAgent` 抛错；agent 手里是文本 |
| `maxDepth` | 顶层为 0，深度由 `parent` 链推出（不作为参数传入，防伪造） | 同上 |
| `budgetTokens` | 全宿主累计 | 同上 |

导览实测（日志第 8 章）：

```
✔ 预算耗尽在创建时就被拦住 → 宿主预算已耗尽（budgetTokens=0，已用 0）
✔ 超过 maxAgents 被拦住   → 宿主已达到 maxAgents=1 的分身上限，不能再创建
✔ 超过 maxDepth 被拦住    → 分身深度 1 超过 maxDepth=0，不能再往下一层
· agent 侧收到的是文本而不是异常 → 分身起不来，被护栏挡了：…（模型有机会换策略）
```

设计取向：**设计者踩到护栏是异常（抛错），agent 踩到护栏是文本**（让它自己换策略）。

---

## 5. 已知边界（都是实测结论，不是猜测）

| 边界 | 后果 | 规避 |
|---|---|---|
| `settings.json` 不被读（`SettingsManager.inMemory({})`） | compaction 不可配；`pi install` 装的扩展包不生效 | 扩展用 `extensions` 显式声明 |
| 白名单非空 ⇒ customTools 强制生效 | 关不掉，只能 `excludeTools` | — |
| 环境自动发现的扩展不受白名单管 | 工具的"意外来源" | `inspectEnv().extensions[].tools` |
| `SYSTEM.md` 整体替换提示词 | `<tools>`/`<rules>` 消失 | 用 `role` 追加；`inspectEnv` 会警告 |
| 并发投递时结果会串台 | `RunResult` 排干的是共享消息池 | 用 `prompt`，或 `send` + `waitForIdle` 后读 `lastResult` |
| 预算只挡"轮前" | 单轮不封顶；忙时 `followUp`/`steer` 绕过 | 用 `host.on("round_completed")` 自己督导 |
| 上下文超限 | 该分身**永久静默返回空**（`text:""`, `usage:0`） | 长任务多起分身，别让单个分身无限长跑 |
| 被 `abort` 的轮次 | 留着 user 消息永久占上下文；usage 记 0 但真实计费 | 别频繁 abort |
| 忙时 `prompt()` 抛错且不发事件 | 得自己 catch | 团队场景一律用 `send` |
| `tools` 写错一字符 | 静默变成"没有工具" | `inspectEnv` 对不了这个，写白名单时小心 |

不承诺：**pi 没有内置沙箱**，`tools` 白名单只是工具集裁剪，不是安全边界。

---

## 6. 三个常用配方

**扇出择优**（同一任务给多个成员，你来选）：

```ts
const a = await createAgent({ ...spec, model: "opencode-go/mimo-v2.6-flash" }, { host });
const b = await createAgent({ ...spec, model: "opencode-go/qwen3.8-flash" }, { host });
const [ra, rb] = await Promise.all([a.prompt(task), b.prompt(task)]);
console.log(pick(ra.text, rb.text));
```

**反思-修订循环**（写手 + 审阅者，全程复用同一对分身）：

```ts
let draft = (await writer.prompt("写初稿")).text;
for (let i = 0; i < 3; i++) {
  const review = await reviewer.prompt(`审这份稿：\n${draft}`);
  if (review.text.includes("通过")) break;
  draft = (await writer.prompt(`按意见改：\n${review.text}`)).text;
}
```

**监督者 + 工人池**（主持人自己组队，你用事件督导成本）：

```ts
host.on("round_completed", ({ agent, result }) => {
  if (host.usage.totalTokens > 150_000) agent.dispose();   // 超支就掐
});
await lead.prompt("用 spawn_agent 让 reviewer 审完 src/index.ts，再把结论交给 writer");
```

---

## 7. 跑起来

```bash
npm test              # 14 个测试文件，本机假 provider，零 API 成本
npm run demo:tour     # 全操控面导览（本文引用的那份日志）
npm run demo          # 真模型多轮协作：形态 5「团队探讨到收敛」
npm run demo:self-env # 只用自建环境（auth.json + 自己的技能）跑一轮
```

导览的运行产物**不会清理**，都在 `demo/run-output/`：`tour.log`（全过程）、`report.json`（检查项与花费）、`facts.txt` / `gated.txt` / `blackboard.md`（agent 真写出来的文件）。
它默认用 `opencode-go/deepseek-v4.1-flash`，全程约 59k tokens ≈ **$0.003**。换成自己的模型：`TOUR_MODEL=... npm run demo:tour`。

导览里每章都会打印 `✔`（硬检查，失败即退出码 1）或 `·`（依赖模型配合的软提示）。
