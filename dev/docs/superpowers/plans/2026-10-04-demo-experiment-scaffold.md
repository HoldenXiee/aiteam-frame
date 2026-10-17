# demo 重做为「实验脚手架」实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** `demo/` 从「安装自检 + 完整案例」变成**实验脚手架**：复制 `demo/` 就复制了环境，打开 `demo/lab.ts`（≤200 行）改代码就能开始实验。786 行的 agent-team 原样挪成 `examples/12-team.ts` 继续当「完整案例」。

**架构：** `demo/lab.ts` 是唯一实验起点（环境声明 → 模板 → 起分身 → 交办 → 观测 → 打印），它只覆盖七个面里的一部分（刻意）。`demo/env.ts` 缩到「这个 demo 的环境在哪」——agentDir 用 `join(import.meta.dirname, "agent")` 相对解析，这是「复制即用」的全部机关。`demo/agent/` 是环境目录（已是仓库里的真文件），跟着 demo 一起被复制。`demo/check.ts` 保留为排查工具。

**技术栈：** TypeScript（Node 原生 `.ts`）、本机假 provider（零 API 成本）、`node:test`（不新增测试，靠既有 144 项 + check 八项 + 本计划的 S1–S4 mutation）。

**规格：** [`docs/superpowers/specs/2026-10-04-demo-experiment-scaffold-design.md`](../specs/2026-10-04-demo-experiment-scaffold-design.md)（**执行者必须两份都读**；每个决定的理由与被否决的替代方案都在里面）。环境目录的细节仍见 [`2026-10-04-demo-first-window-design.md`](../specs/2026-10-04-demo-first-window-design.md) §4.2–§4.4。

## 全局约束

- **不动库 API**（`src/` 不改）；**不动 examples 01–11**；**不动 `docs/DESIGN.md`**。
- `demo/lab.ts` **≤ 200 行**；`demo/env.ts` **≤ 45 行**（`wc -l` 判）。
- 复制即用：`cp -r demo demo-exp1 && node demo-exp1/lab.ts` 必须 exit 0，且打印的 agentDir 含 `demo-exp1`。
- **凭证搬迁顺序不可颠倒**：先复制到 `demo/agent/auth.json` 并验证 `providers` 一致，**才**允许删 `demo/env/`。
- 每个任务收尾：`npx tsc --noEmit` 干净 + `npm test` 144 pass。

## 审查重点（Review Focus）

1. **凭证丢失**：`demo/env/auth.json` 是**唯一的真实 key**（`providers: opencode-go`），而 `demo/agent/auth.json` 目前是 pi 造的 2 字节空壳。→ 任务 1 步骤 2/3 必须逐字比对 `providers`，**比对通过前不许删任何东西**。
2. **复制后仍指向原 demo**：agentDir 若是绝对路径或 `process.cwd()` 推导，「复制即用」就是假的。→ 任务 2 步骤 4 的 S1 + 任务 2 步骤 5 的 S2（反向 mutation，验证 S1 有判别力）。
3. **`lab.ts` 悄悄膨胀**：加了语料、黑板、自证表就回到老路。→ 任务 3 步骤 1 的 `wc -l` 上限 + 步骤 4 的「不依赖 demo 私有机制」检查（无 JSONL、无外部数据文件）。
4. **`examples/` 反向依赖 `demo/`**：`examples/12-team.ts` 若 `import "../demo/env.ts"`，examples 就再也不能独立跑了。→ 任务 4 步骤 2 的 `rg` 检查必须零命中。
5. **文档出现两个「第一窗口」**：`lab.ts`（脚手架）与 `12-team.ts`（案例）必须在每处被同时说明谁是谁。→ 任务 6 步骤 3 的清单式核对。

---

### 任务 1：搬凭证、删 `demo/env/`

**文件：**
- 移动：`demo/env/auth.json` → `demo/agent/auth.json`（覆盖 pi 的空壳）
- 删除：`demo/env/`（整个目录）
- 修改：`demo/env.ts`（删 legacy 迁移分支）

- [ ] **步骤 1：核对源与目标**

```bash
node -e "
const fs=require('fs');
const k=p=>{try{return Object.keys(JSON.parse(fs.readFileSync(p,'utf8'))).join(',')||'(空)'}catch(e){return '读不到'}};
console.log('源 demo/env/auth.json      →', k('demo/env/auth.json'));
console.log('目标 demo/agent/auth.json →', k('demo/agent/auth.json'));
"
```
预期：源是 `opencode-go`；目标是 `(空)`（pi 的 `{}` 空壳）或不存在。**如果源不是 `opencode-go` 或读不到，停下来问人，不要继续。**

- [ ] **步骤 2：复制并验证**

```bash
cp demo/env/auth.json demo/agent/auth.json
node -e "
const fs=require('fs');
const j=JSON.parse(fs.readFileSync('demo/agent/auth.json','utf8'));
const keys=Object.keys(j);
if (!keys.includes('opencode-go')) throw new Error('搬迁后 providers 不含 opencode-go：'+keys.join(','));
console.log('搬迁后 providers:', keys.join(','), '✓');
"
```
预期：打印 `搬迁后 providers: opencode-go ✓`。**这一步的输出是删源的前置条件。**

- [ ] **步骤 3：删 `demo/env/`**

```bash
rm -rf demo/env
ls demo/ | tr '\n' ' '
```
预期：`agent agent-team.ts check.ts env.ts lab.ts(未建则不出现) README.md work`——**不再有 `env`**。

- [ ] **步骤 4：删 `demo/env.ts` 里的 legacy 迁移分支**

删掉 `setupReal()` 里这一段（现有实现约 4 行 + 那行 `console.log`）：

```ts
    const legacy = join(import.meta.dirname, "env", "auth.json");
    const source = existsSync(legacy) ? legacy : undefined;
```
及其配套的 `if (source === legacy) console.log(...)`；同时把错误文案里的 `` `· 或干脆不设 AITEAM_DEMO_AUTH，改用 ${target}（推荐）或 demo/env/auth.json（遗留）` `` 改成不提到 `demo/env/`，以及文件头注释里 `` `demo/env/` 与 `demo/run/` 是**遗留** `` 那段（`demo/run/` 的说明保留）。

运行：`rg -n "demo/env/|\"env\"" demo/env.ts` 预期零命中。

- [ ] **步骤 5：验证**

```bash
npx tsc --noEmit && echo "tsc OK"
rm -rf demo/agent/models.json demo/work && node demo/check.ts >/dev/null 2>&1; echo "check exit=$?"
node demo/agent-team.ts >/dev/null 2>&1; echo "agent-team exit=$?"
git status --short          # 干净（demo/env/ 的删除是本任务的一部分，要一起提交）
```
预期：tsc OK；两个脚本 exit 0；`git status` 只显示 `demo/env/` 被删。

- [ ] **步骤 6：Commit**

```bash
git add -A demo/env demo/agent/auth.json demo/env.ts
git commit -m "demo: 凭证搬到 demo/agent/auth.json，删掉遗留的 demo/env/（key 已验证一致）"
```

---

### 任务 2：`demo/env.ts` —— 环境路径相对本文件解析

**文件：**
- 修改：`demo/env.ts`（缩到 ≤45 行）

- [ ] **步骤 1：缩写**

保留：`ensureEnv()` 幂等缓存、`DemoEnv` 接口（字段不变）、`agentDir()`（`join(import.meta.dirname, "agent")`）、`workDir()`、`setupFaux()`、`setupReal()`（三级凭证解析，去掉 legacy）、`hasCredentials()`。

删掉/压缩：顶部 36 行注释压到 ≤15 行（保留「哪些进 git / 哪些是动态 / 两条血教训 / models.json 为什么只能是生成物」四件事，其余删）；`REAL_MODEL_REF` 保留。

**必须保留的那行机关**（写进注释，别让人后来改成绝对路径）：

```ts
/** 环境目录（= agentDir）。**相对本文件解析** —— 这是「复制 demo/ 就复制了环境」的全部机关：
 *  改成绝对路径或 process.cwd() 推导，副本就会去用原 demo 的环境。 */
const agentDir = (): string => join(import.meta.dirname, "agent");
```

运行：`wc -l demo/env.ts` 预期 ≤ 45。

- [ ] **步骤 2：验证 tsc 与两个脚本**

```bash
npx tsc --noEmit && rm -rf demo/agent/models.json demo/work
node demo/lab.ts 2>/dev/null || echo "（lab.ts 还没建；本任务只需 check 与 agent-team 通过）"
node demo/check.ts >/dev/null 2>&1; echo "check exit=$?"
node demo/agent-team.ts >/dev/null 2>&1; echo "agent-team exit=$?"
```
预期：tsc OK；两个脚本 exit 0。

- [ ] **步骤 3：写 S1 判据的探针**

```bash
rm -rf demo-exp1 && cp -r demo demo-exp1
node demo-exp1/agent-team.ts 2>&1 | head -4
```
预期：`agentDir = ...\demo-exp1\agent`（**含 demo-exp1**）。若打印的是 `demo\agent`，说明路径不是相对解析 —— 停下来修 `env.ts`。

- [ ] **步骤 4：反向 mutation S2（证明 S1 有判别力）**

```bash
cp demo/env.ts /tmp/env.ts.bak
sed -i 's#join(import.meta.dirname, "agent")#join("D:/space/aiteam/test/demo", "agent")#' demo/env.ts
rm -rf demo-exp1 && cp -r demo demo-exp1 && node demo-exp1/agent-team.ts 2>&1 | head -4
cp /tmp/env.ts.bak demo/env.ts
```
预期：S2 之后打印的是 `demo\agent`（副本指向原 demo）⇒ S1 有判别力。**恢复 `env.ts` 后重跑步骤 3 必须又是 `demo-exp1\agent`。**

- [ ] **步骤 5：清理并 Commit**

```bash
rm -rf demo-exp1
git add demo/env.ts
git commit -m "demo(env): 缩到 45 行以内；agentDir 相对本文件解析（复制 demo/ 即复制环境）"
```

---

### 任务 3：`demo/lab.ts` —— 实验起点（≤200 行）

**文件：**
- 创建：`demo/lab.ts`

- [ ] **步骤 1：写它**（七段结构，逐段一个「改这里」的锚点）

内容要求（规格 §4.2 是机械判据，逐条都要有）：

| 段 | 写什么 |
|---|---|
| 0 环境 | `const env = await ensureEnv()`；`createLab({ agentDir: env.agentDir, cwd: env.cwd, modelNetwork: env.real ? undefined : false })` |
| 1 模板 | 一个 `interface Member { name; model?; skills?; tools?; only? }` + 两个**普通对象**（`检索员`、`写作员`），注释写明「库不提供花名册，模板就是你代码里的对象（DESIGN.md）」 |
| 2 起分身 | `lab.createAgent({ id: m.name, model: m.model, skills: m.skills, tools: { custom: m.tools }, permissions: { only: m.only } })`，起 2 个 |
| 3 自定义工具 | 1 个 `tool_search`（在 6 条内联语料里按关键词找），**注释**：`tools.custom` 是研究里最常用的扩展点 |
| 4 跑 | 检索员 `io.prompt` 一次；再 `io.queue` 一次（演示排队投递）；写作员 `io.prompt` |
| 5 观测 | `agent.on("tool_call", …)` 与 `agent.onAny(…)` 各收一样东西（`tool_call` 名称 + `agent_settled` 计数）；检索员用 `context.override` 裁一次发送内容，用 `context.entries()` 打印可寻址条目 |
| 6 打印 | 打印：两个分身的 id/model、工具调用序列、`RunResult.text`、`agent.usage.totalTokens`、`context.entries().length`；末尾一行「改这里：把你的分析写在这」 |

还必须有的两处（规格 §4.2 表里点名）：
- `permissions.gate`：写作员装一个门，拦一次含「清空」字样的调用，并把 `{block:true, reason}` 打印出来；
- `model.set`：检索完后 `await 写作员.model.set(env.altModel)`（升档）再交办。

**允许不复现**（写进文件头注释一句话）：`interrupt` / `reset` / `compact` / `skills.add` / `extensions.add` / `onResult` —— 想看全部七个面去 `examples/12-team.ts`。

- [ ] **步骤 2：验证规模与跑通**

```bash
wc -l demo/lab.ts          # 预期 ≤ 200
node demo/lab.ts           # 预期 exit 0，打印两三个分身的输出与观测结果
```

- [ ] **步骤 3：验证「不依赖 demo 私有机制」**

```bash
rg -n "jsonl|blackboard|writeReport|selfCheck|CORPUS\s*=\s*\[" demo/lab.ts    # 零命中
ls demo/work/               # 只有本任务里自定义工具真的落下的文件（或为空）
```
预期：零命中；`demo/work/` 里没有 JSONL、没有报告拼字产物。

- [ ] **步骤 4：mutation S3（技能是加料，不是必需品）**

```bash
mv demo/agent/skills/env-style/SKILL.md /tmp/SKILL.md
node demo/lab.ts >/dev/null 2>&1; echo "S3 exit=$?（预期 0）"
mv /tmp/SKILL.md demo/agent/skills/env-style/
```

- [ ] **步骤 5：Commit**

```bash
git add demo/lab.ts
git commit -m "demo(lab): 实验起点 —— 环境声明 + 模板 + 七个面的用法，一份实验一个文件"
```

---

### 任务 4：agent-team 搬家 —— `examples/12-team.ts`

**文件：**
- 移动：`demo/agent-team.ts` → `examples/12-team.ts`
- 修改：`examples/12-team.ts`（环境来源 + 文件头路径）

- [ ] **步骤 1：移动**

```bash
git mv demo/agent-team.ts examples/12-team.ts
```

- [ ] **步骤 2：换掉环境来源**

把文件头两行 `import { ensureEnv } from "./env.ts";` 与 `const env = await ensureEnv();` + `createLab({...})` 那段，换成 `examples/lib/harness.ts` 提供的那套：

```ts
import { lab as harnessLab, faux, fauxAgentDir, fauxCwd, FAUX_MODEL_REF, FAUX_MODEL_ALT_REF } from "./lib/harness.ts";
// 环境：与其它示例一致（本机假 provider + 临时 agentDir/cwd，跑完即弃）。
// 想看「环境是仓库里看得见的目录」这件事，去 demo/（那份脚手架用它讲环境规范）。
const lab = harnessLab;
const env = { agentDir: fauxAgentDir, cwd: fauxCwd, real: false as const, model: FAUX_MODEL_REF, altModel: FAUX_MODEL_ALT_REF };
```

（`harness.ts` 已经导出 `lab` / `fauxAgentDir` / `fauxCwd` / 两个 model ref；`env.real` 的所有使用处都按 `false` 走假分支 —— 因为 harness 钉死了离线。若某个打印分支依赖 `env.real`，把它简化为假模式分支。）

- [ ] **步骤 3：改文件头与注释里的路径**

- `跑法：PI_OFFLINE=1 node demo/agent-team.ts` → `跑法：node examples/12-team.ts`
- `demo/work/report.md` → 产物落在 `fauxCwd`（临时目录，跑完即弃），注释里说明
- `demo/agent/skills/env-style/SKILL.md` 相关的说明 → 改成「临时 agentDir 里没有这份技能」并**同步调整那句打印**（它现在会打印 `技能=[research-style]`；若 `env-style` 那段说明不再成立，删掉那句话、保留实测打印）。
- **M1–M4 四条 mutation 判据随文件搬进头部注释**（路径按新位置改）。

运行：
```bash
rg -n "\.\./demo|demo/env|demo/agent|demo/work" examples/12-team.ts   # 预期零命中
```

- [ ] **步骤 4：跑通并核对**

```bash
node examples/12-team.ts 2>&1 | tail -14
```
预期：exit 0；七面自证表全部 ≥ 1。若 `env-style` 相关打印变了，**以实跑为准**更新文件头注释（不改任何断言逻辑）。

- [ ] **步骤 5：更新 `examples/` 的清单引用**

- `examples/` 若有 README/清单列出 01–11，加一行 12。
- 根 `README.md` 里 「`demo/agent-team.ts`」 的引用（`:59`、`:79`、`:83-84`）改到新位置（任务 6 统一处理，这里只记着）。

- [ ] **步骤 6：Commit**

```bash
git add examples/12-team.ts README.md
git commit -m "examples(12): 原 demo/agent-team 搬为完整案例；改用 examples/lib/harness（examples 不再依赖 demo/）"
```

---

### 任务 5：`demo/check.ts` 与 `demo/agent/README.md` 跟随

**文件：**
- 修改：`demo/check.ts`（路径文案；判据不动）
- 修改：`demo/agent/README.md`（删掉已不成立的句子）

- [ ] **步骤 1：`check.ts` 里对 `demo/` 的表述**

- 「`demo/` 下的三个脚本都读同一个环境」这类句子若在 `check.ts` 出现，改成「`demo/` 下的脚本都读同一个环境（`env.ts` 解析出的 `demo/agent/`）」。
- 第 4 项 hints、第 7 项 hints 里若提到 `demo/agent-team.ts` 的，删掉或改成 `demo/lab.ts`。

运行：`rg -n "agent-team|demo/env/" demo/check.ts` 预期零命中。

- [ ] **步骤 2：`demo/agent/README.md`**

- 「`demo/` 下的三个脚本都读同一个环境：`demo/env.ts` 按需补上动态文件…`demo/check.ts` 与 `demo/agent-team.ts` 再用它起 agent」→ 改成提到 `lab.ts`（实验起点）、`check.ts`（自检）。
- 加一句「**复制 `demo/` 会把本目录一起复制走**：环境跟着实验走，副本用副本自己的 `agent/`」。

- [ ] **步骤 3：验证**

```bash
rg -n "agent-team|demo/env/" demo/agent/README.md demo/check.ts    # 零命中
rm -rf demo/agent/models.json demo/work && node demo/check.ts >/dev/null 2>&1; echo "check exit=$?"
```

- [ ] **步骤 4：Commit**

```bash
git add demo/check.ts demo/agent/README.md
git commit -m "demo: check 与环境规范的表述跟随脚手架形态；判据逻辑不动"
```

---

### 任务 6：文档全面对齐（根 README / GETTING-STARTED / demo README / AGENTS）

**文件：**
- 修改：`demo/README.md`（重写）
- 修改：`README.md`
- 修改：`docs/GETTING-STARTED.md`
- 修改：`AGENTS.md:88`

- [ ] **步骤 1：重写 `demo/README.md`**（按规格 §8 的六节）

1. 一句话：**这是实验脚手架，不是展示品** —— 复制它、改它、跑它。
2. 三条命令 + 「环境在副本自己的 `agent/` 里」。
3. `lab.ts` 七段结构表（每段「改这里」改什么）。
4. 环境 → 指向 `demo/agent/README.md`。
5. 换成真模型（路径 `demo/agent/auth.json`）。
6. **完整案例在别处**：`examples/12-team.ts`（786 行、七面全出场、自证表 + mutation 判据）与 `demo/check.ts`（环境自检）；一句解释「脚手架要短、案例要全」。

实录：只保留 `node demo/lab.ts` 与 `cp -r demo demo-exp1 && node demo-exp1/lab.ts` 两段的**实跑输出**（重跑后逐字贴），删掉 agent-team 的实录（它已搬到 examples）。

- [ ] **步骤 2：根 `README.md`**

- `:10-11` 的两条「第一次上手」命令：第一条改成 `cp -r demo demo-exp1 && node demo-exp1/lab.ts`（或 `node demo/lab.ts`），并补一句「完整案例见 `examples/12-team.ts`」。
- `:59` 里 `[demo/agent-team.ts](demo/agent-team.ts)` → `[examples/12-team.ts](examples/12-team.ts)`。
- `:79-84` 三行命令与「`demo/` 是**这个库的第一窗口**」那段：改成「`demo/` 是**实验脚手架**（复制即开始）；完整案例在 `examples/12-team.ts`」。
- 检查全文：`rg -n "agent-team" README.md` 只允许出现在指向 `examples/12-team.ts` 的句子里。

- [ ] **步骤 3：`docs/GETTING-STARTED.md`**

`:42-46`、`:121-125`、`:183-185` 三处命令块与说明：
- 第一篇命令改成 `node demo/lab.ts`（"脚手架"）+ `cp -r demo demo-exp1`（"开始你自己的实验"）；
- agent-team 的引用改成 `examples/12-team.ts`（"完整案例"）；
- 检查 `rg -n "agent-team|demo/env/" docs/GETTING-STARTED.md` 零命中。

- [ ] **步骤 4：`AGENTS.md:88`**

`demo/            安装自检：demo/check.ts（八项，不需要 key）+ demo/agent-team.ts（多 agent 协作写报告）` →
`demo/            实验脚手架（复制即开始实验）：lab.ts（起点）+ agent/（环境）+ check.ts（八项自检）；完整案例在 examples/12-team.ts`

- [ ] **步骤 5：全局失效引用扫描**

```bash
rg -n "demo/agent-team|demo/env/" README.md demo/README.md docs/GETTING-STARTED.md docs/GUIDE.md AGENTS.md
```
预期：零命中（历史档案 `docs/superpowers/{plans,specs}/` 与 `docs/archive/` 例外，属历史记录，不改）。

- [ ] **步骤 6：Commit**

```bash
git add demo/README.md README.md docs/GETTING-STARTED.md AGENTS.md
git commit -m "docs: demo 是实验脚手架（lab.ts），完整案例在 examples/12-team.ts；全文对齐"
```

---

### 任务 7：全链路 + 四条 mutation 复验

**文件：** 无（只验证；发现问题就地修并追加 commit）

- [ ] **步骤 1：干净态全链路**

```bash
rm -rf demo/agent/models.json demo/agent/models-store.json demo/agent/settings.json demo/work demo-exp1
npx tsc --noEmit && echo "tsc OK"
npm test 2>&1 | rg "^ℹ (tests|pass|fail)"
node demo/lab.ts >/dev/null 2>&1; echo "lab exit=$?"
node demo/check.ts >/dev/null 2>&1; echo "check exit=$?"
node examples/12-team.ts >/dev/null 2>&1; echo "12-team exit=$?"
node examples/01-first-agent.ts >/dev/null 2>&1; echo "ex01 exit=$?"
git status --short
```
预期：tsc OK；`tests 144 / pass 144 / fail 0`；四个脚本 exit 0；`git status` 干净。

- [ ] **步骤 2：规模上限**

```bash
wc -l demo/lab.ts demo/env.ts    # 预期 ≤200 / ≤45
```

- [ ] **步骤 3：S1「复制即用」+ 环境跟着走**

```bash
cp -r demo demo-exp1
node demo-exp1/lab.ts 2>&1 | rg "agentDir|环境" | head -3
ls demo-exp1/agent | tr '\n' ' '
```
预期：打印的路径含 `demo-exp1`；`demo-exp1/agent/` 里能看到 `skills/`、`extensions/`、`README.md`（环境真的被复制过来了）。

- [ ] **步骤 4：S1 的判别力（S2 反向 mutation）**

```bash
cp demo/env.ts /tmp/env.ts.bak
sed -i 's#join(import.meta.dirname, "agent")#join("D:/space/aiteam/test/demo", "agent")#' demo/env.ts
node demo-exp1/lab.ts 2>&1 | rg "agentDir" | head -2      # 预期：指向原 demo ⇒ 副本用错环境
cp /tmp/env.ts.bak demo/env.ts
node demo-exp1/lab.ts 2>&1 | rg "agentDir" | head -2      # 预期：又回到 demo-exp1
git status --short                                        # env.ts 必须已还原
```

- [ ] **步骤 5：S3 / S4**

```bash
mv demo/agent/skills/env-style/SKILL.md /tmp/SKILL.md
node demo/lab.ts >/dev/null 2>&1; echo "S3 lab exit=$?（预期 0）"
mv /tmp/SKILL.md demo/agent/skills/env-style/
mv demo/agent/extensions/env-tools.ts /tmp/
node demo/check.ts 2>&1 | rg "^\[7/8\]"     # 预期：… 失败
mv /tmp/env-tools.ts demo/agent/extensions/
node demo/check.ts 2>&1 | rg "^\[7/8\]"     # 预期：… 通过
```

- [ ] **步骤 6：清场 + Commit（若有修正）**

```bash
rm -rf demo-exp1 demo/agent/models-store.json demo/agent/settings.json
git status --short
```
若步骤 1–5 里做过修正：`git add -A && git commit -m "demo: 全链路复验后的修正"`。否则无 commit。

---

## 交付后

- 第一入口 = `node demo/lab.ts`（≤200 行）；「开始你自己的实验」= `cp -r demo demo-exp1`。
- 完整案例 = `examples/12-team.ts`（原 agent-team，逻辑未改）；环境自检 = `demo/check.ts`。
- 环境 = `demo/agent/`，跟着 demo 一起被复制；规范 = `demo/agent/README.md`。
- 库 API 未动；差异③ 仍封存。
- **本计划取代** `2026-10-04-demo-first-window.md` 的任务 7/8（那份计划的任务 1–6 成果保留并在本计划中延续）。
