// context 面：history / usage / autoCompact / override / compact / raw。
//
// 语义依据 spike/FINDINGS.md S2（已实测，不许重新假设）：
//   - `override` 改的是「**这一轮**发给模型的」，逐轮生效、不动历史，`session.messages` 照常增长；
//   - pi 传给钩子的是**副本**，所以历史不会被写坏；
//   - 钩子拿到的是**不含 system** 的消息 —— 所以 `history` 也用同一个视角（system 每轮由 pi 重建，
//     不是历史；这样 `override(history)` 才是恒等）。
import test from "node:test";
import assert from "node:assert/strict";
import { makeAgent, sentMessages } from "./helpers.ts";

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

test("dispose 之后 context 面不许再用", async () => {
  const a = await makeAgent();
  a.dispose();
  assert.throws(() => a.context.history);
  assert.throws(() => a.context.override(() => []));
  await assert.rejects(() => a.context.compact(), /disposed/);
});
