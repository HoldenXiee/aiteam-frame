# `demo/agent/` —— 环境规范

**这个目录就是 `createLab({ agentDir })` 的那个 `agentDir`**，配套的 `cwd` 是 `../work/`（即 `demo/work/`）。

一句话：**环境即目录、目录即配置**。一个 agent 的「身份与装备」——有哪些技能、能加载哪些扩展、用哪份凭证、看得见哪些模型——不写在代码里，就是这个目录里有哪些文件。想改环境，改目录；想让改动可复现、可 review，就把文件签进仓库。

`demo/` 下的脚本都读同一个环境：`demo/env.ts` 解析出「环境在哪」并把凭证就位，`demo/lab.ts`（实验起点）、`demo/check.ts`（环境自检）与 `demo/exp-*.ts`（自己写的实验）用同一套路径起 agent。

**复制 `demo/` 会把本目录一起复制走**：环境跟着实验走，副本用副本自己的 `agent/`（机关是 `demo/env.ts` 里那个「相对本文件解析」的 `agentDir()`）。

## 每一档管什么

| 档 | 进 git | 谁写 | 管什么 · 删掉的后果 |
|---|---|---|---|
| `README.md` | ✅ | 人 | 就是本文件：环境规范。删掉只是少一份文档，不影响运行 |
| `skills/<名>/SKILL.md` | ✅ | 人 | 技能。文件名目录名随你，**技能名取自 frontmatter 的 `name`**。删掉：靠它约束的行为失去依据 —— 技能是**软约束**（靠模型读了照做，不是代码强制）：`demo/lab.ts` 少掉 `env-style` 后照样 exit 0（这就是 S3 那条 mutation） |
| `extensions/<名>.ts` | ✅ | 人 | 扩展。`export default (pi: ExtensionAPI) => …`，在函数体里 `pi.registerTool(...)` / `pi.on(...)`。删掉：它注册的工具与钩子消失（`demo/check.ts` 第 7 项会因此变红） |
| `auth.json` | ❌ gitignored | 人（或 `AITEAM_DEMO_AUTH`） | **唯一读的凭证**。删掉：跑 demo 会明确报错（给出出路），不会静默 |
| `models-store.json` | ❌ gitignored | pi（联网刷新模型目录时） | 模型目录缓存。删掉：pi 下次联网重建 |
| `settings.json` | ❌ gitignored | pi（**只在你改过设置时才写** —— `FileSettingsStorage` 的 `fn` 返回 `undefined` 就不写文件） | pi 设置。demo 不动设置，所以跑完这里**通常没有它**；`demo/` 全用默认值，不签入。删掉：下次改设置时重建 |
| `SYSTEM.md` | **本目录不放** | —— | 见下节 |
| `APPEND_SYSTEM.md` | **本目录不放** | —— | 与 `SYSTEM.md` 同一族；放进去会改变系统提示词，同样会污染 demo 的判据 |

`skills/` 与 `extensions/` 走的是 pi 的**自动发现**：目录里放着就生效，**不需要**写进 `createAgent` 的 spec。`lab.inspectEnv()` 能把实际加载到的技能与扩展列出来，用来核对。

## 为什么 demo 不放 `SYSTEM.md`

`SYSTEM.md` 不是「追加」，是**整体替换**系统提示词——连 pi 自己注入的 `<tools>` / `<rules>` 段一起消失。放一份进去：

- `demo/lab.ts` 的模型行为会变（系统提示词里的工具声明与规则段没了，调用顺序跟着变）；
- `demo/check.ts` 第 7 项「只看得到自己的技能与扩展」的判据会被带偏（它验的是发现与隔离，不是提示词）。

这一档是真实存在的、也确实有这个后果——但要看它的效果，得**单独开一个环境**（另建一个 agentDir 放 `SYSTEM.md`），别把它混进 demo 这个「七面全出场」的环境里。

## 怎么自己改

1. **加一个技能**：新建 `skills/<任意目录名>/SKILL.md`，frontmatter 里写 `name:`（技能名看这里，不看目录名）与 `description:`。跑 `node demo/check.ts` 第 7 项确认它被发现了。
2. **加一个扩展**：新建 `extensions/<名>.ts`，`export default function (pi: ExtensionAPI) { pi.registerTool(…) }`。**类型注解必须写**：本仓 `tsconfig.json` 的 `include` 含 `demo/`，无注解的 `(pi)` 在 `strict` 下编译不过（`npx tsc --noEmit` 会当场报 implicit any）。
3. **换凭证**：把 `auth.json` 放进来（推荐，gitignored），或用 `AITEAM_DEMO_AUTH=/path/to/auth.json` 指一份。改完 `node demo/check.ts` 验。**别指向宿主 `~/.pi/agent`**——pi 的 auth 存储是读-改-写整个文件，会把那里的凭证抹掉（历史事故见 `demo/README.md`）。

改完环境不生效？删**可再生的产物**再跑：`rm -rf demo/work`。`demo/agent/auth.json` 是你的凭证，**不要删**。

## 两条环境事实

**R41：环境自动发现的扩展，其工具名不并入 `permissions.only` 白名单。** 白名单是「精确就是这些」的硬过滤，不该被环境里碰巧存在的扩展悄悄撑开（实现见 `src/agent/loader.ts`）。

实测对照（同一个 `demo/agent/`，只差一行 `only`）：

| 写作员 | 活跃工具 |
|---|---|
| `only: ["read", "write", "bash"]`（`demo/lab.ts` 里就是这个） | `read,write,bash` |
| 不写 `only` | `read,bash,edit,write,env_checklist` |

**要检验这条**：把 `demo/lab.ts` 里写作员那行 `only: ["read", "write", "bash"]` 删掉再跑 —— `env_checklist` 就会出现。

**`agentDir` 与 `cwd` 分工不同。** `agentDir` 是**身份与装备**（技能 / 扩展 / 凭证 / 模型），跨 agent 共享、位置由 `createLab` 声明一次；`cwd` 是**在哪干活**（会话落点、工具的相对路径根），agent 的产物如 `notes.md` 落在那里。这个 demo 里两者分别是 `demo/agent/` 与 `demo/work/`。

## 两种模式共用一个环境目录：已知代价

假模式与真模式**共用**这一个 `agentDir`（不拆成两份），换来的正是「环境看得见」；代价有两条，都只影响打印：

- 假模式跑过会在这里留下 `models.json`（真模式不用它——`opencode-go` 是内置 provider）；
- 真模式的 `auth.json` 在位时，假模式的 `lab.inspectEnv()` 会多列一个 provider。

两者**都不影响任何硬断言**：`demo/check.ts` 第 3 项在假模式下断言的是「`faux/echo` 可用」，不是 provider 数量；第 8 项的 `available=N` 只打印不断言。
