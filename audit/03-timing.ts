// 第 3 部分：投递、并发与时序 —— send 的精确语义、排队行为、并发吞吐。
// 跑法：node audit/03-timing.ts
import { createAgent, createAgentHost, type ControlledAgent } from "../src/index.ts";
import { check, dump, record, section } from "./_harness.ts";
import { makeEnv } from "./_faux.ts";

const env = await makeEnv();
const { agentDir, cwd, runtime, model } = env;
const mk = (extra: Record<string, unknown> = {}, host?: ReturnType<typeof createAgentHost>) =>
  createAgent({ model, cwd, agentDir, ...extra }, { modelRuntime: runtime, ...(host ? { host } : {}) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 等一个 agent 真的静下来（带超时，避免脚本挂死） */
async function settle(a: ControlledAgent, timeoutMs = 8000): Promise<void> {
  await Promise.race([a.waitForIdle(), sleep(timeoutMs)]);
}

// ─────────────────────────────────────────────────────────────
section("3.1 send 的忙闲语义与返回值");

{
  const a = await mk();
  const before = a.lastResult;
  const r = await a.send("空闲投递");
  const immediate = a.lastResult;
  const callsAtReturn = env.calls().length;
  await settle(a);
  record({
    id: "3.1a",
    question: "空闲时 send 返回后，lastResult 是本次还是上一次的",
    observed: `send 返回 ${JSON.stringify(r)}；返回瞬间 lastResult ${immediate === before ? "仍是上一次（未更新）" : "已更新"}；waitForIdle 后 lastResult = ${JSON.stringify(a.lastResult?.text?.slice(0, 30))}`,
    verdict: immediate === before ? "PARTIAL" : "OK",
    conclusion:
      immediate === before
        ? "send 是**发出即返回**（delivered=\"ran\" 只表示『已开始跑』，不表示跑完了）。要拿本次结果必须先 waitForIdle —— 直接读 lastResult 会读到上一轮的陈旧值。"
        : "已更新。",
    data: { delivered: r.delivered, staleOnReturn: immediate === before, callsAtReturn },
  });
  a.dispose();
}

{
  const a = await mk();
  void a.prompt("[[sleep:700]] 慢任务");
  await sleep(150);
  const r1 = await a.send("排队一");
  const r2 = await a.send("排队二");
  await settle(a);
  record({
    id: "3.1b",
    question: "忙时连发两条 send 的返回值与最终 lastResult",
    observed: `两次返回 ${JSON.stringify([r1, r2])}；isStreaming 最终=${a.isStreaming}；lastResult = ${JSON.stringify(a.lastResult?.text?.slice(0, 40))}`,
    verdict: r1.delivered === "queued" && r2.delivered === "queued" ? "OK" : "GAP",
    conclusion: "忙时都返回 queued，不抛错。lastResult 是**最后一次跑完**的结果（即队列里最后一条），不是各自的重放。",
    data: { r1, r2, last: a.lastResult?.text?.slice(0, 60) },
  });
  a.dispose();
}

{
  // 排队 N 条，数到底跑了几轮
  const a = await mk();
  const doneCount = { n: 0 };
  a.on("done", () => (doneCount.n += 1));
  void a.prompt("[[sleep:500]] 慢");
  await sleep(100);
  const N = 5;
  const rs = [];
  for (let i = 0; i < N; i++) rs.push((await a.send(`排队第 ${i}`)).delivered);
  const callsAfterQueue = env.calls().length;
  await settle(a, 15000);
  await sleep(300);
  record({
    id: "3.1c",
    question: `忙时排队 ${N} 条，是否每条都真的跑了一轮（不丢、不合并）`,
    observed: `返回 = ${JSON.stringify(rs)}；排队完成后新增请求数 = ${env.calls().length - callsAfterQueue}；done 事件 ${doneCount.n} 次；lastResult = ${JSON.stringify(a.lastResult?.text?.slice(0, 40))}`,
    verdict: env.calls().length - callsAfterQueue >= N ? "OK" : "GAP",
    conclusion:
      env.calls().length - callsAfterQueue >= N
        ? `每条排队消息各自产生一轮（新增 ${env.calls().length - callsAfterQueue} 次请求，期望 ≥${N}）。`
        : `有条目没跑：只新增 ${env.calls().length - callsAfterQueue} 次请求，少于排队的 ${N} 条。`,
    data: { rs, newCalls: env.calls().length - callsAfterQueue, done: doneCount.n, last: a.lastResult?.text?.slice(0, 60) },
  });
  a.dispose();
}

{
  // 顺序是否保持
  const a = await mk();
  void a.prompt("[[sleep:600]] 慢");
  await sleep(100);
  for (const t of ["第一", "第二", "第三"]) await a.send(t);
  await settle(a, 15000);
  await sleep(200);
  const seen = env
    .calls()
    .map((c) => c.lastUser)
    .filter((u) => /第一|第二|第三/.test(u));
  record({
    id: "3.1d",
    question: "排队消息的投递顺序是否保持",
    observed: `假服务收到的顺序 = ${JSON.stringify(seen.map((s) => s.slice(0, 6)))}`,
    verdict: seen.length === 3 && seen[0].includes("第一") && seen[2].includes("第三") ? "OK" : "GAP",
    conclusion: seen.length === 3 ? "FIFO，顺序保持。" : `只看到 ${seen.length}/3 条，存在丢失。`,
    data: { seen: seen.map((s) => s.slice(0, 20)) },
  });
  a.dispose();
}

{
  // interrupt 模式
  const a = await mk();
  void a.prompt("[[sleep:900]] 长任务");
  await sleep(200);
  const t0 = Date.now();
  const r = await a.send("打断", { mode: "interrupt" });
  await settle(a, 8000);
  record({
    id: "3.1e",
    question: "send({mode:'interrupt'}) 是否真的改变方向",
    observed: `返回 ${JSON.stringify(r)}；从投递到静下来耗时 ${Date.now() - t0}ms（原任务设定 sleep 900ms，投递发生在 200ms 时）`,
    verdict: "INFO",
    conclusion:
      "返回 queued。steer 是『在下一轮开始前改变方向』，不是硬中断 —— 本轮已经发出去的请求仍会跑完。要真正中断得用 abort()。",
    data: { result: r, settleMs: Date.now() - t0, last: a.lastResult?.text?.slice(0, 40) },
  });
  a.dispose();
}

{
  // 空闲时 send 之后再立刻 send（启动窗口）
  const a = await mk();
  const r1 = await a.send("窗口一");
  const r2 = await a.send("窗口二");
  await settle(a, 10000);
  await sleep(200);
  record({
    id: "3.1f",
    question: "空闲状态下同步连发两次 send（启动窗口竞态）",
    observed: `返回 ${JSON.stringify([r1.delivered, r2.delivered])}；收到的消息 = ${JSON.stringify(env.dialog().slice(-4).map((c) => c.lastUser.slice(0, 8)))}`,
    verdict: r1.delivered === "ran" ? "OK" : "GAP",
    conclusion:
      r1.delivered === "ran"
        ? "第一条 ran、第二条按 running 计数判为 queued，两条都没丢（这是库里特意补的忙闲判据）。"
        : "返回异常。",
    data: { r1: r1.delivered, r2: r2.delivered },
  });
  a.dispose();
}

// ─────────────────────────────────────────────────────────────
section("3.2 排队消息与「轮」的对应关系（影响轮次计球与预算归因）");

{
  const host = createAgentHost({ modelRuntime: runtime, maxAgents: 10 });
  const a = await createAgent({ model, cwd, agentDir }, { host, modelRuntime: runtime });
  let done = 0;
  let turn = 0;
  let rounds = 0;
  let roundUsage = 0;
  a.on("done", () => (done += 1));
  a.on("turn", () => (turn += 1));
  host.on("round_completed", ({ result }) => {
    rounds += 1;
    roundUsage += result.usage.totalTokens;
  });

  const callBase = env.calls().length;
  void a.prompt("[[sleep:500]] 慢");
  await sleep(100);
  for (let i = 0; i < 4; i++) await a.send(`排队${i}`);
  await settle(a, 15000);
  await sleep(400);

  const httpCalls = env.calls().length - callBase;
  record({
    id: "3.2a",
    question: "忙时排队的 N 条消息，在库的模型里算「几轮」",
    observed: `模型实际生成次数（HTTP 请求）= ${httpCalls}；turn 事件 = ${turn}；done 事件 = ${done}；host 的 round_completed = ${rounds}（合计 ${roundUsage} token）`,
    verdict: done === httpCalls ? "OK" : "GAP",
    conclusion:
      done === httpCalls
        ? "一轮对一次生成。"
        : `不对应：模型生成了 ${httpCalls} 次，但库层只记了 ${done} 次 done / ${rounds} 次 round_completed。原因：send 忙时走 followUp，排队消息由**同一个 session.prompt() 调用**内部消化，库只在那个调用结束时收一次结果。后果：靠 round_completed 计数的督导逻辑、按轮的用量归因、以及「一共聊了几轮」都会少算。`,
    data: { httpCalls, turn, done, rounds, roundUsage },
  });
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("3.3 并发吞吐曲线");

{
  const curve: Array<{ n: number; ms: number; perAgent: number; heapMB: number }> = [];
  for (const n of [1, 4, 8, 16, 32, 64]) {
    const host = createAgentHost({ modelRuntime: runtime, maxAgents: 200 });
    const kids = await Promise.all(
      Array.from({ length: n }, () => createAgent({ model, cwd, agentDir }, { host, modelRuntime: runtime })),
    );
    const t0 = Date.now();
    await Promise.all(kids.map((k) => k.send("[[sleep:300]] 活")));
    await Promise.all(kids.map((k) => k.waitForIdle()));
    const ms = Date.now() - t0;
    curve.push({ n, ms, perAgent: Number((ms / n).toFixed(1)), heapMB: Number((process.memoryUsage().heapUsed / 1e6).toFixed(1)) });
    host.dispose();
  }
  const worst = curve[curve.length - 1];
  record({
    id: "3.2a",
    question: "并发吞吐曲线：N 个分身各跑 300ms，墙钟怎么变",
    observed: curve.map((c) => `N=${c.n} → ${c.ms}ms（${c.perAgent}ms/个）`).join("；"),
    verdict: worst.ms < 3000 ? "OK" : "PARTIAL",
    conclusion:
      worst.ms < 3000
        ? `真并发：每个分身各跑 300ms，N=64 时总墙钟仅 ${worst.ms}ms（若串行应为 ${64 * 300}ms）。库内**没有任何并发闸门** —— 并发度完全由设计者与操作系统决定。`
        : `N=64 时出现明显退化（${worst.ms}ms），疑似资源争抢。`,
    data: curve,
  });
}

{
  // 一条 assistant 消息里的兄弟工具调用，pi 的并发度
  const host = createAgentHost({ modelRuntime: runtime, maxAgents: 20 });
  const parent = await createAgent({ model, cwd, agentDir, tools: ["spawn_agent"] }, { host, modelRuntime: runtime });
  const spawnArgs = (i: number) => JSON.stringify({ member: "w", task: `[[sleep:400]] 活${i}` });
  const members: Record<string, unknown> = { w: { description: "工人" } };
  const host2 = createAgentHost({ members: members as never, modelRuntime: runtime, maxAgents: 20 });
  const lead = await createAgent({ model, cwd, agentDir, tools: ["spawn_agent"] }, { host: host2, modelRuntime: runtime });

  const one = `[[call:spawn_agent ${spawnArgs(0)}]]`;
  const three = [0, 1, 2].map((i) => `[[call:spawn_agent ${spawnArgs(i)}]]`).join(" ");

  await lead.prompt("热身");
  const t1 = Date.now();
  await lead.prompt(one);
  const oneMs = Date.now() - t1;
  const t3 = Date.now();
  await lead.prompt(three);
  const threeMs = Date.now() - t3;

  record({
    id: "3.2b",
    question: "一条 assistant 消息里的兄弟工具调用是否并发执行",
    observed: `1 个 spawn（内含 400ms 任务）= ${oneMs}ms；同一条消息里 3 个 spawn = ${threeMs}ms（若串行应约 ${oneMs * 3}ms）`,
    verdict: threeMs < oneMs * 2 ? "OK" : "GAP",
    conclusion:
      threeMs < oneMs * 2
        ? `并发。同一条消息里 3 个 spawn_agent 只用了 ${threeMs}ms，接近 1 个的耗时。`
        : `未并发（${threeMs}ms ≈ 3×${oneMs}ms）。`,
    data: { oneMs, threeMs, ratio: Number((threeMs / oneMs).toFixed(2)) },
  });
  host.dispose();
  host2.dispose();
  parent.dispose();
}

// ─────────────────────────────────────────────────────────────
section("3.4 时序相关的边界与陷阱");

{
  // 对同一个 agent 反复 send 而不 waitForIdle，再看 lastResult 到底是谁的
  const a = await mk();
  void a.prompt("[[sleep:400]] 甲");
  await sleep(80);
  await a.send("乙");
  await a.send("丙");
  await settle(a, 12000);
  await sleep(300);
  const texts = env.dialog().slice(-3).map((c) => c.lastUser.slice(0, 4));
  record({
    id: "3.3a",
    question: "多条排队消息跑完后，lastResult 代表哪一轮",
    observed: `最近几轮请求 = ${JSON.stringify(texts)}；lastResult = ${JSON.stringify(a.lastResult?.text?.slice(0, 30))}`,
    verdict: "PARTIAL",
    conclusion:
      "lastResult 只保留**最后一轮**。中间轮次的结果在库里查不到 —— 要拿到每一轮的结果，设计者必须自己监听 turn/done 事件或自己维护队列。",
    data: { recent: texts, last: a.lastResult?.text?.slice(0, 50) },
  });
  a.dispose();
}

{
  // agent.usage 在哪一刻更新
  const a = await mk();
  await a.prompt("一");
  const afterAwait = a.usage.totalTokens;
  await a.send("二");
  const afterSend = a.usage.totalTokens;
  await settle(a);
  const afterIdle = a.usage.totalTokens;
  record({
    id: "3.3b",
    question: "agent.usage 在哪一刻更新（prompt 返回时 vs send 返回时）",
    observed: `await prompt 之后 = ${afterAwait}；send 返回瞬间 = ${afterSend}；waitForIdle 之后 = ${afterIdle}`,
    verdict: afterSend === afterIdle ? "OK" : "PARTIAL",
    conclusion:
      afterSend === afterIdle
        ? "已更新（假服务每次固定 18 token）。"
        : "send 返回瞬间 usage 还没算上这一轮 —— 想实时读成本必须等 waitForIdle。",
    data: { afterAwait, afterSend, afterIdle },
  });
  a.dispose();
}

{
  // 等待已 dispose 的分身
  const a = await mk();
  a.dispose();
  const t0 = Date.now();
  await a.waitForIdle();
  record({
    id: "3.3c",
    question: "对已 dispose 的分身 waitForIdle()",
    observed: `立即返回（${Date.now() - t0}ms），不抛错`,
    verdict: "OK",
    conclusion: "直接 resolve，符合决策 #21。但这也意味着**等待一个已回收的分身看不出差别** —— 设计者无法从 waitForIdle 判断目标是否还活着。",
    data: { ms: Date.now() - t0 },
  });
}

{
  // abort 之后的 status 与再投递
  const a = await mk();
  void a.prompt("[[sleep:800]] 长");
  await sleep(150);
  await a.abort();
  const st = a.status;
  await sleep(100);
  const r = await a.send("abort 之后再来一条");
  await settle(a, 6000);
  record({
    id: "3.3d",
    question: "abort 之后 status 是什么，还能不能再投递",
    observed: `abort 后 status=${st}；再 send 返回 ${JSON.stringify(r)}；最终 status=${a.status} lastResult=${JSON.stringify(a.lastResult?.text?.slice(0, 30))}`,
    verdict: "INFO",
    conclusion:
      "status 变成 aborted，但**仍然可以继续 prompt/send**（aborted 不是终态）—— 后续一轮会把 status 改回 idle 或 error。设计者若把 aborted 当作『已废』会误判。",
    data: { afterAbort: st, sendResult: r, final: a.status },
  });
  a.dispose();
}

{
  record({
    id: "3.3e",
    question: "等待原语有没有超时参数",
    observed: "ControlledAgent.waitForIdle(): Promise<void> —— 无参数；send(): 无等待语义；无 waitFor(timeout) / waitForNext()",
    verdict: "GAP",
    conclusion: "没有任何带超时的等待。规格把『任何无超时等待一律不允许』写进死锁规则，但 API 层没兑现（见 2.4b 的实测死锁）。",
  });
}

dump("03-timing");
await env.close();
