# 计划 2：examples / demo / docs 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `aiteam` 被别人用起来——能看懂（`docs/`）、能上手（`examples/`）、能在陌生机器上一键验证装好了（`demo/`）。

**架构：** 计划 1 已交付七面库（114 例测试、零政策）。本计划不新增库能力，只做三件交付物 + 一次清理：`examples/` 是**一事一文件**的最小演示（含 v1 三个假设的「待检验」版本）；`demo/` 是**完整例子 + 安装自检**（多 agent 协作写报告）；`docs/` 重写并把 `examples/` 的优质片段抽成可编译模块；`audit/` 整目录删除。

**技术栈：** TypeScript（Node 24 原生跑 `.ts`，`erasableSyntaxOnly`）、`node:test`、`@earendil-works/pi-coding-agent@0.99.1`。

**规格：** [`docs/superpowers/specs/2026-10-03-plan2-examples-docs-demo.md`](../specs/2026-10-03-plan2-examples-docs-demo.md) —— 执行者两份都读。

---

## 全局约束

- 依赖版本固定 `@earendil-works/pi-coding-agent@0.99.1`（lockfile 钉住）；类型**一律从 pi 直接 import，不自己重定义**。
- **不新增库能力**：若发现契约缺陷，只修缺陷、不加面；`src/agent/types.ts` 除非明确授权不得改。
- **L1 不做任何 SDK 已经做了的事。**
- `examples/` 与 `demo/` 默认**离线假 provider**：`PI_OFFLINE=1`，零 API 成本、无需真 key。
- Node 24 原生跑 `.ts`（`erasableSyntaxOnly`：无 enum / namespace / 参数属性）。
- 提交：Conventional Commits + 中文描述。
- **断言/演示必须有判别力**：计划 1 出过 4 次假测试（恒绿的、空函数体的、换「它自己」不可区分的、靠 pi 自带文案满足的）。凡声称「跑通即证明 X」，要能被别人独立复现。
- `demo/env/` 与 `demo/work/` **不进 git**（前者含真实 API 密钥，已被 `.gitignore` 排除）。

## 审查重点（Review Focus）

规格隐含、但没有任务测试覆盖到，最可能伤到使用者的五类：

1. **示例代码在别人机器上跑不起来**：示例依赖本机 `~/.pi/agent/` 的真实凭证或已装好的环境 ⇒ 期望：示例自己造环境（临时 `agentDir`），不读宿主状态。
2. **文档片段与库脱节**：`GUIDE.md` 里的代码是手抄的、编译不过 ⇒ 期望：片段抽成 `examples/lib/snippets.ts`，`tsc` 会报错。
3. **demo 自检「假通过」**：自检只打「成功」却没验证任何东西（例如没验证工具真被模型调用）⇒ 期望：每一项都有可失败的判据。
4. **demo 自检失败时无法诊断**：只打「失败」⇒ 期望：打哪一步、原始错误、最可能的三个原因。
5. **v1 假设被误读为库功能**：`examples/09-11` 看起来像在推荐「花名册/红线」⇒ 期望：文件头明确标注【假设】+ 一条具体的改法。

---

### 任务 1：清理 audit/ 与 demo 残留

**文件：**
- 删除：`audit/`（整目录，208 文件 / 3.7M）
- 删除：`demo/work/`（v1 产物）
- 修改：`.gitignore`（去掉 `!demo/work/AGENTS.md` 例外行）
- 修改：`AGENTS.md`（仓库地图去掉 `audit/` 行，见任务 8）

- [ ] **步骤 1：确认 audit/ 全在 git 里（可找回）**

运行：`git ls-files audit | wc -l`
预期：`204`（另有 4 个未跟踪）。若显著少于 204，**停下来问**——说明有内容不在版本控制里，删了就真没了。

- [ ] **步骤 2：确认 demo/env 的密钥不会被提交**

运行：`git check-ignore -v demo/env/auth.json demo/work/report.md`
预期：两条都命中 `.gitignore`。若不是，**停下来问**。

- [ ] **步骤 3：删除**

```bash
git rm -r --quiet audit/
git rm -r --quiet demo/work/
```

- [ ] **步骤 4：清理 .gitignore 的例外行**

去掉 `!demo/work/AGENTS.md`（`demo/work/` 整个不进仓库了，例外行失去意义）。

- [ ] **步骤 5：验证测试与 typecheck 不受影响**

运行：`npm test 2>&1 | tail -4 && npm run typecheck`
预期：`tests 114 / pass 114 / fail 0`；typecheck 无输出。（`audit/` 不在 `tsconfig.include` 里，删除不影响编译。）

- [ ] **步骤 6：Commit**

```bash
git add -A
git commit -m "chore: 删除 audit/ 与 demo 残留产物

audit/ 是 v1 期能力与极限审计（208 文件 / 3.7M：115 个探测脚本 + 20+ 份 FINDINGS）。
库的机制层已在 v2 重写，其结论多数不再成立，保留会误导。
需要时从 git 历史 043dea3 检出。

demo/work/* 是 v1 跑出来的产物；demo/env/auth.json 含真实 API 密钥（已被 gitignore 排除）。"
```

---

### 任务 2：`examples/lib/snippets.ts` —— 优质代码片段的唯一真源

**文件：**
- 创建：`examples/lib/harness.ts`（离线假环境，供全部示例复用）
- 创建：`examples/lib/snippets.ts`（**优质片段**：每个面一小段「正确用法」）
- 修改：`tsconfig.json`（`include` 加 `"examples"`）

**Interfaces：**
- 产出：`examples/lib/harness.ts` 导出 `makeOfflineAgent(spec?: AgentInit): Promise<Agent>`、`FAUX_MODEL_REF`、`FAUX_MODEL_ALT_REF`、`tmpCwd()`。
- 产出：`examples/lib/snippets.ts` 导出 `snippets: Record<string, string>`——**键是片段名，值是源码文本**，供 `GUIDE.md` 逐字引用。
- 产出：`snippets.ts` 里每个片段同时以**真函数**形式导出（`export async function ioPrompt(...)` 等），保证它们**真的能编译**。

- [ ] **步骤 1：写 `examples/lib/harness.ts`**

复用 `test/faux-server.ts` + `test/faux-models.ts` 的写法（**读它们，不要重写**），但：
- 落在 `examples/lib/` 下，**不 import `test/`**（示例不该依赖测试代码的路径）；把需要的那两个文件**照抄**成 `examples/lib/faux-server.ts` / `examples/lib/faux-models.ts` 并去掉测试专用导出；

  > 若你发现照抄产生大量重复，**停下来问**——替代方案是让 `examples` 依赖 `test/` 的相对路径（但 `tsconfig` 会把两者都编进去，可行）。这是本任务唯一留给实现者的判断。

- `makeOfflineAgent` 必须：设置 `PI_OFFLINE=1`、造临时 `agentDir` + `cwd`、默认 `model: FAUX_MODEL_REF`，签名与 `test/helpers.ts:makeAgent` 一致。

- [ ] **步骤 2：写 `examples/lib/snippets.ts`**

每个面一个片段。**注释要讲「为什么这样写」，不是「这行做了什么」**——这是「优质」的定义。至少覆盖：
`io.prompt / io.queue / io.waitIdle`、`events.on / onAny`、`context.history / override / compact`、`tools.add`（含工厂形式）、`permissions.gate / only`、`extensions.add / skills.add`、`model.set / setThinking`、各面 `raw` 逃生口。

- [ ] **步骤 3：把 `examples` 加进 tsconfig**

修改 `tsconfig.json` 的 `include` 为 `["src", "test", "demo", "examples"]`。

- [ ] **步骤 4：验证能编译**

运行：`npm run typecheck`
预期：无输出。若有错，**修示例**（不许把 `examples` 移出 include）。

- [ ] **步骤 5：Commit**

```bash
git add examples/lib tsconfig.json
git commit -m "feat(examples): 离线假环境 + 优质片段库（文档代码的唯一真源）

snippets.ts 里的片段既作为【真函数】导出（保证编译得过），
又以源码文本形式导出（供 GUIDE.md 逐字引用）—— 漂移的文档比没有文档更坏，
所以让 tsc 在片段与库脱节时立刻报错。
examples 因此进 tsconfig.include（规格 §6.3）。"
```

---

### 任务 3：`examples/01-08` —— 七面最小演示

**文件：**
- 创建：`examples/01-first-agent.ts` … `examples/08-raw-escape.ts`

**Interfaces：**
- 消费：任务 2 的 `makeOfflineAgent`、各面片段。
- 每个文件：`node examples/NN-name.ts` 必须**直接跑起来**并打印可读结果，退出码 0。
- 文件头统一注释块：演示什么、怎么跑、期望看到什么。

- [ ] **步骤 1：逐个写 01–08**

| 文件 | 演示 | 必须打印 |
|---|---|---|
| `01-first-agent.ts` | 起 agent、问一句、拿文本 | `RunResult.text` 与 `usage` |
| `02-events.ts` | 七个归一化事件 | 事件名序列（证明 `on` / `onAny` 都收得到） |
| `03-context.ts` | 读历史 / 本轮覆盖 / 压缩 | `history.length` 前后变化 |
| `04-tools.ts` | 加自定义工具 | `tools.list()` 里它 `active`，且模型声明里有它 |
| `05-permissions.ts` | 审批门 + 白名单 | 门被调用时的 `{name, input}` |
| `06-resources.ts` | 运行期加载扩展与技能 | `extensions.list()` / `skills.list()` 前后对比 |
| `07-model.ts` | 换模型 / 换思考档 | `current.id`、`thinking`、`available` 长度 |
| `08-raw-escape.ts` | `raw` 直通 pi | 说明「这是逃生口，全权、无护栏」 |

- [ ] **步骤 2：逐个跑一遍**

运行：`for f in examples/0*.ts; do echo "=== $f"; PI_OFFLINE=1 node "$f" || echo "FAILED: $f"; done`
预期：八行 `===`，每个都退出码 0。**任何 FAILED 都必须修，不许跳过。**

- [ ] **步骤 3：验证 typecheck**

运行：`npm run typecheck`
预期：无输出。

- [ ] **步骤 4：Commit**

```bash
git add examples
git commit -m "feat(examples): 七个面的最小演示（一事一文件，可直接 node 跑）"
```

---

### 任务 4：`examples/09-11` —— v1 三个假设（标注「待检验」）

**文件：**
- 创建：`examples/09-roster.ts`、`examples/10-spawn.ts`、`examples/11-redline.ts`

**Interfaces：**
- 消费：任务 2 的 harness。
- 每个文件**必须**以此注释块开头（规格 §2.1 的写法，逐字）：

```ts
// ⚠️ 这是一个【假设】，不是推荐做法：
//    「<假设内容>」
//    库不提供它 —— 以下是把它作为使用者代码的一种写法。
//    要检验它，请<一条具体的改法>。
```

- [ ] **步骤 1：写 `09-roster.ts`**

假设：「预定义成员能约束 agent 的行为」。
实现：用 `Map<string, {role, tools}>` 写一张花名册，加一个 `spawn` 工具，让 agent 只能从花名册挑成员。
「要检验它」那行写：**删掉花名册、让 spawn 接受任意 role，跑同一个任务对比结果**。

- [ ] **步骤 2：写 `10-spawn.ts`**

假设：「委派给分身能扩展能力」。
实现：一个 `spawn` 工具，内部 `createAgent` 起子 agent、`await io.prompt`、把结果作为工具返回值；用 `maxDepth` 之类**自己写的**计数器防无限递归（**注意：库不提供护栏，这个计数器是使用者代码**）。
「要检验它」：**把深度上限从 2 改成 1 或去掉，看结果怎么变**。

- [ ] **步骤 3：写 `11-redline.ts`**

假设：「agent 不该能配置 agent」。
实现：给 `spawn` 工具加一段检查——拒绝 `tools` / `model` 之类的配置字段，只允许传 role 与任务。
「要检验它」：**把这段检查注释掉再跑**，观察 agent 会不会自己尝试设计 agent。

> 这三个文件的核心是**那条检查是使用者代码**。若你把它们写成库功能，就是把计划 1 删掉的政策请回来了。

- [ ] **步骤 4：跑一遍 + typecheck**

运行：`for f in examples/09*.ts examples/10*.ts examples/11*.ts; do PI_OFFLINE=1 node "$f" || echo "FAILED: $f"; done && npm run typecheck`
预期：三个都退出码 0；typecheck 无输出。

- [ ] **步骤 5：Commit**

```bash
git add examples
git commit -m "feat(examples): v1 三个假设的「待检验」写法（花名册 / 委派 / 红线）

全部保留，但每条标注【假设】不是推荐做法，并写清「要检验它，请改成 X」。
三者都实现为【使用者代码】—— 库在 v2 不再提供它们，这正是可对照的前提。"
```

---

### 任务 5：`demo/env.ts` + `demo/check.ts` —— 安装自检

**文件：**
- 创建：`demo/env.ts`（幂等自建环境）
- 创建：`demo/check.ts`（**安装自检**：逐步打印、退出码 0/1）
- 创建：`demo/README.md`

**Interfaces：**
- `demo/env.ts` 导出 `ensureEnv(): Promise<{ agentDir: string; cwd: string; baseUrl: string }>`——幂等，已存在则复用。
- `demo/check.ts` 是**可执行入口**：`node demo/check.ts`，退出码 0 = 本机可以开始研究。

- [ ] **步骤 1：写 `demo/env.ts`**

按当前 `models-store.json` / `auth.json` 的**真实结构**写（形状参照 `test/faux-models.ts:writeModelsJson`）。**不读** v1 遗留的 `demo/env/` 内容（结构已变）。

- [ ] **步骤 2：写 `demo/check.ts` 的骨架**

七项自检，**每项必须打印三行**：

```
[1/7] Node 与原生 .ts        … 通过（v24.18.0）
[2/7] pi-coding-agent 可解析 … 通过（0.99.1）
...
```

失败时打印：`哪一步` + `原始错误` + `最可能的三个原因与怎么补`，然后 `process.exit(1)`。

- [ ] **步骤 3：填七项自检**

1. Node 版本与 `.ts` 原生执行；
2. `@earendil-works/pi-coding-agent` 可解析且版本匹配；
3. `agentDir` 可写、模型可读（离线假 provider 可用）；
4. `createAgent` 能起 agent；
5. 一轮 `io.prompt` 能拿到非空文本；
6. **一个工具真被模型调用**（证明工具链通，不是只声明了）；
7. 七个面各自至少一次读写（证明 API 形状与文档一致）。

> 第 6 项的判据必须是「工具的执行体真跑过」（用闭包计数器），**不是**「`tools.list()` 里有它」——后者不判别。

- [ ] **步骤 4：跑通自检**

运行：`PI_OFFLINE=1 node demo/check.ts; echo "退出码=$?"`
预期：七项全「通过」、`退出码=0`。

- [ ] **步骤 5：验证失败路径真的可诊断**

临时把第 5 项的条件改成不可能满足（例如断言文本非空但让它空），跑一次，确认打印出**哪一步 + 原始错误 + 三个原因**，然后**改回来**。

- [ ] **步骤 6：写 `demo/README.md`**

一条命令 + 预期输出（贴真实输出）+ 「失败了怎么办」。

- [ ] **步骤 7：Commit**

```bash
git add demo
git commit -m "feat(demo): 安装自检 —— 一条命令验证本机能否开始研究

目标使用者是没装过 pi、但想研究 agent 课题的人：他需要的第一个东西
不是文档，是「跑通了 ⇒ 我这台机器可以开始了」。
所以验收标准是退出码 0 + 可读结果，失败必须打哪一步/原始错误/三个原因。
第 6 项用闭包计数器判「工具真被执行」—— tools.list() 里有它不判别。"
```

---

### 任务 6：`demo/agent-team.ts` —— 完整例子（多 agent 协作写报告）

**文件：**
- 创建：`demo/agent-team.ts`
- 修改：`demo/README.md`（加这一节的跑法）

**Interfaces：**
- 消费：任务 5 的 `ensureEnv`、任务 2 的 harness 思路（但 demo 走**自己的** env）。
- 产出：产物落在 `demo/work/`（gitignored）。

- [ ] **步骤 1：写分工骨架**

多个 agent 协作产出一份报告（沿用 v1 主题）。**七面各至少出场一次**：

| 面 | 在这个 demo 里干什么 |
|---|---|
| `io` | 每轮 prompt / queue / waitIdle |
| `context` | 检索 agent 用 `override` 压上下文预算 |
| `tools` | 检索工具、写黑板工具 |
| `permissions` | 写作 agent 上装审批门（拦「删除」类操作） |
| `extensions` / `skills` | 按角色加载（写作角色的技能与检索角色不同） |
| `model` | 检索用便宜的、写作用强的（`model.set`） |

- [ ] **步骤 2：每一处设计决策旁写一行「要检验这条，改成 X 再跑」**

至少覆盖：几个 agent、怎么分工、要不要护栏、审批门拦什么。**它不是推荐架构，是可改造的起点。**

- [ ] **步骤 3：跑通并产出报告**

运行：`PI_OFFLINE=1 node demo/agent-team.ts && ls -la demo/work/`
预期：退出码 0；`demo/work/` 里出现报告文件。

- [ ] **步骤 4：验证七面真的都出场了**

在 demo 里加一段**自证**：跑完后打印一张表，列出七面各自被调用了几次；断言每一项 ≥ 1。**若某个面没出场，那是设计缺陷，修设计而不是删断言。**

- [ ] **步骤 5：typecheck + 全套测试**

运行：`npm run typecheck && npm test 2>&1 | tail -4`
预期：无输出；`tests 114 / pass 114 / fail 0`。

- [ ] **步骤 6：Commit**

```bash
git add demo
git commit -m "feat(demo): 多 agent 协作写报告 —— 七面全出场的完整例子

沿用 v1 主题，因为它是唯一一个七面都有出场机会的任务形状
（换小任务会让自检覆盖变虚）。
含自证：跑完打印七面各自的调用次数并断言 ≥1，防「某个面悄悄没出场」。"
```

---

### 任务 7：`docs/DESIGN.md` 重写 + v1 归档

**文件：**
- 创建：`docs/archive/DESIGN-v1.md`（从 `docs/DESIGN.md` 移入，顶部加归档横幅）
- 重写：`docs/DESIGN.md`

- [ ] **步骤 1：归档 v1**

`git mv docs/DESIGN.md docs/archive/DESIGN-v1.md`，在文件顶部加：

```markdown
> **归档**：这是 **v1** 的宏观设计，已被 v2 取代（[`../DESIGN.md`](../DESIGN.md)）。
> 保留它以理解演进：v1 把花名册 / 内置工具 / 护栏 / 红线都放在库里，v2 全部移出。
```

- [ ] **步骤 2：写 v2 的 `DESIGN.md`**

必须覆盖（**讲「为什么」，不是复述实现**）：
1. 一句话：库是什么（七面 + 零政策）与研究工具的定位；
2. 三个概念在 v2 里的**变化**（花名册/红线已不是库的一部分，而是使用者代码——指向 `examples/09-11`）；
3. 七个面各自的**职责边界**（谁负责机制、谁负责政策）；
4. 结算边界（`agent_start` → `agent_settled`）与 `RunResult` 的归属单位；
5. 48 条裁决里**影响使用者**的那些的「为什么」（R26 槽位顺序、R29 单一忙判据、R37/R43/R44 三档优先级、R41 显式声明总生效、R47 非对象真值抛错、R48 dispose 后全拒绝）；
6. 明确不做的（规格 §9）。

- [ ] **步骤 3：验证文档里的代码能编译**

`DESIGN.md` 里如出现代码块，**必须**来自 `examples/lib/snippets.ts` 或 `examples/*.ts`。运行：`npm run typecheck`（若片段是手抄的，这一步抓不到——所以**引用文件路径**，不手抄）。

- [ ] **步骤 4：Commit**

```bash
git add docs
git commit -m "docs: DESIGN.md 重写为 v2 + v1 归档到 docs/archive/"
```

---

### 任务 8：`docs/GUIDE.md` + `AGENTS.md` 更新

**文件：**
- 重写：`docs/GUIDE.md`
- 修改：`AGENTS.md`

- [ ] **步骤 1：写 `GUIDE.md`**

面向设计者：每个面怎么用。**每个面的代码必须引用 `examples/lib/snippets.ts` 的同源片段**（规格 §6.1）——用「见 `examples/04-tools.ts`」这类指针，不手抄。

- [ ] **步骤 2：更新 `AGENTS.md`**

- 仓库地图：去掉 `audit/` 行（任务 1 已删）、补 `src/surfaces/`（R23）、补 `examples/` 与 `demo/`；
- 「三个概念」表格：改述——**花名册 / 红线已不是库的一部分**（v2 里是使用者代码，见 `examples/09-11`）；
- 「库有什么」一节：改为七个面。

- [ ] **步骤 3：核对文档与代码现实**

逐条核对 `AGENTS.md` 里的每个路径都存在。运行：
`for p in $(grep -oE '`[a-z/]+/[a-z-]+\.(ts|md)`' AGENTS.md | tr -d '\`' | sort -u); do [ -e "$p" ] || echo "缺失: $p"; done`
预期：无输出。

- [ ] **步骤 4：全套验证**

运行：`npm run typecheck && npm test 2>&1 | tail -4 && PI_OFFLINE=1 node demo/check.ts`
预期：typecheck 无输出；`tests 114 / pass 114 / fail 0`；自检七项通过、退出码 0。

- [ ] **步骤 5：Commit**

```bash
git add docs AGENTS.md
git commit -m "docs: GUIDE.md 重写（引用 snippets 同源片段）+ AGENTS.md 跟上 v2 现实

AGENTS.md 修两处漂移：仓库地图补 src/surfaces/（R23）、去掉已删的 audit/；
三个概念表格改述 —— 花名册与红线在 v2 里是使用者代码（examples/09-11），不是库功能。"
```

---

## 自检

**1. 规格覆盖度**

| 规格章节 | 任务 |
|---|---|
| §1 分工 | 全局约束 + 任务 2/3/5/6 |
| §2 examples（含 2.1 三假设、2.2 离线） | 任务 2/3/4 |
| §3 demo（含 3.2 适配点、3.3 形态） | 任务 5/6 |
| §4 docs | 任务 7/8 |
| §5 明确不做（audit 整删） | 任务 1 |
| §6.1 snippets | 任务 2 |
| §6.2 多 agent 协作写报告 | 任务 6 |
| §6.3 examples 进 tsconfig | 任务 2 步骤 3 |

无遗漏。

**2. 步骤扫描**：每个步骤都给出了确切命令与可检查结果。任务 2 步骤 1 与任务 4 步骤 1/2 留了实现者判断（照抄 vs 引用测试代码；花名册的具体数据结构），都写明了「停下来问」或「要检验它」——这是有意的，因为那些是**研究设计选择**，不该由计划拍死。

**3. 类型一致性**：`makeOfflineAgent(spec?: AgentInit): Promise<Agent>`（任务 2）在任务 3/4 一致消费；`ensureEnv(): Promise<{agentDir, cwd, baseUrl}>`（任务 5）在任务 6 一致消费。均与 `src/agent/types.ts` 的 `AgentInit` / `Agent` 一致。

**4. 审查重点**：五条全部落进任务——①示例自造环境（任务 2 步骤 1）②片段进 tsc（任务 2 步骤 3/4）③自检第 6 项用闭包计数器（任务 5 步骤 3）④失败路径实测（任务 5 步骤 5）⑤【假设】标注逐字（任务 4 Interfaces）。

**5. 比例**：本计划约 330 行，规格约 120 行，任务是命令与判据的清单而非代码抄本（只有任务 4 的注释块是真需要逐字的）。
