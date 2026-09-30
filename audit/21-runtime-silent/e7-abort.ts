// E7：abort() 的静默后果 —— 能不能接着用、半截消息会不会污染下一轮、连续 abort 会不会累积坏状态。
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
const mk = (hostOpts: any = {}) => {
  const host = createAgentHost(hostOpts);
  return createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir }, { modelRuntime: env.runtime, host }).then((a) => ({ a, host }));
};
const snap = (a: any, host: any) => ({
  status: a.status,
  isStreaming: a.isStreaming,
  agentUsage: a.usage.totalTokens,
  hostUsage: host.usage.totalTokens,
  lastResultText: a.lastResult?.text?.slice(0, 50) ?? null,
  lastResultError: a.lastResult?.error ?? null,
  pending: a.session.pendingMessageCount,
});
const msgs = (a: any) =>
  (a.session.messages as any[]).map((m) => `${m.role}:[${(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 45)}]${m.errorMessage ? `(err:${m.errorMessage.slice(0, 40)})` : ""}`);

console.log("═══ E7-1 abort 空闲的 agent（什么都没在跑）═══");
{
  const { a, host } = await mk();
  await a.prompt("预热一轮");
  const before = snap(a, host);
  await a.abort();
  const after = snap(a, host);
  const nxt = await a.prompt("abort 之后的一轮").then((r) => `ok:${r.text}`, (e) => `throw:${e.message}`);
  rec("abort-idle", { abort前: before, abort后: after, 之后prompt: nxt, 之后状态: snap(a, host) });
  a.dispose();
}

console.log("\n═══ E7-2 abort 正在跑的一轮 ═══");
{
  const { a, host } = await mk();
  const from = env.srv.calls.length;
  const p = a.prompt("[[sleep:1200]] 被打断的一轮").then((r) => `ok:${JSON.stringify(r)}`, (e) => `throw:${(e as Error).message}`);
  await sleep(250);
  await a.abort();
  const rightAfter = snap(a, host);
  const awaited = await p;
  await sleep(300);
  const settled = snap(a, host);
  const nxt = await a.prompt("abort 之后的一轮").then((r) => `ok:${r.text}/usage=${r.usage.totalTokens}`, (e) => `throw:${e.message}`);
  rec("abort-running", {
    被中断那轮的prompt结果: String(awaited).slice(0, 200),
    abort返回瞬间: rightAfter,
    稳定后: settled,
    下次prompt: nxt,
    session消息: msgs(a),
    请求数: env.srv.calls.length - from,
    请求正文: env.srv.digest(from),
  });
  a.dispose();
}

console.log("\n═══ E7-3 abort 流到一半（半截消息）═══");
{
  const { a, host } = await mk();
  const from = env.srv.calls.length;
  const partials: string[] = [];
  a.on("text", (p: any) => partials.push(p.delta));
  const p = a.prompt("[[slowtext:120]] 慢慢吐").then((r) => `ok:text=${r.text}/error=${r.error}/usage=${r.usage.totalTokens}`, (e) => `throw:${(e as Error).message}`);
  await sleep(350); // 大约吐了 2~3 片
  const midCount = partials.length;
  await a.abort();
  const awaited = await p;
  await sleep(200);
  const afterAbortMsgs = msgs(a);
  const nxt = await a.prompt("半截之后的一轮").then((r) => `ok:${r.text}`, (e) => `throw:${e.message}`);
  rec("abort-midstream", {
    中断前收到的text片段数: midCount,
    被中断那轮结果: String(awaited).slice(0, 300),
    abort后session消息: afterAbortMsgs,
    下次prompt: nxt,
    下次请求正文: env.srv.digest(env.srv.calls.length - 1),
    状态: snap(a, host),
    请求次数: env.srv.calls.length - from,
  });
  a.dispose();
}

console.log("\n═══ E7-4 连续 4 次 abort，然后正常跑 ═══");
{
  const { a, host } = await mk();
  const seq: any[] = [];
  for (let i = 0; i < 4; i++) {
    const p = a.prompt(`[[sleep:900]] 第${i + 1}次被打断`).then((r) => `ok:${r.text}`, (e) => `throw:${(e as Error).message}`);
    await sleep(180);
    await a.abort();
    const awaited = await p;
    seq.push({ i: i + 1, 结果: String(awaited).slice(0, 80), ...snap(a, host) });
    await sleep(100);
  }
  const nxt = await a.prompt("连续 abort 之后的正常一轮").then((r) => `ok:${r.text}`, (e) => `throw:${e.message}`);
  rec("abort-x4", { 序列: seq, 最终: snap(a, host), 正常一轮: nxt, session消息数: (a.session.messages as any[]).length, 最后一条请求正文: env.srv.digest(env.srv.calls.length - 1) });
  a.dispose();
}

console.log("\n═══ E7-5 abort 之后立刻 waitForIdle / 再 abort ═══");
{
  const { a, host } = await mk();
  const p = a.prompt("[[sleep:1000]] X").catch(() => "thrown");
  await sleep(200);
  await a.abort();
  const w = await a.waitForIdle().then(() => "returned", (e) => `throw:${e.message}`);
  const ab2 = await a.abort().then(() => "no-throw", (e) => `throw:${e.message}`);
  await p;
  rec("abort-then-idle", { waitForIdle: w, 再次abort: ab2, 状态: snap(a, host) });
  a.dispose();
}

save("e7", rows);
await env.srv.close();
