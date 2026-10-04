// context 面：history / usage / autoCompact / override / compact / raw。
//
// 语义依据 spike/FINDINGS.md S2（已实测，不许重新假设）：
//   - `override` 改的是「**这一轮**发给模型的」，逐轮生效、不动历史，`session.messages` 照常增长；
//   - pi 传给钩子的是**副本**，所以历史不会被写坏；
//   - 钩子拿到的是**不含 system** 的消息 —— 所以 `history` 也用同一个视角（system 每轮由 pi 重建，
//     不是历史；这样 `override(history)` 才是恒等）。
import test from "node:test";
import assert from "node:assert/strict";
import { faux, makeAgent, sentMessages } from "./helpers.ts";
import { sleep } from "./faux-server.ts";

test("history 是会话里存的历史（只读快照）", async () => {
  const a = await makeAgent();
  try { await a.io.prompt("hi"); assert.deepEqual(a.context.history.map((m) => m.role), ["user", "assistant"]); }
  finally { a.dispose(); }
});

test("override 只改这一轮发给模型的，不动历史", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("one");
    const h1 = a.context.history.length;
    a.context.override((m) => m.slice(-1));
    await a.io.prompt("two");
    assert.equal(sentMessages(), 2);            // system + 1 条
    assert.ok(a.context.history.length > h1);   // 历史照常增长
    a.context.override(undefined);              // 清除
    await a.io.prompt("three");
    assert.ok(sentMessages() > 2);              // 恢复完整
  } finally { a.dispose(); }
});

test("compact() 成功，且 session_before_compact / session_compact 被触发", async () => {
  const a = await makeAgent();
  const fired: string[] = [];
  a.onAny((e) => { if (e.type.includes("compact")) fired.push(e.type); });
  try {
    // 必须造一段比 keepRecentTokens（默认 20000）更长的历史，否则 pi 认为「session too small」、
    // 根本没东西可压（prepareCompaction 返回 undefined）。[[huge:N]] 是假服务的脚本标记。
    await a.io.prompt("[[huge:200000]] one");
    await a.context.compact("压成一句");
    assert.ok(fired.includes("session_before_compact"));
    assert.ok(fired.includes("session_compact"));
  } finally { a.dispose(); }
});

test("R27：运行中调 compact() 抛错，且在飞的那轮不被静默打断", async () => {
  const a = await makeAgent();
  try {
    // 先攒一段可压历史：否则「抛错」可能只是 pi 的 session too small，判不出守卫有没有生效
    await a.io.prompt("[[huge:200000]] warm");
    const p = a.io.prompt("[[sleep:400]] 慢");   // 不 await：制造在飞轮次
    await assert.rejects(() => a.context.compact("压成一句"), /waitIdle|context\.raw/);
    const result = await p;   // 真价值在这：在飞的那轮没被 pi 的首行 abort() 打断，正常跑完
    assert.ok(result.text.length > 0, `在飞的那轮应当正常跑完并拿到文本，实际：${JSON.stringify(result)}`);
    await a.context.compact("压成一句");   // idle 之后正常路径不被误伤（守卫不是粘的）
  } finally {
    a.dispose();
  }
});

test("autoCompact 可读写，且反映到 session", async () => {
  const a = await makeAgent();
  try {
    a.context.autoCompact = true;
    assert.equal(a.context.autoCompact, true);
    assert.equal(a.context.raw.session.autoCompactionEnabled, true);
    a.context.autoCompact = false;              // 双向都要真的写下去（默认就是 true，只写 true 判不出写没写）
    assert.equal(a.context.autoCompact, false);
    assert.equal(a.context.raw.session.autoCompactionEnabled, false);
  } finally { a.dispose(); }
});

test("usage 是上下文占用，读不到时返回 undefined（不抛错）", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("one");
    assert.doesNotThrow(() => a.context.usage);
    assert.equal(a.context.usage?.contextWindow, 200000);   // 真读到了 pi 的上下文窗口，不是假的 undefined
  } finally { a.dispose(); }
});

test("override 也接受直接给一组消息", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("one");
    const keep = a.context.history.slice(-1);
    a.context.override(keep);
    await a.io.prompt("two");
    assert.equal(sentMessages(), 2);
  } finally { a.dispose(); }
});

test("创建期的 context.autoCompact 真的落到 session 上", async () => {
  const a = await makeAgent({ context: { autoCompact: false } });
  try {
    assert.equal(a.context.autoCompact, false);
    assert.equal(a.context.raw.session.autoCompactionEnabled, false);
  } finally { a.dispose(); }
});

test("override 与只观测的监听器共存：槽位的结果照常生效（槽位排在监听表之前）", async () => {
  const a = await makeAgent();
  const seen: number[] = [];
  a.on("context", (e) => { seen.push(e.messages.length); return undefined; });   // 只观测，不返回变换
  a.context.override((m) => m.slice(-1));
  try {
    await a.io.prompt("one");
    await a.io.prompt("two");
    assert.equal(sentMessages(), 2, "override 的结果应该照常发给模型");
    assert.deepEqual(seen, [1, 3]);   // 监听器看到的是 override **之前**的原始可见消息（不含 system）
  } finally { a.dispose(); }
});

test("设了 override 之后 on('context') 再返回变换 → 抛错，不静默只生效一个（R26）", async () => {
  // 专属槽位与监听表共用同一个「已有非空结果」守卫：槽位先占位，监听器再返回变换就是第二个。
  // pi 的 emitContext 会把 handler 抛的错吞进 emitError，而那条路只有 createAgent 注册的扩展错误
  // 监听器能浮到 console.error —— 所以这里断言的就是那条消息。
  const a = await makeAgent();
  a.context.override((m) => m.slice(-1));
  a.on("context", (e: any) => ({ messages: e.messages }));
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    await a.io.prompt("hi");
  } finally {
    console.error = original;
    a.dispose();
  }
  assert.ok(
    logged.some((line) => line.includes("已有监听器返回了变换结果")),
    `应当报「同一事件只允许一个监听器返回变换结果」，实际：${logged.join(" | ") || "（无输出）"}`,
  );
});

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
  // preview 是这条 entry 的文本摘要：真取到了正文，且截断到 60 字符
  for (const e of visible) assert.ok(e.preview.length <= 60);
  assert.ok(visible.some((e) => e.preview.includes("第一句")), "preview 应当是这条 entry 的文本");
  a.dispose();
});

test("压缩之后 entries() 仍与 history 逐项对齐（compaction entry 投影出 system + 摘要两条）", async () => {
  const a = await makeAgent();
  try {
    // 必须先攒够可压历史，否则 pi 认为 session too small、压根不产生 compaction entry（该文件上面的用例同理）
    await a.io.prompt("[[huge:200000]] one");
    await a.io.prompt("two");
    await a.context.compact("压成一句");
    assert.equal(a.context.history[0].role, "compactionSummary", "压缩确实发生了（否则这条用例什么都没钉住）");
    assert.deepEqual(
      a.context.entries().filter((e) => e.role !== "system").map((e) => e.role),
      a.context.history.map((m) => m.role),
      "压缩后 entry 与 history 必须逐项同序同角色 —— 不能拿 role === system 当过滤口径",
    );
  } finally {
    a.dispose();
  }
});

test("dispose 之后 context 面不许再用", async () => {
  const a = await makeAgent();
  a.dispose();
  assert.throws(() => a.context.history);
  assert.throws(() => a.context.override(() => []));
  assert.throws(() => a.context.entries());
  await assert.rejects(() => a.context.compact(), /disposed/);
});

// ---------------------------------------------------------------------------
// replace / erase：历史可改（append-only entry，不是改原 entry，也不要求 idle）
// ---------------------------------------------------------------------------

test("entries() 的 id 真的能用：换一条的内容，历史里那条确实变了", async () => {
  const a = await makeAgent();
  await a.io.prompt("原始问题");
  const target = a.context.entries().find((e) => e.role === "user");
  assert.ok(target);
  await a.context.replace(target!.id, "被换掉的问题");
  // 追改 = 换掉那一条，不是再注入一条：只断言「新文本在」判不出「旧文本还在」。
  // 假 provider 会把用户原话回显进助手回复（echo:原始问题），所以不能直接在整份投影里找「原始问题」，
  // 要看**投影里的 user 消息**：只有一条，且它是被换掉的那条。
  const proj = a.context.raw.sessionManager.buildSessionProjection().messages;
  const userTexts = proj
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  assert.equal(userTexts.length, 1, "追改是换掉那一条，不是再注入一条");
  assert.match(userTexts[0], /被换掉的问题/);
  assert.ok(!userTexts[0].includes("原始问题"), "追改是换掉，不是注入：旧文本必须消失");
  a.dispose();
});

test("erase：抹掉一轮之后，history 变短，且它不再出现在投影里", async () => {
  const a = await makeAgent();
  await a.io.prompt("第一句");
  const before = a.context.history.length;
  // 假 provider 会把用户原话回显进助手回复（echo:第一句），只抹 user 会留下回显副本 ——
  // 要断言「这段文本从投影里消失」，就得抹掉承载它的整轮（user + assistant）。
  const doomed = a.context.entries().filter((e) => e.role === "user" || e.role === "assistant");
  assert.equal(doomed.length, 2);
  for (const e of doomed) await a.context.erase(e.id);
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

/** 断言「不可编辑」的中文错：文案命中可编辑类措辞，且带上这个 id */
const assertNotEditable = async (fn: () => Promise<void>, id: string) => {
  await assert.rejects(fn, (err: Error) => {
    assert.match(err.message, /不参与可编辑|只可寻址|可编辑/);
    assert.match(err.message, new RegExp(id), "错误文案必须带上这个 entry 的 id");
    return true;
  });
};

test("entries() 含 system 条目，但 system 只可寻址、不可编辑（replace/erase 抛中文错）", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("一句话");
    const system = a.context.entries().find((e) => e.role === "system");
    assert.ok(system, "按设计 entries() 必须包含 system 条目（否则与 history 的对齐关系不成立）");
    await assertNotEditable(() => a.context.replace(system!.id, "x"), system!.id);
    await assertNotEditable(() => a.context.erase(system!.id), system!.id);
  } finally {
    a.dispose();
  }
});

test("entries() 含压缩摘要条目，但它只可寻址、不可编辑（erase 抛中文错）", async () => {
  const a = await makeAgent();
  try {
    // 沿用本文件已有的压缩基建：不攒够历史 pi 认为 session too small，压根没有压缩条目
    await a.io.prompt("[[huge:200000]] one");
    await a.context.compact("压成一句");
    assert.equal(a.context.history[0].role, "compactionSummary", "压缩确实发生了（否则这条用例什么都没钉住）");
    const summary = a.context.entries().find((e) => e.role === "compactionSummary");
    assert.ok(summary, "压缩后的 entries() 必须包含压缩摘要条目（否则与 history 的对齐关系不成立）");
    await assertNotEditable(() => a.context.erase(summary!.id), summary!.id);
  } finally {
    a.dispose();
  }
});

test("连续两次 erase 不会找错下标", async () => {
  const a = await makeAgent();
  await a.io.prompt("甲");
  await a.io.prompt("乙");
  const users = a.context.entries().filter((e) => e.role === "user");
  assert.equal(users.length, 2);
  // 先按捕获的 id 连抹两个 user（中间投影已变，仍不许找错条目）
  await a.context.erase(users[0].id);
  await a.context.erase(users[1].id);
  // 再抹助手回显，才能断言「甲」「乙」彻底不在投影里
  for (const e of a.context.entries().filter((e) => e.role === "assistant")) {
    await a.context.erase(e.id);
  }
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
  const doomed = a.context.entries().filter((e) => e.role === "user" || e.role === "assistant");
  for (const e of doomed) await a.context.erase(e.id);
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

test("idle 时抹掉一整轮，不影响之后那轮的结算（RunResult.messages / text）", async () => {
  const a = await makeAgent();
  try {
    await a.io.prompt("要被抹掉的一句");
    const doomed = a.context.entries().filter((e) => e.role === "user" || e.role === "assistant");
    for (const e of doomed) await a.context.erase(e.id);
    // 结算区间靠 `io` 的「运行前下标 → slice」切出来，而 pi 会在回合边界从投影重建 `agent.state.messages`。
    // 忙时编辑会让重建后的数组比下标短、切到数组之外；idle 时编辑则不该影响后面那轮的结算。
    const r = await a.io.prompt("继续");
    assert.ok(r.text.length > 0, "忙时编辑会打坏结算，空闲时不该受影响");
    assert.ok(r.messages.some((m) => m.role === "assistant"), "本轮产出必须出现在结算区间里");
    assert.ok(!JSON.stringify(r.messages).includes("要被抹掉的一句"), "被抹的条目不该回到结算区间");
  } finally {
    a.dispose();
  }
});

test("忙时编辑：本轮 RunResult 不再包含产出（已登记边界，防止 pi 升级后文档变谎言）", async () => {
  const a = await makeAgent();
  await a.io.prompt("旧的");
  const doomed = a.context.entries().filter((e) => e.role === "user" || e.role === "assistant");
  const p = a.io.prompt("[[sleep:400]] 新的");          // 不 await：制造在飞那轮
  await sleep(120);
  for (const e of doomed) await a.context.erase(e.id);  // 在飞期间编辑历史
  const r = await p;
  assert.equal(r.text, "", "忙时编辑会把结算区间切到数组之外 —— 这是 boundary，不是期望行为");
  assert.ok(r.messages.length === 0, "同上：结算区间为空");
  assert.ok(a.context.history.some((m) => m.role === "assistant"), "产出本身仍然持久化在历史里");
  a.dispose();
});

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
