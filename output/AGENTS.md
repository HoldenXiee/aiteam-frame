# AGENTS.md —— 给你（AI 助手）的操作手册

> **这份文件是写给 AI 读的。** 如果你是人类，先读 `README.md`，再把这个文件夹整个交给你的 AI 助手。
>
> 你的角色：**单 agent 助手**。用户给你一句意图，你要用这套库（`src/`）把意图变成一个**能跑的 agent 集群**，并且能说出「它到底成了没有」。
> 你不是替用户想研究什么，你是**把用户的目标翻译成结构**。

---

## 〇、六十秒上手

```bash
# 只需要 Node ≥ 24。依赖已经在 node_modules 里，不用 npm install。
node demo/smoke.ts        # ← 先用这个确认环境活着（花 ~$0.0001）
```

```ts
import { createLab } from "./src/index.ts";

const lab = await createLab({
  agentDir: "./demo/agent",   // 环境：凭证/模型/技能/扩展都从这里找。必填
  cwd:      "./demo/work",    // 工作目录：起的 agent 共用。必填
});

const agent = await lab.createAgent({
  id: "写者",
  model: "opencode-go/deepseek-v4.1-flash",
  permissions: { only: ["read", "write", "bash"] },
});

const r = await agent.io.prompt("把这批材料整理成一张表");
console.log(r.text, r.usage.cost.total);   // ★ 成本每次都要看
if (r.error) throw new Error(r.error);     // ★ 接受之后失败不 reject，只在 error 里
await agent.dispose();
```

**三条立刻要记住的事**：

1. `agentDir` 和 `cwd` **必填，没有默认值**，也不回落到 `~/.pi/agent`。这是刻意的——这次运行用什么环境，必须写在纸上。
2. 顶层 `await` 可用（ESM），但**必须 `"type": "module"`**。在 `.ts` 文件里直接写，Node 24 原生剥类型，无构建步骤。
3. 路径**相对你自己的文件**解析（`import.meta.url`），不要用 `process.cwd()`。这样别人把这个文件夹复制到任何地方都能跑。

---

## 一、先读这个：你最容易犯的错

★★★ **机制「写了」不等于「接上了」。** 这是本项目用真金白银换来的第一条教训——
七个机制第一次上线时**全部空转**：规则写了、代码在、日志无错、跑出来是 0 次。

```
规则写了 ≠ 规则被调用 ≠ 消息送达 ≠ 目标在运行 ≠ 对方会响应 ≠ 判据匹配得上
```

所以在你的集群里，任何一个新机制上线后的第一件事**不是**审设计，是核对四件事：

| 问 | 怎么核 | 不合格的样子 |
|---|---|---|
| 日志里**出现过它的名字**吗 | `grep 规则名 run.log` | 一次都没出现 |
| 落盘文件**有内容**吗 | `ls -l` | 0 字节 |
| **失败会不会响** | 故意制造一次失败 | 静默返回 `undefined` |
| **判据会不会永远匹配不上** | 想想真实数据长什么样 | 只认一种投票，而实际没人这么投 |

★ 并且：**量具必须与机制同批上线**。否则你无法区分「没发生」和「发生了但我没看见」。

---

## 二、库的形状：一个工厂 + 七个面

对外只有**一个入口函数** `createLab`。没有框架、没有基类、没有装饰器。

```
createLab({agentDir, cwd, ...})  →  Lab
                                    └─ createAgent(spec) → Agent
                                                          ├─ io           投递与结算
                                                          ├─ context      上下文
                                                          ├─ tools        有哪些工具
                                                          ├─ permissions  允许哪些
                                                          ├─ extensions   插件
                                                          ├─ skills       技能
                                                          ├─ model        模型与档位
                                                          └─ observe      观测
```

**环境（`agentDir` + `cwd`）在 Lab 上声明一次，之后所有 agent 共用。**

### 2.1 `Lab` —— 四个成员

```ts
lab.agentDir                    // 环境目录
lab.cwd                         // 工作目录
lab.createAgent(spec?)          // 唯一的创建入口
await lab.inspectEnv()          // 自检：实际生效了哪些模型/技能/扩展/上下文文件
```

★ **`inspectEnv()` 先跑永远是对的**。它零成本、不建 agent，能当场告诉你「凭证没配 / 模型 id 拼错 / 技能没被加载」。每个新会话、每次换环境，先跑它。

### 2.2 创建期 `AgentSpec` —— 只说「这个 agent 用哪些」

```ts
{
  id?: string
  model?: string                    // "provider/model:thinking"，如 "opencode-go/deepseek-v4.1-flash:low"
  thinking?: "off"|"low"|"medium"|"high"
  skills?: (string | Skill)[]       // ★ 精确白名单：写了就只有这些；不写 = 环境里的全给；[] = 一个都没有
  extensions?: (string | InlineExtension)[]
  role?: string                     // 这个 agent 的角色定义
  permissions?: { only?: string[]; deny?: string[]; gate?: ToolGate }
  tools?: { custom?: AgentTool[] }
  context?: { autoCompact?: boolean }
}
```

★★ **`permissions.only` 是硬白名单，装了扩展 ≠ 它手上有那个工具。**
实测事故：扩展装在环境目录里、`pi list` 认、拿**没设 `only`** 的探针验过「能搜」——就判定了「接上了」。
而真实 agent 的 spec 写着 `only: [...7 个名字，没有 web]` ⇒ **它手上 0 个 web 工具**。

> **验能力必须用与生产完全相同的 spec**（含 `only`、`tools.custom`），否则你验的是另一个 agent。

★ `only` 的「精确」有一个边界：**你在同一个 spec 里显式声明的工具会自动并入**（`tools.custom` 的名字、`extensions` 里显式声明的扩展注册的工具）。**环境自动发现的扩展不并入**——否则你写死的白名单会被环境里碰巧存在的东西悄悄撑开。

### 2.3 运行期七个面

| 面 | 关键方法 | 记住这一条 |
|---|---|---|
| **io** | `prompt` / `queue` / `steer` / `interrupt` / `abort` / `waitIdle`；读数 `pending` / `isRunning` | `prompt` 忙时**会拒**；`interrupt` 忙时**不拒**（它先 abort 再投）。`steer` 不 abort，只在本轮工具跑完、下次 LLM 调用前改向 |
| **context** | `history` / `entries` / `replace` / `erase` / `reset` / `override` / `compact` / `usage` / `autoCompact` | `override` 只改**这一轮发给模型的内容**，历史一条不动——这是最便宜、最可预测的裁剪。`compact` 要求 idle |
| **tools** | `list` / `add` / `remove` / `onResult` | `add` 要碰工具声明面 ⇒ 要求 idle |
| **permissions** | `only` / `allow` / `deny` / `gate` | 创建期叫 `only`（精确），运行期才有并集语义的 `allow`。**同名不同义是陷阱** |
| **extensions** | `list` / `add` / `remove` / `errors` | ★ 永远看 `errors`：扩展加载失败会静默 |
| **skills** | `list` / `add` / `remove` | 技能是**软约束**（靠模型读了照做），不是代码强制 |
| **model** | `current` / `thinking` / `available` / `set` / `setThinking` | 按需分配成本：简单活降到 `low` |
| **observe** | `wire`（每轮真正发出去的 messages，含 system）/ `turns` / `injections` | ★★★ 区分「它没听劝」与「它根本没收到」的唯一手段 |

★ 除 `permissions` 外每个面都有 `.raw`，指向对应的 pi 对象：全权、无护栏。逃生口，不是常规路径。

### 2.4 `RunResult` —— 一次运行的结算

```ts
{
  runId: string
  text: string
  usage: Usage          // 本次运行：input/output/cacheRead/cacheWrite/totalTokens/cost.total
  error?: string        // ★ 接受之后失败不 reject，只写这里
  messages: AgentMessage[]
  mock?: true           // ★ 来自本机假服务 ⇒ 读数不能当真实结论
}
```

★★ **`if (r.error)` 必须写。** pi 对「接受后失败」不 reject。
★ **报结果必报成本**：`r.usage.cost.total`。只报 token 不报钱不算交付。

---

## 三、怎么把「一句话」变成集群：五步

> 这一节照抄书的《实操 · 设计一个集群：从一句话到可验收的五步与价目》。
> 顺序是**先判据、后分工、最后买**——不是先派人再看结果。**顺序错了，钱花了但你分不清是哪一步在起作用。**

### 第 0 步：抽谓词，量 arity（0 token，先做）

把人话写成**能返回真假**的东西，然后问：**一条真值跨几个元素？**

| 意图 | 谓词 | arity |
|---|---|---|
| 这两个文件是不是在说同一件事 | 一对文件 → 真/假 | **2** |
| 这份报告有没有洞见 | —— | **不可判 ⇒ 停，换制度** |
| 200 条工单里哪些是重复报修 | 一对工单 → 真/假 | **2** |

★ **判死点**：如果你说不出「一条答案长什么样」，后面四步全部无单位，**不要往下走**。
★★ 实测：arity-2 的任务**不能按数据切半**——12 对真值全部跨半，切半后两个写者各自连一对都看不见（`matched` 0、fp 10–19）。

### 第 1 步：定断言单位（形状）——买「找得到」，不买「不多报」

让每条断言成为一个**判据读得到的容器**：

- **arity-2** ⇒ 一个二元条目（**恰好两个 id**）+ 两侧逐字引文
- **arity-1** ⇒ 一个条目 = **一个 id + 那个值 + 逐字引文**

★★ **关键字：说「把主表放进 `findings`」，不要说「别把清单放进来」。**
「指定容器」比「排除」便宜且满额：

| 做法 | 落地 | 面值/轮 |
|---|---|---|
| **指定**「主表放进 `findings`」 | **4/4** | **35k** |
| 只删清单 | 3/4 | 39k |
| **等长安慰剂**（写得更清楚，但仍是对象数组） | **0/8** | **138k**（贵 3×） |
| 不管容器（让模型自己组织） | 0/4 | 50k |

⇒ ①赢的**不是**「说得多」；②**指定容器最便宜**；③删也能救，但会丢掉有用的候选。

### 第 2 步：给数（每格一个数）

**症状 → 杠杆**（这一张表是全书唯一的「按症状查表」，别凭感觉选）：

| 你看到 | 空的是哪个槽 | 该动的杠杆 |
|---|---|---|
| 判据什么也没读到（解出 0 条、读到的全是散文） | 观测面 | **形状** |
| 条数自由（13–43 条，「差不多」就停） | 数的执行者 | **每格一个数** |
| **真漏**（`matched` 低，且 `proposed ≤ 真值`） | 停止规则 | **形状** 或 **数** |
| **超报**（`proposed > 真值`，fp 大） | 上界 | **数**（不要用形状代替） |
| N 本身是错的 | 真值 | 让它自己数 N，或把验收改成不需要 N |

★★★ **杠杆不可互换。** 用错杠杆，落地不会变好，钱会变多。

★★ **区分「真漏」与「超报」看 `proposed` 与 `fp`**：
`proposed ≤ 真值` 是真没找齐（fp 大是因为分母小）；`proposed > 真值` 且 fp 小是多报。
**修法相反**——一个要停止规则，一个要上界。

### 第 3 步：定验收（合取，不是加法）

```
落地 = (matched 满) AND (fp = 0)
```

★★ 实测同批 32 轮（单写者四臂）：

| 臂 | matched（中位） | fp | **落地** | tok/轮 |
|---|---|---|---|---|
| 无形状无数 | 8 | 18–92 | **0/8** | 247k |
| **只有形状** | **12** | 1–8 | **0/8** | **62.6k** |
| **只有数** | 12 | 0–24 | **3/8** | 84.3k |
| 形状 + 数 | 12 | **0** | **6/8** | 71.5k |

★ 读法：形状**同时**把召回抬满**并**把面值砍掉 75%，但**不修 fp** ⇒ 单独用落地 0/8。
⇒ 「召回」与「精度」是两个合取项，**同一个杠杆可以修一个、修不了另一个**。

★ **不要四件一起上**。那会让你付四份钱，而且**分不清是哪一件起了作用**。

### 第 4 步：定停手点

★ 从「数」和「钱」两条里至少选一条写死，并且**在开跑前**写死：

| 停手条件 | 写法 |
|---|---|
| 数 | `一共 12 对`（不是「最多 12 对」——见下） |
| 钱 | `cost.total 累计 > $2 就停` |
| 轮 | `--secs` 窗口到点进收尾态 |

★★ **「最多 12 对」不被执行，「一共 12 对」被执行。** 这是书里一条实测：
约束的**编码方式**决定它是否被执行——上限是「别超过」，总数是「凑够」。

### 第 5 步：跑，然后**读读数**，不是读感觉

跑完必须回答四个问题（缺一个就是没做完）：**读数 / 对照组 / 成本 / ★ 边界**。

★ 「都成立」是最大的谎。**每条结论必须带条件**——书里每一条都是在**特定条件下**成立的观察，**条件是它的一部分**，别把条件抠掉只用结论。

---

## 四、集群的骨架：你会反复用到的四个形状

### 4.1 多写者分工（最容易上手）

```ts
const writers = await Promise.all(
  ["A", "B", "C"].map((name) =>
    lab.createAgent({ id: `写者-${name}`, model: MODEL, permissions: { only: ["read", "write"] } })
  )
);
const outs = await Promise.all(writers.map((w) => w.io.prompt(task)));
```

### 4.2 派活器（**并发上限 1**，别用 `await` 卡住 tick）

★★★ **这是本项目踩了两次的坑，不要再走。**

```ts
// ✘ 错：await 专家几分钟，整个循环停在那里
for (const rule of rules) await fire(rule);

// ✘ 也错：tick 不卡了，但一个 tick 里能同时 fire 好几个 ⇒ 成本不可控
for (const rule of rules) void fire(rule);

// ✔ 对：排队 + 峰值并发 1 + 同专家去重 + onDone 回传
class Dispatcher {
  private q: (() => Promise<void>)[] = [];
  private busy = false;
  async fire(name: string, job: () => Promise<string>) {   // 几微秒返回
    this.q.push(async () => { /* 跑 job */ });
    if (!this.busy) void this.drain();
  }
  private async drain() {
    this.busy = true;
    while (this.q.length) await this.q.shift()!();
    this.busy = false;
  }
  async waitIdle() { while (this.busy || this.q.length) await new Promise(r => setTimeout(r, 200)); }
}
```

实测代价：`await fire(...)` 让 180s 只跑 **1** 次 tick（该 ~6）、600s 只跑 **3** 次（该 ~20）⇒ 后面的规则**全部饿死**（有一条规则从上线起 0 次触发）。

★★ **收尾时必须等队列跑空**，否则 `dispose()` 会截断正跑着的专家。

### 4.3 让模型写代码编排（沙箱）

```ts
import { createSandbox } from "./src/index.ts";

const sandbox = createSandbox({
  lab, agent,
  capabilities: ["spawn", "prompt", "list_agents", "dispose"],  // ★ 白名单
});
await agent.tools.add(sandbox.tool);
```

模型可以在脚本里 `Promise.all` 起 5 个 agent、过滤结果、只把结论带回来——
**编排逻辑从「模型一轮一轮选」变成「一段代码」**。

★ 三个边界：①没声明的能力**连存在都看不见**（看得见但调不动会让它反复试错）；
②**限一层**：沙箱里 spawn 出来的子 agent 不再有沙箱；③**只回一条结果**：跑 50 次调用，回到模型面前的只有 `return` 的那点东西。

### 4.4 门（拦得住的那一半）

★★ **规则必须落在结构上，不能落在提示词里。** 写在文档里的规则 = 没有规则。

```ts
const agent = await lab.createAgent({
  permissions: {
    only: ["read", "write"],
    gate: async ({ toolName, args }) => {
      if (toolName === "write" && !String(args.path).startsWith("out/")) {
        return { block: true, reason: "只能写 out/ 下" };   // ← 结构上过不去
      }
    },
  },
});
```

★ **拦的同时必须给「路」**：只说「不许」，它会反复试同一个入口。
★★ **一件能力有多个入口时，全堵才有效**（`write` 拦住了，它换 `bash` 写文件）。

### 4.5 长座位：让集群自己长出常驻角色

集群可以在**框架里**长出新的常驻座位——只读、不能再长、本轮有效。
★ 判据：规则表（几条、判据、触发次序）属于**框架**；角色叫什么、怎么组织属于**内容**。前者写死在你的代码里，后者让它自己长。

---

## 五、二十条可迁移的纪律

> 全部来自真实事故。**每一条都花过钱**。标 ★ 的尤其常犯。

| # | 纪律 |
|---|---|
| 1 | ★★★ **「接上了」的唯一证据是日志/落盘里真的出现了它** |
| 2 | ★★★ 量具本身也会「没接上」——**证明「它在该失败时会失败」**：故意制造一个错误，看量具报不报 |
| 3 | ★★ 缺数据 ≠ 0。加新字段后历史数据是「未知」，**单列**，别当 `false` |
| 4 | ★★ 报比例前先问：分子/分母里混进了不属于这个问题的东西吗 |
| 5 | ★★ 分母要跟着机制的出生时间变：`机制上线后已覆盖 X/Y`，不是 `X/全部历史` |
| 6 | ★★ 量具响了 ≠ 响的是那件事。问「那时候是什么样」，只能读**那时候的记录** |
| 7 | ★★ 先查「产出被什么驱动」再改机制。实测：42% 的产物明写「回答上级」⇒ 产出是**投递**驱动，不是规则驱动 |
| 8 | ★★★ 开环系统里**限产无效，要清欠账**。实测：规则停了，问题照样积压（每审一条开 2–3 条、关 0–1 条 ⇒ 存量本身就是工作来源） |
| 9 | ★ 任何「回头看」类规则都要写**「它最多能占多少产出」**。实测：审查类规则吃掉 57/60 产出，把探索者变成了审计员 |
| 10 | ★★ 先查「我给它起了几个角度」再诊断它的行为。实测：`--employees=2` 把唯一建设性的角度切掉了，我却把它诊断成「集群变成了审计员」 |
| 11 | ★★ 「允许它做 X」它不做。给了工具 ≠ 它会用（20 张签字里 0 张用新选项 ⇒ 我改了工具描述） |
| 12 | ★★★ 加了新选项，**必须同时改描述**，否则它永远不知道有第四个选项 |
| 13 | ★★ `tsc --noEmit` 通过 ≠ 跑得起来。必须再跑一次真实执行 |
| 14 | ★★★ 量具的 `include` 可能从来没检查过你的集群代码——**先证明量具活着** |
| 15 | ★ 别承诺「我会盯着」。要么有机制，要么说实话 |
| 16 | ★ 同一现象第 3 次出现就停下梳理 |
| 17 | ★ 区分「它不听劝」和「它做不到」。后者改工具/给路 |
| 18 | ★ 改语料/判据/机制后，**旧数据不与新数据混用** |
| 19 | ★ 对照实验里「它的行为变了」先排除「我给的东西变了」 |
| 20 | ★★ 不要替集群拍板**内容**。你决定的是「什么情况 → 做什么」，不是「研究结论是什么」 |

★ 一份更长的、按编号引用的纪律表在书的第三部分与第四部分。**遇到没见过的失败，先去书里按症状查表**，别自己发明。

---

## 六、书的用法

`book/` 是本方向的最终产物。**40 个 md 文件，1.4 MB**。

| 你要 | 去哪 |
|---|---|
| 一次读完 / 一次喂给模型 | **`book/全书.md`**（单文件合订本，按 SUMMARY 顺序拼好） |
| 查某一章 | `book/src/05-集群产出/` |
| 按症状查动作 | `src/05-集群产出/实操-从一句话到判据-四个杠杆与四个症状.md` |
| 按步骤走 | `src/05-集群产出/实操-设计一个集群-从一句话到可验收的五步与价目.md` |
| 查术语 | `src/附录/术语表.md` |
| 入口 | `src/SUMMARY.md` |

★★★ **别把书当规范。** 它每一条都是**在特定条件下**成立的观察。**条件是它的一部分**——
别把条件抠掉只用结论。看到一处结论没有条件，那是它的缺陷，不是你的许可证。

★ 书里有「带保留」的章节：它们写了**解除条件**（「在 §X 补一句可判死的话」）。读到就照着去核。

---

## 七、成本与模型

| 项 | 值 |
|---|---|
| 唯一可用模型 | ★ **`opencode-go/deepseek-v4.1-flash`** |
| 凭证 | `demo/agent/auth.json`（已带） |
| 实测单价 | 约 **$0.0002 / 轮**（input ~1900 tok） |
| 示例（离线假 provider） | **$0** |

★ **其他模型一律禁止**（没有凭证）。例外：`faux/*` 是本机假 provider，离线零成本，**用于测装置、不用于测模型行为**。

```ts
// 便宜档：简单活降到 low
await agent.model.setThinking("low");

// 记账：每次运行都看
console.log(r.usage.cost.total);
```

★★ **报成本时不要编精确数**。从基线推：一轮 60 分钟单员工的量级是 **≈$1.4**；6 席位 + 4 观众约 **2–3×**。
拿不准就写「量级：数美元」。

---

## 八、环境（`agentDir` 里有什么）

环境即目录、目录即配置。改环境 = 改目录，不用改代码。

```
demo/agent/
├── auth.json          ★ 唯一凭证（读-改-写整个文件）
├── models.json        额外的 provider 声明（本机假 provider 用）
├── skills/<名>/SKILL.md     技能（软约束；技能名取自 frontmatter 的 name）
└── extensions/<名>.ts       扩展，export default (pi) => pi.registerTool(...)
```

★★ **别把 `agentDir` 指向宿主 `~/.pi/agent`** —— pi 的 auth 存储是**读-改-写整个文件**，
指向那里会把宿主别的 provider 的 key 抹掉（历史事故）。

★ **实验室边界** = `{agentDir}` ∪ `{cwd 及其子树}`。cwd 祖先链的 `AGENTS.md`、宿主 `~/.agents/skills`、
祖先项目的 `.agents/skills` **都挡住**。这是刻意的：实验环境必须可复现，不能被外面的东西悄悄影响。

---

## 九、交付检查表

一件活交出去，必须**同时**有这四样，缺一样就是没做完：

| # | 要素 | 反例 |
|---|---|---|
| 1 | **读数** | 「机制应该能工作了」 |
| 2 | **对照组** | 「跑了一次，效果不错」 |
| 3 | **成本** | 只报 token 不报钱 |
| 4 | ★ **边界** | 「都成立」——无条件是最大的谎 |

★ 加一条**自查**：你说的每个「做了」，能不能给出一个**可核的路径**（文件 + 行 / 日志片段 / 命令）？
不能 ⇒ 说「我核不了」，**不要说「做了」**。反过来，别人说「做了」但只给了文件名，也判「我核不了」——
**别判「假结账」**（那是冤枉）。

---

## 十、文件地图

```
output/
├── AGENTS.md          ★ 本文件：给你的操作手册
├── README.md          给人的快速开始
├── package.json       type: module（必需）
├── src/               底层库源码（18 个 .ts，约 4000 行）—— 唯一导出入口 src/index.ts
├── node_modules/      依赖（114 个包，离线自带，不用 npm install）
├── demo/
│   ├── smoke.ts       ★ 先用它验环境
│   ├── agent/         环境：凭证 + 技能 + 扩展
│   └── work/          工作目录（产物落这里）
├── examples/          13 个可跑的示例（离线假 provider，$0）
└── book/
    ├── 全书.md        ★ 单文件合订本
    ├── src/           40 个 md 原文（按 SUMMARY.md 组织）
    └── book.toml      mdbook 配置（想渲染成网站在这里 build）
```

**建议的读代码顺序**：`src/index.ts`（30 行，看清全部导出）→ `src/agent/types.ts`（七个面的签名）→ `examples/01-first-agent.ts` → `examples/12-team.ts`。
