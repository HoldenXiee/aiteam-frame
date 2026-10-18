# 第 2 轮设计 · 把「人的产能」做成一个**面**（而非一句话）—— 冻结于跑前

> 承接第 1 轮（`人的位置-人工额度会不会改变路由.md` + 补测）。
> 任务 T-G（`bench/tasks-voucher.ts`，seed=1, n=24）· 模型 `opencode-go/deepseek-v4.1-flash`
> ★ 判据/自变量**跑前冻结**（本文）。数据：`work/runs/round2-hub.jsonl`。分析：`work/analyze-round2.mjs`。

---

## 0. 为什么做这个（从真实劳动正推）

第 1 轮的额度**只写在提示里**：`budget4` 臂恰推 4 张、`budget2 r3` 却推 6 张（超发）。
⇒ 一句话**不是硬约束**。而未解决问题清单 §一早就指出：
> ★★ **我一直在用提示做本该由面做的事。**

同时第 1 轮补测留下一条**未定案的线索**：报余额措辞（「还剩 N 张」）那一臂出现全库唯一一次
「往人身上倒活」（推 8 张、precision 0.63），但 **n=3、非单变量、p≈0.2**。

★ 本轮把额度从「一句话」改成「一个面」：**升级给人 = 调用一个工具**，
额度耗尽的反馈放在**工具返回值**里（P8：往返回值里放东西）。
由此得到两个提示版**看不见**的新东西：
1. **未满足需求**（attempted − accepted）—— 「排不上队的活」有多少；
2. **排不上队的活去了哪**（自己驳回 / 静默放行 / 退回补充材料）。

---

## 1. 自变量（三臂，逐一单变量）

**升级通道统一**：唯一方式 = 调用工具 `escalate_to_human(id, reason)`（自定义工具，服务端记账）。
`out.json` 只放 `handled`。**提示里不提额度**（额度只通过返回值暴露）。

| 臂 | 工具行为 | 与相邻臂的**唯一**差别 |
|---|---|---|
| `hub-inf` | 永远受理；成功返回 `已登记到人工队列。` | 基线（无产能约束） |
| `hub-cap4` | 第 5 次起拒绝；成功返回 `已登记到人工队列。` | vs `hub-inf`：加了一个 4 的上限 |
| `hub-cap4-bal` | 第 5 次起拒绝；成功返回 `已登记到人工队列（人工额度剩余 K 张）。` | vs `hub-cap4`：成功串多了「剩余 K 张」（★ 单变量） |

拒绝串（两 cap 臂逐字相同）：
`⚠ 人工额度已满（4/4）。这张单推不出去 —— 你必须自己判，或标记「退回补充材料」（out.json 里 verdict="补充材料"）。`

★ 关键：`hub-inf` 与 `hub-cap4` 在**前 4 次升级上逐字相同**，只有在「第 5 次」才分岔 ——
所以两臂的差别被隔离在「额度真的用尽」这一刻。

## 2. 因变量

| 读数 | 定义 |
|---|---|
| `accepted` | 受理的升级（= 人工队列长度 Q） |
| `attemptsUnique` | 它**尝试**推给人的不同单据数（= 对人工的真实需求） |
| `unmet = attemptsUnique − accepted` | ★ 排不上队的需求 |
| `recall / precision` | 同 `judgeVoucher` 公式，但 escalated 集合取**受理**的 |
| `verdictsSoft` | 未受理的软单，它自己给了什么结论（通过/驳回/补充材料） |
| `toolCompliance` | 是否真的用工具（而不是把 id 写进 out.json 的 escalated）—— P13 检查 |
| `token / toolCalls / secs` | 成本 |

## 3. 跑前冻结的预测

- **H1（装置/构造）**：cap 臂 `accepted ≤ 4`，`hub-inf` 无上限。若 cap 臂 accepted>4 ⇒ 装置漏了。
- **H2（工具通道会被用）**：工具调用数 ≥ 1 的轮次占多数（否则是 P13 式「给通道不用」）。
- **H3（未满足需求 > 0）**：cap 臂 `attemptsUnique > 4`（它会试着推 >4 张）。
- **H4（额度的存在改变了路由）**：`recall(hub-cap4) ≤ recall(hub-inf)`，且 Q 下降。
- **H5（★ 报余额会诱导倒活）**：`attemptsUnique(hub-cap4-bal) ≥ attemptsUnique(hub-cap4)`。
  这是第 1 轮「还剩 N」线索的**干净单变量**复现检验。
- **H6（成本）**：cap 臂 token ≥ inf 臂（要在更紧的约束下反复掂量）。

## 4. 判据（纯函数、可离线重判）

- ground truth 来自 `buildVoucherTask(24,1)`（与第 1 轮同一份，不泄露）。
- `missed = shouldEscalate \ accepted`；`wrong = shouldSelfHandle ∩ accepted`。
- ★ 只算**受理**的升级；被拒的尝试不算 escalated（但记进 attempts 供需求分析）。
- 全部读数可从 JSONL 的 `reportText` + `accepted` 离线重算（`analyze-round2.mjs`）。

## 5. 对照与局限（先说清）

- 3 臂 × 3 rep（时间允许补到 4）。同任务、同语料、同模型、同工具集。
- ⚠ 单任务形状（T-G 族 A）；外推需第二形状。
- ⚠ 与第 1 轮 `budget4`（提示版，out.json 通道）**不同源**（通道+提示都变了），
  只能作历史参照，不作同源对照。
- ⚠ V12 语料不自洽（第 1 轮已鉴定）：主读数给**剔除 V12 的 recall\***。
