// E2：send() 排队之后 —— 谁会唤醒它？没人唤醒时有没有任何信号？
// 每个场景都打印：库返回的 delivered、SDK 队列长度、请求正文、wake 后是否真跑到。
import { createAgent, createAgentHost } from "../../src/index.ts";
import { makeEnv2 } from "./_srv.ts";
import { sleep } from "../../test/faux-server.ts";
import { save } from "./_data.ts";

const env = await makeEnv2();
const rows: any[] = [];
const rec = (k: string, v: any) => {
  rows.push({ case: k, ...v });
  console.log(`  ▶ ${k}: ${JSON.stringify(v)}`);
};

/** 直接建 agent（带 host，便于看 round_completed） */
async function mk(hostOpts: any = {}) {
  const host = createAgentHost(hostOpts);
  const roundCompleted: any[] = [];
  host.on("round_completed", (p: any) => roundCompleted.push({ agent: p.agent.id, text: p.result.text.slice(0, 40) }));
  const a = await createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir }, { modelRuntime: env.runtime, host });
  return { a, host, roundCompleted };
}
const q = (a: any) => ({ pending: a.session.pendingMessageCount, steerQ: [...a.session.getSteeringMessages()], followQ: [...a.session.getFollowUpMessages()] });
/** 库层面有没有任何可观察量能表示「还有消息没跑」 */
const observables = (a: any, host: any) => ({
  status: a.status,
  isStreaming: a.isStreaming,
  lastResultText: a.lastResult?.text?.slice(0, 30) ?? null,
  lastResultError: a.lastResult?.error ?? null,
  usageTotal: a.usage.totalTokens,
  hostActiveCount: host.activeCount,
  hostUsage: host.usage.totalTokens,
  sessionPending: a.session.pendingMessageCount,
});

console.log("═══ E2-1 对照组：忙时 send（queued）→ 正常跑完 ═══");
{
  const { a, host, roundCompleted } = await mk();
  const from = env.srv.calls.length;
  let doneCount = 0;
  a.on("done", () => (doneCount += 1));
  const p = a.prompt("[[sleep:500]] P1");
  await sleep(120);
  const r = await a.send("Q1-BUSY");
  const obsAtQueue = observables(a, host);
  await a.waitForIdle();
  const runText = await p;
  const obsAfterIdle = observables(a, host);
  await sleep(200);
  rec("ctl/busy-send", {
    send返回: r,
    排队瞬间可观察量: obsAtQueue,
    waitForIdle后可观察量: obsAfterIdle,
    prompt返回文本: runText.text,
    Q1是否到过模型: env.srv.contains("Q1-BUSY", from),
    请求次数: env.srv.calls.length - from,
    剩余pending: q(a).pending,
    done事件数: doneCount,
    round_completed: roundCompleted,
    请求正文: env.srv.digest(from),
  });
  a.dispose();
}

console.log("\n═══ E2-2 忙时 send（queued）→ 立刻 abort 当前轮 ═══");
{
  const { a, host, roundCompleted } = await mk();
  const from = env.srv.calls.length;
  const p = a.prompt("[[sleep:900]] P2").catch((e) => `throw:${(e as Error).message}`);
  await sleep(150);
  const r = await a.send("Q2-THEN-ABORT");
  const obsAtQueue = observables(a, host);
  await a.abort();
  const pendingRightAfterAbort = q(a);
  await p;
  await sleep(200);
  const pendingLater = q(a);
  const obsLater = observables(a, host);
  // 再 prompt 一次，看 Q2 会不会被唤醒
  let afterNextPrompt: any = null;
  try {
    const rr = await a.prompt("P2-NEXT");
    afterNextPrompt = { text: rr.text, pending: q(a).pending, Q2到过模型: env.srv.contains("Q2-THEN-ABORT", from) };
  } catch (e: any) {
    afterNextPrompt = { throw: e.message };
  }
  rec("queued+abort", {
    send返回: r,
    排队瞬间可观察量: obsAtQueue,
    abort后队列: pendingRightAfterAbort,
    等200ms后队列: pendingLater,
    等后观察量: obsLater,
    下一次prompt后: afterNextPrompt,
    round_completed: roundCompleted,
    请求正文: env.srv.digest(from),
  });
  a.dispose();
}

console.log("\n═══ E2-3 send（queued）→ 当前轮失败（HTTP 400）→ 队列谁来收 ═══");
{
  const { a, host, roundCompleted } = await mk();
  const from = env.srv.calls.length;
  let errEvents: string[] = [];
  a.on("error", (e: any) => errEvents.push(e.message));
  const p = a.prompt("[[fail]] P3").then((r) => `ok:${r.text}`, (e) => `throw:${(e as Error).message}`);
  await sleep(150);
  const r = await a.send("Q3-THEN-FAIL");
  const obsAtQueue = observables(a, host);
  const promptOutcome = await p;
  await sleep(300);
  const qAfterFail = q(a);
  let afterNextPrompt: any = null;
  try {
    const rr = await a.prompt("P3-NEXT");
    afterNextPrompt = { text: rr.text, pending: q(a).pending, Q3到过模型: env.srv.contains("Q3-THEN-FAIL", from) };
  } catch (e: any) {
    afterNextPrompt = { throw: e.message };
  }
  rec("queued+fail", {
    send返回: r,
    排队瞬间可观察量: obsAtQueue,
    prompt结果: promptOutcome,
    error事件: errEvents,
    失败后队列: qAfterFail,
    库可观察量: observables(a, host),
    下一次prompt后: afterNextPrompt,
    round_completed: roundCompleted,
    请求正文: env.srv.digest(from),
  });
  a.dispose();
}

console.log("\n═══ E2-4 空闲时 send（返回 ran）→ 紧跟 prompt（K5 复现）═══");
{
  const { a, host } = await mk();
  const from = env.srv.calls.length;
  const r = await a.send("S4-RAN");
  const second = await a.prompt("P4").then((x) => `ok:${x.text}`, (e) => `throw:${(e as Error).message}`);
  await sleep(300);
  rec("idle-send+prompt", {
    send返回: r,
    紧随prompt: second,
    S4到过模型: env.srv.contains("S4-RAN", from),
    P4到过模型: env.srv.contains("P4", from),
    库可观察量: observables(a, host),
    请求正文: env.srv.digest(from),
  });
  a.dispose();
}

console.log("\n═══ E2-5 空闲 steer 后什么都不做 —— 消息停在哪 ═══");
{
  const { a, host } = await mk();
  const from = env.srv.calls.length;
  await a.steer("S5-PARKED");
  await sleep(600);
  rec("idle-steer-parked", {
    "600ms后队列": q(a),
    库可观察量: observables(a, host),
    请求次数: env.srv.calls.length - from,
    任何事件: "见下方 spy",
  });
  a.dispose();
}

console.log("\n═══ E2-6 空闲 followUp（直接走 SDK，库没有对应 API） ═══");
{
  const { a, host } = await mk();
  const from = env.srv.calls.length;
  const d = await (a.session as any).followUp("S6-PARKED-FOLLOWUP");
  await sleep(600);
  rec("idle-followUp-parked", { disposition: d, "600ms后队列": q(a), 请求次数: env.srv.calls.length - from });
  a.dispose();
}

console.log("\n═══ E2-3b send（queued）→ 当前轮延迟失败（[[slowfail]]）→ 队列谁来收 ═══");
{
  const { a, host, roundCompleted } = await mk();
  const from = env.srv.calls.length;
  const p = a.prompt("[[slowfail:600]] P3B").then((r) => `ok:${r.text}`, (e) => `throw:${(e as Error).message}`);
  await sleep(150);
  const r = await a.send("Q3B-THEN-SLOWFAIL");
  const obsAtQueue = observables(a, host);
  const promptOutcome = await p;
  await sleep(300);
  rec("queued+slowfail", {
    send返回: r,
    排队瞬间可观察量: obsAtQueue,
    prompt结果: promptOutcome,
    失败后队列: q(a),
    waitForIdle是否在这之前就返回: "见 E2-8",
    库可观察量: observables(a, host),
    round_completed: roundCompleted,
    请求正文: env.srv.digest(from),
  });
  a.dispose();
}

console.log("\n═══ E2-7 abort 返回后立刻 send（竞态：队列已死但 running 还是 1？）═══");
{
  const { a, host, roundCompleted } = await mk();
  const from = env.srv.calls.length;
  const p = a.prompt("[[sleep:900]] P7").catch((e) => `throw:${(e as Error).message}`);
  await sleep(200);
  await a.abort();
  const r = await a.send("Q7-AFTER-ABORT-SEND");
  const pendingRightAfter = q(a);
  const idle = await a.waitForIdle().then(() => "returned");
  await sleep(100);
  const pendingAfterIdle = q(a);
  await p;
  rec("abort-then-send", {
    send返回: r,
    send后队列: pendingRightAfter,
    waitForIdle: idle,
    waitForIdle之后队列: pendingAfterIdle,
    可观察量: observables(a, host),
    Q7是否到过模型: env.srv.contains("Q7-AFTER-ABORT-SEND", from),
    round_completed: roundCompleted,
    请求正文: env.srv.digest(from),
  });
  a.dispose();
}

console.log("\n═══ E2-8 排队期间 waitForIdle 的语义（正常路径对照）═══");
{
  const { a, host } = await mk();
  const from = env.srv.calls.length;
  const p = a.prompt("[[sleep:700]] P8");
  await sleep(150);
  const r = await a.send("Q8");
  const t0 = Date.now();
  await a.waitForIdle();
  const waitedMs = Date.now() - t0;
  await sleep(50);
  rec("waitForIdle语义", {
    send返回: r,
    waitForIdle耗时ms: waitedMs,
    "waitForIdle返回时队列": q(a),
    Q8已到模型: env.srv.contains("Q8", from),
    prompt返回文本: (await p).text,
  });
  a.dispose();
}

console.log("\n═══ E2-9 启动窗口内 send（0ms，running>0 但 isStreaming=false）═══");
{
  const { a, host } = await mk();
  const from = env.srv.calls.length;
  const p = a.prompt("[[sleep:600]] P9");
  const r = await a.send("Q9-STARTUP-WINDOW");
  const obs = observables(a, host);
  const back = await p;
  await a.waitForIdle();
  await sleep(100);
  rec("startup-window-send", {
    send返回: r,
    那一刻可观察量: obs,
    请求次数: env.srv.calls.length - from,
    Q9到过模型: env.srv.contains("Q9-STARTUP-WINDOW", from),
    prompt返回文本: back.text,
    剩余pending: q(a).pending,
    请求正文: env.srv.digest(from),
  });
  a.dispose();
}

console.log("\n═══ E2-10 队列里躺着消息时 dispose ═══");
{
  const { a, host } = await mk();
  await a.steer("S10-PARKED");
  const before = q(a);
  a.dispose();
  const after = (() => {
    try {
      return q(a);
    } catch (e: any) {
      return `throw:${e.message}`;
    }
  })();
  await sleep(300);
  rec("dispose-with-pending", { dispose前队列: before, dispose后读队列: after, 请求次数: env.srv.calls.length, status: a.status });
}

save("e2", rows);
await env.srv.close();
