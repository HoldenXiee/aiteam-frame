# 上下文·历史层实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给 `agent.context` 补上「改历史」的两层能力——**追改**（把已有轮次在本轮上下文里的贡献换成新内容）与**抹除**（把已有轮次从本轮上下文里删掉），底层走 pi 的 `SessionManager.appendContextEdit`。

**架构：** 先给 `context` 面加一个**寻址**成员（`context.entries()`，暴露会话 entry 的 `id` + 角色 + 预览），再加两个写成员 `replace(entryId, content)` / `erase(entryId)`。两者都是 **append-only 的 entry**，写完在当前轮的下一次请求生效，**不要求 idle、不触发 reload**。`reset`（整段重置）不在本计划内——它在 `DESIGN-解读.md` §5 封存。

**技术栈：** TypeScript、`node:test`、pi SDK 0.99.1、本机假 provider

**规格：** [`docs/DESIGN.md`](../../DESIGN.md)（手写版）+ [`docs/DESIGN-解读.md`](../../DESIGN-解读.md) §4.4（三层「赋予上下文」的落地与各自代价）。执行者两份都读。

## 全局约束

- 不新增依赖。
- 全部测试走本机假 provider；零 API 成本。
- 三个成员都**不要求 idle**：追改与抹除是 append-only entry，不走 `reload()`。只有 `compact` 保留 idle 守卫。
- `dispose` 之后三个成员都必须抛错（与七个面其余成员同一条判据，`R48`）。
- 本计划**不改** `examples/` 与 `demo/`（无新依赖）；只在任务 3 给 `docs/GUIDE.md` 补一段。
- 文案与注释用中文。不写「TODO」「待定」。
- 每个任务结束时：`npm run typecheck` 无输出，且 `npm test` 全绿。

## 审查重点（Review Focus）

1. **`history` 与 `entries()` 的下标错位。** `context.history` 不含 `system`，而 `sessionManager.getEntries()` 含全部 entry 类型。若 `entries()` 用 `history` 的下标去对 entry id，抹除会删错条目。测试见任务 1 步骤 1 第三条。
2. **entry id 传错。** `replace` / `erase` 收到不存在的 id → 必须抛错并给出该 id，不能静默 no-op。测试见任务 2 步骤 1 第二条。
3. **抹除后再看历史。** `erase` 之后 `context.history` 必须**变短**（被抹的条目不再出现在投影里），且 `RunResult.messages` 里也不含它。测试见任务 2 步骤 1 第一条。
4. **连续两次抹除。** 第二次不能因为「投影已变」而找错下标。测试见任务 2 步骤 1 第三条。
5. **未跑过任何一轮的空会话。** `entries()` 必须返回空数组而不是抛错。测试见任务 1 步骤 1 第一条。

---

### 任务 1：`context.entries()` —— 能寻址才谈得上改

**文件：**
- 修改：`src/agent/types.ts`、`src/surfaces/context.ts`
- 测试：`test/context.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
test("entries() 空会话返回空数组，不抛错", async () => {
  const a = await makeAgent();
  assert.deepEqual(a.context.entries(), []);
  a.dispose();
});

test("entries() 与 history 下标的对齐关系（entry.id，不是数组下标）", async () => {
  const a = await makeAgent();
  await a.io.prompt("第一句");
  await a.io.prompt("第二句");
  const entries = a.context.entries();
  assert.ok(entries.length >= 4, "两轮至少四条：user/assistant ×2");
  for (const e of entries) assert.equal(typeof e.id, "string");

  // 关键：entries() 过滤掉 system 之后，顺序与条数必须与 history 一一对应
  const visible = entries.filter((e) => e.role !== "system");
  assert.equal(
    visible.length,
    a.context.history.length,
    "entries() 的非 system 部分必须与 history 同长同序 —— 下标是可换的吗",
  );
  a.dispose();
});

test("entries() 的 id 真的能用：换一条的内容，历史里那条确实变了", async () => {
  const a = await makeAgent();
  await a.io.prompt("原始问题");
  const target = a.context.entries().find((e) => e.role === "user");
  assert.ok(target);
  await a.context.replace(target!.id, "被换掉的问题");
  assert.match(JSON.stringify(a.context.raw.sessionManager.buildSessionProjection().messages), /被换掉的问题/);
  a.dispose();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/context.test.ts`
预期：FAIL，`a.context.entries is not a function`

- [ ] **步骤 3：实现**

`src/agent/types.ts` 的 `ContextSurface` 增加：

```ts
/** 会话里的 entry（可寻址；system 也在里面，用 role 区分） */
entries(): { id: string; role: string; preview: string }[];
```

`replace` / `erase` 也在这里加上签名（本任务先只实现 `entries`，两个写成员抛 `尚未实现`，任务 2 补齐）：

```ts
/** 追改：把 entry 在本轮上下文里的贡献换成新内容。append-only，不要求 idle */
replace(entryId: string, content: string): Promise<void>;
/** 抹除：把 entry 从本轮上下文里删掉（原 entry 不动）。append-only，不要求 idle */
erase(entryId: string): Promise<void>;
```

`src/surfaces/context.ts` 实现 `entries()`：
- 数据源是 `sessionManager.buildSessionProjection().entries`（每项有 `sourceEntry` 与 `messages`）。
- 只保留 `messages.length > 0` 的项（状态型 entry 如 model 切换不对上下文有贡献）。
- `role` 取 `sourceEntry` 对应的消息角色（`messages[0].role`）。
- `preview`：把 `messages` 里所有 text 内容拼起来，截断到 60 字符。
- **顺序即投影顺序**，与 `history` 的一致性由步骤 1 第二条用例钉住。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/context.test.ts`
预期：PASS

- [ ] **步骤 5：跑全量**

运行：`npm run typecheck && npm test`
预期：typecheck 无输出；全绿

- [ ] **步骤 6：Commit**

```bash
git add src/agent/types.ts src/surfaces/context.ts test/context.test.ts
git commit -m "feat(context): entries() —— 会话条目的可寻址视图"
```

---

### 任务 2：`replace()` 与 `erase()`

**文件：**
- 修改：`src/surfaces/context.ts`
- 测试：`test/context.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
test("erase：抹掉一条之后，history 变短，且它不再出现在投影里", async () => {
  const a = await makeAgent();
  await a.io.prompt("第一句");
  const before = a.context.history.length;
  const target = a.context.entries().find((e) => e.role === "user")!;
  await a.context.erase(target.id);
  assert.ok(a.context.history.length < before, "history 必须变短");
  assert.ok(
    !JSON.stringify(a.context.raw.sessionManager.buildSessionProjection().messages).includes("第一句"),
    "被抹的条目不能再出现在发给模型的投影里",
  );
  a.dispose();
});

test("replace / erase 收到不存在的 id → 抛错，不静默 no-op", async () => {
  const a = await makeAgent();
  await a.io.prompt("一句话");
  await assert.rejects(() => a.context.replace("no-such-id", "x"), /no-such-id/);
  await assert.rejects(() => a.context.erase("no-such-id"), /no-such-id/);
  a.dispose();
});

test("连续两次 erase 不会找错下标", async () => {
  const a = await makeAgent();
  await a.io.prompt("甲");
  await a.io.prompt("乙");
  const users = a.context.entries().filter((e) => e.role === "user");
  assert.equal(users.length, 2);
  await a.context.erase(users[0].id);
  await a.context.erase(users[1].id);
  const msgs = JSON.stringify(a.context.raw.sessionManager.buildSessionProjection().messages);
  assert.ok(!msgs.includes("甲") && !msgs.includes("乙"));
  a.dispose();
});

test("replace 出来的内容真的进了下一次请求（跑一轮验证）", async () => {
  const a = await makeAgent();
  await a.io.prompt("原始问题");
  const target = a.context.entries().find((e) => e.role === "user")!;
  await a.context.replace(target.id, "替换后的问题");
  const before = faux.calls.length;
  await a.io.prompt("继续");
  assert.match(faux.calls[before].messagesText, /替换后的问题/);
  a.dispose();
});

test("erase 之后模型收到的那条消息确实不见了", async () => {
  const a = await makeAgent();
  await a.io.prompt("要被抹掉的一句");
  const target = a.context.entries().find((e) => e.role === "user")!;
  await a.context.erase(target.id);
  const before = faux.calls.length;
  await a.io.prompt("继续");
  assert.ok(!faux.calls[before].messagesText.includes("要被抹掉的一句"));
  a.dispose();
});

test("dispose 之后 replace / erase 都抛错", async () => {
  const a = await makeAgent();
  await a.io.prompt("一句话");
  const id = a.context.entries()[0].id;
  a.dispose();
  await assert.rejects(() => a.context.replace(id, "x"), /dispose/);
  await assert.rejects(() => a.context.erase(id), /dispose/);
});
```

后两条用例需要假服务记录**消息文本**（今天只记了 `messageCount`）。先给假服务加一个字段：
`test/faux-server.ts` 里每个 call 记录 `messagesText`（把所有消息的 text 内容拼成一个字符串）。
这是测试基建改动，**同时给 `examples/lib/faux-server.ts` 加上**（两份照抄，见仓库既有约定）。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test test/context.test.ts`
预期：FAIL，`a.context.erase is not a function` / `replace is not a function`

- [ ] **步骤 3：实现**

`src/surfaces/context.ts`，两个成员共用一段寻址逻辑：

- 从 `sessionManager.buildSessionProjection().entries` 里按 `sourceEntry.id === entryId` 找目标；**找不到就抛**，错误文案里带上 `entryId`。
- `replace(entryId, content)`：`sessionManager.appendContextEdit(entryId, { content })`。`content` 的形状必须是 pi 的 `ContextEditableContent`（`UserMessage["content"]` 等）；传字符串时按 `[{ type: "text", text: content }]` 包装后再 append（具体形状从 `pi` 的类型里取，不要自己发明）。
- `erase(entryId)`：`sessionManager.appendContextEdit(entryId, null)`。
- 两个成员都先 `deps.assertAlive()`。**不**调用 `deps.isBusy()`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test test/context.test.ts`
预期：PASS

- [ ] **步骤 5：跑全量**

运行：`npm run typecheck && npm test`
预期：typecheck 无输出；全绿（含此前 114 条）

- [ ] **步骤 6：Commit**

```bash
git add src/surfaces/context.ts test/context.test.ts test/faux-server.ts examples/lib/faux-server.ts
git commit -m "feat(context): replace/erase —— 追改与抹除历史（append-only，不要求 idle）"
```

---

### 任务 3：写进 GUIDE

**文件：**
- 修改：`docs/GUIDE.md`

- [ ] **步骤 1：在 `context` 面那一段后面补一节**

写明三件事，每件一句话加一段可跑代码：

1. **三层的区别**：`override` 改本轮（一次性）／`replace` `erase` 改历史（append-only，永久）／`reset` 不在库内。
2. **必须用 `entries()` 的 id**，不要用 `history` 的下标——`history` 不含 `system`，下标会错位。
3. **这三个写成员不要求 idle**，与 `tools.add` / `permissions.only` / `compact` 不同。

- [ ] **步骤 2：确认 GUIDE 里的代码能跑**

把新加的那段代码抄进 `examples/lib/snippets.ts` 对应的片段（若 GUIDE 引用的是 snippets，就同步 snippets），然后：

运行：`node -e "import('./examples/lib/snippets.ts').then(()=>console.log('ok'))" 2>&1 | tail -3`（若 snippets 没有 main，就写一个临时脚本跑一遍新加的那段）

预期：无异常

- [ ] **步骤 3：Commit**

```bash
git add docs/GUIDE.md examples/lib/snippets.ts
git commit -m "docs(GUIDE): context 的改本轮 / 改历史三层，以及为什么必须用 entries() 的 id"
```

---

## 交接

**本计划不覆盖的、已登记的项**（`docs/DESIGN-解读.md` §5，不要顺手做）：

- **`reset()`（整段重置）**：换 session / 新建 agent / 逐条抹除三条路还没选。它需要实验室（plan-3）落地后才有地方安放，所以排在 plan-3 之后。
- 压缩策略是否可介入、token 估算归谁、观测粒度与落盘。

**验收基线**：`npm run typecheck` 无输出；`npm test` 全绿；`test/context.test.ts` 新增用例全过。
