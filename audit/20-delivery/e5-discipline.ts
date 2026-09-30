// E5：投递纪律的候选方案实测（配对）。目标：给出「设计者怎么写才不会拿到串台结果」的可执行答案。
import { createAgent, createAgentHost } from "../../src/index.ts";
import { sleep } from "../../test/faux-server.ts";
import { makeEnv } from "../_faux.ts";
import { runLibTool, textOf } from "./_lib.ts";

const env = await makeEnv("echo");
const out: any = {};
const mk = () => createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir }, { modelRuntime: env.runtime });

console.log("═══ E5a：串台时「本轮用量」是否也错（配对：k=0 对照 / k=1 投一条）═══");
{
  const a = await mk();
  const single = await a.prompt("单独一轮");
  console.log(`  对照组（无并发）：RunResult.usage=${single.usage.totalTokens}（应为 18）`);
  a.dispose();
  const b = await mk();
  const main = b.prompt("[[sleep:300]] 主干");
  await sleep(100);
  await b.send("追加");
  const r = await main;
  console.log(`  投递组：主干 RunResult.usage=${r.usage.totalTokens}（自己只花 18，期望 18；若为 36 则被并入了追加那一轮）`);
  console.log(`  投递组：主干 RunResult.text=${JSON.stringify(r.text)}  agent.usage=${b.usage.totalTokens}（累计正确=36）`);
  out.e5a = { controlTokens: single.usage.totalTokens, injectTokens: r.usage.totalTokens, injectText: r.text, agentUsage: b.usage.totalTokens };
  b.dispose();
}

console.log("\n═══ E5b：三种「消费者侧纪律」在重叠投递下的对错（各 8 次试验）═══");
type Variant = "M1-prompt" | "M2-send" | "M3-send+waitForIdle" | "M4-send+自读messages";
const flatContent = (c: any) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x.text ?? "").join("") : "");
/** 按「自己的 user 消息之后、下一个 user 之前」手工取 assistant 文本（不依赖 collectRun） */
function readOwn(a: any, mine: string): string {
  const msgs = a.session.messages as any[];
  const i = msgs.findIndex((m) => m.role === "user" && flatContent(m.content) === mine);
  if (i < 0) return "(找不到自己的 user 消息)";
  const texts: string[] = [];
  for (let k = i + 1; k < msgs.length; k++) {
    if (msgs[k].role === "user") break;
    if (msgs[k].role === "assistant") texts.push(flatContent(msgs[k].content));
  }
  return texts.join("");
}
async function runVariant(v: Variant, trial: number, overlap: "concurrent" | "settle") {
  const a = await mk();
  let chain: Promise<any> = Promise.resolve();
  const ask = (text: string) => {
    if (v === "M4-send+自读messages") return (async () => { await a.send(text); await a.waitForIdle(); return readOwn(a, text); })();
    const p = chain.then(async () => {
      if (v === "M1-prompt") return (await a.prompt(text)).text;
      await a.send(text);
      if (v === "M2-send") return a.lastResult?.text;
      await a.waitForIdle();
      return a.lastResult?.text;
    });
    chain = p.catch(() => {}) as any;
    return p;
  };
  let innerRet: any = null;
  if (overlap === "settle") {
    let fired = 0;
    a.session.subscribe((raw: any) => {
      if (raw.type === "agent_settled" && fired === 0) { fired++; void ask("B").then((r) => (innerRet = r)); }
    });
    var outerRet = await ask("A");
  } else {
    const [r1, r2] = await Promise.all([ask("A"), ask("B")]);
    var outerRet = r1;
    innerRet = r2;
  }
  await sleep(500);
  const rec = { v, trial, overlap, outerRet, innerRet, aGetsA: outerRet === "echo:A", bGetsB: innerRet === "echo:B", finalLast: a.lastResult?.text };
  a.dispose();
  return rec;
}
const disc: any[] = [];
for (const v of ["M1-prompt", "M2-send", "M3-send+waitForIdle", "M4-send+自读messages"] as const) {
  for (const overlap of ["concurrent", "settle"] as const) {
    const rows: any[] = [];
    for (let t = 1; t <= 8; t++) rows.push(await runVariant(v, t, overlap));
    const ok = rows.filter((r) => r.aGetsA && r.bGetsB).length;
    disc.push({ v, overlap, ok: `${ok}/8`, sample: rows.slice(0, 2) });
    console.log(`  ${v.padEnd(20)} 重叠形态=${overlap.padEnd(10)} 两侧各自正确 = ${ok}/8  样例=${JSON.stringify(rows.slice(0, 2).map((r) => ({ 甲: r.outerRet, 乙: r.innerRet })))}`);
  }
}
out.e5b = disc;

console.log("\n═══ E5c：委派层的纪律 —— 什么时候给子分身追加消息才不会毁掉 spawn 的结果 ═══");
const deleg: any[] = [];
async function delegTrial(when: "busy" | "after-spawn" | "when-idle") {
  const host = createAgentHost({ members: { w: {} }, maxAgents: 1000, maxDepth: 5 });
  const lead = await createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir, tools: ["spawn_agent"] }, { host, modelRuntime: env.runtime });
  let child: any = null;
  host.on("agent_created", ({ agent, member }) => { if (member === "w") child = agent; });
  const spawnP = runLibTool("spawn_agent", { member: "w", task: "[[sleep:400]] 子任务原文" }, { agent: lead, host });
  let sentAt = "";
  if (when === "busy") {
    await sleep(150);
    if (child?.isStreaming) { await child.send("追加"); sentAt = "忙时"; }
    else sentAt = "（没赶上，子已空闲）";
  }
  const r = await spawnP;
  if (when === "after-spawn") { await child.send("追加"); sentAt = "spawn 返回之后"; }
  if (when === "when-idle") {
    for (let i = 0; i < 40 && child?.isStreaming; i++) await sleep(30);
    await child.send("追加"); sentAt = "确认 !isStreaming 后";
  }
  await sleep(300);
  const text = textOf(r);
  const rec = { when, sentAt, spawnKeepsTask: /子任务原文/.test(text), spawnText: text.slice(0, 70) };
  host.dispose();
  return rec;
}
for (const when of ["busy", "after-spawn", "when-idle"] as const) {
  const rows: any[] = [];
  for (let t = 0; t < 6; t++) rows.push(await delegTrial(when));
  const ok = rows.filter((r) => r.spawnKeepsTask).length;
  deleg.push({ when, ok: `${ok}/6`, sample: rows[0] });
  console.log(`  ${when.padEnd(12)}：spawn_agent 返回的文本仍含原子任务 = ${ok}/6   样例=${JSON.stringify(rows[0].spawnText)}`);
}
out.e5c = deleg;

const fs = await import("node:fs");
fs.writeFileSync(new URL("./data-e5.json", import.meta.url), JSON.stringify(out, null, 2), "utf-8");
console.log("\n→ audit/20-delivery/data-e5.json");
await env.close();
