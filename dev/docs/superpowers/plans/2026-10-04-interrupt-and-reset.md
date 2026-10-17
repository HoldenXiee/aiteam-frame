# 截断输入（`io.interrupt`）与上下文重置（`context.reset`）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 补上 `docs/DESIGN.md` 与现状的两处差异：① `io.interrupt(text)` —— 真正「中断在飞那轮、立即投递新输入」的一等方法（现状 `io.steer` 只是运行中改向，**不 abort**）；② `context.reset()` —— 逐条抹除、**仍是原来那个 agent** 的「整段重置」（现状只有 per-entry 的 `replace` / `erase`）。

**架构：** 两个方法都只组合 pi 已有的原语，不新增机制。
`interrupt` = `session.abort()`（pi 内部已 `await waitForIdle()`）+ 库的 `io.waitIdle()`（再排干库自己记的在飞运行）+ 现有 `run()`。
`reset` = 对 `entries()` 里每一条**可编辑**的 entry 调 `sessionManager.appendContextEdit(id, null)`（与 `erase` 同一个原语），最后一次 `refreshContext()`。
不可编辑的条目（system / compactionSummary / 分支摘要）**不抛错**，进返回值 `skipped` —— 与库「不静默失效」一致。

**技术栈：** TypeScript（Node 原生 `.ts` 直跑，无构建）、`node:test`、本机假 provider（离线，零 API 成本）。

**规格：** `docs/DESIGN.md`（手写设计源）+ `docs/DESIGN-解读.md` §0 已裁决项（Q3 = 上下文三层都要、Q1 / Q4 / Q5）。本计划只实现差异 ①②；差异 ③④（实验室逐项声明资源、`lab.get(id)`）你说「先不管」，**不做**。

## 全局约束

- 对外类型一律从 pi import，不自己重定义（`src/agent/types.ts` 头注）。
- 七面统一自律：`dispose()` 之后**一切**都抛错；`io.waitIdle()` 是唯一有注释的例外（v1 决策 #21 / R48）。
- 错误文案一律中文，且带上「怎么办」。
- 不新增依赖，不新增源文件；`docs/DESIGN.md` 不改（①② 落地后它的措辞已被兑现）。
- 测试一律经 `lab.createAgent` 真实入口 + 本机假 provider；零真 API 调用。
- 每步之后 `npx tsc --noEmit` 必须干净；每个任务收尾 `npm test` 必须全绿。
- 沿用既有模式：`async` 方法、`assertAlive()` 打头、中文 JSDoc 说明「为什么」。

## 审查重点（Review Focus）

1. **启动窗口**：`prompt()` 刚发起、pi 的 `isStreaming` 还是假时调 `interrupt` —— 必须照样中断，不许抛「正在运行」。（`io.ts` 的 `running` 计数就是为这个洞存在的。）→ 任务 1 测试「启动窗口里调用也要中断」。
2. **abort 之后 inFlight 未清**：`session.abort()` 只保证 pi 侧 idle，库的 `run()` 还没走完 finally；此时直接 `prompt()` 会撞「agent 正在运行」。必须 `await io.waitIdle()` 把 `inFlight` 排干。→ 任务 1 首条测试。
3. **reset 边遍历边改投影**：遍历 `entries()` 的同时 append edit 会漏抹 / 重复 —— 必须先取**快照**再逐条抹。→ 任务 2 首条测试（多轮 + system 条目同时存在）。
4. **reset 撞上不可编辑条目**（system / compactionSummary）：不许抛错、也不许静默 —— 必须出现在 `skipped` 里。压缩摘要抹不掉是 pi 的硬天花板（FACTS #28）。→ 任务 2 第二条测试（压缩后 reset）。
5. **R48**：`interrupt` / `reset` 在 `dispose()` 之后必须抛错，与其余六个面一致，不做「七分之六遵守」的例外。→ 两个任务各一条测试。

---

### 任务 1：`io.interrupt(text, opts?)`

**文件：**
- 修改：`src/agent/types.ts:105-115`（`IoSurface`）
- 修改：`src/surfaces/io.ts`（把 `waitIdle` 提成局部函数；新增 `interrupt`）
- 测试：`test/io.test.ts`（追加 5 条）
- 修改：`docs/FACTS.md`（v2 段末尾追加 #27）
- 修改：`docs/GUIDE.md:42`、`:82`、`:196-200`

- [ ] **步骤 1：写失败的测试**（追加到 `test/io.test.ts` 末尾）

```ts
test("interrupt：在飞那轮被中断，新输入立即投递并拿到它的 RunResult", async () => {
  const a = await makeAgent();
  try {
    const slow = a.io.prompt("[[sleep:2000]] 慢").catch(() => {});
    await a.io.interrupt("换成这句");            // 不抛错 = 它真的中断了，而 prompt 在忙时会拒绝
    const r = await a.io.prompt("下一句");        // 中断之后可以正常继续
    assert.equal(r.text, "echo:下一句");
    await slow;
    assert.notEqual(a.status, "running");
  } finally { a.dispose(); }
});

test("interrupt：启动窗口里调用也要中断（pi 的 isStreaming 还没翻真）", async () => {
  const a = await makeAgent();
  try {
    const slow = a.io.prompt("[[sleep:800]] 慢").catch(() => {});
    const r = await a.io.interrupt("窗口里插队");   // 紧跟同步调用，不给 setTimeout
    assert.match(r.text, /窗口里插队/);
    await slow;
  } finally { a.dispose(); }
});

test("interrupt 空闲时 = prompt", async () => {
  const a = await makeAgent();
  try {
    const r = await a.io.interrupt("直接说");     // 没有在飞轮次，不该抛错
    assert.equal(r.text, "echo:直接说");
  } finally { a.dispose(); }
});

test("interrupt 不吞掉已排队的 queue 消息（queue 的承诺不被违背）", async () => {
  const a = await makeAgent();
  try {
    const slow = a.io.prompt("[[sleep:800]] 慢").catch(() => {});
    await a.io.queue("排队的话");
    const r = await a.io.interrupt("打断");
    const userText = r.messages
      .filter((m) => m.role === "user")
      .map((m) => JSON.stringify(m.content))
      .join("|");
    assert.ok(userText.includes("排队的话"), `排队的消息应当在这一轮里被投递：${userText}`);
    await slow;
  } finally { a.dispose(); }
});

test("dispose 之后 interrupt 抛错（R48）", async () => {
  const a = await makeAgent();
  a.dispose();
  await assert.rejects(() => a.io.interrupt("x"), /disposed/);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-timeout=60000 test/io.test.ts`
预期：5 条新用例 FAIL，报 `a.io.interrupt is not a function`。

- [ ] **步骤 3：在 `src/agent/types.ts` 的 `IoSurface` 里加方法**

`steer` 之后插入（保留 `steer` 不动；两者语义不同，注释里写清）：

```ts
  /**
   * 截断输入：**中断在飞那轮**，立即投递新输入并拿它的结算。
   *
   * 与 `steer` 的区别是本质的：pi 的 `steer` 不 abort，只在本轮工具调用跑完、**下一次 LLM 调用之前**
   * 改向（`agent-session.js:1665` 只 push 进队列）。要「现在就停、就发这句」只能 abort。
   *
   * 空闲时等价于 `prompt`（不抛错）。忙时**不抛错** —— 这正是它存在的理由，`prompt` 忙时会拒。
   */
  interrupt(text: string, opts?: { images?: ImageContent[] }): Promise<RunResult>;
```

- [ ] **步骤 4：在 `src/surfaces/io.ts` 实现**

把现在对象字面量里的 `async waitIdle() {...}` 原样提取成局部函数 `async function waitIdle(): Promise<void> {...}`，对象里写 `waitIdle,`（`interrupt` 内部要用它；不能用 `this`，会被解构调用打断）。然后加：

```ts
    /**
     * 截断输入 = abort → 等库自己的在飞运行收尾 → 正常跑一轮。
     * 三步缺一不可：pi 的 `session.abort()` 内部已经 `await this.waitForIdle()`（agent-session.js:1841-1851），
     * 但库自己的 `run()` 还在 finally 里清 runId / status，不排干 `inFlight` 就调 `run()` 会撞
     * 「agent 正在运行」——把一次合法的中断变成假错误。
     * 已排队的 queue 消息**不清**：`queue` 承诺过「等空闲再发」，那一轮就是这一轮（用例钉住）。
     */
    async interrupt(text, opts) {
      deps.assertAlive();
      if (!isRunning()) return run(text, opts, nextRunId());   // 空闲：等价 prompt，abort 也不需要
      await session.abort();
      await waitIdle();
      return run(text, opts, nextRunId());
    },
```

若步骤 1 第 4 条用例失败（pi 把 follow-up 留到下一次 `prompt` 才发）：把断言改成「排队消息仍在 `io.pending` 里」，并在 `docs/FACTS.md` #27 记一条实测 —— **不许**为了让测试变绿去调 `session.clearQueue()`（那会违背 `queue` 对调用者的承诺）。

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test --test-timeout=60000 test/io.test.ts`
预期：全部 PASS（含既有用例）。

- [ ] **步骤 6：`docs/FACTS.md` 追加 #27**（v2 实测表末尾，接 #26）

| 27 | `session.steer()` **不 abort**：`_queueSteer` 只 push 进 `_steeringMessages` + `agent.steer()`（`agent-session.js:1665-1676`），消息在**本轮工具调用跑完、下一次 LLM 调用前**投递 ⇒ 「截断输入 / 立即中断」不能靠它，只能 `abort()` + `waitIdle()` + `prompt()`。`session.abort()` 内部已经 `await this.waitForIdle()`（`:1841-1851`），但它**不清** `_steeringMessages` / `_followUpMessages`（要清得显式 `clearQueue()`）。 | 任务 1 实现（源码行 + 用例） |

- [ ] **步骤 7：`docs/GUIDE.md` 三处更新**

- `:42` 表格 io 行的成员列表：加 `interrupt`。
- `:82` 「能做什么」：加 `interrupt`（**中断在飞那轮并立即投递**，拿 `RunResult`；与 `steer` 的区别一句话写清）。
- `:196-200` §5 表格：把 `interrupt` 放进**不要求空闲**那一列。

- [ ] **步骤 8：全量验证**

运行：`npx tsc --noEmit && npm test`
预期：typecheck 无输出；`pass 139`（134 + 5）、`fail 0`。

- [ ] **步骤 9：Commit**

```bash
git add src/agent/types.ts src/surfaces/io.ts test/io.test.ts docs/FACTS.md docs/GUIDE.md
git commit -m "feat(io): interrupt —— 中断在飞那轮并立即投递（steer 不 abort，两者并存）"
```

---

### 任务 2：`context.reset()`

**文件：**
- 修改：`src/agent/types.ts:117-155`（`ContextSurface`；并把 `replace` / `erase` 的「忙时边界」注释扩到 `reset`）
- 修改：`src/surfaces/context.ts`（提取 `isEditable` 与 `listEntries`；新增 `reset`）
- 测试：`test/context.test.ts`（追加 4 条）
- 修改：`docs/FACTS.md`（追加 #28）
- 修改：`docs/GUIDE.md:94`、`:199`

- [ ] **步骤 1：写失败的测试**（追加到 `test/context.test.ts` 末尾）

```ts
test("reset：整段抹掉可编辑历史，同一个 agent、id 不变", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("第一句");
    await a.io.prompt("第二句");
    const idBefore = a.id;
    const r = await a.context.reset();
    assert.equal(a.id, idBefore, "reset 是同一个 agent，不是新建一个");
    assert.equal(a.context.history.length, 0);
    assert.equal(r.erased.length, 4, "两轮 = 2 user + 2 assistant");
    await a.io.prompt("重置之后");
    assert.equal(sentMessages(), 2, "system + 这一句 —— 模型确实看不到旧历史");
  } finally { a.dispose(); }
});

test("reset：不可编辑的条目进 skipped，不抛错、不静默（压缩摘要是天花板）", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("[[huge:200000]] one");
    await a.context.compact("压成一句");
    assert.equal(a.context.history[0].role, "compactionSummary", "压缩确实发生了（否则这条用例什么都没钉住）");
    const r = await a.context.reset();
    assert.ok(
      r.skipped.some((s) => s.role === "compactionSummary"),
      `压缩摘要抹不掉，必须出现在 skipped 里：${JSON.stringify(r)}`,
    );
    assert.equal(a.context.history[0].role, "compactionSummary", "抹不掉就得留在历史里，不许假装清空了");
  } finally { a.dispose(); }
});

test("reset：连抹两次不报错，第二次没有可抹的（不线性 append）", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("一句话");
    const first = await a.context.reset();
    assert.ok(first.erased.length > 0);
    const second = await a.context.reset();
    assert.deepEqual(second.erased, [], "第二次不该再抹出条目");
  } finally { a.dispose(); }
});

test("dispose 之后 context.reset() 抛错（R48）", async () => {
  const a = await makeAgent();
  a.dispose();
  await assert.rejects(() => a.context.reset(), /disposed/);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test --test-timeout=60000 test/context.test.ts`
预期：4 条新用例 FAIL，报 `a.context.reset is not a function`。

- [ ] **步骤 3：在 `src/agent/types.ts` 的 `ContextSurface` 里加方法**

放在 `erase` 之后：

```ts
  /**
   * 整段重置：把当前**模型可见**的可编辑条目逐条抹除（`erase` 的批量版），仍然是原来那个 agent
   * （`id` / 各面引用 / session 都不换）。
   *
   * 不可编辑的条目（system / 压缩摘要 / 分支摘要）**抹不掉**（pi 的 `appendContextEdit` 只收
   * custom_message 与 user / assistant / toolResult），它们出现在返回值的 `skipped` 里 —— 不抛错、
   * 也不静默：只抹掉一半而返回值像「成功了」正是本库要根除的失效模式。
   *
   * 与 `replace` / `erase` 同一条路（append-only、不要求 idle、不走 reload），所以忙时编辑的
   * `RunResult` 边界同样适用（见 `replace` 的注释）。
   */
  reset(): Promise<{ erased: string[]; skipped: { id: string; role: string }[] }>;
```

- [ ] **步骤 4：在 `src/surfaces/context.ts` 实现**

把 `appendEdit` 里那段「可编辑性」判定提取成函数（`appendEdit` 与 `reset` 共用；`appendEdit` 的报错文案逐字不变）：

```ts
/** pi 的 `appendContextEdit` 只接受 custom_message 与 user / assistant / toolResult 消息 */
function isEditable(source: { type: string; message?: { role: string } }): boolean {
  return (
    source.type === "custom_message" ||
    (source.type === "message" &&
      (source.message!.role === "user" ||
        source.message!.role === "assistant" ||
        source.message!.role === "toolResult"))
  );
}
```

（若 TS 收窄麻烦，就沿用现有 `target.sourceEntry` 的联合类型写一个接受该类型的 `isEditable(source: EntrySource)`，形状照抄 `appendEdit` 现有内联判定的字段。）然后把 `entries()` 的函数体提取成局部 `listEntries()`（`entries` 与 `reset` 共用，避免 `this`），并加：

```ts
    async reset() {
      deps.assertAlive();
      // 先取快照：边遍历边 appendContextEdit 会改投影，遍历器会漏抹或重复
      const snapshot = listEntries();
      const erased: string[] = [];
      const skipped: { id: string; role: string }[] = [];
      for (const entry of snapshot) {
        const target = findEntry(entry.id);
        if (!target) continue;
        if (!isEditable(target.sourceEntry)) {
          skipped.push({ id: entry.id, role: entry.role });
          continue;
        }
        sessionManager.appendContextEdit(entry.id, null);
        erased.push(entry.id);
      }
      if (erased.length) session.refreshContext();   // 不刷的话 history 读的是旧投影
      return { erased, skipped };
    },
```

- [ ] **步骤 5：运行测试验证通过**

运行：`node --test --test-timeout=60000 test/context.test.ts`
预期：全部 PASS。

- [ ] **步骤 6：`docs/FACTS.md` 追加 #28**

| 28 | `sessionManager.appendContextEdit(id, …)` 只接受 `custom_message` 或 role 为 user / assistant / toolResult 的 message（`context.ts` 的可编辑性判定就是照它写的）⇒ **system 条目、compactionSummary、分支摘要只可寻址、不可抹除**。所以 `context.reset()` 不可能把历史清到「真的空」：压缩摘要会留下，必须由返回值 `skipped` 显性化。 | 任务 2 实现（源码 + 压缩后 reset 用例） |

- [ ] **步骤 7：`docs/GUIDE.md` 两处更新**

- `:94` 「能做什么」：加 `reset`（整段重置；不可编辑条目见返回值 `skipped`）。
- `:199` §5 表格「不要求空闲」列：加 `context.reset`。

- [ ] **步骤 8：全量验证**

运行：`npx tsc --noEmit && npm test`
预期：typecheck 无输出；`pass 143`、`fail 0`。

- [ ] **步骤 9：Commit**

```bash
git add src/agent/types.ts src/surfaces/context.ts test/context.test.ts docs/FACTS.md docs/GUIDE.md
git commit -m "feat(context): reset —— 逐条抹除的整段重置（同一 agent；不可编辑条目进 skipped）"
```

---

### 任务 3：文档与示例对齐（把差异从文档里抹掉）

**文件：**
- 修改：`README.md:66-70`
- 修改：`AGENTS.md`（`io` / `context` 两行描述）
- 修改：`docs/DESIGN-解读.md`（§6 术语表 `steer` 行 + §4.4 标注 Q3 已落地）
- 修改：`examples/01-first-agent.ts`、`examples/03-context.ts`
- 修改：`demo/check.ts:377-386`（io 冒烟块）

- [ ] **步骤 1：`README.md` 的 `Agent` 面描述**：`io`（投递 / `abort` / `waitIdle` / 结算 `RunResult`）→ 加 `interrupt`；`context`（历史 / 逐轮覆盖 / 压缩）→ 加 `重置`。

- [ ] **步骤 2：`AGENTS.md` 两行**：`agent.io` 行的投递列表加 `interrupt`；`agent.context` 行加 `reset`。（`AGENTS.md` 的「哪些动作要求空闲」表里 `io.waitIdle` 那组不动 —— `interrupt` 与 `reset` 都不要求空闲。）

- [ ] **步骤 3：修正 `docs/DESIGN-解读.md` 的事实错误**（这是唯一会把使用者读错的地方）

§6 术语表 `steer` 行现在写的是「打断在飞那轮，立即把新输入发出去」—— **与 pi 源码相反**。改成：

| `steer` | 运行中**改向**：在飞那轮的工具调用跑完后、下一次 LLM 调用前投递，**不 abort**。真中断见 `io.interrupt` |

同时在 §4.4 表格「整段重置」那一行后加一句：**已落地** —— `context.reset()`（逐条抹除，同一 agent；不可编辑条目见 `skipped`）。

- [ ] **步骤 4：`examples/01-first-agent.ts` 加 `[4]` 段**

在 `[3]` 之后、`agent.dispose()` 之前：

```ts
console.log("[4] 截断输入：中断在飞那轮，立即投递新输入（io.interrupt）");
const slow = agent.io.prompt("[[sleep:2000]] 慢任务").catch(() => {});
const cut = await agent.io.interrupt("换成这句：现在说这句");
console.log(`    interrupt 的返回文本：${cut.text}`);
await slow;
console.log("    对照：io.steer 不中断，只在本轮工具调用结束后改向");
```

运行：`node examples/01-first-agent.ts`
预期：退出码 0，`[4]` 段打印出 `echo:换成这句：现在说这句`。

- [ ] **步骤 5：`examples/03-context.ts` 加 `[4]` 段**

在压缩那段之后、`agent.dispose()` 之前：

```ts
console.log("[4] 整段重置：逐条抹除，还是同一个 agent（context.reset）");
const resetReport = await agent.context.reset();
console.log(`    抹掉 ${resetReport.erased.length} 条；跳过 ${resetReport.skipped.length} 条（id=${resetReport.skipped.map((s) => `${s.role}`).join(",") || "无"}）`);
console.log(`    重置后 history.length = ${agent.context.history.length}（压缩摘要抹不掉 —— 这就是 skipped 里的那条）`);
await agent.io.prompt("重置之后重新开始");
console.log(`    新的一轮照常跑，history.length = ${agent.context.history.length}`);
```

运行：`node examples/03-context.ts`
预期：退出码 0；`[4]` 段打印出跳过 `compactionSummary`（若压缩那段走的是「会话太小」分支，则 skipped 为空 —— 两种输出都合法，脚本不据此断言）。

- [ ] **步骤 6：`demo/check.ts` 的 io 冒烟块加一行**

在 `await me.io.queue(...)` / `waitIdle` 之后加：

```ts
        const cut = await me.io.interrupt("七面 · io：interrupt 一次");   // 空闲时 = prompt
        if (!cut.text) throw new Error("io.interrupt 空闲时应当等价 prompt 并拿到文本");
```

**不**在自检里调 `context.reset()`：它会抹掉共享 agent 的历史，影响自检后续步骤；`reset` 由 `test/context.test.ts` 覆盖。

运行：`node demo/check.ts`
预期：八项全过、退出码 0。

- [ ] **步骤 7：全量验证**

运行：`npx tsc --noEmit && npm test && node examples/01-first-agent.ts && node examples/03-context.ts && node demo/check.ts`
预期：typecheck 无输出；`pass 143 / fail 0`；三个脚本都退出码 0。

- [ ] **步骤 8：Commit**

```bash
git add README.md AGENTS.md docs/DESIGN-解读.md examples/01-first-agent.ts examples/03-context.ts demo/check.ts
git commit -m "docs: interrupt / reset 写进 README、AGENTS、GUIDE、示例与自检；更正 steer 的术语描述"
```

---

## 交付后

- `docs/DESIGN.md` 的差异 ①② 由此消失（「截断输入：直接中断当前工作内容，立即发送」= `io.interrupt`；「直接赋予 Agent 的上下文」= `override` / `replace` / `erase` / `reset`）。
- 差异 ③④（实验室逐项声明 skills / extensions / model；`lab.get(id)`）按你的裁决**不动**，留在 `docs/DESIGN-解读.md` §5 封存区。
