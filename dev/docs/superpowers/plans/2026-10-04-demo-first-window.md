# demo 第一窗口 + 真实环境目录 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 `demo/` 从「安装自检」改造成「这个 agent 操控库的第一窗口」，并把环境从「脚本用字符串生成的 gitignored 产物」改成「仓库里看得见、可手改的 `demo/agent/` 目录（= agentDir）」，同时留下第一份环境规范。

**架构：** `demo/agent/` 成为唯一 agentDir，技能与扩展是仓库里的真文件（进 git），只有 `models.json`（假 provider 端口随机）与 `auth.json`（你的 key）等动态文件是 gitignored。`demo/env.ts` 从「seed 一堆字符串」缩成「起假 provider → 写一个 models.json」或「把凭证放进 agent 目录」。`demo/README.md` 重排：第一屏 agent-team，check 降为「附加：环境自检」。

**技术栈：** TypeScript（Node 原生 `.ts` 直跑）、本机假 provider（零 API 成本）、`node:test`（本计划不新增测试文件，靠既有 144 项 + demo/check 八项 + 4 条 mutation 判据）。

**规格：** [`docs/superpowers/specs/2026-10-04-demo-first-window-design.md`](../specs/2026-10-04-demo-first-window-design.md)（**执行者必须两份都读**；规格里有每个决定的理由与被否决的替代方案）

## 全局约束

- **不动库 API**（`src/` 除 `create-agent.ts:55` 的一行注释外不改）；**不动 examples**（除 `examples/lib/harness.ts` 一句注释）；**不动 `docs/DESIGN.md`**。
- **不建 `docs/ENVIRONMENT.md`**；环境规范长在 `demo/agent/README.md`。
- demo 的**所有脚本必须在「新 clone」与「删掉全部 gitignored 动态文件」两种情形下退出码 0**。
- 凭证只放 `demo/agent/auth.json`（gitignored）；**不碰宿主 `~/.pi/agent`**（pi 的 auth 存储是读-改-写整个文件，历史事故见 `demo/README.md`）。
- 文案一律中文，失败必须带「最可能的三个原因与怎么补」。
- 每个任务收尾：`npx tsc --noEmit` 干净 + `npm test` 144 pass。

## 审查重点（Review Focus）

1. **`env-tools.ts` 进了 tsc 范围**（`tsconfig.json` 的 `include` 含 `demo`，现在只靠 `exclude: ["demo/run"]` 躲开）—— 无类型标注的 `(pi)` 会让 `strict` 编译失败。→ 任务 1 步骤 2 的 `npx tsc --noEmit`。
2. **迁移路径只能触发一次、且不许吞掉源文件**：`demo/env/auth.json`（含真实 key）必须被**复制**、不是移动；源文件保留。→ 任务 4 步骤 1/6 的两种断言（有遗留 ⇒ 复制；无遗留 ⇒ 不报错）。
3. **删掉 `demo/agent/skills/` 后 agent-team 仍须退出码 0**（环境加料不是必需品）。→ 任务 5 步骤 5 的 mutation M4。
4. **两份 README 的实录必须与实跑逐字一致**（路径 / 技能列表 / `extensions=N` / 工具白名单 / 七面计数）。→ 任务 7 步骤 2 的逐行 diff。
5. **跑完不出现未跟踪垃圾**：`git status --short` 必须干净（新写进 `demo/agent/` 的动态文件都必须被 gitignore 覆盖）。→ 任务 3 步骤 3。

---

### 任务 1：把环境资源变成仓库里的真文件

**文件：**
- 创建：`demo/agent/skills/env-style/SKILL.md`
- 创建：`demo/agent/extensions/env-tools.ts`
- 修改：`tsconfig.json:28`（`exclude` 注释）
- 修改：`demo/env.ts`（**只**删 `seedOwnResources` 与它的两处调用；`envDir()` / 真实路径改动留到任务 3，任务 4，任务 5 会短命一次）

- [ ] **步骤 1：创建两个真文件**

`demo/agent/skills/env-style/SKILL.md` —— 内容**逐字**取 `demo/env.ts:132-150` 那个数组 `join("\n")` 的结果（`---` frontmatter + `name: env-style` + 那句 description + 正文三条 + 「要检验它有没有生效」那段）。取法：读 `demo/env.ts`，把那两段数组原样抄成文件，**不要**再抄一遍字符串转义。

`demo/agent/extensions/env-tools.ts` —— 内容取 `demo/env.ts:158-196` 那段数组，但做三处改造：

```ts
// demo 环境自带的扩展：只在这个 agentDir 里，因此能证明「环境自动发现」这条路是通的。
// 它注册的工具名**不会**被并入 `permissions.only` 白名单（R41）—— 所以只在没写 only 的
// agent 上可见。demo 里的写作员正是没写 only 的那个，它用这个工具给报告加一份「交付清单」。
//
// 类型注解不是装饰：这个文件在 tsconfig 的 include 范围内（demo/），无注解的 (pi) 在 strict 下编译不过。
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "env_checklist",
      label: "Env Checklist",
      description: "给报告追加一份交付清单（由环境扩展提供，不在 spec 里声明）。参数 items 是要列出的条目。",
      parameters: Type.Object({ items: Type.Array(Type.String()) }),
      execute: async (_id, p) => ({
        content: [
          {
            type: "text",
            text: [
              "交付清单：",
              ...p.items.map((x, i) => `  ${i + 1}. ${x}`),
              "（这一份由环境扩展 env-tools.ts 提供 —— 它不在 spec 的 extensions 里）",
            ].join("\n"),
          },
        ],
        details: {},
      }),
    }),
  );
}
```

（`ExtensionAPI` 从 `@earendil-works/pi-coding-agent` 导出，已核实：`dist/index.d.ts:8` 的 type 导出列表里有它。原来那段 `const NL = String.fromCharCode(10)` 是字符串转义技巧，改成真文件后直接用 `"\n"`。）

- [ ] **步骤 2：验证 tsc 仍然干净，且新文件真的在类型检查范围内**

运行：`npx tsc --noEmit`
预期：无输出。
再运行（判别力检查，必须看到错误）：`git stash push demo/agent/extensions/env-tools.ts && npx tsc --noEmit; git stash pop`
预期：看不到错误（因为文件被移走了）。**反过来验**：手工把 `(pi: ExtensionAPI)` 临时改成 `(pi)` 再 `npx tsc --noEmit`，**必须**报 implicit any —— 确认这个文件真的被检查（确认后改回来）。

- [ ] **步骤 3：从 `demo/env.ts` 删除 `seedOwnResources`**

删掉整个 `seedOwnResources` 函数（含它上面 10 行注释）与它的两处调用（`setupReal` 里 `seedOwnResources(agentDir);` 那一行、`setupFaux` 里的那一行）。**不要**动 `demo/env.ts` 的其他部分 —— 路径切换到 `demo/agent/` 是任务 4 的事。

- [ ] **步骤 4：运行验证**

运行：`npx tsc --noEmit && npm test 2>&1 | tail -6`
预期：typecheck 无输出；`pass 144 / fail 0`。

- [ ] **步骤 5：不动 `tsconfig.json`**

`exclude` 里的 `demo/run` **保持原样**（旧 checkout 的残留可能还在，里面是无类型的 seed 扩展）。JSON 不允许注释，所以「为什么还留着它」写进 `demo/README.md` 的目录说明表里（任务 7 的步骤 1），不写进 tsconfig。

- [ ] **步骤 6：Commit**

```bash
git add demo/agent/skills/env-style/SKILL.md demo/agent/extensions/env-tools.ts demo/env.ts
git commit -m "demo(env): skills/extensions 从 env.ts 的字符串变成仓库里的真文件（demo/agent/）"
```

---

### 任务 2：环境规范 `demo/agent/README.md`

**文件：**
- 创建：`demo/agent/README.md`

- [ ] **步骤 1：写规范**

结构（每节都要有实质内容，不许写「待定」）：

1. **一句话**：这个目录**就是** `createLab({ agentDir })` 的那个 `agentDir`；配套的 `cwd` 是 `../work/`。「环境即目录、目录即配置」。
2. **一档一行的表**：`auth.json`（真模式凭证 · gitignored · 谁写：你或 `AITEAM_DEMO_AUTH`）／`models.json`（假模式 provider 地址与两个模型 · gitignored · 谁写：`env.ts`，因为假 provider 端口随机）／`models-store.json`（模型目录缓存 · gitignored · pi 在真模式联网时写）／`settings.json`（pi 会 ensure，值全默认 · gitignored）／`skills/<名>/SKILL.md`（进 git · 技能是被**发现**的，名字来自 frontmatter 的 `name`）／`extensions/<名>.ts`（进 git · `export default (pi: ExtensionAPI) => …`）／`SYSTEM.md`（**本目录不放**）／`APPEND_SYSTEM.md`（本目录不放）。
3. **为什么不放 `SYSTEM.md`**：它会**整体替换**系统提示词（连 `<tools>` / `<rules>` 段一起消失），会把 agent-team 的报告与 check 第 7 项的判据一起弄失真；这一档存在且有这个后果，要演示它得单独开一个环境。
4. **怎么自己改**三条：加技能 / 加扩展 / 换凭证。
5. **两条环境事实**：R41（环境自动发现的扩展，其工具名**不并入** `permissions.only` 白名单）；`agentDir`（身份与装备）vs `cwd`（在哪干活）。
6. **两种模式共用一个环境目录的已知代价**：假模式跑过会留下 `models.json`；真模式的 `auth.json` 会让假模式的 `lab.inspectEnv()` 多列一个 provider —— **只影响打印，不影响任何断言**。

- [ ] **步骤 2：验证文件没有失效引用**

运行：`rg -n "demo/run|demo/env/" demo/agent/README.md`
预期：无命中（这份文档只讲 `demo/agent/` 与 `demo/env/` 的**遗留**位置，后者要写就明说是遗留）。

- [ ] **步骤 3：Commit**

```bash
git add demo/agent/README.md
git commit -m "docs(demo): 环境规范 —— demo/agent 每一档管什么、哪些能删、为什么不放 SYSTEM.md"
```

---

### 任务 3：`.gitignore` 覆盖新环境的动态文件

**文件：**
- 修改：`.gitignore`

- [ ] **步骤 1：加四行 + 保留两行并注释**

在 `# demo 的**配置源**：你自己的凭证与模型目录缓存（gitignored，不进仓库）` 那两行下面追加：

```gitignore
# demo 环境（demo/agent 就是 agentDir）：只有动态文件不进仓库，技能与扩展是仓库里的真文件
demo/agent/auth.json
demo/agent/models.json
demo/agent/models-store.json
demo/agent/settings.json

# 遗留：v1 的配置源目录与 v2 早先的运行产物目录（旧 checkout 可能还在，仍可能含 key，保留忽略）
demo/env/*
demo/run/
```

（即：原来的 `demo/env/*` 与 `demo/run/` 两行**保留**，只是挪到新注释下。）

- [ ] **步骤 2：验证 gitignore 与清单一致**

运行：
```bash
git check-ignore -v demo/agent/auth.json demo/agent/models.json demo/agent/models-store.json demo/agent/settings.json
git ls-files demo/agent
```
预期：前一条四行都命中（各自打印匹配的规则）；后一条只列出 `demo/agent/README.md`、`demo/agent/skills/env-style/SKILL.md`、`demo/agent/extensions/env-tools.ts`（任务 1/2 已经 commit）。

- [ ] **步骤 3：Commit**

```bash
git add .gitignore
git commit -m "chore(gitignore): demo/agent 的动态文件不入库；保留 demo/env 与 demo/run 的旧忽略"
```

---

### 任务 4：`ensureEnv()` —— agentDir 换成 `demo/agent/`，只写一个动态文件

**文件：**
- 修改：`demo/env.ts`（顶部 33 行注释 + `DemoEnv.agentDir` 注释 + `setupReal()` + `setupFaux()` + 删 `envDir()/runDir()`）

- [ ] **步骤 1：先写失败的验证**（三段式，跑之前先确认现在会失败）

运行：`node demo/check.ts 2>&1 | head -8`
预期：现在**通过**（旧结构还在）—— 这是基线。记录 `agentDir=` 现在的值是 `demo\run\faux`。改完这个任务后它必须变成 `demo\agent`。

- [ ] **步骤 2：改路径与 `setupFaux`**

```ts
/** 环境目录（**就是 agentDir**）：`demo/agent/` —— 技能与扩展是仓库里的真文件，见该目录的 README */
const agentDir = (): string => join(import.meta.dirname, "agent");
/** 工作目录与产物落点：`demo/work/` */
const workDir = (): string => join(import.meta.dirname, "work");
```

`setupFaux()` 变成：

```ts
async function setupFaux(): Promise<DemoEnv> {
  const cwd = workDir();
  const dir = agentDir();
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const faux = await startFaux();
  // 两个模型：echo 给普通轮次，echo-alt（reasoning:true）给 setThinking 这类要合法档位的检查
  writeModelsJson(dir, faux.baseUrl, [FAUX_MODEL_ID, FAUX_MODEL_ALT_ID]);
  return { agentDir: dir, cwd, baseUrl: faux.baseUrl, real: false, model: FAUX_MODEL_REF, altModel: FAUX_MODEL_ALT_REF };
}
```

（删掉原来的 `const agentDir = join(runDir(), "faux")` 与 `seedOwnResources(agentDir)` 那一行。）

- [ ] **步骤 3：改 `setupReal()`**

```ts
async function setupReal(): Promise<DemoEnv> {
  const cwd = workDir();
  const dir = agentDir();
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });

  const target = join(dir, "auth.json");
  if (!existsSync(target)) {
    // AITEAM_DEMO_AUTH 优先级最高；否则用环境目录里那份；再否则迁移 v1 遗留的 demo/env/auth.json
    const explicit = process.env.AITEAM_DEMO_AUTH;
    const legacy = join(import.meta.dirname, "env", "auth.json");
    const source = explicit ?? (existsSync(legacy) ? legacy : undefined);
    if (!source || !existsSync(source)) {
      throw new Error(
        `真模式需要 demo 自己的凭证，但三处都没有：\n` +
          `  · ${target}（推荐：把 auth.json 放这里，gitignored）\n` +
          `  · 或 AITEAM_DEMO_AUTH=/path/to/auth.json\n` +
          `  · 或干脆不设 AITEAM_DEMO_REAL，跑离线假 provider（默认，零成本）\n` +
          `  · 注意：别指向宿主 ~/.pi/agent —— pi 会整文件写回，把那里别的 provider 凭证抹掉`,
      );
    }
    copyFileSync(source, target);
    if (source === legacy) {
      console.log(`[demo] 已把凭证从 demo/env/auth.json 迁到 demo/agent/auth.json（原文件保留，可自行删除）`);
    }
  }
  return { agentDir: dir, cwd, real: true, model: REAL_MODEL_REF, altModel: REAL_MODEL_REF };
}
```

（删掉原函数体里的 `source` / `copyIfAbsent(env/auth.json)` / `copyIfAbsent(models-store.json)` / `copyIfAbsent(settings.json)` / `seedOwnResources` 五段 —— 后三样由 pi 自己管，`:47` 的注释里交代。）

- [ ] **步骤 4：重写文件头注释（第 1-33 行）**

必须写清：两种模式**共用一个** `demo/agent/`；哪些文件是仓库里的真文件、哪些是动态的（三行表即可）；`demo/env/` 与 `demo/run/` 是**遗留**；两条血教训（不碰宿主、不借宿主 key）；以及一句「为什么 `models.json` 只能生成」（假 provider 端口随机）。

- [ ] **步骤 5：删掉 `envDir()` / `runDir()` / `copyIfAbsent`**

三个都不再被引用（`rg -n "envDir|runDir|copyIfAbsent" demo/` 必须零命中，否则删漏了）。

- [ ] **步骤 6：运行验证**

```bash
rm -rf demo/agent/models.json demo/agent/auth.json demo/work
node demo/check.ts 2>&1 | head -12          # 预期 agentDir 与 cwd 都指向 demo/agent 与 demo/work，八项全过
ls demo/agent                                 # 预期：README.md、skills/、extensions/、models.json（脚本刚写的）
AITEAM_DEMO_AUTH=/nonexistent node demo/check.ts 2>&1 | head -6   # 预期：明确报错、四条出路（不许静默）
```

有遗留凭证时的迁移路径：

```bash
rm -f /tmp/auth-backup.json
cp demo/env/auth.json /tmp/auth-backup.json 2>/dev/null || true
if [ -f demo/env/auth.json ]; then rm -f demo/agent/auth.json; AITEAM_DEMO_REAL=1 node demo/check.ts 2>&1 | head -3; else echo "（本机无遗留凭证，跳过迁移验证）"; fi
if [ -f /tmp/auth-backup.json ]; then cmp /tmp/auth-backup.json demo/env/auth.json && echo "源文件未被改动 ✓"; fi
```

预期：打印那行「已把凭证从 demo/env/auth.json 迁到 …」，且 `demo/env/auth.json` 逐字节未变。

- [ ] **步骤 7：Commit**

```bash
git add demo/env.ts
git commit -m "demo(env): agentDir 换成 demo/agent；凭证迁到 demo/agent/auth.json；只生成 models.json"
```

---

### 任务 5：跑通 agent-team，并用 mutation 证明环境判据是活的

**文件：**
- 修改：`demo/agent-team.ts`（注释里的路径 ×4，不改逻辑）

- [ ] **步骤 1：改注释里的路径**

逐处（约 4 / 15 / 448-450 / 720 行）：`demo/env.ts 钉死` → `demo/env.ts 钉死`（不变，文件还在）；`删掉 demo/run/*/skills/env-style/SKILL.md` → `删掉 demo/agent/skills/env-style/SKILL.md`；`demo/env.ts 里 seed 的 env-style` → `demo/agent/skills/env-style/SKILL.md（环境里那份真文件）`。运行 `rg -n "demo/run" demo/agent-team.ts` 预期零命中。

- [ ] **步骤 2：跑它**

```bash
rm -rf demo/work && node demo/agent-team.ts
```
预期：退出码 0；`[1]` 段打印 `agentDir = <repo>\demo\agent`；`[2]` 段检索员技能含 `env-style`；`[6]` 段七面全部 ≥ 1。

- [ ] **步骤 3：mutation M1（技能是软约束）**

```bash
mv demo/agent/skills/env-style/SKILL.md /tmp/  && node demo/agent-team.ts >/tmp/no-skill.txt 2>&1; mv /tmp/SKILL.md demo/agent/skills/env-style/
rg -c "依据：" demo/work/report.md ; rg -c "依据：" /tmp/no-skill.txt
```
预期：删掉技能后报告里**不再有**「依据：」行（或被明确跳过）；恢复后回来。取证方式以实际输出为准（若 agent-team 在缺技能时直接不写那行，就看 `report.md`）。

- [ ] **步骤 4：mutation M3（隔离判据是活的）**

```bash
cp demo/env.ts /tmp/env.ts.bak
# 把 agentDir() 临时改成宿主目录，跑 check 第 7 项
sed -i 's#join(import.meta.dirname, "agent")#join(process.env.HOME ?? "", ".pi", "agent")#' demo/env.ts
node demo/check.ts 2>&1 | sed -n '/7\/8/p'
cp /tmp/env.ts.bak demo/env.ts
```
预期：第 7 项**红**（「demo 的 agentDir 就是宿主 pi 目录」）。恢复后第 7 项绿。

- [ ] **步骤 5：mutation M4 / M2**

M4：`mv demo/agent/skills /tmp/skills-bak && node demo/agent-team.ts; echo $?; mv /tmp/skills-bak demo/agent/skills`
预期：**仍然退出码 0**（技能是环境加料，不是必需品）。**若为红**：说明 agent-team 硬依赖了这份加料 —— 把它改成创建期 `skills` 显式声明（`agent-team.ts:452` 已有同样写法可参照），然后重跑。

M2：`mv demo/agent/extensions/env-tools.ts /tmp/ && node demo/check.ts 2>&1 | sed -n '/7\/8/p'; mv /tmp/env-tools.ts demo/agent/extensions/`
预期：第 7 项**红**（看不到自己的扩展 env-tools）。

- [ ] **步骤 6：Commit**

```bash
git add demo/agent-team.ts
git commit -m "demo(team): 注释里的环境路径跟着迁移；mutation M1/M2/M3/M4 已验"
```

---

### 任务 6：`demo/check.ts` —— 只改文案，判据一行不动

**文件：**
- 修改：`demo/check.ts`（注释与 hints 里的路径，约 204/206/233/293/360-362 行）

- [ ] **步骤 1：逐处替换**

| 行（约） | 原文 | 改成 |
|---|---|---|
| 204 | `` `demo/run/` 不可写（权限位、只读挂载、杀软拦住新建目录）`` | `` `demo/agent/` 不可写（权限位、只读挂载、杀软拦住新建目录）`` |
| 206 | `` 删掉 `demo/run/` 整个目录再重跑，ensureEnv 会重建 `` | `` 删掉 `demo/agent/models.json` 与 `demo/work/` 再重跑 `` |
| 233 | `` 删 `demo/run/` 再重跑 `` | `` 删 `demo/agent/models.json` 再重跑 `` |
| 293 | `（env.ts 里 seedOwnResources 放进去的那份）` | `（demo/agent/ 里那份真文件）` |
| 360 | `看不到自己的技能/扩展 ⇒ demo/run/ 被手工清过或写失败…` | `看不到自己的技能/扩展 ⇒ demo/agent/ 被清过：skills/env-style/SKILL.md 或 extensions/env-tools.ts 不在磁盘上` |
| 361 | `…检查 demo/env.ts 的 runDir()…` | `…检查 demo/env.ts 的 agentDir()` |
| 362 | `…确认 demo/run/*/skills/env-style/SKILL.md 真在磁盘上` | `…确认 demo/agent/skills/env-style/SKILL.md 真在磁盘上` |

运行 `rg -n "demo/run|seedOwnResources|runDir" demo/check.ts` 预期零命中。

- [ ] **步骤 2：验证判据没被动**

运行：`git diff HEAD --stat demo/check.ts` 预期只动这几处文案（外加注释），**没有任何一行 `if (` / `throw` 逻辑变化。

- [ ] **步骤 3：跑一遍**

```bash
rm -rf demo/agent/models.json demo/work && node demo/check.ts
```
预期：八项全过、退出码 0。

- [ ] **步骤 4：Commit**

```bash
git add demo/check.ts
git commit -m "demo(check): 文案与 hints 指向 demo/agent；判据逻辑一行不动"
```

---

### 任务 7：README 重排 —— agent-team 当第一窗口，check 降为附加

**文件：**
- 修改：`demo/README.md`（整篇结构重排）
- 修改：`README.md`（demo 一节 + 「运行结果的标准」一节）
- 修改：`docs/GETTING-STARTED.md`（`:61`/`:74-75`/`:225-229`）

- [ ] **步骤 1：重排 `demo/README.md`**

按规格 §4.1 的七节顺序。要点：
- 标题 `# demo —— 第一窗口：看这个库能操控什么`；
- 第一屏 `node demo/agent-team.ts` + 四句「看什么」；
- 参考 `docs/` 与 `docs/GETTING-STARTED.md` 里对它的定位，**删掉**「给没装过 pi 的人：先跑这条命令」这类把 check 当第一步的措辞；
- check 一节标题写 `## 附加：环境自检（可选）`，正文第一句说明**用途**：环境出问题时来这查，不是新人的第一步；
- 目录说明表换成新版（`demo/agent/**`、`demo/work/`、`demo/env.ts`、`demo/check.ts`、`demo/agent-team.ts`；遗留的 `demo/env/` 与 `demo/run/` 单列一行说明它们只作为旧 checkout 的残留被忽略）。

- [ ] **步骤 2：重贴两份实录（逐字）**

```bash
rm -rf demo/agent/models.json demo/work
node demo/agent-team.ts > /tmp/at.txt 2>&1 ; echo "exit=$?"
node demo/check.ts      > /tmp/ck.txt 2>&1 ; echo "exit=$?"
```
把两份输出**逐行**贴进 `demo/README.md`（去掉绝对仓库前缀，端口/`history=N` 这类每次不同的值保留本机实际值，并把「这些每次跑都会略不同」的声明保留）。贴完再核对一次关键行：

```bash
rg -n "agentDir = |技能=\[|extensions=|工具白名单=|io            |context       " demo/README.md
```
预期与 `/tmp/at.txt` 的同名行逐字一致。

- [ ] **步骤 3：根 `README.md` 两处**

- demo 一节：`demo/env/auth.json` → `demo/agent/auth.json`；`AITEAM_DEMO_AUTH=/path/to/auth.json` 保留；`demo/run/`（假模式 `demo/run/faux`、真模式 `demo/run/real`）那段 → `demo/agent/` 是环境目录（技能与扩展进仓库、`auth.json`/`models.json` 不入库），`demo/work/` 是产物。
- 「运行结果的标准」一节：开头改成承认**两个**命令（`node demo/agent-team.ts` 是第一窗口、`node demo/check.ts` 是环境自检），并把 `120 项测试` 改成实数（`npm test` 实际输出）。

- [ ] **步骤 4：`docs/GETTING-STARTED.md` 三处**

- `:61` 的 hint `删 demo/run/ 再重跑` → `删 demo/agent/models.json 再重跑`；
- `:74` 那行 `# 用宿主 ~/.pi/agent 的真实凭证 + 一个免费模型` → `# 用 demo 自己的凭证（demo/agent/auth.json）+ 一个免费模型`（这是自相矛盾的一句话，规格事实 #4）；
- `:75` 与 `:225-229` 两问里的 `demo/env/auth.json` / `demo/run/...` → 新路径；`rm -rf demo/run demo/work` → `rm -rf demo/agent/models.json demo/work`。

- [ ] **步骤 5：验证没有失效引用**

```bash
rg -n "demo/run|demo/env/auth" README.md demo/README.md docs/GETTING-STARTED.md
```
预期：只出现在**明确标注为遗留**的句子里（否则改掉）。再跑一次 `npx tsc --noEmit && npm test 2>&1 | tail -4` 确认没碰坏代码。

- [ ] **步骤 6：Commit**

```bash
git add demo/README.md README.md docs/GETTING-STARTED.md
git commit -m "docs(demo): agent-team 当第一窗口、check 降为附加自检；实录重贴；路径与测试数更正"
```

---

### 任务 8：收尾 —— FACTS 记一条、examples 指一句、全链路复验

**文件：**
- 修改：`docs/FACTS.md`（v2 段追加 #29）
- 修改：`examples/lib/harness.ts`（顶部注释一句）
- 修改：`src/agent/create-agent.ts:55`（注释里的示例路径）

- [ ] **步骤 1：`docs/FACTS.md` 追加 #29**

格式照 #27/#28：

| 29 | `<agentDir>/extensions/*.ts` 与 `<agentDir>/skills/*/SKILL.md` 是 pi 的**自动发现**路径（无需写进 spec 就能生效，`lab.inspectEnv()` 能看到）。被 tsc 检查的扩展文件必须自带类型：`export default (pi: ExtensionAPI) => …` —— 无注解的 `(pi)` 在本仓 `strict` 下编译不过（本仓 `tsconfig.include` 含 `demo/`，以前靠 `exclude: ["demo/run"]` 躲开了）。 | 本次实现（`npx tsc --noEmit` 判别力实测） |

- [ ] **步骤 2：`examples/lib/harness.ts` 顶部加一句**

在「做法照 `test/helpers.ts`」那段之后加：`// 注意：这是**跑完即弃**的临时环境（mkdtemp）——示例演示的是「面」。真要研究，环境要像 demo/agent/ 那样是一个看得见、可手改的目录（见 demo/agent/README.md）。`

- [ ] **步骤 3：`src/agent/create-agent.ts:55` 的注释**

`（`demo/run/faux` 与它的绝对路径是同一个目录…`）` → `（`demo/agent` 与它的绝对路径是同一个目录…`）。运行 `rg -n "demo/run" src/` 预期零命中。

- [ ] **步骤 4：全链路复验（一次跑完，全部必须通过）**

```bash
rm -rf demo/agent/models.json demo/work
npx tsc --noEmit && echo "tsc OK"
npm test 2>&1 | tail -6
node demo/agent-team.ts >/dev/null && echo "agent-team OK"
node demo/check.ts      >/dev/null && echo "check OK"
node examples/01-first-agent.ts >/dev/null && echo "ex01 OK"
git ls-files demo/agent
git status --short
```
预期：tsc 无输出；`pass 144 / fail 0`；三个脚本退出码 0；`git ls-files demo/agent` 只有三个文件；`git status --short` **干净**（跑完不留未跟踪垃圾）。

- [ ] **步骤 5：Commit**

```bash
git add docs/FACTS.md examples/lib/harness.ts src/agent/create-agent.ts
git commit -m "docs: demo/agent 作为环境规范的落地事实（FACTS #29）；examples 指向真实环境做法"
```

---

## 交付后

- 第一窗口 = `node demo/agent-team.ts`；`node demo/check.ts` = 附加的环境自检。
- 环境 = `demo/agent/`（可 `git ls-files` 看到技能与扩展），规范 = `demo/agent/README.md`。
- 库 API 未动：规格 §2 的「非目标」仍然成立（差异③ 封存）。
- 未覆盖的：`docs/DESIGN.md` 未改（它是设计源，本次是它的实现落地）；`docs/superpowers/` 里的历史 plan/spec 未回改。
