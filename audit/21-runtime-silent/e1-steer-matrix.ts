// E1：steer() 的全状态矩阵 —— idle / running / 启动窗口 / abort 之后 / dispose 之后。
// 用带完整请求正文的假 provider：不仅看「请求数变没变」，还看**prompt 的正文有没有到模型那里**。
import { createAgent } from "../../src/index.ts";
import { makeEnv2 } from "./_srv.ts";
import { sleep } from "../../test/faux-server.ts";
import { save, spy } from "./_data.ts";

const env = await makeEnv2();
const rows: any[] = [];
const rec = (k: string, v: any) => {
  rows.push({ case: k, ...v });
  console.log(`  ▶ ${k}: ${JSON.stringify(v, null, 0)}`);
};
const mk = (extra: any = {}) => createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir, ...extra }, { modelRuntime: env.runtime });
const q = (a: any) => ({ pending: a.session.pendingMessageCount, steerQ: [...a.session.getSteeringMessages()], followQ: [...a.session.getFollowUpMessages()] });
const roles = (a: any) => (a.session.messages as any[]).map((m: any) => `${m.role}:"${(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 30)}"`);

console.log("═══ E1a 空闲时 steer（库的 agent.steer，返回 void）═══");
{
  const a = await mk();
  const from = env.srv.calls.length;
  const ret = await a.steer("STEER-IDLE");
  rec("idle/steer返回", { 返回值: String(ret), pending: q(a).pending, steer队列: q(a).steerQ, 请求数变化: env.srv.calls.length - from, status: a.status });
  await sleep(500);
  rec("idle/等500ms后", { pending: q(a).pending, 请求数变化: env.srv.calls.length - from, status: a.status });
  const r = await a.prompt("MAIN-AFTER-IDLE-STEER");
  rec("idle/随后prompt", {
    返回文本: r.text,
    请求次数: env.srv.calls.length - from,
    请求正文: env.srv.digest(from),
    session消息: roles(a),
    MAIN是否出现在任何请求里: env.srv.contains("MAIN-AFTER-IDLE-STEER", from),
    剩余pending: q(a).pending,
  });
  a.dispose();
}

console.log("\n═══ E1a2 空闲时 steer（直接调 SDK，拿被库丢掉的 disposition）═══");
{
  const a = await mk();
  const d = await (a.session as any).steer("STEER-RAW");
  rec("idle/sdk-steer-disposition", { disposition: d, pending: q(a).pending });
  const d2 = await (a.session as any).followUp("FOLLOW-RAW");
  rec("idle/sdk-followUp-disposition", { disposition: d2, pending: q(a).pending, followQ: q(a).followQ });
  a.dispose();
}

console.log("\n═══ E1b running 时 steer ═══");
{
  const a = await mk();
  const s = spy(a);
  const from = env.srv.calls.length;
  const p = a.prompt("[[sleep:700]] MAIN-RUNNING");
  await sleep(250);
  const mid = { isStreaming: a.isStreaming, status: a.status };
  const ret = await a.steer("STEER-RUNNING");
  const rightAfter = q(a);
  const r = await p;
  rec("running/steer", {
    steer时状态: mid,
    返回值: String(ret),
    steer后pending: rightAfter.pending,
    返回文本: r.text,
    请求次数: env.srv.calls.length - from,
    请求正文: env.srv.digest(from),
    剩余pending: q(a).pending,
    事件计数: s.counts,
  });
  a.dispose();
}

console.log("\n═══ E1c 启动窗口内 steer（prompt 刚发起、isStreaming 还没翻真）═══");
{
  const a = await mk();
  const from = env.srv.calls.length;
  const p = a.prompt("[[sleep:600]] MAIN-STARTUP");
  const win = { isStreaming: a.isStreaming, status: a.status };
  const ret = await a.steer("STEER-STARTUP");
  const rightAfter = q(a);
  const r = await p;
  rec("startup/steer", {
    窗口内isStreaming: win.isStreaming,
    窗口内status: win.status,
    返回值: String(ret),
    steer后pending: rightAfter.pending,
    返回文本: r.text,
    请求次数: env.srv.calls.length - from,
    请求正文: env.srv.digest(from),
    MAIN是否出现在任何请求里: env.srv.contains("MAIN-STARTUP", from),
    剩余pending: q(a).pending,
  });
  a.dispose();
}

console.log("\n═══ E1d abort 之后 steer ═══");
{
  const a = await mk();
  const from = env.srv.calls.length;
  const p = a.prompt("[[sleep:900]] MAIN-ABORTED").catch((e) => `throw:${(e as Error).message}`);
  await sleep(250);
  await a.abort();
  const afterAbort = { status: a.status, isStreaming: a.isStreaming, pending: q(a).pending };
  const ret = await a.steer("STEER-AFTER-ABORT");
  rec("after-abort/steer", { abort后状态: afterAbort, 返回值: String(ret), steer后pending: q(a).pending, steer队列: q(a).steerQ });
  await p;
  await sleep(300);
  const r = await a.prompt("MAIN-AFTER-ABORT");
  rec("after-abort/随后prompt", {
    返回文本: r.text,
    请求次数: env.srv.calls.length - from,
    请求正文: env.srv.digest(from),
    MAIN是否出现在任何请求里: env.srv.contains("MAIN-AFTER-ABORT", from),
    status: a.status,
    session消息: roles(a),
  });
  a.dispose();
}

console.log("\n═══ E1e/E1f dispose 之后各 API ═══");
{
  const a = await mk();
  await a.prompt("hi");
  a.dispose();
  const probe = async (name: string, fn: () => Promise<unknown>) => rec(`after-dispose/${name}`, { 结果: await fn().then(() => "no-throw", (e: any) => `throw:${e.message}`) });
  for (const [n, f] of [["steer", () => a.steer("x")], ["prompt", () => a.prompt("x")], ["send", () => a.send("x")], ["abort", () => a.abort()], ["waitForIdle", () => a.waitForIdle()]] as any) await probe(n, f);
  rec("after-dispose/状态", { status: a.status, isStreaming: a.isStreaming });
}

save("e1", rows);
await env.srv.close();
