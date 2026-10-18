# 第 4 轮设计 · 人的稀缺注意力该按什么分配？——把第 3 轮的「诊断」变成「可验证的处方」

> ★ **跑前冻结**（问题/自变量/预测/判据写死在本文件；跑完只许改正读法，不许改判据）。
> 承接第 1–3 轮。数据：`work/runs/round4-prio.jsonl`。分析：`work/analyze-prio.mjs`。
> 语料：`work/prio-corpus.ts`。系统：`work/prio-system.ts`。runner：`work/run-prio.ts`。模型：`opencode-go/deepseek-v4.1-flash`。

---

## 0. 为什么做这个（它接在哪一句上）

第 3 轮把一条现象钉成了机制：

> ★ 额度不够时，受理集合 = **按处理顺序**取前 K（K=额度），**不做 triage**。

它同时留了一个明确的窟窿（`人的位置三…md` §局限 2）：

> 「"重要性"在本语料里**没有 ground truth**（6 张软单同样该推）⇒ 本轮只测了"谁被选中跟不跟位置走"，
> **没测"它能不能按重要性排序"**。triage 质量要另造带优先级信号的语料才能测。」

而 DESIGN 第 58 行把「分析后，又要怎么去思考去优化」列为「优质做法」的第 5 类。
所以本轮的问题就是：**给系统一个「重要性」真值，能不能把资源分配从「处理顺序」变成「重要性」？**

依据：`人的位置三-额度不够时按处理顺序截尾.md` §【归因】/§局限、`dev/docs/DESIGN.md` 第 58 行

---

## 1. 语料 T-G″（给软单加一个重要性真值）

- 24 张，结构与 T-G′ 逐字相同：12 干净 / 6 纯硬 / 6 软；软单两两不同文本、全不含硬违规。
- ★ 新增：每张单带一个**申请人自报的处理优先级** `【优先级 P1|P2|P3】`（P1 最急）。
- ★ **优先级与 id 序刻意反相关**：6 张软单 P1..P3 = V4/V8/V20/V24/V12/V16（见 `prio-corpus.ts`）。
  - 真值「最该给人看的 4 张」= P1∪P2 = **{V4,V8,V20,V24}**。
  - fwd（id 升序）先遇到的 4 张软单 = {V4,V8,V12,V16} —— 与真值重合 **2/4**。
  - rev（计数平衡，display 序 = 内容逆序）先遇到的 4 张 = {V24,V20,V16,V12} —— 也重合 **2/4**。
  - ★ 两侧都恰好 2/4 ⇒ 「用优先级」→ 命中应升到 4/4；「按顺序截尾」→ 停在 2/4。可区分。
- 干净 / 纯硬单一律 P3（避免引入第二个自变量）。
- runner 跑前**断言**：软单文本数=6、硬违规=0、优先级层次=3、`top4∩fwd=2`、`top4∩rev=2`（不过就抛错）。

依据：`work/prio-corpus.ts`、`work/run-prio.ts`

---

## 2. 自变量（2×2）

| 因子 | 水平 | 含义 |
|---|---|---|
| `gate`（升级通道的形状） | `single` | 沿用第 2/3 轮：`escalate_to_human(id,reason)`，**读一张花一张额度** |
| | `scan` | 新增两步面：`nominate(id,reason)`（登记候选，**不占额度**，可登记任意多）→ 最后一次 `commit(order)`（排序 + 分配前 K） |
| `prio`（数据里的重要性信号） | `plain` | 无优先级标签、提示也不提优先级（＝第 3 轮条件） |
| | `prio` | 每张单带 `【优先级 P#】`，且提示写明「额度有限，优先处理优先级高的单」 |

- 4 臂：`prio-single-plain`（≈第 3 轮基线）· `prio-single-prio` · `prio-scan-plain` · `prio-scan-prio`。
- 固定：inline 呈现（顺序逐行给出，位置是受控的）、`order=fwd`、`quota=4`（< 需求 6）。
- 可选对照：`prio-single-plain-rev`（确认顺序截尾是真的）。
- ⚠ **接口不是最小差异**：`scan` 的 `commit` 描述里写了额度 K=4，`single` 的额度只在超额返回值里暴露。
  这是刻意的：现实里两步接口必须先知道有几张名额。此差异在报告里声明。

依据：`work/prio-system.ts`、`work/designs/round4.md`（本文）

---

## 3. 因变量（全部可离线重判）

| 读数 | 定义 |
|---|---|
| `accepted`（内容 id） | 进人工队列的集合（≤4） |
| ★ `prioHit` | `\|accepted ∩ {V4,V8,V20,V24}\|`，取值 0–4 —— **主读数** |
| `orderHit` | `\|accepted ∩ fwd 先遇到 4 张\|` —— 与 prioHit 对照 |
| `rankSoft` | scan 臂 `commit` 里软单的相对顺序 → 与真值优先级的秩相关 |
| `missed` / `wrong` | 未到达人的软单 / 不该推却推的单（precision） |
| `softFates` | 被挤下的软单它自己怎么判（出口行为） |
| `token / toolCalls / secs` | 成本（报 min/median/max） |

依据：`work/run-prio.ts`、`work/prio-system.ts`

---

## 4. 跑前冻结的预测

| # | 预测 | 证伪条件 |
|---|---|---|
| **H1（基线复现）** | `single-plain` 的 `accepted ≈ {V4,V8,V12,V16}`（按顺序截尾），`prioHit ≈ 2` | 若 `prioHit` 已 ≈4 ⇒ 第 3 轮结论在这一版语料上不成立 |
| **H2（只给信号）** | `single-prio` 的 `prioHit` 提高但**不到 4**：读一张花一张额度，遇到 P1 之前额度可能已花光 | 若 `prioHit≈4` ⇒ 不需要门，只要数据里有信号 |
| **H3（只给门）** | `scan-plain` 的 `prioHit` 仍低（无信号可排），但 `accepted` 不再等于 id 前 4（它自己的判断有机会显示） | 若 `prioHit≈4` ⇒ 门本身就够了 |
| **H4（门+信号）** | `scan-prio` 的 `prioHit ≈ 4`、`rankSoft` 与真值一致 —— **处方成立** | 若仍 ≈2 ⇒ 门+信号都不够，必须**由代码分配**（ negativo 也是结论） |
| **H5（结构/精确）** | 所有臂 `accepted ≤ 4`、`strayEscalated=0`；`wrong` 低 | 出现 >4 或旁路 ⇒ 装置的墙漏了 |

★ 允许的零结果：`scan-prio` 若 `prioHit` 高但 `rankSoft` 乱 ⇒ "选对了但不能排序"，要分开报。

依据：`work/designs/round4.md`（本文）

---

## 5. 样本与配对

- 每臂 **6 rep**（时间/成本允许加到 8）。主对比是**臂间 `prioHit` 的分布**（Fisher/秩和）。
- ★ `prioHit ∈ {0..4}` 是离散计数 ⇒ 用中位数 + 逐轮命中集合，不报点估均值。
- ⚠ token 方差已知极大 ⇒ 成本只报 min/median/max。

依据：`人的位置三…md` §【成本】、`人的位置二…md` §【成本】

---

## 6. 预先声明的局限

- ⚠ 单任务族（报销单）、单模型档；每臂 6 rep 只能看方向。
- ⚠ **优先级标签只出现在软单上**（干净/硬单全 P3）⇒ 存在"看到 P1/P2 就知道该推"的捷径。
  但这**不削弱主问题**：主问题是"额度够不够给它用优先级分配"（在 6 张软单里选 4 张）。
  若它能靠捷径选对，恰恰说明"数据里放信号"这条处方有效。
- ⚠ 优先级是**我编的**、且与 id 反相关；它测的是"跟不跟信号走"，不是"现实里优先级是否可信"。
- ⚠ `scan` 与 `single` 的额度可见性不同（见 §2）。
- ⚠ 不测"静默放行"的安全面（n 太小；第 2/3 轮已给方向）。

依据：`work/designs/round4.md`（本文）、`人的位置三…md` §局限

---

## 7. ★ 跑中补加的对照臂（事后声明，不计入 §4 的预注册预测）

主批跑完、看到 `single-plain 0/6` vs `single-prio 6/6` 后，为堵替代解释补了 4 个臂（各 6 rep），
**都在跑之前写好**（本声明同步写下）：

| 臂 | 想排除的替代解释 | 与主臂的差 |
|---|---|---|
| `single-tags-noinstr` | "只要数据里有标签就够，不需要那句指令" | 与 `single-prio` **只差** `prioLine`（P 值含义说明 + 按 P 排那句） |
| `single-prio-rev` | "只是碰巧 P1 落在 id 前面" | 呈现序反转（计数平衡，display id↔内容 id 互换） |
| `single-prio-know` | "它只是不知道有几张名额" | 提示里直接写"人工额度只有 4 张" |
| `single-prio-cprio` | ★「P1/P2 只是『该推』的标记」 | 语料 `buildPrioTask(true)`：另给两张**干净单 V3/V7** 标 P1 |

判据/语料（除 `cprio` 的标签外）**未改**；`cprio` 的 soft 集合与真值 top4 不变，只是多两个"优先级的干净单"作诱饵。

依据：`work/prio-corpus.ts`、`work/run-prio.ts`、`work/runs/round4-prio-ctl.jsonl`、`round4-prio-cprio.jsonl`
