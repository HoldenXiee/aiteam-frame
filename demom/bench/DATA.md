# 数据集说明

> 这个文件解释 `demom/runs/` 里的原始记录怎么读。**改字段名必须同步改这里。**

研究纪律：**先收数据、后分析**。所以原始记录存的是**事实**（每个 agent 的用量、工具流水、产物全文、逐项判据），
不是算好的分数。判据改了可以拿旧数据重判，不用再花钱重跑。

---

## 1. 文件

| 文件 | 是什么 | 进 git |
|---|---|---|
| `collect-<时间>.log` | 一次数据收集的完整日志（prep → A → B → 对照表） | ❌ |
| `A-<tag>-<时间>.jsonl` | 实验室 A 的原始记录，**一次运行一行** | ❌ |
| `B-<tag>-<时间>.jsonl` | 实验室 B 的原始记录 | ❌ |
| `A-<tag>-<时间>-drafts.txt` | A 的中间产物（委派图 + 各角色写了什么） | ❌ |
| `B-<tag>-<时间>-drafts.txt` | B 的中间产物（各阶段写了什么） | ❌ |

`runs/` 全部 gitignored —— 它是可再生的（`bench/prep.ts` 铺语料、`run.ts` 生成记录）。要留档就把文件拷出去。

---

## 2. 一行 JSONL 的字段

类型定义在 [`measure.ts`](measure.ts) 的 `RunRecord`。对照表只用了其中一部分，**其余是为后面分析留的**。

### 2.1 身份与计时

| 字段 | 含义 |
|---|---|
| `lab` | `"A-cluster"` 或 `"B-workflow"` |
| `tag` | 这批数据的名字（`--tag`） |
| `startedAt` | ISO 时间戳（**UTC**） |
| `secs` | 这次运行的墙钟秒数 |
| `crashed` | 崩了的话是错误原文；正常是 `undefined`。**注意与轮失败区分**：轮失败在 `agents[].error` |

### 2.2 每个 agent（`agents[]`）—— 形状分析的原料

| 字段 | 含义 |
|---|---|
| `id` / `role` | 身份。A 的 role 是花名册角色（`scout`…），B 的是阶段名（`S1-摸底`…） |
| `parent` | 谁派的它。**A 用**；B 恒为 `null`（B 没有委派，只有边） |
| `depth` | 在委派图里的深度（根 = 1）。**A 的形状核心指标** |
| `toolCalls` / `distinctTools` / `calls` | 工具调用次数 / 用过哪些 / **完整顺序流水**（`calls` 是形状分析最细的一层） |
| `usage` | 这个 agent 的**全生命周期累计**用量（不是单轮） |
| `error` | 这个 agent 有没有轮失败 |

### 2.3 汇总（口径统一：所有 agent 累加）

`agentCount` / `toolCalls` / `inTokens` / `outTokens` / `totalTokens` / `costUsd`

> ⚠️ 口径一致性是这个对比成立的前提：子 agent 的用量也累加进总数。
> A 起 6 个、只算父的，对比就废了 —— `Meter` 强制每个 `createAgent` 都 `watch`。

### 2.4 形状（本次对比真正的因变量）

| 字段 | 含义 |
|---|---|
| `maxDepth` | 最大委派深度 |
| `delegations` | 委派边数（`parent !== null` 的 agent 数）。**B 恒为 0** |
| `budgetHit` | A 的 token 预算闸有没有被触发（护栏有没有真的起作用） |

### 2.5 判据（`verdict`）

| 字段 | 含义 |
|---|---|
| `ok` | 五项全过 |
| `covered` / `idsValid` / `deduped` / `contradictionPaired` / `distractorClean` | 逐项 |
| `dedupDetail[]` | **逐组**去重结果 `{group, ok}` —— 能回答「哪一组最难」 |
| `contradictionDetail[]` | 逐组矛盾结果 |
| `failed[]` | 未过的项，人话 |
| `reportHash` / `reportChars` | 产物哈希 / 字数（让「自由 = 话多」在表里露出来） |
| `reportText` | **产物全文** —— 定性分析的原料（只存哈希看不出「它到底写了什么」） |

---

## 3. 分析入口

```bash
node demom/bench/compare.ts                                   # 自动挑最新的 A 与 B
node demom/bench/compare.ts runs/A-main-x.jsonl runs/B-main-y.jsonl
```

`compare.ts` **只读 JSONL，不重跑**。改判据后拿旧数据重判即可。

要自己分析，直接读 JSONL（一行一个 JSON）：

```bash
node -e "const fs=require('fs'); const r=fs.readFileSync('demom/runs/A-main-....jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse); console.log(r.map(x=>x.agentCount))"
```

---

## 4. 数据完整性（已经踩过的坑）

这几件事都**实测撞过**，写在这里是为了后面分析时知道数据是干净的：

1. **`--repeat N` 不重置现场** → 第 N 轮看到第 N-1 轮的 `draft/` 与 `report.md`，静默污染。
   已修：`resetScene()` 在**每一轮**之前调用（`prep.ts`）。
2. **语料目录不清空** → 旧版语料的遗留文件被 agent 当材料读进去（实测 45 份 vs 期望 44）。
   已修：`writeCorpus()` 先清空目录；`checkScene()` 现在也报「多出来的文件」。
3. **判据把「提到 M11 说它无关」误判成越界** → 假阳性（B 处理对了却被判红）。
   已修：只在**依据行**上抠 id 判越界。
4. **A 压根不派活**（14 份材料时 `delegations=0`）→ 集群形态没出现。
   已修：语料 44 份 + root role 加硬约束（措施 1 + 2，见 A README §10）。
