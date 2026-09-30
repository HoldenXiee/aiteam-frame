// E5：预算耗尽后的 send() 与 spawn_agent——库返回什么、父 agent 看到什么、有没有信号。
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
const mk = (host: any, extra: any = {}) =>
  createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir, ...extra }, { modelRuntime: env.runtime, host });

console.log("═══ E5-1 预算耗尽后调 send()（空闲）═══");
{
  const host = createAgentHost({ budgetTokens: 18 });
  const a = await mk(host);
  const r1 = await a.prompt("第一轮");
  const from = env.srv.calls.length;
  const errs: string[] = [];
  a.on("error", (e: any) => errs.push(e.message));
  let done = 0;
  a.on("done", () => (done += 1));
  const r = await a.send("预算耗尽后的消息-SHOULD-NOT-RUN");
  await sleep(500);
  rec("budget-exhausted-send", {
    第一轮结果: r1.text,
    耗尽时host用量: host.usage.totalTokens,
    send返回: r,
    请求数变化: env.srv.calls.length - from,
    消息是否到过模型: env.srv.contains("预算耗尽后的消息", from),
    error事件: errs,
    done事件数: done,
    库可观察量: { status: a.status, lastResult: a.lastResult?.text, lastResultError: a.lastResult?.error ?? null, usage: a.usage.totalTokens },
    pendingMessageCount: a.session.pendingMessageCount,
  });
  a.dispose();
}

console.log("\n═══ E5-2 预算耗尽时 spawn_agent（父在跑，另一个分身把预算烧光）═══");
{
  const host = createAgentHost({ budgetTokens: 18, members: { helper: { description: "帮手", model: env.model } } });
  const parent = await mk(host, { cwd: env.cwd, tools: ["spawn_agent"] });
  const hostEvents: string[] = [];
  host.on("agent_created", (p: any) => hostEvents.push(`created:${p.member ?? "top"}`));
  host.on("round_completed", (p: any) => hostEvents.push(`round:${p.agent.id}`));
  const from = env.srv.calls.length;
  // 父这一轮发一个慢请求 + 一次 spawn_agent
  const p = parent.prompt('[[sleep:700]] [[call:spawn_agent {"member":"helper","task":"干活"}]]');
  await sleep(150);
  // 趁父还在等，用另一个同宿主的分身烧掉预算
  const burner = await mk(host, { id: "burner" });
  await burner.prompt("烧预算的一轮");
  const burnUsage = host.usage.totalTokens;
  const spawnOutcome = await p;
  await sleep(300);
  const toolResults = (parent.session.messages as any[])
    .filter((m) => m.role === "toolResult" || m.role === "tool")
    .map((m) => ({ toolName: m.toolName, isError: m.isError ?? null, text: (m.content ?? []).map((c: any) => c?.text ?? "").join("") }));
  rec("budget-exhausted-spawn", {
    烧预算后host用量: burnUsage,
    父这一轮返回文本: spawnOutcome.text,
    父这一轮error: spawnOutcome.error ?? null,
    工具结果: toolResults,
    宿主事件: hostEvents,
    请求数变化: env.srv.calls.length - from,
    请求正文: env.srv.digest(from),
  });
  parent.dispose();
  burner.dispose();
}

console.log("\n═══ E5-3 maxAgents 耗尽时 spawn_agent（确定性构造，不需要竞态）═══");
{
  const host = createAgentHost({ maxAgents: 1, members: { helper: { description: "帮手", model: env.model } } });
  const parent = await mk(host, { tools: ["spawn_agent"] });
  const hostEvents: string[] = [];
  host.on("agent_created", (p: any) => hostEvents.push(`created:${p.member ?? "top"}`));
  const r = await parent.prompt('[[tool:spawn_agent]] [[args:{"member":"helper","task":"干活"}]]');
  const toolResults = (parent.session.messages as any[])
    .filter((m) => m.role === "toolResult" || m.role === "tool")
    .map((m) => ({ toolName: m.toolName, isError: m.isError ?? null, text: (m.content ?? []).map((c: any) => c?.text ?? "").join("") }));
  rec("maxagents-exhausted-spawn", {
    父这一轮返回文本: r.text,
    父这一轮error: r.error ?? null,
    工具结果: toolResults,
    宿主事件: hostEvents,
    activeCount: host.activeCount,
  });
  parent.dispose();
}

console.log("\n═══ E5-4 预算耗尽时子分身自己能不能建（构造期）═══");
{
  const host = createAgentHost({ budgetTokens: 18, members: { helper: { description: "帮手", model: env.model } } });
  const burner = await mk(host);
  await burner.prompt("烧一轮");
  const after = host.usage.totalTokens;
  const r = await createAgent({ model: env.model, id: "late", cwd: env.cwd, agentDir: env.agentDir }, { modelRuntime: env.runtime, host }).then(
    () => "构造成功（没拦）",
    (e: any) => `throw:${e.message}`,
  );
  rec("budget-exhausted-construct", { 烧完后用量: after, 再建分身: r, activeCount: host.activeCount });
  burner.dispose();
}

save("e5", rows);
await env.srv.close();
