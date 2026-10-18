# 研究员集群的代码

> ★ 一个集群一个文件夹 · 一个项目多文件（2026-10-18 拆）
> ★ **集群的代码在这里，集群的空间在 [`../../labfirst/`](../../labfirst/)。**

---

## 布局

```
research/
├── clusters/            ★ 集群的**代码**（这里）
│   └── lab-3b/
├── labfirst/            ★ 集群的**空间**（它的 inbox/outbox/work/lib，独立 git）
│   └── lab-3b/
└── docs/                ★ 这个研究方向的**材料**（成果/实验/规划/装置）
```

★ 一个集群 = `clusters/<名>/`（代码）+ `labfirst/<名>/`（空间），**同名**。

---

## `lab-3b` 的文件

| 文件 | 管什么 |
|---|---|
| `index.ts` | 入口（只管 CLI，不放规则） |
| `runner.ts` | 主流程：起 agent、挂事件、投一次、等窗口 |
| **`prompts/`** | ★ **每个 agent 的提示词一个文件** |
| `prompts/researcher.ts` | 研究员（唯一常驻） |
| `prompts/inspector.ts` | 审查者兼鼓励者兼判停 |
| `prompts/archivist.ts` | 复审者（重看目标） |
| `prompts/inspirer.ts` | 跨学科启发者 |
| `prompts/libsmith.ts` | 改库者 |
| `prompts/watchdog.ts` | 看门狗（真探索 vs 转圈） |
| `prompts/index.ts` | ★ 名册：专家 = 提示词工厂 + 工具白名单 |
| **`tools/`** | ★ **agent 触发**（它自己拉的） |
| `tools/consult.ts` | 请一位专家（★ 传"处境 + 地盘"，不是一句话） |
| `tools/spawn-line.ts` | 派一条探索支线 |
| **`topology/rules.ts`** | ★ **代码触发**（情况 → 动作的规则表） |
| `guard.ts` | 写边界守卫（★ 拦的同时给"路"） |
| `env.ts` | 实验室环境（凭证 / models.json） |
| `paths.ts` | 路径与常量（★ 唯一的路径来源） |

---

## 两类触发（这是这个集群的核心设计）

| | 谁触发 | 用于 | 依据 |
|---|---|---|---|
| **代码触发** | `agent.on(...)` 事件规则 | **审查 / 重审目标 / 换视角 / 判停** | ★ 它躲不掉（`P13`）；这些事需要**不被当前处境困住的视角** |
| **agent 触发** | 自定义工具 | **问专家 / 派支线** | ★ 它知道自己卡在哪，代码只能猜 |

★★★ **共同点**：代码触发的那四件事，**都需要"一个不被当前处境困住的视角"** ——
而"当前处境"正是 agent 本身。

---

## 跑法

```bash
npx tsx research/clusters/lab-3b/index.ts --secs=1800
npx tsx research/clusters/lab-3b/index.ts --dry        # 只搭装置不投递（自检）
```

★ 日志落在 `labfirst/lab-3b/work/_topology.log`（看它有没有用 `consult`）。
★ 专家结论落在 `labfirst/lab-3b/outbox/_audits/`。

---

## ★★ 设计约束（改之前先读）

**① 运行时不能干涉** —— 要干涉只能重设计集群。
⇒ **不许**在外面写"盯状态 / 判断 / 起 agent"的循环。触发挂在 agent 的事件规则上。

**② 拦的同时必须给"路"**（`P12`）——
只拦不给路：拦 59 次、成功 0 次、905k token。给路：0 次拦、6 次成功、93k token。

**③ 别指望它主动用你给的东西**（`P13`）——
所以"审查"不能靠它自己叫（它可以不叫）。

**④ 它能审"量具"，审不了"结论真伪"**（`P24`）。
