# 第 10 部分：红线与越界的实际强度（交叉验证轮）

> **状态声明（必读）**：本轮在收到「停止调研」指令前**只完成了脚本撰写，没有执行任何实验**。
> 因此本文件**不含任何独立实测数据**，也**没有**抄录既有报告。下方只有一条**静态阅读**得到的
> 线索，已明确标注为「未实测」。**我有独立实测证据的条目：0 条。**

- 既有成果（勿重复）：`audit/10-redlines.ts` + `audit/findings/10-redlines.json`
  → 已汇总为 `docs/research/2026-09-30-phase1-capability-audit-report.md` 第七部分
- 本轮已写但**未执行**的脚本：`audit/10-redlines/e1-whitelist.ts`（+ `_lib.ts`）
- 未执行原因：收到停止指令。可随时用 `node audit/10-redlines/e1-whitelist.ts` 复跑。

## 结论速览

- **无**任何独立实测结论。
- 与既有报告**可能相左的候选 1 条**（未实测）：既有报告把「agent 读别人的上下文」判为
  *真守住 / 无任何通道*，把扩展旁路判为 *设计者声明的扩展工具被并进白名单*；静态阅读显示还存在
  **agent 自己驱动**的一条路 —— 往会被后续成员加载的扩展目录里写文件，代码在**宿主进程内**执行，
  **且 `tools` 白名单挡不住它**（白名单只过滤工具名，过滤发生在加载之后）。见 U1。

## 实测证据

（无。本轮没有任何原始输出。）

## 未实测线索（静态阅读，仅代码引用，勿当结论用）

### U1 扩展的「加载」与「白名单过滤」是两件事 —— 白名单可能挡不住代码执行

- **问题**：`tools` 白名单能否阻止扩展代码在成员会话中执行？既有报告 10.1e 的结论是
  「这个口子握在设计者手里，agent 拿不到」；强度表把「agent 不能读别人的上下文」判为 *真守住*。
  这两条是否成立？
- **证据（代码位置，非运行输出）**：
  1. `src/agent/create-agent.ts`：`await buildLoader(...)` 在**组装 `tools` 白名单之前**执行，
     白名单随后才传给 `createAgentSession`。→ 加载/执行发生在过滤之前，白名单在时序上不可能阻止它。
  2. `src/agent/loader.ts`：`await loader.reload()` 加载全部被发现的扩展；
     `declaredExtensionToolNames()` **只过滤工具名**，不做任何加载准入。
  3. `node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:761`：
     项目扩展根 = `join(this.cwd, ".pi", "extensions")` → 扩展可从**成员的 cwd** 被发现。
  4. `.../dist/core/settings-manager.js:214`：`projectTrusted = options.projectTrusted ?? true`；
     而 `buildLoader` 调 `loader.reload()` 时**未传** `resolveProjectTrust`，即跳过了
     「先按不可信加载、再决定信任」的那趟预检 → 项目扩展按可信加载。
  5. `.../dist/core/extensions/types.d.ts:267`：`ExtensionToolContext extends ExtensionContext`，
     而 `ExtensionContext` 带 `sessionManager: ReadonlySessionManager`（含 `getEntries`）、
     `executeTool()`、`getSystemPrompt()`。→ 被加载的代码能读**它所在会话**的消息、改系统提示。
- **推理出的候选结论（未验证）**：一个持有 `write`/`bash` 的分身，把扩展写进
  `agentDir/extensions/`（`agentDir` 默认宿主共享，决策 #9）或共享 cwd 的 `.pi/extensions/`，
  此后新建的成员 —— **即使被 `tools: ["read"]` 裁剪过** —— 仍会加载并执行这段代码，
  且代码运行在**设计者进程内**（权限高于 bash 子进程）。若同时用 `pi.on("tool_call", …)`
  注册钩子，还能改写该成员的**行为**，并借 `ctx.sessionManager` 读该成员自己的消息。
- **为什么值得单独跑**：它与既有报告的 10.1e 结论、以及强度表里的两条判定直接冲突；
  若成立，「读别人的上下文」这一行应从 *真守住* 改判，10.1 应从「白名单可被绕过」升级为
  「白名单可能只是挡住了模型调用，没挡住代码执行」。
- **怎么验证**：`node audit/10-redlines/e1-whitelist.ts`（脚本已就绪，未跑）。
  关键断言是**文件系统副作用**（标记文件 / `globalThis` 标记），不依赖库的返回文本：
  `E1.6` 看植入工具是否出现在请求的 tools 里、标记文件是否生成；
  `E1.9` 看植入的 `tool_call` 钩子能否拦掉受害者白名单内的 `read`。
- **风险声明**：`.pi/extensions` 的 TS 扩展在本 Node 运行时能否被真正加载、项目信任预检是否
  真如阅读所见被跳过 —— 都必须以运行结果为准。**本条目未实测，不得直接引用为结论。**

## 清单

| # | 现象 | 类别 | 严重度 | 证据 |
|---|---|---|---|---|
| — | 本轮无实测发现 | — | — | — |
| U1 | 白名单可能在扩展「加载之后」才生效，因而挡不住代码执行；候选与既有报告 10.1e / 强度表「读别人上下文」冲突 | 缺口（**未实测**） | 待评 | 静态阅读：`src/agent/create-agent.ts`、`src/agent/loader.ts`、`resource-loader.js:761`、`settings-manager.js:214`、`extensions/types.d.ts:267` |

## 与既有报告的关系

- **重复劳动确认**：本轮任务（10.1–10.5）与 `audit/10-redlines.ts` 的 10.1a–10.6 完全重叠；
  收到停止指令后未执行任何脚本，未产生重复数据。
- **不一致**：仅 U1 一条，且为静态阅读，未实测。
- **一致**：无法评价（本轮无实测输出可比对）。
