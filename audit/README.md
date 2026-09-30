# 阶段 1 框架能力审计 —— 调研规范（所有 subagent 必读）

本文件是**唯一**的公共约定。你的任务书会指向本文件 + `docs/research/2026-09-30-framework-capability-audit-plan.md` 里属于你的那一部分。

---

## 1. 背景

`D:/space/aiteam/test` 是一个用 pi agent SDK 搭「agent 集群」的本地 TypeScript 库（包名 `aiteam`），**阶段 1 已实现并验收**。

- 规格：`docs/specs/2026-09-30-agent-control-lib-design.md`（决策表在 §5，接口在 §4，已实跑核对的结论在 §11）
- 实现计划：`docs/plans/2026-09-30-agent-control-lib.md`
- 源码：`src/`（约 1030 行），测试：`test/`（70 个测试全绿）

**阶段 1 已实现的能力**（你审计的对象）：
- `createAgent(spec, deps?)` → `ControlledAgent`（`prompt` / `send` / `steer` / `waitForIdle` / `abort` / `dispose` / `on` / `status` / `isStreaming` / `usage` / `lastResult` / `session`）
- `createAgentHost({ members, maxAgents, maxDepth, budgetTokens, defaults, modelRuntime })` → `AgentHost`（`list` / `get` / `on` / `usage` / `dispose` / `activeCount`）
- `defineAgentTool(def)` → 工厂式自定义工具（`execute(params, ctx)`，`ctx.agent` / `ctx.host`）
- 两个能力工具：`spawn_agent`（挑成员+派活+拿结果）、`send_message`（只能投给**自己的后代**）
- 成员配置字段（`MemberSpec`）：`description` `cwd` `agentDir` `role` `skills` `extensions` `tools` `excludeTools` `customTools` `model` `thinking` `onToolCall`

**关键设计红线**（审计时注意，别把"红线"当 bug）：
- agent **不能**设计/配置 agent —— `spawn_agent` 没有 `tools` 参数、不接受任何配置覆盖
- 库**不承诺**是安全边界（pi 无沙箱，`tools` 白名单只是裁剪）
- 任何**无超时的等待**都不允许（死锁规则）

---

## 2. 纪律（硬性）

| 规则 | 说明 |
|---|---|
| **只测不改** | **禁止**修改 `src/` `test/` `demo/` `docs/` `probe/` `spike/`。你的产出只写在 `audit/` 下自己的目录里 |
| **不要 commit** | 不碰 git。工作区里其他 agent 也在跑，commit 会冲突 |
| **不要跑 `npm test`** | 70 个测试已知全绿，重跑只是噪音。你要写的是**新**的探测脚本 |
| **不要改 `package.json`** | 缺依赖就在自己脚本里绕开 |
| **并行真模型调用 ≤ 4** | 唯一例外是「第 3 部分 并发/限流」，那里故意施压是你的任务 |
| **真模型必须先冒烟** | 每个真模型实验先跑 1 次，记录实际 token 与花费，再决定样本量 |
| **记录真实花费** | 从 `agent.usage.cost.total` 累加，写进 FINDINGS |
| **禁止编造** | 每个结论必须附**原始输出**。跑不出来就写"未验证"并说明卡在哪 |

---

## 3. 怎么跑代码

Node 24 **原生跑 `.ts`**，无构建步骤。相对 import **必须写 `.ts` 后缀**。只用**可擦除** TS 语法（不用 `enum` / `namespace` / 装饰器）。

```bash
cd /d/space/aiteam/test
node audit/你的目录/你的脚本.ts
```

---

## 4. 可复用的测试基建（`test/` 里已有，直接 import）

```ts
// test/faux-models.ts
export const FAUX_MODEL_REF = "faux/echo";
export function writeModelsJson(agentDir: string, baseUrl: string, modelId?: string): string;
export async function makeFauxRuntime(baseUrl: string):
  Promise<{ runtime: ModelRuntime; agentDir: string; cwd: string }>;
export function assistantTexts(session: any): string[];
export function lastAssistant(session: any): any;

// test/faux-server.ts
export async function startFaux(): Promise<Faux>;   // { baseUrl, calls, close() }
export function sleep(ms: number): Promise<void>;

// test/helpers.ts   ← 见下面的警告
export const faux: Faux;                 // 已启动的假服务
export const fauxAgentDir: string;
export const fauxCwd: string;
export function seenTools(target?, index?): string[];   // 假服务收到的工具名（ground truth）
export async function captureSystemPrompt(spec): Promise<{ system: string }>;
export const echoTool: ToolDefinition;   // 名字固定 probe_echo
export async function runTool(name, args, ctx): Promise<AgentToolResult>;
export function textOf(result): string;
```

### ⚠️ 关键坑：`test/helpers.ts` 会把真模型弄坏

`helpers.ts` 在 import 时执行 `process.env.AITEAM_AGENT_DIR = <假 provider 目录>`。而 `createAgent` 在不传 `agentDir` 时读这个环境变量。

**所以**：
- 只用假 provider 的脚本 → `import { faux } from "../test/helpers.ts"` 很方便
- 要**真模型**的脚本 → **不要 import `test/helpers.ts`**。自己 `import { startFaux } from "../test/faux-server.ts"`，然后真模型用：

```ts
const agent = await createAgent({ model: "opencode-go/deepseek-v4.1-flash", cwd, tools: [...] });
// 不传 deps → 走库自己的 ModelRuntime，读 ~/.pi/agent（本机已配好凭证）
```

真模型**不要**传 `agentDir`，不要传 `modelRuntime`。`test/faux-models.ts`（只提供 `makeFauxRuntime` 等纯函数）可以安全 import，它不设环境变量。

---

## 5. 假 provider 的脚本约定（写在**最后一条 user 消息**里，且最后一条不是工具结果时生效）

| 标记 | 作用 |
|---|---|
| `[[tool:NAME]]` | 让模型发起一次 `NAME` 工具调用（参数取同消息里最近的 `[[args:{...}]]`） |
| `[[call:NAME {...}]]` | 同上，但可以在一条消息里写**多个** → 模拟「同一 assistant 消息里的兄弟工具调用」（并发） |
| `[[args:{...}]]` | 给 `[[tool:]]` 指定 JSON 参数。**参数里不要嵌 `[[...]]` 标记**（只做 lazy 正则） |
| `[[sleep:MS]]` | 延迟 MS 毫秒再回包 → 制造「正忙」窗口 |
| `[[fail]]` | 回 HTTP 400 → 测错误路径 |
| `[[huge:BYTES]]` | 回一段超大文本 → 测上下文/用量 |

其余情况回 `echo:<原文截断>`。工具结果回来后，假服务会**回显本条回复里所有工具结果的内容**。

`faux.calls` 每条记录：`{ model, tools: string[], system, lastUser, messageCount }` —— **这是"模型实际收到了什么"的 ground truth**，比库的 API 更可信。

---

## 6. 真模型

- **只用** `opencode-go/deepseek-v4.1-flash`（用户指定）
- 本机配置在 `~/.pi/agent/`（`auth.json` + `models-store.json`），已验证可解析
- 参考花费：一次四轮多 agent demo 约 **$0.0041 / 32681 tokens** —— 很便宜，放开跑
- 真模型的典型价格字段：`agent.usage.cost.total`、`RunResult.usage.cost.total`

---

## 7. 产出规范

在你自己的目录 `audit/<你的编号-名字>/` 下写：

1. **探测脚本**（可重跑），命名带序号：`e1-xxx.ts`
2. **原始数据** `data.json`（机器可读，报告附录要用）
3. **`FINDINGS.md`** —— 唯一的人读产物，结构：

```markdown
# <第 N 部分：标题>

## 结论速览
- 一句话一条，每条带证据编号（如 E1）。正面结论与负面结论都要写。

## 实测证据
### E1 <实验名>
- **问题**：（要回答什么）
- **方法**：`node audit/xx/e1-xxx.ts`（脚本路径 + 关键手法）
- **原始输出**：
  ```
  （贴关键片段，不要改写、不要总结成"成功了"）
  ```
- **读出的现象**：（准确描述发生了什么，而不是判断好坏）
- **结论**：能 / 不能 / 部分能；边界在哪

（E2、E3…）

## 清单
| # | 现象 | 类别 | 严重度 | 证据 |
|---|---|---|---|---|
| 1 | … | 能力 / 极限 / **静默失败** / 缺口 | 高/中/低 | E3 |
```

**写作要求**：
- **准确 > 详细 > 简洁**。把现象描述准确，不堆形容词。
- 不写"效果良好""基本可用"这类无法检验的话。写"20 并发下 388ms 完成、无错误"。
- 失败、跑不通、结论不确定的，**照样写**，并写清卡在哪。这些对后续设计最有价值。
- 「静默失败」单独标出来 —— 不报错但不按预期工作的行为，是最危险的一类。

---

## 8. 汇报纪律（重要）

你的**最终返回消息**是给主 agent 的，**不要**把 FINDINGS.md 全文贴回来。
只返回（**200 字以内**）：
- `FINDINGS.md` 的绝对路径
- 最重要的 3–5 条结论，每条一句话
- 实际花费（真模型部分）
- 有没有没做完/跑不通的

详细的都写进文件。

---

# 第二部分：本轮的已知基线（2026-10-01 增补，**必读**）

## 已有两份产出，你的任务是补它们的洞

1. **既有审计报告**：`docs/research/2026-09-30-phase1-capability-audit-report.md`（511 行，203 条发现）+ 原始数据 `audit/findings/_all.json` + 脚本 `audit/01-config.ts` … `audit/10-redlines.ts`、`audit/r1..r7-live-*.ts`
   → **先读它对应的那一节**，不要重跑它已经覆盖的东西。
2. **第一轮交叉验证**：`audit/verification-of-report.md`（F/G/H/I/J/K 六节，每条都带脚本与原始输出）
   → **这一份记录了「既有报告错在哪、漏在哪」**，是你要接着往前推的起点。

## 第一轮交叉验证已确认的结论（**不要重新发现，直接采信并在此基础上推进**）

| 编号 | 结论 | 证据 |
|---|---|---|
| **K** | **`RunResult` 不跟调用绑定，会串台**。`create-agent.ts` 的 `collectRun()` 排干的是「共享池里所有未计过的 assistant 消息」并返回**最后一个**的文本 + 用量之和。子分身正在跑 `spawn_agent` 的任务时再给它投一条消息，**`spawn_agent` 返回给父的就是后一条的答案**。三方用量对账自洽所以查不出 | `audit/verify-result-misattribution.ts`、`audit/verify-h1.ts` |
| **K5** | `send()` 空闲时返回 `{delivered:"ran"}`，但**紧随其后的 `prompt()` 不排队、直接抛**。`send(A); await prompt(B)` 3/3 全抛 | 同上 |
| **E1** | 忙时 `prompt()` 抛 SDK 原始错，**且不产生任何事件**（`error` 也不发）—— 只订阅事件流的话这次失败完全不可见 | `audit/verify-observability-hypotheses.ts` |
| **H2** | `collectRun()` 的 `WeakSet` 按**对象身份**去重；把 assistant 消息换成 `{...m}` 克隆后，下一轮 `RunResult.usage=54`（应 18）、累计 `90`（应 54）→ **用量虚高**，且三方同步虚高 | 同上 |
| **F** | **扩展的「加载」不受 `tools` 白名单管辖**。种在共享 `cwd/.pi/extensions/` 或共享 `agentDir/extensions/` 的**未声明**扩展，`tools:["read"]` 的分身照样加载它，其钩子（`tool_call` / `tool_result` / `before_provider_request`）全部生效 | `audit/verify-extension-planting.ts` |
| **H1** | 不给 `tools` 时，环境里自动发现的扩展**工具**会进默认工具集（`["read","bash","edit","write","user_ext_probe"]`）。与 F 合并 = 默认配置下能力裁剪拦不住被种进来的扩展 | `audit/verify-config-gaps.ts` |
| **E9** | 工厂式 customTool **在创建期读 `ctx.agent` 必抛**，而**类型层不提示**（`strict` 下编译通过，证据：`TS2578 Unused '@ts-expect-error'`） | 同上 + tsc |
| **I1** | 扩展加载失败的**原因存在于 `loader.getExtensions().errors`**（结构化，含路径与 ParseError 原文），而 `src/` 只读 `.extensions`，**从不读 `errors`/`warnings`** → 修复成本约一行 | `audit/verify-loader-errors.ts` |
| **I2** | **白名单非空时 customTools 是强制并入的**（`create-agent.ts:139`），白名单**关不掉** customTool，只能靠 `excludeTools`。（规格决策 #4 原本的理由写反了，已更正） | 代码 + `06-failures` E2 |
| **J1** | **预算不是天花板**：检查只在 `prompt()` 开头与 `spawn_agent` 预检；忙时 `send()`（`followUp`）与直接 `steer()` **完全绕过**，实测击穿 2.0×；单轮超支上不封顶（实测 36×） | `audit/verify-budget-bypass.ts` |
| **J2** | 并发触发 `maxAgents` 时 `spawn_agent` **抛异常而非返回错误文本**（成功 2 / 错误文本 0 / 抛异常 6），契约破裂 | 同上 |
| **G** | `dispose` **不清** `session.messages`（既有报告 5.1g 说"变空数组"是错的，它用了从未 prompt 过的空样本；同一报告第 259 行自相矛盾） | `audit/verify-dispose-history.ts` |
| **G** | 中间层 `dispose` → 后代成孤儿：祖先对**真后代**投递被拒且报错**事实错误**（"不是你的后代"）；`descendantCount(top)=0` 而已回收的 mid 算出 2 | 同上 |
| **G** | `maxDepth` 绕过**有界 +1 层**（`depthOf` 的保守分支只对"直接父缺失"那层生效） | `05-lifecycle` E5 |

## 已证实的盲区（既有报告**没有**覆盖的，优先打）

1. **同一个 agent 被重叠投递**：报告里所有并发实验都是「多个*不同* agent 并发」（那个没问题）。**没有一条测过「同一个 agent 在跑的时候又被投递」** —— 而最大的 bug（K）就在这个盲区里。而形态 4/5/9（专家复用、反复投递）恰好全在这个风险面上。
2. **运行期静默失败**：`06-failures` 的子 agent 只跑完了构造期，运行期那几条（空闲 `steer` 丢弃、`followUp` 排队后永不被唤醒、`onToolCall` 拦截后模型看到什么、skill 配了没用上）**一条都没测**。
3. `02-topology` 那次因输出 token 超限**整个挂掉、零产出**；既有报告的 2.6（真模型按 id 寻址 3/3）/ 2.7（花名册选人 4/4）**样本极小，未被交叉验证**。
4. 既有报告自己列的未覆盖：**真实上下文超限**（该模型声明 100 万上下文）、**强制 GC 的泄漏复测**（需 `node --expose-gc`）、`thinking` 对**真实生成质量**的影响（题目太简单）、内容拒答的**确切触发率**。

## 方法纪律（补充）

- **不要只验证"一边"**。第一轮里我两次差点下错结论，都是因为只看了配对实验的一侧（H1 只看窗口内那次 prompt；`04-guards` 的预算旁路我先用错了构造方式）。**凡是配对/对照实验，两侧都要打印。**
- 构造场景时注意**前置条件**：例如"预算耗尽后进忙碌态"是不可能的（`prompt()` 会在预算检查处先抛），必须先想清楚状态可达性。
- 真模型只用 `opencode-go/deepseek-v4.1-flash`，并发 ≤4。
- 报告要写"实际发生了什么"，尤其**失败、跑不通、不确定**的照样写，并写清卡在哪。
