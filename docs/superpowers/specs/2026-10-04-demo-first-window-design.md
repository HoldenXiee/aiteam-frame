# demo 第一窗口 + 真实环境目录 设计

> **性质：** 规格（设计源是 `docs/DESIGN.md`）。实现计划由 writing-plans 产出。
> **范围：** 只改 `demo/`、根 `README.md`、`docs/GETTING-STARTED.md`、`.gitignore`、`src/agent/create-agent.ts` 的一行注释。**不动库 API、不动 examples、不动 `docs/DESIGN.md`。**

## 1. 目标

1. **demo 是「这个 agent 操控库的第一窗口」**：新人第一条命令看到的是库能操控什么（七个面全出场的一件真事），而不是「这台机器装好没有」。
2. **环境是看得见、可手改的真实目录**：`demo/agent/` 就是 agentDir，技能与扩展是仓库里的真文件，而不是 `demo/env.ts` 里 `writeFileSync` 的字符串产物。
3. **环境设置第一次有规范**：`demo/agent/README.md` 逐项讲清环境里每个文件/目录管什么、谁是源谁是产物、哪些能删。

成功标准：新 clone 与「删掉全部 gitignored 动态文件」两种情形下，`node demo/agent-team.ts` 与 `node demo/check.ts` 都退出码 0，且两份 README 的实录与实跑逐字一致。

## 2. 非目标

- **不改库 API**。差异③（`createLab` 逐项显式声明 skills / extensions / model）仍按你的裁决封存。
- **不改 examples**。只在 `examples/lib/harness.ts` 注释里加一句指引。
- **不建 `docs/ENVIRONMENT.md`**。规范先长在 `demo/agent/README.md`（有真实例子才有规范可讲）；它以后要升格成文档时再说。
- **不新增自动化比对 README 实录的脚本**。实录仍靠人工贴（这次会重贴一次并与实跑逐字核对）。

## 3. 现状事实（本次要修的根因，带证据）

| # | 事实 | 证据 |
|---|---|---|
| 1 | `demo/README.md` 第一行是「安装自检」，第一条命令是 `node demo/check.ts` | `demo/README.md:1-8` |
| 2 | 环境是脚本用字符串生成到 gitignored 目录的，仓库里看不到环境长什么样 | `demo/env.ts:125-206`（`seedOwnResources` 里两段字符串数组写入 `demo/run/<mode>/`） |
| 3 | agent-team 的实录已与实跑不符：README 写 `agentDir=...demo\env\agent`、检索员 `技能=[research-style]`、写作员 `extensions=1`、白名单不含 pi 默认工具 | 实跑：`agentDir=...demo\run\faux`、`技能=[env-style、research-style]`、`extensions=2`、白名单含 `read、bash、edit、write、env_checklist`（2026-10-04 实测） |
| 4 | `docs/GETTING-STARTED.md:74` 的注释说真模式「用宿主 `~/.pi/agent` 的真实凭证」，与同段 `:75`「demo 用它自己的 key」自相矛盾 | `docs/GETTING-STARTED.md:74-75` |
| 5 | 根 `README.md:123` 写「`npm test`：120 项测试」 | 实际 144 项（`npm test` 实测） |
| 6 | 把扩展搬进 tsc 范围会立刻编译不过：现在生成的扩展是无注解的 `function (pi)` | `demo/env.ts:180` 起；`tsconfig.json` 的 `include` 含 `demo`，只是靠 `exclude: ["demo/run"]` 躲开了 |

## 4. 设计

### 4.1 门面重排（`demo/README.md`）

新结构（顺序即优先级）：

1. **标题**：`# demo —— 第一窗口：看这个库能操控什么`
2. **第一屏**：一条命令 `node demo/agent-team.ts`（离线、零成本）+ 「看什么」四句（七个面各出场≥1 的自证表 / 黑板流水 / 报告由代码拼 / 每处设计决策旁边有「改成 X 再跑」的实验入口）。
3. **agent-team 的实录**：与实跑逐字一致（本次重贴，含 `demo/agent` 路径）。
4. **环境**：`demo/agent/` 是什么、怎么看、怎么改（指向 `demo/agent/README.md`）。
5. **换成真模型**：环境变量表（路径改成 `demo/agent/auth.json`）。
6. **附加：环境自检（可选）**：`node demo/check.ts` 的说明 + 八项表 + 失败三段式。**用途从「新人第一步」改成「环境出问题时来这查」。**
7. **目录说明**（新表）、**常见问题**、**链接到 examples**。

### 4.2 环境目录 `demo/agent/`（= agentDir）

| 路径 | 进 git | 谁写 | 管什么 |
|---|---|---|---|
| `demo/agent/README.md` | ✅ | 人 | **环境规范**：本目录每一档的职责、哪些能删、改动后果 |
| `demo/agent/skills/env-style/SKILL.md` | ✅ | 人 | 报告写作规范。从 `demo/env.ts` 的字符串搬出来，内容逐字保留 |
| `demo/agent/extensions/env-tools.ts` | ✅ | 人 | 注册 `env_checklist` 工具。**必须带类型**：`export default function (pi: ExtensionAPI)`（否则 `strict` 下编译不过，见事实 6） |
| `demo/agent/models.json` | ❌ gitignored | 脚本（假模式） | 假 provider 的地址与两个模型（端口是随机的，所以只能生成） |
| `demo/agent/auth.json` | ❌ gitignored | 脚本（真模式） | **真模式的凭证**。唯一的 key 位置 |
| `demo/agent/models-store.json` | ❌ gitignored | pi（真模式联网时） | 模型目录缓存；假模式离线，不会写它 |
| `demo/agent/settings.json` | ❌ gitignored | pi | pi 会 ensure 它；值全用默认，不签入 |

`cwd` 仍是 `demo/work/`（gitignored）。**`demo/run/` 取消**（不再写入）。

**已知取舍（明确接受）**：两种模式共用一个环境目录，因此
- 假模式跑过后，`models.json` 会留在那里（真模式不用它，`opencode-go` 是内置 provider）；
- 真模式的 `auth.json` 会让假模式的 `lab.inspectEnv()` 多列出一个 provider。

两者都**只影响 inspectEnv 的输出文本，不影响任何硬断言**（已核实：`demo/check.ts` 第 3 项的假模式分支断言的是「`faux/echo` 可用」，不是 provider 数量；第 8 项的 `available=N` 只打印不断言）。README 与 `demo/agent/README.md` 都要写明这一点。
**被否决的替代方案**：每模式一个 agentDir（`demo/run/faux`、`demo/run/real`）—— 确定性更好，但 agentDir 本身又变成看不见的产物，正是本次要修的问题。

### 4.3 `ensureEnv()` 新流程（`demo/env.ts`）

保留：`ensureEnv(): Promise<DemoEnv>` 幂等缓存、`DemoEnv` 字段（`agentDir` / `cwd` / `baseUrl` / `real` / `model` / `altModel`）不变。

**假模式**（默认）：
1. `mkdirSync(agentDir)`, `mkdirSync(cwd)`
2. `const faux = await startFaux()`
3. `writeModelsJson(agentDir, faux.baseUrl, [FAUX_MODEL_ID, FAUX_MODEL_ALT_ID])`
4. 返回 `{ agentDir, cwd, baseUrl: faux.baseUrl, real: false, model: FAUX_MODEL_REF, altModel: FAUX_MODEL_ALT_REF }`

**真模式**（`AITEAM_DEMO_REAL=1`）：
1. `mkdirSync(agentDir)`, `mkdirSync(cwd)`
2. 凭证源解析（按序）：
   a. `process.env.AITEAM_DEMO_AUTH`
   b. `join(agentDir, "auth.json")`（已在位就直接用，不再复制）
   c. **遗留迁移**：`join(import.meta.dirname, "env", "auth.json")` 存在 → 复制到 `join(agentDir, "auth.json")` 并 `console.log` 一行「已把你的凭证从 demo/env/auth.json 迁到 demo/agent/auth.json（原文件保留，可自行删除）」
3. 三者都没有 → 抛错，文案四条（更新路径：写到 `demo/agent/auth.json` / 用 `AITEAM_DEMO_AUTH=` / 干脆跑离线 / **别指向宿主**）—— 沿用现有文案结构，只换路径。
4. 源不是 `demo/agent/auth.json` 时 `copyIfAbsent(source, join(agentDir, "auth.json"))`
5. 返回 `{ agentDir, cwd, real: true, model: REAL_MODEL_REF, altModel: REAL_MODEL_REF }`

**删除**：`seedOwnResources()`、`envDir()`、`runDir()`、`models-store.json` / `settings.json` 的复制（pi 自己管，见 4.2）。

### 4.4 环境规范 `demo/agent/README.md`（新文件）

必写内容：
1. 一句话：**这个目录就是 `createLab` 的 `agentDir`**，环境即目录、目录即配置；配套的 `cwd` 是 `demo/work/`。
2. 逐档表：`auth.json` / `models.json` / `models-store.json` / `settings.json` / `skills/` / `extensions/` / `SYSTEM.md` / `APPEND_SYSTEM.md`，每档写：管什么、谁写、进不进 git、删掉的后果。
3. **为什么 demo 不放 `SYSTEM.md`**：它会**整体替换**系统提示词（连 `<tools>` / `<rules>` 段一起消失），会让 agent-team 与 check 的既有判据失真 —— 这一档存在且有这个后果，要演示它得单独开一个环境。
4. 「怎么自己改」三条：加一个技能=`skills/<名>/SKILL.md`；加一个扩展=`extensions/<名>.ts`（`export default (pi: ExtensionAPI) => …`）；换凭证=改 `auth.json` 或 `AITEAM_DEMO_AUTH`。
5. 两条环境事实：R41（环境自动发现的扩展，其工具名**不并入** `permissions.only` 白名单）；`agentDir` 与 `cwd` 的分工（身份与装备 vs 在哪干活）。

### 4.5 连带改动清单

| 文件 | 改什么 |
|---|---|
| `demo/env.ts` | 按 4.3 重写（顶部注释也要重写：路径、模式说明、为什么不放 SYSTEM.md） |
| `demo/agent/skills/env-style/SKILL.md` | 新建（内容从 `seedOwnResources` 逐字搬） |
| `demo/agent/extensions/env-tools.ts` | 新建（内容同上，改成带类型的真文件；不再需要 `String.fromCharCode(10)` 这类转义技巧） |
| `demo/agent/README.md` | 新建（4.4） |
| `demo/check.ts` | 只改**文案与注释**：`demo/run/` → `demo/agent/`（第 3 项的 hints、第 4 项 hints、第 7 项的注释与三条 hints，行号约 204/206/233/293/360-362）；判据逻辑一行不动 |
| `demo/agent-team.ts` | 同样只改注释里的路径（约 4/15/448-450/720 行） |
| `demo/README.md` | 按 4.1 重写；agent-team 实录重贴；目录说明表换成新版 |
| `README.md` | demo 一节：`demo/env/auth.json` → `demo/agent/auth.json`；`demo/run/...` 那段改成 `demo/agent/` + `demo/work/`；`120 项测试` → 实数（144） |
| `docs/GETTING-STARTED.md` | `:61` 的 hints 路径、`:74` 那行自相矛盾的注释（「用宿主 `~/.pi/agent` 的真实凭证」——与同段 `:75` 冲突）、`:75`、`:225-229` 两问（`demo/run/` → `demo/agent/`、`rm -rf` 命令改成只删可再生的产物） |
| `.gitignore` | 增 4 行：`demo/agent/auth.json`、`demo/agent/models.json`、`demo/agent/models-store.json`、`demo/agent/settings.json`；`demo/env/*` 与 `demo/run/` 两行**保留**并加注释（遗留、仍可能含 key / 旧 checkout 的残留） |
| `tsconfig.json` | `exclude` 里的 `demo/run` **保留**（防止旧 checkout 的残留目录带着无类型扩展进 tsc）；不动 `include` |
| `src/agent/create-agent.ts:55` | 注释里的示例路径 `demo/run/faux` → `demo/agent` |
| `docs/FACTS.md` | 追加一条 v2 事实：**`<agentDir>/extensions/*.ts` 与 `skills/*/SKILL.md` 是 pi 的自动发现路径**，且被 tsc 检查的扩展文件必须自带类型（本次实测） |

## 5. 错误处理

| 情形 | 行为 |
|---|---|
| 真模式但三处都没有凭证 | 抛错，四条出路（4.3 步骤 3），**不静默** |
| `AITEAM_DEMO_AUTH` 指向宿主 `~/.pi/agent/auth.json` | **不拦**（拦不住任意路径），但报错文案与 README 都明写「别指向宿主，pi 会整文件写回」——沿用现有措辞 |
| 遗留 `demo/env/auth.json` 存在 | 迁移 + 打印一行提示；原文件不删（可能含真实 key，删除是人的决定） |
| `demo/agent/` 不可写 | 由 `demo/check.ts` 第 3 项负责报（hints 已改成新路径） |
| `demo/agent/skills/env-style/SKILL.md` 被删 | **不报错**（技能是软约束）：agent-team 报告里的「依据：」行消失 —— 这是记录在案的 mutation 判据 |
| `env-tools.ts` 被删 | 假模式仍跑通；`check.ts` 第 7 项红（「只看得到自己的 1 个扩展」不再成立） |

## 6. 测试与验证

**必须全绿：**

```bash
npx tsc --noEmit
npm test                                  # 144 pass / 0 fail（demo/agent/extensions/env-tools.ts 现在在 tsc 范围内）
rm -rf demo/agent/models.json demo/work   # 只删可再生的产物，模拟新 clone；auth.json 是你的凭证，不删
node demo/agent-team.ts                   # 退出码 0
node demo/check.ts                        # 八项全通过，退出码 0
git ls-files demo/agent                   # 只有 README.md、skills/env-style/SKILL.md、extensions/env-tools.ts
git check-ignore -v demo/agent/auth.json demo/agent/models.json demo/agent/models-store.json demo/agent/settings.json
git status --short                        # 跑完不出现未跟踪垃圾
```

**mutation 判据（每条都要能判红/判绿）：**

| # | 改成什么 | 期望 |
|---|---|---|
| M1 | 删掉 `demo/agent/skills/env-style/SKILL.md` 再跑 agent-team | 报告小节末尾的「依据：」行消失（技能是软约束），恢复后回来 |
| M2 | 删掉 `demo/agent/extensions/env-tools.ts` 再跑 check | 第 7 项红（自己那份扩展看不见了） |
| M3 | 把 `ensureEnv` 的 `agentDir` 临时指向宿主 `~/.pi/agent` 再跑 check | 第 7 项红（宿主资源混进来）——判定「隔离」这条判据是活的 |
| M4 | 递归删掉 `demo/agent/skills/` 整个目录再跑 agent-team | 仍退出码 0（技能是环境加料，不是跑通的必要条件）。**若为红**：说明 agent-team 硬依赖了这份环境加料 —— 那就把它改成创建期 `skills` 显式声明（或 `skills.add`），别让环境加料成为必需品 |

**实录一致性：** `demo/README.md` 里两份 transcript 的关键行（`agentDir`、技能列表、`extensions=N`、工具白名单、七面计数表）与实跑逐字一致；路径/端口/`history=N` 这类每次不同的值，与 README 里已有的「这些每次跑都会略不同」声明一致。

## 7. 迁移（对已有本地目录）

1. `demo/env.ts` 不再读 `demo/env/models-store.json` / `demo/env/settings.json`（pi 自管）。
2. `demo/env/auth.json` 首次真模式运行会被**复制**到 `demo/agent/auth.json`，并打印一行提示；用户可自行删除 `demo/env/`。
3. `demo/run/` 不再被写入；本地残留可留可删（`.gitignore` 与 `tsconfig.json` 继续忽略它）。
4. 写进 `demo/README.md` 的「改了环境不生效怎么办」：删**可再生的产物**（`demo/agent/models.json` + `demo/work/`）再跑；`demo/agent/auth.json` 是你的凭证，**不要删**。

## 8. 风险与取舍

- **一个环境两种模式**（4.2 的已知取舍）：inspectEnv 输出会随对方模式的产物出现而变。代价已量化为「只影响文本」。若以后要求确定性，再拆 `demo/run/<mode>/`（那时得重新回答「环境为什么看不见」）。
- **凭证迁到 `demo/agent/auth.json`**：`demo/agent/` 里从此有一个含真实 key 的文件（gitignored）。这与「环境是可见目录」不矛盾——可见的是**规范位置**，不是密钥内容；`git ls-files` 里不会有它。
- **`models.json` 只能是生成物**（假 provider 端口随机）：所以「可见的环境」里有一个文件是脚本写的。`demo/agent/README.md` 必须点明这一档为什么例外。
