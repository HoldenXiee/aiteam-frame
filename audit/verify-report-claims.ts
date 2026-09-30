// 核对既有审计报告里三条影响最大的断言（独立复现，不看它的脚本）
// 跑法：node audit/verify-report-claims.ts
import { createAgent, createAgentHost } from "../src/index.ts";
import { startFaux, sleep } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);

const line = (s = "") => console.log(s);

// ── 断言 4.7：abort 那一轮的 usage 记为 0，请求却真的发出去了 ──
line("═══ 断言 A（报告 4.7）：abort 的账 ═══");
{
  const a = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { modelRuntime: made.runtime });
  const before = faux.calls.length;
  const p = a.prompt("[[sleep:800]] 长活").catch((e) => `throw:${(e as Error).message}`);
  await sleep(200);
  await a.abort();
  const r = await p;
  await sleep(300);
  line(`  假服务收到的请求数：${before} → ${faux.calls.length}（>0 说明请求真的发出去了）`);
  line(`  prompt() 的返回：${typeof r === "string" ? r : JSON.stringify({ text: (r as any).text, usage: (r as any).usage.totalTokens, error: (r as any).error })}`);
  line(`  agent.usage.totalTokens = ${a.usage.totalTokens}`);
  line(`  → 结论：请求发出 ${faux.calls.length - before} 次，库记的 token = ${a.usage.totalTokens}`);
  a.dispose();
}

// ── 断言 6.1e：JSON.stringify(agent) / (agent.session) 会抛 Theme 错误 ──
line("\n═══ 断言 B（报告 6.1e）：序列化分身会抛主题错误 ═══");
{
  const b = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { modelRuntime: made.runtime });
  for (const [label, obj] of [["agent", b], ["agent.session", b.session], ["host 事件载荷", { agent: b }]] as const) {
    try {
      JSON.stringify(obj);
      line(`  JSON.stringify(${label}) → 成功`);
    } catch (e) {
      line(`  JSON.stringify(${label}) → 抛错：${(e as Error).message}`);
    }
  }
  b.dispose();
}

// ── 断言 C2.6：预算耗尽后 send() 谎报 delivered:"ran" ──
line("\n═══ 断言 C（报告 C2.6）：预算耗尽后 send 谎报 ran ═══");
{
  const host = createAgentHost({ budgetTokens: 1 }); // 立刻超
  const c = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, modelRuntime: made.runtime });
  const errs: string[] = [];
  c.on("error", (p) => errs.push(p.message));
  const before = faux.calls.length;
  const r = await c.send("这条应该跑不了");
  await sleep(300);
  line(`  send() 返回：${JSON.stringify(r)}`);
  line(`  假服务收到的请求数：${before} → ${faux.calls.length}（不变 = 一个字都没跑）`);
  line(`  error 事件：${errs.length ? JSON.stringify(errs) : "(无)"}`);
  line(`  lastResult：${c.lastResult ? JSON.stringify(c.lastResult.text) : "undefined"}`);
  line(`  status = ${c.status}`);
  c.dispose();
}

// ── 断言 C2.5：第 2 条及之后的排队消息不产生 done / round_completed ──
line("\n═══ 断言 D（报告 C2.5）：排队消息不产生 done / round_completed ═══");
{
  const host = createAgentHost({});
  const rounds: string[] = [];
  host.on("round_completed", ({ agent }) => rounds.push(agent.id));
  const d = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, modelRuntime: made.runtime });
  let dones = 0;
  d.on("done", () => (dones += 1));
  const reqBefore = faux.calls.length;
  await d.send("[[sleep:400]] 第一条");
  await sleep(80);
  for (const t of ["第二条", "第三条"]) await d.send(t);
  await d.waitForIdle();
  await sleep(400);
  line(`  真服务收到的请求数增加：${faux.calls.length - reqBefore}（3 = 三条都真的跑了）`);
  line(`  done 事件次数 = ${dones}，round_completed 次数 = ${rounds.length}`);
  d.dispose();
}

line(`\n假服务总请求数 ${faux.calls.length}，零真实 API 花费`);
await faux.close();
