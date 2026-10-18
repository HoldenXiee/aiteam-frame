# O8 · 成本会从**子 agent** 逃出观测（库的真实缺口）

> 来源：`BRIEF薄度探针结果.md` 第 2 轮 · 2026-10-18
> 由「token 速率差 5 倍」这个**异常**追出来的 —— 不是设计出来的实验。

## 【现象】

六臂探针里，单臂 token 速率差 **5 倍**：

| 臂 | token | 秒 | tok/min | 工具间隔中位 |
|---|---|---|---|---|
| B1-fmt | 463 万 | 766 | **36.3 万** | 8s |
| A2-env | 296 万 | 2402 | **7.4 万** | 6s |

★ 工具间隔几乎一样（8s vs 6s）→ **不是端点慢**。
★ 但 `A2-env` 跑了 2.8 倍时间、token 却更少。

## 【归因】追了三层才到根

| 层 | 看到什么 | 排除了什么 |
|---|---|---|
| 1 | `A2-env` 耗时 2402s | ✗ 不是"磨蹭" —— 看 trace 的**长间隔分布**：4 次 >60s，最大 1100s |
| 2 | 它 `bash` 起了一个脚本 | ✗ 不是"卡住" —— 看它的 `work/wsmem.ts`：**它自己 import 库、自己 `createAgent`、跑 2×3×rep** |
| 3 | ★★★ 它跑了 **20 次**（`wsmem-runs.jsonl` 20 行） | ★★ **这 20 次的 token 我一次都没量到** |

★★★ **根因：`observe.totalTokens` 只统计这个 agent 自己的轮次**（监听 `message_end`），
而 `AgentSpec` **没有 parent / child / depth 字段**。
**⇒ agent 用代码起的子 agent，成本对任何人都不可见。**

★ 这不是探针写漏了 —— **是库没有这条线**。

## 【做法】

1. ★★ **凡是要报"成本"的结论，先问一句：这个 agent 有没有起过子 agent？**
   （`bash` 里有没有 `createAgent` / `io.prompt` / 递归跑脚本）
2. ★ **量具要能穿透**：至少要能从 `work/` 里认出"它自己起了 agent"
3. ★★ **`AgentSpec` 需要一条 `parent` 线**（这是**改库提案**，不是使用者代码能补的）
   —— 理由：成本核算是 DESIGN 的核心目标，而"分包"是这门生产方式最自然的用法。
   **不记这条线 = 这门学科最关键的数字量不到。**

## 【验证】

- ★ 看 `work/wsmem.ts` 确认它真的 `createAgent`（不是推测）
- ★ 看 `wsmem-runs.jsonl` 确认跑了 20 次
- ★ 看 `src/surfaces/observe.ts` L125-139 确认 `totalTokens` 只监听**本 agent** 的 `message_end`
- ★ 看 `src/agent/types.ts` 确认 `AgentSpec` 无 parent/child 字段

## 【和 O6 的关系】

★ **同一个坑，换了位置**：

| | 老坑（O6） | 新坑（O8） |
|---|---|---|
| 漏掉什么 | 主 agent **上下文里**看不到 system | 主 agent **usage 里**看不到子 agent |
| 为什么漏 | `context.history` 不含 system | `observe` 只监听本 agent 的 `message_end` |
| 后果 | 四次干预有三次静默失败查不出 | 成本可被分包到观测之外 |

★★ **规律**：**每一层"间接"都会吃掉一层可观测性。** 加面（O6）解决了一层，
子 agent 这层又冒出来 —— ★ **而且这次漏掉的正是 DESIGN 目标里的那个数字（成本）。**
