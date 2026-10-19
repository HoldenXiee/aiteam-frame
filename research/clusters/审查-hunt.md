# 研究员集群代码审查（lab-3b）

> 2026-10-18 · 审查 `research/clusters/lab-3b/`（746 行，13 个文件）
> ★ 方法：**逐个文件读 + 逐条对着库的真实形状核对**（不猜）
> ★ 结论：**能跑，但有 3 个致命缺陷 —— 其中 2 个会让整个拓扑失效。**
>
> ## ★★★ 修复状态（2026-10-18）
>
> ★ 设计者裁定：「**没实验过，建议不改，设计疏漏需要修复。**」
> ⇒ 分清两类，**只修设计疏漏，实现问题等实验**：
>
> | # | 问题 | 性质 | 状态 |
> |---|---|---|---|
> | 致命 1 | 审查意见没回流 | ★★★ **设计疏漏** | ✅ **已修**（`feedback.ts`） |
> | 致命 1b | ★ **它改 `lib/` 等于没改**（`env.ts` import 的是仓库 `src/`） | ★★★ **设计疏漏** | ✅ **已修**（`env.ts` 改 import `lib/aiteam/`） |
> | 致命 1c | 改了 `lib/` 改坏会撞死 | ★★ **设计疏漏** | ✅ **已修**（`lib-state.ts`：能看见、能撤销） |
> | 致命 2 | 所有 agent 共用 cwd | ⚠ **实现问题** | ⏸ **等实验**（没跑过，不知道怎么调才对） |
> | 致命 3 | 平台期判据恒为 0 | ⚠ **实现问题** | ⏸ **等实验** |
> | 重要 4/5 | 反复触发 / `as` 断言 | ⚠ 实现 | ⏸ 等实验 |
> | 次要 6/7/8 | 兜底 / dispose / 落盘位置 | ⚠ 实现 | ★ 8 已顺手修（改到 `work/audits/`） |

---

## 一、按严重度排的问题

### 🔴 致命 1：**审查意见根本没有回流到研究员**

**位置**：`runner.ts` `fire()` + `topology/rules.ts` `onSettled()`

**现象**：
```ts
// runner.ts：结论只落盘
writeFileSync(join(ad, `${seq}-${role}.md`), `# ${role}\n\n为什么叫它来：${why}\n\n${text}\n`);
return text;                    // ★ 返回值给了调用方（rules），但 rules 只是解析 VERDICT

// rules.ts onSettled：拿到全文却只用它解析 VERDICT
const out = await fire("inspector", why, focus);
const v = out.match(/VERDICT:\s*(STOP|CONTINUE)/i);   // ★★ 正文丢了！
```

**后果**：
- ★ **研究手册 L111 说"审查者会拿它开火"** —— 但**它永远看不到那些火力**。
- ★★ **等于没审。** 这跟我上一版自陈的断链**是同一个病，我没修掉**。

**为什么 `consult` 没这个问题**：`defineTool.execute` 的**返回值自动进父上下文** ——
★ 那条路是对的。**出问题的是"代码触发"那条路**（`fire` 的返回值没有投回 researcher）。

**修法**：`fire()` 之后 `researcher.io.queue(...)` 把结论投进去（或至少在 `work/` 里留一个 `INBOX.md` 并在手册里说"每次开工先读它"）。

---

### 🔴 致命 2：**所有 agent 共用同一个 cwd → 并发写会互相删数据**

**位置**：`runner.ts` L34
```ts
const lab = await labAt(join(LAB, "work"));    // ★ 一份 cwd，所有 agent 共用
```

**后果**：
★★★ **第一代集群（lab-1）自己提过这个案**：
> `提案-并发集群共用工作区会互相删数据.md` —— 实测 `wc -l` 从 15 变成 2。

★ 现在的情况更严重：**researcher 在跑，5 个专家随时可能被叫起来**，
它们**同一个 cwd、同一个 work/**，而且 `libsmith` 还有写权限。

**修法**：每个 agent 独立 cwd（`work/instances/<id>/`），
或者至少**专家只读它们该读的**、不落任何临时文件到共用区。

---

### 🔴 致命 3：**"平台期"判据永远为 0，onPlateau 永不触发**

**位置**：`runner.ts` 事件回调 + `rules.ts` `PLATEAU_ROUNDS`
```ts
// runner.ts
const n = listOutbox().length;
if (n > state.auditedOutputs) state.roundsSinceNew = 0;   // ← ①
else state.roundsSinceNew++;                              // ← ②

// 紧接着 rules.onSettled() 里：
if (outs.length > state.auditedOutputs) {
  state.auditedOutputs = outs.length;                     // ← ③ 立刻同步了
```
**① 和 ③ 用的是同一个判据** —— 一旦有新产物，**① 把它归零，③ 又把它推进去**。
⇒ 下一次就一定是"没新东西" → `roundsSinceNew++`。
★ **看着像对，但 `auditedOutputs` 被 `onSettled` 抢先更新，导致计数时机混乱。**

★★ 更根本的问题：**`agent_settled` 每次运行结束都发**，而 `roundsSinceNew` 的语义
应该是"**连续几轮没有新东西**" —— 但"一轮"是什么？**在事件驱动的集群里没有"轮"的定义。**

**修法**：换判据 —— 用**时间**（多久没新产物）或**运行次数**，且**把状态更新收到一处**。

---

### 🟠 重要 4：`onCapabilityGap` 会**反复**起 libsmith

```ts
const gaps = listOutbox().filter((f) => /缺口|提案|撞墙|做不到|capability/i.test(f));
if (!gaps.length) return;
if (Date.now() - (state.firedAt["libsmith"] ?? 0) < COOLDOWN_MS) return;   // ★ 只是冷却
```
★ **那份"缺口"文件一旦写出来就永远在 outbox 里** ⇒ 每过 20 分钟**再起一次 libsmith**。
★★ **正确语义是"一次"**（那份缺口处理过了就不再触发），不是"每 20 分钟一次"。

**修法**：记**已处理过的文件名**（集合），不是时间戳。

---

### 🟠 重要 5：`as ExpertName` 是个**会静默出事**的断言

```ts
const consult = makeConsult((r, why, focus) => fire(r as ExpertName, why, focus));
```
★ `consult.ts` 只放 4 个可请的角色（**不含 libsmith** —— 那是故意的）。
★ 但 `as ExpertName` 把类型放宽了 —— ★★ **如果 `CONSULTABLE` 和 `EXPERTS` 不同步，会在运行时 `EXPERTS[role]` 是 undefined。**

**修法**：让 `consult` 的类型与 `EXPERTS` 对齐（用 `satisfies` 或显式类型检查），别用 `as`。

---

### 🟡 次要 6：`fire` 失败没有兜底

```ts
const res = await a.io.prompt(spec.prompt());
const text = res.text ?? "";
```
★ 如果 `prompt` **抛异常**（不是返回 error），`fire` 会把异常往上抛 →
**整个规则链断掉**（`onSettled` 后面的 `onCapabilityGap`/`onPlateau` 都不跑）。
★★ `runner.ts` 的 try/catch 能接住，但**接住之后这一轮的三个规则全废了**。

**修法**：`fire` 内部 try/catch，失败返回空串并记日志。

---

### 🟡 次要 7：`spawn_line` 的子 agent **没进 `EXPERTS` 体系**，也没有 `waitIdle` 之外的清理

```ts
const res = await child.io.prompt(...);
child.dispose();              // ★ 同步 dispose —— 若还在跑会怎样？
```
★ `dispose()` 是同步的（`types.ts` L101）。
★★ 如果 `prompt` 正常返回，说明已 settled，dispose 没问题 —— **但这条依赖"prompt 一定跑完"，没有兜底**。

---

### 🟡 次要 8：`_audits/` 落在 `outbox/` 里面

★ `outbox/` 的语义是"**研究员交出来的成果**"。
★★ 把审查意见放进去，会让 **`listOutbox()` 的语义变混**（虽然它只数 `.md`，目录不计）。
★ 更重要的是：**研究员可能会把审查意见当"自己的成果"**。

**修法**：换个地方（`work/audits/` 或 `inbox/feedback/`）—— ★ 而且顺便解决致命 1。

---

### 🔵 提示 9：分支名不一致

★ 主仓库是 `main`，`lab-3b` 独立仓库是 `master`。**建议统一**。

---

## 二、做对了的地方（也要说）

| # | 做对了什么 | 为什么好 |
|---|---|---|
| 1 | ★★ **没有 while 循环** | 遵守了"运行时不能干涉"——规则挂在事件上 |
| 2 | ★★ **`consult` 传"处境+地盘"而不是"一句话"** | 采纳了你的纠正；专家能自己去读 |
| 3 | ★ **`guard.ts` 的 BLOCK_REASON 里有"路"** | `P12` 落实到位 |
| 4 | ★ **只读专家用 `READONLY_TOOLS`** | `prompts/index.ts` 一眼看得出谁能写 |
| 5 | ★ **每 agent 一个提示词文件** | 拆对了 |
| 6 | ★ **`labAt` 钳住 cwd** | 我刚加的，防静默长垃圾 |

---

## 三、我的建议：先修 1/2/3 再跑

| 优先级 | 修什么 | 代价 |
|---|---|---|
| 🔴 **必修** | **致命 1**（回流）—— 不修等于没审 | 小（`fire` 后 `queue` 一句） |
| 🔴 **必修** | **致命 2**（共用 cwd）—— 会丢数据 | 中（每 agent 独立 work 子目录） |
| 🔴 **必修** | **致命 3**（平台期判据）—— 等于没有"换视角"触发 | 中（换判据） |
| 🟠 建议 | 重要 4/5（反复触发 + `as` 断言） | 小 |
| 🟡 可后 | 6/7/8 | 小 |

---

## 四、★ 一个更深的问题（我审查时才想清的）

★★★ **"代码触发"这条路上，`fire()` 的返回值没有天然的"回流入口"。**

对比两条路：

| | agent 触发（`consult`） | 代码触发（`fire`） |
|---|---|---|
| 谁发起 | 模型调工具 | 我的规则 |
| 结果怎么回去 | ★★ **`execute` 的返回值自动进父上下文** | ★ **没有这个机制** —— 得我自己投 |

★★ **这是我设计上的疏漏**：我以为"两条路都能回流"，其实**只有 `consult` 那条天然能**。

★ 而且这解释了为什么**上一版也有同一个病** ——
★★ **因为我两次都只想到"把结论落盘"，没想到"落盘 ≠ 它读得到"**。
