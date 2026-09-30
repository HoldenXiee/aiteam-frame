# 第 6 部分：失败与错误（独立实测，2026-09-30 23:2x）

> **本文件的边界（重要）**：按指令在收到「立即停止调研」时中止，**只收录我自己亲手跑出原始输出的结果**。
> 6.3 的「运行期静默失败」（空闲 steer、预算耗尽 + send、followUp 永不被唤醒、onToolCall 拦截后模型看到什么、skill 配了没用上）、6.4 传染性、6.5/6.6 真模型的失败形态与主持人反应 **本轮未做**，见文末「未完成」。
> 既有报告 `docs/research/2026-09-30-phase1-capability-audit-report.md` 与 `audit/06-failures.ts` 已覆盖 6.1–6.4 的一部分；本文件的用途是**交叉验证**，凡与既有结论不一致处已用 `⚠️ 分歧` 标出。
>
> 唯一脚本：`node audit/06-failures/e1-construct.ts`（假 provider，零成本）
> 原始数据：`audit/06-failures/data.json`（键 `e1`）；脚手架输出：`audit/findings/06-failures-e1.json`

---

## 结论速览

- E1：构造期 **22 组可疑输入里 13 组静默成功**（9 组抛错）：不抛错、不警告、照样把 agent 建出来，抛错的全是自由文本、无错误码。
- E1：构造期**完全离线** —— provider 端口没人听（`http://127.0.0.1:1`）构造照样成功，第一次 `prompt()` 才炸。
- E2：`tools` 里拼错工具名 → **静默丢弃**（模型只看到正确的那几个）。
- E2：`excludeTools` 拼错 → **静默无效**，与不写完全一样（既有报告只覆盖了写对的正例，没有覆盖拼错）。
- E2 `⚠️ 分歧`：**`customTools` 并不会因为「没列进 `tools` 白名单」而不生效** —— 只要白名单非空，库会把 `customTools` 的名字强制并进白名单。任务书里给的候选（决策 #4「customTools 提供了但没列进 tools → 静默不生效」）**被我实测推翻**。
- E3（新）：扩展加载失败**并非没有错误信息** —— `loader.getExtensions().errors` 里有完整原因（路径不存在 / ParseError），但 `buildLoader()` 只读 `.extensions`，**从不读 `errors`/`warnings`**。这是「扩展静默不加载」的可修复根因。
- E4（新）：花名册为空时 `spawn_agent` 的 `member` 参数 schema 退化成 `Type.Never`，**任何调用都在参数校验阶段失败**，模型看到 `member: must not be valid`；工具描述里那句「（花名册是空的）」永远到不了。
- E5（正面）：构造失败（模型解析失败）**不占 maxAgents 名额**，反复失败不会锁死宿主。
- E6（新，次要）：构造期报错**文本与真实原因不符** —— `model` 不存在时抛的是「解析有警告」，附带的原因才是 `Model "…" not found … Using custom model id`。

---

## 实测证据

### E1 构造期失败模式全表 + 原始错误串（6.1）

- **问题**：构造期有哪些输入会失败？失败通道是什么？没失败的，实际生效了吗？
- **方法**：`node audit/06-failures/e1-construct.ts`。假 provider（`audit/_faux.ts` 的 `makeEnv()`，模型 `faux/echo`）。22 组输入逐个 `createAgent()` 并捕获完整错误串；再对「静默成功」的条目用假服务记录的 `payload.tools` 做 ground truth 验证（`probe()`，每个 spec 起一个真 agent 跑一轮 `prompt("hi")`）。
- **原始输出**（构造期，逐条原文）：

```
c01 model 指向不存在的模型 → 抛错
    Error: 模型「faux/不存在」解析有警告：Model "不存在" not found for provider "faux". Using custom model id.
c02 model 指向不存在的 provider → 抛错
    Error: 模型「没这个provider/x」解析失败：Model "没这个provider/x" not found. Use --list-models to see available models.
c03 skills 名字不存在 → 抛错
    Error: 找不到技能「不存在技能」，当前可用：(无)
c04 Skill 对象 filePath 不存在 → 抛错
    Error: 技能「x」的 SKILL.md 不存在：C:\Users\Holder\AppData\Local\Temp\aiteam-audit-s7l1pP\no\SKILL.md
c05 extensions 路径不存在 → 成功
c06 extensions 文件语法错误 → 成功
c07 extensions 内联工厂自己抛错 → 成功
c08 cwd 目录不存在 → 成功
c09 agentDir 目录不存在（显式传 runtime） → 成功
c09b agentDir 目录不存在（不传 runtime） → 抛错
    Error: 模型「faux/echo」解析失败：Model "faux/echo" not found. Use --list-models to see available models.
c10 agentDir 指向一个普通文件 → 成功
c11 agentDir 里的 models.json 是坏 JSON（显式传了 runtime） → 成功
c12 agentDir 里的 models.json 是坏 JSON 且不传 runtime → 抛错
    Error: 模型「faux/echo」解析失败：Model "faux/echo" not found. Use --list-models to see available models.
c13 tools 里含不存在的工具名 → 成功
c14 excludeTools 拼错名字 → 成功
c15 customTools 提供了但没列进 tools → 成功
c16 model 的 thinking 档位非法 → 抛错
    Error: 模型「faux/echo:ultra」解析有警告：Model "echo:ultra" not found for provider "faux". Using custom model id.
c17 重复的 agent id → 抛错
    Error: 宿主里已经有 id=same 的分身，id 必须唯一
c18 provider 端口没人听：构造期会不会发现 → 成功
c19 手动传的 modelRuntime 与 spec.model 对不上 → 抛错
    Error: 模型「faux/echo」解析失败：Model "faux/echo" not found. Use --list-models to see available models.
c20 skills 里同一个名字写两遍（技能真实存在） → 成功
c21 不传 model（留给全局默认） → 成功
```

- **读出的现象**：抛错 9 组（c01 c02 c03 c04 c09b c12 c16 c17 c19），静默成功 13 组（c05 c06 c07 c08 c09 c10 c11 c13 c14 c15 c18 c20 c21）。抛错信息全是 `Error: <自由文本>`，没有 `code`/`type`/`stage` 字段，且文本会互相矛盾（c01 说「解析有警告」，真实原因是「Model not found」）。c18 证明构造期不与 provider 通信。
- **结论**：构造期只有 4 类输入会被拒（模型解析、技能解析、重复 id、传了错的 runtime）。其余一律静默。设计者无法在构造期发现「扩展写错路径」「白名单拼错」「agentDir 不可用」等配置错误。

### E2 静默通过的配置项：实际生效了吗（ground truth = 模型收到的 tools）

- **问题**：候选清单里的「白名单漏列 / 拼错 / customTools 不列进 tools」到底是不是静默失败？
- **方法**：同上脚本 `probe()`；`意图` = 设计者写进 spec 的内容，`实际` = 假服务 `payload.tools` 里模型真正看到的工具名。
- **原始输出**：

```
p01 不给 tools（默认工具集）          意图=默认不指定                     实际=["read","bash","edit","write"]
p02 tools 里拼错一个工具名            意图=["read","根本不存在的工具"]      实际=["read"]                      ← 不一致（静默丢弃）
p03 excludeTools 拼错                意图=["read","bash"] + exclude "reed" 实际=["read","bash"]              ← 与不排除完全相同
p04 excludeTools 拼对（对照）         意图=["read"]                       实际=["read"]
p05a customTools 提供 + 不给 tools     意图=["probe_echo",…默认]            实际=["read","bash","edit","write","probe_echo"]
p05b customTools 提供 + tools:["read"] 意图=["read"]                      实际=["read","probe_echo"]          ← customTools 仍被挂上
p06a extensions 指向有效扩展（正对照）  意图=["ext_probe_tool",…默认]        实际=["read","bash","edit","write","ext_probe_tool"]
p06b extensions 路径不存在            意图=[…默认,"ext_probe_tool"]        实际=["read","bash","edit","write"]  ← 扩展静默不加载
p07 tools 白名单点名有效扩展工具        意图=["ext_probe_tool"]             实际=["ext_probe_tool"]
p08 tools: []                        意图=[]                            实际=[]
p09 excludeTools 排掉 customTool（对）  意图=[]                            实际=[]
```

- **读出的现象**：
  1. p02：拼错的工具名被静默丢弃，没有警告。
  2. p03：`excludeTools` 里写错名字 = 什么都没排除，没有警告。
  3. p05b：**`customTools` 被强制并入非空白名单**（`create-agent.ts` 里 `[...new Set([...spec.tools, ...customTools.map(t=>t.name), ...])]`）。白名单**不能**关掉一个 `customTools`；只有 `excludeTools` 能（p09）。
  4. p06b：扩展路径不存在 → 扩展不加载、工具不出现、无任何信号。
  5. p08：`tools: []` 真能拿到零工具（既有修复有效）。
  6. p01：不写 `tools` 时默认工具集恰好是 `read,bash,edit,write`。
- **结论**：
  - 「`tools` 拼错 → 静默」：**能**，实测确认（与既有报告 C1.5 一致）。
  - 「`customTools` 没列进 `tools` → 静默不生效」：**不能** —— 实测推翻，它反而一定生效。**⚠️ 分歧**：任务书把这条列为「决策 #4 已知」的静默失败，实测行为是相反的（决策改的是 `tools: []` 的真值判断，没有改变「customTools 强制并入」这一点）。
  - 「`excludeTools` 拼错 → 静默无效」：**能**（既有报告未覆盖这条负面情形）。

### E3 扩展加载失败的根因：错误信息存在，但库只读了一半（6.3 构造期，新）

- **问题**：扩展加载失败到底是「pi 没给信息」还是「库没用信息」？
- **方法**：直接构造 `DefaultResourceLoader`（同一个包），对「有效扩展 / 语法错误扩展 / 路径不存在」三种输入各 reload 一次，打印 `loader.getExtensions()` 的全部键。脚本对比：`audit/06-failures/_probe-ext.ts`（探针）与 `e1-construct.ts` 的 6.1c 段。
- **原始输出**：

```
path= good.ts  keys= [ 'extensions', 'errors', 'warnings', 'runtime' ]
  extensions= [{"path":"…\\good.ts","tools":["good_tool"]}]   errors= []

path= bad.ts   keys= [ 'extensions', 'errors', 'warnings', 'runtime' ]
  extensions= []
  errors= [{"path":"…\\bad.ts",
    "error":"Failed to load extension: ParseError: D:\\: Missing semicolon.  \n C:/Users/Holder/AppData/Local/Temp/probe-ext-D5ImHS/bad.ts:1:35"}]

path= nope.ts  keys= [ 'extensions', 'errors', 'warnings', 'runtime' ]
  extensions= []
  errors= [{"path":"…\\nope.ts",
    "error":"Extension path does not exist: C:\\Users\\Holder\\AppData\\Local\\Temp\\probe-ext-D5ImHS\\nope.ts"}]
```

- **读出的现象**：`getExtensions()` 返回 `{ extensions, errors, warnings, runtime }`，两类失败都有**带路径的结构化错误对象**。而 `buildLoader()` 只调用 `declaredExtensionToolNames(spec, loader)`，那里只取 `.extensions`（`src/agent/loader.ts:47-52`），`errors` 与 `warnings` 在整个 `src/` 里一次都没被读过（grep 可复核）。
- **结论**：「扩展静默不加载」的责任在库这一层，且**修复成本是一行**（读 `errors` 并在非空时抛错/警告）。这给既有报告 C1.1/C1.2 补上了根因与可修复路径。

### E4 空花名册时的 `spawn_agent`（6.3/6.4 交叉，新）

- **问题**：`tools` 里点了 `spawn_agent` 但没有 host / 花名册为空时，设计者得到什么信号？
- **方法**：`mk({ tools: ["spawn_agent"] })`（无 host）与 `createAgentHost({ members 未给 })` 两种，各让假模型发起一次 `[[tool:spawn_agent]] [[args:{"member":"x","task":"y"}]]`。
- **原始输出**：

```
无 host：error=null  text="echo:Validation failed for tool \"spawn_agent\":
                       - member: must not be valid
                     Received arguments:
                     { "member": "x", "task": "y" }"
有 host 但 members 空：error=null  text="echo:Validation failed for tool \"spawn_agent\":
                       - member: must not be valid
                     Received arguments:
                     { "member": "x", "task": "y" }"
```

- **读出的现象**：`createSpawnAgentTool` 在花名册为空时把 `member` 建成 `Type.Never()`，所以调用在**参数校验**阶段就被拒；`execute()` 里那句 `（花名册是空的）` 与 `spawn_agent 需要一个宿主：…` 都执行不到。整轮 `RunResult.error = null`，只有工具结果文本里有校验错误。
- **结论**：设计者看到的是 schema 级错误 `member: must not be valid`，不是「你没配 members」。既有报告未覆盖空花名册路径。

### E5 构造失败不留登记残留（正面，新）

- **方法**：`maxAgents: 4` 的 host，连续 3 次用不存在的模型构造成员，观察每次结果与 `host.activeCount`。
- **原始输出**：

```
0: 抛错「模型「faux/不存在」解析有警告：Model "不存在" 」
1: 抛错「模型「faux/不存在」解析有警告：Model "不存在" 」
2: 抛错「模型「faux/不存在」解析有警告：Model "不存在" 」
失败后 host.activeCount=0，host 仍可用=true
```

- **结论**：构造失败不占 `maxAgents` 名额。与 4.3 的「不回收会被吃满」是两件不同的事，前者是干净的。

---

## 静默失败清单（本文件独立实测的部分）

**判据**：设计者的意图与运行结果不一致，而库不发任何信号。

| # | 静默行为 | 触发方式 | 观察到的现象 | 信号 | 证据 |
|---|---|---|---|---|---|
| S1 | `extensions` 路径写错 → 扩展不加载 | `extensions: ["<不存在的路径>.ts"]` | 构造成功；模型收到 `["read","bash","edit","write"]`，扩展工具一个都没有 | **无**（`loader.errors` 里有完整原因，库没读） | E1 c05 / E2 p06b / E3 |
| S2 | `extensions` 文件语法错误 → 静默跳过 | 写入 `export default function (pi) { this is not valid (((` | 构造成功，无 warning | **无** | E1 c06 / E3 |
| S3 | `extensions` 内联工厂自己抛错 → 静默 | `extensions: [() => { throw new Error("…EXT") }]` | 构造成功，无 warning | **无** | E1 c07 |
| S4 | `tools` 里拼错工具名 → 静默丢弃 | `tools: ["read","根本不存在的工具"]` | 模型只看到 `["read"]`，无警告 | **无** | E2 p02 |
| S5 | `excludeTools` 拼错名字 → 静默无效 | `excludeTools: ["reed"]`（想排除 read） | 工具集与不写排除完全相同 `["read","bash"]` | **无** | E2 p03/p04 |
| S6 | `cwd` 目录不存在 → 构造成功 | `cwd: "<不存在的目录>"` | 构造成功、无 warning（首次 `prompt` 行为本轮未测） | **无** | E1 c08 |
| S7 | `agentDir` 不存在 / 指向普通文件 / `models.json` 是坏 JSON → 构造成功 | 见触发方式 | 只要显式传了 `modelRuntime`，三种都构造成功且无 warning | **无** | E1 c09 c10 c11 |
| S8 | `skills` 里同一名字写两遍 → 静默 | `skills: ["dup","dup"]`（`agentDir/skills/dup` 真实存在） | 构造成功，无 warning | **无** | E1 c20 |
| S9 | 花名册为空时 `spawn_agent` 的所有调用都成为参数校验错误 | `tools: ["spawn_agent"]` + 无 host / 空 members | `RunResult.error=null`；模型拿到 `Validation failed … member: must not be valid`；设计者拿不到「花名册是空的」 | **无**（错误只存在于工具结果文本） | E4 |
| S10 | 不写 `model` → 静默用全局默认（可能是真实 provider） | `createAgent({})` | 构造成功、无 warning | **无**（同一现象既有报告 C2.3 从 spawn 角度记过，此处是构造者直接省略 model） | E1 c21 |

### 与任务书候选清单的逐条对照（只列我实测过的）

| 任务书候选 | 我的实测 | 是否静默失败 |
|---|---|---|
| `tools` 白名单漏列/拼错某工具名 | 模型只收到存在的那几个（p02） | **是** |
| `excludeTools` 名字打错 | 与不写完全一样（p03） | **是** |
| `customTools` 提供了但没列进 `tools` | 实测**仍然生效**（p05b 实际 = `["read","probe_echo"]`） | **否，候选被推翻** ⚠️ |
| 空闲时 `steer()` 静默丢弃 | **本轮未测**（需运行期时序实验） | 未验证 |
| `send()` 忙时 `followUp` 排队但永不被唤醒 | **本轮未测** | 未验证 |
| `budgetTokens` 耗尽时 `send()` 怎么办 | **本轮未测** | 未验证 |
| `skill` 配了但模型没用上 | **本轮未测**（仅测到技能名字解析失败会抛错，c03/c04） | 未验证 |
| `onToolCall` 返回 `{block:true}` 后模型看到什么 | **本轮未测** | 未验证 |

---

## 与既有报告的交叉验证（只就我实测过的条目）

| 既有报告条目 | 我的独立结果 | 判定 |
|---|---|---|
| C1.1 `extensions` 路径不存在 → 构造成功、静默未加载 | 同（E1 c05、E2 p06b） | ✅ 一致 |
| C1.2 `extensions` 文件语法错误 → 构造成功、静默跳过 | 同（E1 c06） | ✅ 一致 |
| C1.3 `cwd` 目录不存在 → 构造成功 | 同（E1 c08）；补：只验证了构造期 | ✅ 一致 |
| C1.4 `agentDir` 目录不存在 → 构造成功 | 同（E1 c09）；补：仅在显式传 `modelRuntime` 时成立，不传 runtime 会抛（c09b） | ✅ 一致（有前提条件） |
| C1.5 `tools` 里写不存在的工具名 → 静默丢弃 | 同（E2 p02） | ✅ 一致 |
| 「`customTools` 没列进 `tools` → 静默不生效（决策 #4）」 | **相反**：白名单非空时强制并入（E2 p05b） | ⚠️ **分歧** |
| （既有报告未记）`excludeTools` 拼错 | 静默无效（E2 p03） | 🆕 新 |
| （既有报告未记）扩展加载失败的结构化 `errors` 被库丢弃 | 根因（E3） | 🆕 新 |
| （既有报告未记）空花名册 → `Type.Never` → `must not be valid` | E4 | 🆕 新 |
| （既有报告未记）构造期报错文本与真实原因不符（「有警告」vs「not found」） | E1 c01/c16 | 🆕 新 |

---

## 未完成 / 未验证（因中止指令）

- **6.1 运行期部分**：`cwd` 不存在时首次 `prompt()` 的行为、`agentDir` 指向普通文件时的运行期行为。
- **6.2 可区分性**：只拿到构造期的 9 条原始错误串。**运行期**的原始 `RunResult.error` 串（模型 HTTP 400 / 工具 execute 抛错 / 调用未挂载工具 / 工具参数不合法 / 上下文超限）本轮**一条都没跑**，无法给出「失败模式 × 可区分性」完整表。
- **6.3 运行期静默失败**：任务书重点指名的 `steer()` 空闲丢弃、`send()` 预算耗尽谎报 `ran`、`followUp` 永不被唤醒、`onToolCall` 拦截后模型看到什么、skill 配了没用上 —— **全部未测**。本文件只覆盖了构造期 10 条。
- **6.4 传染性**：未测（同桌既有 `06-failures.ts` 与 r3 R14a 有覆盖，但我没有独立复现）。
- **6.5 真模型失败形态**：未做，**花费 $0**。
- **6.6 真模型主持人反应 ×3**：未做，**花费 $0**。

## 数据

- `audit/06-failures/data.json` → `e1.{rows, probeRows}`（含 22 组构造结果的完整错误串与 11 组 probe 的意图/实际工具名）。
- `audit/findings/06-failures-e1.json` → 6 条 finding（6.1a / 6.1b / 6.1c / 6.1d1 / 6.1d2 / 6.1e）。
- 脚本：`audit/06-failures/e1-construct.ts`（正式）、`audit/06-failures/_probe-ext.ts`（扩展错误字段探针）、`audit/06-failures/_d.ts`（data.json 累加器）。
- 真模型花费：**$0.0000**（本文件全部为假 provider）。
