# demo 重做为「实验脚手架」设计

> **性质：** 规格（设计源是 `docs/DESIGN.md`）。实现计划由 writing-plans 产出。
> **取代：** `docs/superpowers/specs/2026-10-04-demo-first-window-design.md` 的 §4.1（门面选择）与计划 `2026-10-04-demo-first-window.md` 的任务 7/8。那份规格的**环境目录设计（§4.2–§4.4）继续有效**。
> **范围：** `demo/` 整体重做 + `examples/12-team.ts` 新增 + 三份文档跟随。**不动库 API、不动 examples 01–11、不动 `docs/DESIGN.md`。**

## 1. 目标

demo 的隐喻从「安装自检 + 完整案例」改成**实验脚手架**：

> 研究员想做一个实验，就把 `demo/` 整个复制成 `demo-exp1/`，打开 `lab.ts` 改代码，跑。

成功标准（三条，都可机械验证）：

1. **复制即用**：`cp -r demo demo-exp1 && node demo-exp1/lab.ts` 退出码 0，且用的是 `demo-exp1/agent/`（不是原 demo 的）。
2. **一份实验读得完**：`demo/lab.ts` ≤ 200 行，且它自己就能回答「环境在哪、模板是什么、agent 怎么起、结果怎么读」。
3. **库用法不变形**：七面在 `lab.ts` 里各有至少一次真实调用，且不依赖 demo 私有的复杂机制（黑板 / 语料 / 自证表）。

## 2. 非目标

- **不改库 API**（差异③「实验室逐项显式声明资源」仍封存）。
- **不删 agent-team 那份资产**：它是一件已验证的真事，挪到 `examples/12-team.ts`，逻辑一行不改。
- **不删 `demo/check.ts`**：它是排查工具（549 行、八项、失败三段式），不是复制起点。
- **不新增 `template/` 目录**（已否决：`demo/` 本身就是模板，多一层反而要解释「该复制哪个」）。
- **不追求「复制后即脱离本仓」**：`lab.ts` 仍依赖 `examples/lib/faux-server.ts`（假 provider）与本仓 `src/`，像 `examples/*.ts` 一样。脱离本仓使用不在本次范围。

## 3. 最终目录形态

```
demo/
  lab.ts                  ← 实验起点（≤200 行）：环境声明 + 模板 + 逻辑 + 运行
  agent/                  ← 环境目录（= agentDir），**跟着 demo 走**
    README.md             环境规范（已有，本次只改受影响的句子）
    skills/env-style/SKILL.md     进 git
    extensions/env-tools.ts       进 git
    auth.json             gitignored（真模式凭证）
    models.json           gitignored（假模式生成）
    models-store.json / settings.json  gitignored（pi 写）
  env.ts                  ← 缩到 ~40 行：只回答「这个 demo 的环境在哪 + 假 provider 起没起」
  work/                   ← cwd，产物落点（gitignored）
  check.ts                ← 环境自检（保留，549 行；只改路径文案）
  README.md               ← 重写：「复制 demo/ → 改 lab.ts → 跑」
```

`demo/run/` 不再有（上一个规格已取消）。`demo/env/` 删除（见 §6）。

## 4. `demo/lab.ts` —— 实验起点

### 4.1 结构（七段，每段都是一个「改这里」的锚点）

```ts
// ═══ 0. 环境：这个实验用自己的 agentDir（相对本文件解析 ⇒ 复制 demo/ 就复制了环境）═══
// ═══ 1. 模板：一个「成员」就是一个普通对象（库不提供花名册，见 DESIGN.md）═══
// ═══ 2. 启一个实验室，按模板起分身 ═══
// ═══ 3. 自定义工具：研究中最常用的扩展点 ═══
// ═══ 4. 跑：交办、拿结算、看事件 ═══
// ═══ 5. 观测：想拿什么材料，就自己收集（研究工具的一半在这）═══
// ═══ 6. 打印结果（这里换成你自己的分析）═══
```

### 4.2 必须出现的库调用（这是「库用法不变形」的机械判据）

| 面 | 在 `lab.ts` 里的调用 | 为什么保留它 |
|---|---|---|
| `lab.createAgent` | 起 2 个分身（1 个检索员 + 1 个写作员） | 「模板 → 多个实例」这条设计原话要看得见 |
| `tools.custom` | 1 个自定义工具（检索语料） | DESIGN.md：「很多研究中的高级功能都是通过自定义工具实现的」 |
| `permissions.only` + `gate` | 写作员限工具；gate 拦一次危险调用 | 「能力裁剪 + 拦截」是库的两条主张，各来一次 |
| `context.override` / `entries` | 检索员按轮裁剪发送内容 | 上下文操控是研究重点（DESIGN.md 专栏） |
| `io.prompt` / `queue` | 交办 + 排队投递 | 两种输入语义各一次 |
| `on` / `onAny` | 收集 `tool_call` 与 `agent_settled` | 「为分析研究提供材料」= 自己收集 |
| `model.set` | 检索用便宜档、写作升档 | 「同一模板不同分身」的现实用法 |

**允许不复现**：`interrupt`、`reset`、`compact`、`skills.add`、`extensions.add`、`onResult` —— 它们由 `examples/*` 与 `demo/check.ts` 覆盖，`lab.ts` 装不下全部（这本身就是「一份实验只关心自己那几个面」的示范）。

### 4.3 规模上限

- 文件 ≤ **200 行**（含注释）；语料不超过 **6 条短句**（内联在文件里，不做外部数据文件）。
- 不引入黑板 JSONL：两个分身之间用**一个内存数组 + 一个自定义工具**交接（这就是「设计者也可以不走工具，直接把一个 agent 的输出喂给另一个」的最小演示）。
- 不写报告文件：`work/` 只在写作员的 `write` 工具被调用时落一个 `notes.md`（用来证明 `cwd` 生效）。

## 5. `demo/env.ts` —— 缩到「环境在哪」

保留且必须：

1. `ensureEnv(): Promise<DemoEnv>`（幂等缓存；`DemoEnv` 字段不变：`agentDir` / `cwd` / `baseUrl?` / `real` / `model` / `altModel`）。
2. **agentDir 相对本文件解析**：`join(import.meta.dirname, "agent")` —— 复制 `demo/` 后自动指向副本自己的环境（**这是「复制即用」的全部机关**）。
3. 假模式：`startFaux()` + `writeModelsJson(agentDir, baseUrl, [echo, echo-alt])`。
4. 真模式：凭证三级解析（`AITEAM_DEMO_AUTH` 总是赢且坏了报错 → `agent/agent 里已在位 → 遗留迁移）；这段逻辑照抄现有实现，只删「遗留迁移」分支（§6 之后不再需要）。
5. 顶部注释保留「哪些进 git / 哪些是动态 / 两条血教训」，压到 ~15 行。

**删除**：`legacy` 迁移分支、`hasCredentials` 之外的杂项、所有 `demo/env/` 相关表述。

## 6. 凭证搬迁与 `demo/env/` 删除

1. `demo/env/auth.json`（**含真实 key，providers: opencode-go**）→ 移动到 `demo/agent/auth.json`。
   - 移动前先确认目标不是 pi 的 `{}` 空壳（当前它是 2 字节空壳，会被覆盖）。
   - 执行者必须先把原文件复制到 `demo/agent/auth.json`，**验证 providers 一致**，再删 `demo/env/`。
2. `demo/env/models-store.json` 是缓存，直接随目录删掉（真模式联网会重建）。
3. `demo/env.ts` 里那段 `legacy` 迁移分支随之删除（否则它会指着一个不存在的目录）。
4. `demo/README.md`、`demo/agent/README.md`、根 `README.md`、`docs/GETTING-STARTED.md` 里所有 `demo/env/` 的表述一并清除（只允许在「历史遗留」语境里出现）。

## 7. `examples/12-team.ts` —— 原 agent-team 的搬家

- `git mv demo/agent-team.ts examples/12-team.ts`，**逻辑一行不改**。
- 只改：`import ... from "./env.ts"` → 从 `../demo/env.ts` 导入（或直接内联环境声明，见下），以及文件头「跑法」路径。
- **决策（执行时按此办）**：不依赖 `demo/env.ts`，改用 `examples/lib/harness.ts` 的 `lab` + 临时 agentDir（与其它 examples 一致），这样 `examples/` 不反向依赖 `demo/`。若这一步导致 agent-team 的环境相关打印（`agentDir = …`、`env-style` 技能）变化，**以实跑为准重贴它的输出说明**，不改断言逻辑。
- 它原有的 4 条 mutation 判据（M1–M4）**随文件一起搬家**，仍写进 `examples/12-team.ts` 的头部注释。

## 8. `demo/README.md` 重写要点

结构：

1. **一句话**：这是**实验脚手架**，不是展示品 —— 复制它、改它、跑它。
2. **三条命令**：`cp -r demo demo-exp1` → 改 `demo-exp1/lab.ts` → `node demo-exp1/lab.ts`（+ 一句「环境在副本自己的 `agent/` 里，跟 demo 一起被复制」）。
3. **`lab.ts` 的七段结构表**（每段「改这里」改什么）。
4. **环境**：指向 `demo/agent/README.md`（保留）。
5. **换成真模型**：环境变量表，路径 `demo/agent/auth.json`。
6. **完整案例在别处**：`examples/12-team.ts`（786 行、七个面全出场、带自证表与 mutation 判据）+ `demo/check.ts`（环境自检）—— 一句解释「为什么它们不在 demo 里」：**脚手架要短，案例要全，两者服务不同的人**。

## 9. 验证

```bash
npx tsc --noEmit                          # 干净
npm test                                  # 144 pass / 0 fail
rm -rf demo/agent/models.json demo/work
node demo/lab.ts                          # exit 0
node demo/check.ts                        # 八项全过，exit 0
node examples/12-team.ts                  # exit 0
cp -r demo demo-exp1 && node demo-exp1/lab.ts && rm -rf demo-exp1   # 「复制即用」成立，且用的是 demo-exp1/agent
git ls-files demo/agent                   # 只有 README.md、skills/…、extensions/…
git status --short                        # 干净
wc -l demo/lab.ts demo/env.ts             # ≤200 / ≤45
rg -n "demo/env/" demo README.md docs/GETTING-STARTED.md   # 零命中（历史语境外）
```

**mutation 判据**（针对新脚手架）：

| # | 改成什么 | 期望 |
|---|---|---|
| S1 | `cp -r demo demo-exp1` 后跑 `demo-exp1/lab.ts` | 环境用的是 `demo-exp1/agent`（打印的 agentDir 带 `demo-exp1`）—— 证明路径是相对解析的 |
| S2 | 把 `demo/env.ts` 的 `agentDir()` 改成绝对路径常量 | S1 变红（副本仍指向原 demo）—— 证明 S1 有判别力 |
| S3 | 删 `demo/agent/skills/env-style/SKILL.md` | `lab.ts` 仍 exit 0（技能是加料，不是必需品） |
| S4 | 把 `demo/agent/extensions/env-tools.ts` 删掉 | `demo/check.ts` 第 7 项红（与既有判据一致） |

## 10. 风险与取舍

- **两份「第一窗口」**：`demo/lab.ts`（短，给要动手的人）与 `examples/12-team.ts`（全，给要案例的人）。文档必须一眼说清谁是谁，否则又回到「第一眼看到 786 行」。
- **`lab.ts` 只覆盖 7 个面中的一部分**：刻意如此（§4.2 已列出豁免项），但要在 `demo/README.md` 里明说「想看全部七个面去 12-team」。
- **`examples/` 与 `demo/` 不再共享环境代码**：`examples/12-team.ts` 改用 `examples/lib/harness.ts`，代价是它失去 `demo/agent/` 那份「环境是可见目录」的演示 —— 这个演示由 `demo/` 独家承担（正好，脚手架本来就该教这件事）。
- **凭证搬家是一次性手工动作**：执行者必须验证 `providers` 一致后才删 `demo/env/`；**删除前不得先删源**。
