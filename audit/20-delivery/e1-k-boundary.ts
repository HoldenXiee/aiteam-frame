// E1：K 边界 —— collectRun 串台的条件、发生率、以及「安全投递纪律」的候选方案实测。
// 全部假 provider，零成本。配对实验两侧都打印。
import { createAgent, createAgentHost } from "../../src/index.ts";
import { sleep } from "../../test/faux-server.ts";
import { makeEnv } from "../_faux.ts";
import { runLibTool, textOf } from "./_lib.ts";

const env = await makeEnv("echo");
const out: any = {};
const mk = (extra: any = {}) =>
  createAgent(
    { model: env.model, cwd: env.cwd, agentDir: env.agentDir, ...extra },
    { modelRuntime: env.runtime },
  );

/** 一次「spawn_agent 等待期间给子投一条」的实验。inject=false 是对照组。 */
async function spawnTrial(i: number, inject: boolean) {
  const host = createAgentHost({ members: { w: {} }, maxAgents: 1000, maxDepth: 5 });
  const lead = await createAgent(
    { model: env.model, cwd: env.cwd, agentDir: env.agentDir, tools: ["spawn_agent", "send_message"] },
    { host, modelRuntime: env.runtime },
  );
  let child: any = null;
  host.on("agent_created", ({ agent, member }) => {
    if (member === "w") child = agent;
  });
  const before = env.calls().length;
  const spawnP = runLibTool("spawn_agent", { member: "w", task: `[[sleep:400]] 子任务原文${i}` }, { agent: lead, host, signal: undefined });
  let sent: any = null;
  if (inject) {
    await sleep(200);
    if (!child) throw new Error(`第${i}次没抓到子分身`);
    sent = await child.send(`追加第${i}条`);
  }
  const r = await spawnP;
  const text = textOf(r);
  const childLast = child?.lastResult?.text;
  if (inject) await child.waitForIdle().catch(() => {});
  const seen = env.calls().slice(before).map((c) => c.lastUser.slice(0, 40));
  const rec = {
    i,
    inject,
    sent,
    spawnTextHasTask: /子任务原文/.test(text),
    spawnTextHasAppend: /追加第/.test(text),
    spawnText: text.slice(0, 90),
    childLast: childLast?.slice(0, 40),
    childUsage: child?.usage.totalTokens,
    spawnUsage: r.details?.usage?.totalTokens,
    seq: seen,
  };
  host.dispose();
  return rec;
}

console.log("═══ E1a：spawn_agent 等待期间给子分身投一条（N=20）+ 对照（N=20）═══");
const withInject: any[] = [];
const control: any[] = [];
for (let i = 1; i <= 20; i++) {
  withInject.push(await spawnTrial(i, true));
  const t = withInject[withInject.length - 1];
  console.log(`  [投递] #${i} 返回=${JSON.stringify(t.sent)} spawn文本含子任务=${t.spawnTextHasTask} 含追加=${t.spawnTextHasAppend} | ${JSON.stringify(t.spawnText.slice(0, 60))}`);
}
for (let i = 1; i <= 20; i++) {
  control.push(await spawnTrial(i, false));
}
const rateInject = withInject.filter((t) => !t.spawnTextHasTask).length;
console.log(`  [对照] 不投递的 20 次里 spawn 文本不含子任务原文的次数 = ${control.filter((t) => !t.spawnTextHasTask).length}`);
console.log(`  → 投递组串台率 = ${rateInject}/20；对照组 = ${control.filter((t) => !t.spawnTextHasTask).length}/20`);
out.e1a = { rateInject: `${rateInject}/20`, rateControl: `${control.filter((t) => !t.spawnTextHasTask).length}/20`, withInject, control };

console.log("\n═══ E1b：settle 窗口（agent_settled 发射中）注入 —— 四种方法 × 两侧结果 ═══");
const settleRows: any[] = [];
for (const method of ["prompt", "send", "steer", "followUp"] as const) {
  const a = await mk();
  const before = env.calls().length;
  let inner: any = null;
  let fired = 0;
  a.session.subscribe((raw: any) => {
    if (raw.type === "agent_settled" && fired === 0) {
      fired++;
      const call =
        method === "prompt" ? () => a.prompt("窗口内消息") :
        method === "send" ? () => a.send("窗口内消息") :
        method === "steer" ? () => a.steer("窗口内消息") :
        () => (a.session as any).followUp("窗口内消息");
      void Promise.resolve(call()).then(
        (r: any) => (inner = { ret: r?.delivered ?? r?.text ?? "(void)", text: r?.text }),
        (e: any) => (inner = { threw: e.message.slice(0, 70) }),
      );
    }
  });
  const outer = await a.prompt("外层第一轮");
  await sleep(900);
  const ran = env.calls().slice(before).some((c) => /窗口内消息/.test(c.lastUser));
  const row: any = {
    method,
    outerText: outer.text,
    outerTokens: outer.usage.totalTokens,
    inner,
    innerRan: ran,
    lastResult: a.lastResult?.text,
    agentUsage: a.usage.totalTokens,
    requests: env.calls().length - before,
  };
  // 关键追问：窗口内那条没跑的话，它是不是被静默留在队列里、下次 prompt 才醒、并偷走那次 prompt 的返回？
  if (!ran) {
    const pending = (a.session as any).pendingMessageCount;
    const next = await a.prompt("之后的无关 prompt").then((r) => r.text, (e) => `THROW:${e.message.slice(0, 50)}`);
    await sleep(400);
    row.pendingAfterWindow = pending;
    row.nextPromptText = next;
    row.windowMsgRanLater = env.calls().slice(before).some((c) => /窗口内消息/.test(c.lastUser));
    row.windowMsgHijackedNextPrompt = /窗口内消息/.test(String(next));
  }
  settleRows.push(row);
  console.log(`  ${method.padEnd(9)} 外层=["${outer.text}"] tok=${outer.usage.totalTokens} | 窗口内=${JSON.stringify(inner)} | 窗口内实际跑了=${ran} | lastResult="${a.lastResult?.text}" | agent.usage=${a.usage.totalTokens} | 请求=${row.requests}`);
  if (!ran) console.log(`            └ 队列里还留着 ${row.pendingAfterWindow} 条；下一次 prompt("之后的无关 prompt") 返回="${row.nextPromptText}" → 那句无关 prompt ${row.windowMsgHijackedNextPrompt ? "**被窗口内消息顶替（返回了它的答案）**" : "正常"}；窗口内那条此时跑了=${row.windowMsgRanLater}`);
  a.dispose();
}
out.e1b = settleRows;

console.log("\n═══ E1c：忙时投 1/2/5 条（send / steer / followUp），各条是否真的各跑一轮 ═══");
const busyRows: any[] = [];
for (const method of ["send", "steer", "followUp"] as const) {
  for (const k of [1, 2, 5]) {
    const a = await mk();
    const before = env.calls().length;
    const main = a.prompt("[[sleep:500]] 主干任务").catch((e) => ({ text: `THROW:${e.message.slice(0, 40)}`, usage: { totalTokens: -1 } } as any));
    await sleep(150);
    const rs: any[] = [];
    for (let n = 1; n <= k; n++) {
      const fn = method === "send" ? () => a.send(`追加${n}`) : method === "steer" ? () => a.steer(`追加${n}`) : () => (a.session as any).followUp(`追加${n}`);
      rs.push(await fn().then((r: any) => r?.delivered ?? "(void)", (e: any) => `THROW:${e.message.slice(0, 30)}`));
    }
    const mainRet = await main;
    await a.waitForIdle().catch(() => {});
    await sleep(250);
    const seen = env.calls().slice(before).map((c) => c.lastUser.slice(0, 30));
    const row = {
      method, k,
      injectReturns: rs,
      mainText: mainRet.text,
      mainTokens: mainRet.usage.totalTokens,
      agentUsage: a.usage.totalTokens,
      lastResult: a.lastResult?.text,
      requests: env.calls().length - before,
      appendedRan: seen.filter((s) => /追加\d/.test(s)).length,
      seq: seen,
    };
    busyRows.push(row);
    console.log(`  ${method.padEnd(8)} k=${k}: 投递返回=${JSON.stringify(rs)} 主干返回="${mainRet.text.slice(0, 40)}" 追加实际跑了=${row.appendedRan}/${k} 请求=${row.requests} lastResult="${a.lastResult}" agent.usage=${a.usage.totalTokens}`);
    a.dispose();
  }
}
out.e1c = busyRows;

console.log("\n═══ E1d：空闲 steer / followUp 会不会跑（盲区 2：运行期静默失败）═══");
const idleRows: any[] = [];
for (const method of ["steer", "followUp"] as const) {
  const a = await mk();
  const before = env.calls().length;
  const ret = await (method === "steer" ? a.steer("空闲投递的消息") : (a.session as any).followUp("空闲投递的消息")).then((r: any) => r?.delivered ?? "(void)", (e: any) => `THROW:${e.message.slice(0, 50)}`);
  await sleep(600);
  const ranAlone = env.calls().length - before;
  const pendingBefore = (a.session as any).pendingMessageCount;
  // 再补一条 prompt，看队列里的那条会不会被顺带唤醒
  const after = await a.prompt("后续的 prompt");
  await sleep(300);
  const seen = env.calls().slice(before).map((c) => c.lastUser.slice(0, 30));
  const row = {
    method, ret, ranAlone, pendingBefore,
    afterPromptText: after.text,
    promptRequests: env.calls().length - before,
    idleMsgRan: seen.some((s) => /空闲投递/.test(s)),
    seq: seen,
    lastResult: a.lastResult?.text,
    agentUsage: a.usage.totalTokens,
  };
  idleRows.push(row);
  console.log(`  ${method}: 返回=${JSON.stringify(ret)} 600ms 内单独跑了 ${ranAlone} 次 pending=${pendingBefore} | 之后 prompt 返回="${after.text.slice(0, 40)}" | 空闲那条最终跑了=${row.idleMsgRan} | 请求序列=${JSON.stringify(seen)} | agent.usage=${a.usage.totalTokens}`);
  a.dispose();
}
out.e1d = idleRows;

console.log("\n═══ E1e：重叠 prompt 下四种「取结果」纪律的对错（同一场景，配对）═══");
// 场景：同一 agent，settle 窗口内并发一次 prompt —— 模拟「spawn 等待期间被投递」的最小形态
const discipline: any[] = [];
// D1 裸 prompt 并发
{
  const a = await mk();
  let inner: any = null; let fired = 0;
  a.session.subscribe((raw: any) => {
    if (raw.type === "agent_settled" && fired === 0) { fired++; void a.prompt("B").then((r) => (inner = r.text)); }
  });
  const outer = await a.prompt("A");
  await sleep(700);
  const rec = { d: "D1 裸 prompt 并发", outer: outer.text, inner, outerCorrect: outer.text === "echo:A", innerCorrect: inner === "echo:B" };
  discipline.push(rec);
  console.log(`  ${rec.d}: outer="${rec.outer}" 正确=${rec.outerCorrect} | inner="${rec.inner}" 正确=${rec.innerCorrect}`);
  a.dispose();
}
// D2 消费者侧互斥（per-agent promise 链）
{
  const a = await mk();
  let chain: Promise<any> = Promise.resolve();
  const ask = (t: string) => { const p = chain.then(() => a.prompt(t)); chain = p.catch(() => {}); return p; };
  let inner: any = null; let fired = 0;
  a.session.subscribe((raw: any) => {
    if (raw.type === "agent_settled" && fired === 0) { fired++; void ask("B").then((r) => (inner = r.text)); }
  });
  const outer = await ask("A").then((r) => r.text);
  await sleep(500);
  const rec = { d: "D2 消费者侧互斥链", outer, inner, outerCorrect: outer === "echo:A", innerCorrect: inner === "echo:B" };
  discipline.push(rec);
  console.log(`  ${rec.d}: outer="${rec.outer}" 正确=${rec.outerCorrect} | inner="${rec.inner}" 正确=${rec.innerCorrect}`);
  a.dispose();
}
// D3 send + waitForIdle + lastResult（既有报告 B5 推荐的写法）
{
  const a = await mk();
  const p = a.send("X");
  const ret = await p;
  await a.waitForIdle();
  const rec = { d: "D3 send+waitForIdle+lastResult", ret, last: a.lastResult?.text, correct: a.lastResult?.text === "echo:X" };
  discipline.push(rec);
  console.log(`  ${rec.d}: send→${JSON.stringify(ret)} lastResult="${rec.last}" 正确=${rec.correct}`);
  a.dispose();
}
// D4 send + waitForIdle + lastResult，但期间有另一个投递者
{
  const a = await mk();
  await a.prompt("热身"); // 让 lastResult 有陈旧值
  const s = a.send("X");            // 第一个投递者
  await sleep(30);
  void a.send("Y");                 // 第二个投递者（并发）
  await a.waitForIdle().catch(() => {});
  await sleep(400);
  const rec = { d: "D4 send+waitForIdle，两名投递者", firstSees: a.lastResult?.text, equalsX: a.lastResult?.text === "echo:X", agentUsage: a.usage.totalTokens };
  discipline.push(rec);
  console.log(`  ${rec.d}: 第一个投递者读到的 lastResult="${rec.firstSees}" 等于自己的 X=${rec.equalsX} agent.usage=${rec.agentUsage}`);
  a.dispose();
}
// D5 按 session.messages 自读切片（自己的 user 消息之后、下一个 user 之前的 assistant）
{
  const a = await mk();
  await a.prompt("热身");
  const n0 = a.session.messages.length;
  const s = a.send("X");
  await sleep(30);
  void a.send("Y");
  await a.waitForIdle().catch(() => {});
  await sleep(400);
  const flat = (content: any) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("") : "");
  const tail: any[] = (a.session.messages as any[]).slice(n0);
  const mine = tail.findIndex((m) => m.role === "user" && flat(m.content) === "X");
  let texts: string[] = [];
  if (mine >= 0) {
    for (let i = mine + 1; i < tail.length; i++) {
      if (tail[i].role === "user") break;
      if (tail[i].role === "assistant") texts.push(flat(tail[i].content));
    }
  }
  const rec = { d: "D5 自读 session.messages 切片", mineIndex: mine, sliceTexts: texts, correct: texts.join("") === "echo:X" };
  discipline.push(rec);
  console.log(`  ${rec.d}: 自己那条之后的 assistant 文本=${JSON.stringify(texts)} 正确=${rec.correct}`);
  a.dispose();
}
out.e1e = discipline;

console.log("\n═══ E1f：3 个调用者同时投给同一个忙 agent，各自 waitForIdle 后读 lastResult ═══");
const multiRows: any[] = [];
{
  const a = await mk();
  const main = a.prompt("[[sleep:500]] 主干").catch(() => {});
  await sleep(120);
  const senders = await Promise.all(
    ["甲", "乙", "丙"].map(async (who, idx) => {
      const ret = await a.send(`${who}的消息`);
      await sleep(idx * 40);
      await a.waitForIdle().catch(() => {});
      return { who, ret, reads: a.lastResult?.text };
    }),
  );
  await main;
  await a.waitForIdle().catch(() => {});
  await sleep(300);
  console.log(`  主干返回后 lastResult="${a.lastResult?.text}" agent.usage=${a.usage.totalTokens}`);
  for (const s of senders) console.log(`  ${s.who}: send→${JSON.stringify(s.ret)} 读到的 lastResult="${s.reads}"`);
  multiRows.push({ senders, finalLast: a.lastResult?.text, agentUsage: a.usage.totalTokens });
  a.dispose();
}
out.e1f = multiRows;

console.log("\n═══ E1g：串台时「原子任务的答案」还能从哪找到？（同一份 session.messages 里手工读）═══");
{
  const host = createAgentHost({ members: { w: {} }, maxAgents: 1000, maxDepth: 5 });
  const lead = await createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir, tools: ["spawn_agent"] }, { host, modelRuntime: env.runtime });
  let child: any = null;
  host.on("agent_created", ({ agent, member }) => { if (member === "w") child = agent; });
  const spawnP = runLibTool("spawn_agent", { member: "w", task: "[[sleep:400]] 子任务原文" }, { agent: lead, host });
  await sleep(200);
  await child.send("追加");
  const r = await spawnP;
  const flat = (c: any) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x.text ?? "").join("") : "");
  const msgs = (child.session.messages as any[]).map((m) => `${m.role}:${flat(m.content).slice(0, 30)}`);
  console.log(`  spawn_agent 返回给父的文本 = ${JSON.stringify(textOf(r).slice(0, 70))}`);
  console.log(`  子分身 session.messages 里能看到的：${JSON.stringify(msgs)}`);
  console.log(`  → 子任务答案 ${msgs.some((m) => /子任务原文/.test(m)) ? "**仍在 session.messages 里**（可手工恢复）" : "找不到"}`);
  out.e1g = { spawnText: textOf(r), messages: msgs, recoverable: msgs.some((m) => /子任务原文/.test(m)) };
  host.dispose();
}

const fs = await import("node:fs");
fs.writeFileSync(new URL("./data-e1.json", import.meta.url), JSON.stringify(out, null, 2), "utf-8");
console.log("\n→ audit/20-delivery/data-e1.json");
await env.close();
