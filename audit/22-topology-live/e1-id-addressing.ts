// E1：真模型按 id 寻址 —— 本部分最关键。
// 每个变体独立跑 N 次；每次都从 session.messages 取「模型实际发出的 agentId」做 ground truth（不靠库的 API）。
// 跑法：node audit/22-topology-live/e1-id-addressing.ts   （真模型，并发 2）
import { createAgent, createAgentHost, type AgentHost, type ControlledAgent } from "../../src/index.ts";
import { FLASH, ci, makeSink, pool, turn, workDir, type ToolCallRec, type ToolResultRec } from "./_lib.ts";

const sink = makeSink("e1-id-addressing");
const SMOKE = process.argv.includes("--smoke"); // 每个变体先各跑 1 次验证机制
const N = SMOKE ? { v1: 1, v2: 1, v3: 1, v4: 1, v5: 1 } : { v1: 9, v2: 9, v3: 9, v4: 8, v5: 9 };
const CONC = 2;
const cwd = workDir("e1");

const MEMBERS = {
  worker: { description: "工人：只回一句极简回答，不超过 8 个字", tools: [] as string[] },
  researcher: { description: "调研员：查资料、给事实", tools: [] as string[] },
  coder: { description: "程序员：写代码、改 bug", tools: [] as string[] },
  tester: { description: "测试员：复现缺陷、跑用例", tools: [] as string[] },
  writer: { description: "文案：写说明与公告", tools: [] as string[] },
};

function newHost(maxAgents = 12) {
  return createAgentHost({ defaults: { model: FLASH }, members: MEMBERS, maxAgents } as never);
}
async function newLead(host: AgentHost) {
  return createAgent({ model: FLASH, cwd, tools: ["spawn_agent", "send_message"] }, { host });
}
/** 设计者侧直接造一个后代（不经 LLM），用于「id 写在 prompt 里」这类变体 */
async function designerChild(host: AgentHost, parent: ControlledAgent, member: string) {
  return createAgent({ model: FLASH, cwd, tools: [], ...(MEMBERS as any)[member] }, { host, parent, member });
}
const idFromSpawnText = (s: string) => s.match(/id 是 (a\d+)/)?.[1];

interface RunRec {
  variant: string;
  i: number;
  ok: boolean;
  mode: string;
  expectedId?: string;
  actualId?: string;
  calls: ToolCallRec[];
  results: Array<{ name: string; text: string; isError: boolean }>;
  finalText: string;
  err?: string;
  tokens: number;
  cost: number;
  ms: number;
}

function base(variant: string, i: number, expectedId?: string): RunRec {
  return { variant, i, ok: false, mode: "unclassified", expectedId, calls: [], results: [], finalText: "", tokens: 0, cost: 0, ms: 0 };
}
function finish(sinkRef: any, host: AgentHost, rec: RunRec, turns: Array<{ tokens: number; cost: number; ms: number }>) {
  rec.tokens = host.usage.totalTokens;
  rec.cost = host.usage.cost.total;
  rec.ms = turns.reduce((a, t) => a + t.ms, 0);
  host.dispose();
  return rec;
}
const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ─────────────── V1：id 直接写在 prompt 里 ───────────────
async function v1(i: number): Promise<RunRec> {
  const rec = base("V1-id在prompt", i);
  const host = newHost();
  const lead = await newLead(host);
  const w = await designerChild(host, lead, "worker");
  rec.expectedId = w.id;
  const t = await turn(lead, `你的一个后代分身 id 是 ${w.id}。请用 send_message 给它发一条消息，内容正好是「ping-7」。除此之外什么都不要做。`);
  rec.calls = t.calls;
  rec.results = t.results;
  rec.finalText = t.text;
  rec.err = t.error;
  const send = t.calls.find((c) => c.name === "send_message");
  const other = t.calls.find((c) => c.name !== "send_message");
  if (t.error) rec.mode = "抛错";
  else if (!send && other) rec.mode = `调错工具(${other.name})`;
  else if (!send) rec.mode = "不调用工具";
  else {
    rec.actualId = String(send.args.agentId);
    rec.mode = rec.actualId === w.id ? "正确" : host.get(rec.actualId) ? "投给别的真实 id" : "编造 id";
  }
  rec.ok = rec.mode === "正确";
  return finish(sink, host, rec, [t]);
}

// ─────────────── V2：id 只出现在上一条工具结果里 ───────────────
async function v2(i: number): Promise<RunRec> {
  const rec = base("V2-id只在工具结果");
  const host = newHost();
  const lead = await newLead(host);
  const t1 = await turn(lead, "用 spawn_agent 让 worker 回答「2+2 等于几」，只回一个数字。");
  const w = host.list().find((a) => a.member === "worker");
  if (!w) {
    rec.mode = "第一轮没建出 worker";
    rec.calls = t1.calls;
    rec.finalText = t1.text;
    return finish(sink, host, rec, [t1]);
  }
  rec.expectedId = w.id;
  const t2 = await turn(lead, "现在用 send_message 把你刚建的那个分身再叫一次，消息正好是「请确认收到」。用它刚才的 id。");
  rec.calls = t2.calls;
  rec.results = t2.results;
  rec.finalText = t2.text;
  rec.err = t2.error;
  const send = t2.calls.find((c) => c.name === "send_message");
  if (t2.error) rec.mode = "抛错";
  else if (!send) rec.mode = t2.calls.length ? "不提 id 只换别的工具" : "不调用工具";
  else {
    rec.actualId = String(send.args.agentId);
    if (rec.actualId === w.id) rec.mode = "正确";
    else if (host.get(rec.actualId)) rec.mode = "投给别的真实 id";
    else if (rec.actualId.replace(/\d/g, "") === w.id.replace(/\d/g, "")) rec.mode = "id 写错一位/数字错";
    else rec.mode = "编造 id";
  }
  rec.ok = rec.mode === "正确";
  return finish(sink, host, rec, [t1, t2]);
}

// ─────────────── V3：同时 4 个 id 需要区分 ───────────────
const V3_TARGET = "tester";
async function v3(i: number): Promise<RunRec> {
  const rec = base("V3-四个 id 区分");
  const host = newHost();
  const lead = await newLead(host);
  const t1 = await turn(
    lead,
    "请分别用 spawn_agent 起这四个分身，每人都派一句话的活：" +
      "researcher 回答「天为什么是蓝的」（一句话）；coder 写一行 hello world；" +
      "tester 复现「点击后闪退」（一句话）；writer 写一句公告。",
  );
  const agents = host.list();
  const spawned = Object.keys(MEMBERS).filter((m) => agents.some((a) => a.member === m));
  rec.calls = t1.calls;
  if (!agents.some((a) => a.member === V3_TARGET)) {
    rec.mode = `第一轮没建出 ${V3_TARGET}（建出：${spawned.join(",") || "无"}）`;
    rec.finalText = t1.text;
    return finish(sink, host, rec, [t1]);
  }
  const target = agents.find((a) => a.member === V3_TARGET)!;
  rec.expectedId = target.id;
  const siblings = agents.filter((a) => a.member !== V3_TARGET).map((a) => a.id);
  const t2 = await turn(lead, `把消息「请复测一下登录闪退」发给刚才那个 tester 分身。用它的 id。`);
  rec.results = t2.results;
  rec.finalText = t2.text;
  const send = t2.calls.find((c) => c.name === "send_message");
  if (t2.error) rec.mode = "抛错";
  else if (!send) rec.mode = "不调用工具";
  else {
    rec.actualId = String(send.args.agentId);
    if (rec.actualId === target.id) rec.mode = "正确";
    else if (siblings.includes(rec.actualId)) rec.mode = `投给兄弟(${host.get(rec.actualId)?.member})`;
    else if (host.get(rec.actualId)) rec.mode = "投给别的真实 id";
    else rec.mode = "编造 id";
  }
  rec.ok = rec.mode === "正确";
  return finish(sink, host, rec, [t1, t2]);
}

// ─────────────── V4：隔 5 轮后再用该 id（记忆保持） ───────────────
async function v4(i: number): Promise<RunRec> {
  const rec = base("V4-隔5轮后复用");
  const host = newHost();
  const lead = await newLead(host);
  const t1 = await turn(lead, "用 spawn_agent 让 worker 回答「9-3 等于几」，只回一个数字。记住它的 id，后面要用。");
  const w = host.list().find((a) => a.member === "worker");
  if (!w) {
    rec.mode = "第一轮没建出 worker";
    return finish(sink, host, rec, [t1]);
  }
  rec.expectedId = w.id;
  const turns = [t1];
  for (let k = 1; k <= 5; k++) {
    const f = await turn(lead, `只回答这个数字：${k}。不要任何其他字符。`);
    turns.push(f);
  }
  const t2 = await turn(lead, "用 send_message 把「记忆测试」发给你在最开始建的那个 worker 分身。用它当时的 id。");
  turns.push(t2);
  rec.calls = t2.calls;
  rec.results = t2.results;
  rec.finalText = t2.text;
  const send = t2.calls.find((c) => c.name === "send_message");
  if (t2.error) rec.mode = "抛错";
  else if (!send) rec.mode = "不调用工具";
  else {
    rec.actualId = String(send.args.agentId);
    if (rec.actualId === w.id) rec.mode = "正确";
    else if (host.get(rec.actualId)) rec.mode = "投给别的真实 id";
    else rec.mode = "编造 id（忘了）";
  }
  rec.ok = rec.mode === "正确";
  return finish(sink, host, rec, turns);
}

// ─────────────── V5：给一个不存在的 id ───────────────
const GHOST = "a9999";
async function v5(i: number): Promise<RunRec> {
  const rec = base("V5-不存在的 id", i, GHOST);
  const host = newHost();
  const lead = await newLead(host);
  const w = await designerChild(host, lead, "worker"); // 真有个后代，但 id 不是 GHOST
  void w;
  const t = await turn(
    lead,
    `请用 send_message 把「hello」发给 id 是 ${GHOST} 的分身。然后把工具返回的原文照抄给我，并用一句话说明结果。`,
  );
  rec.calls = t.calls;
  rec.results = t.results;
  rec.finalText = t.text;
  rec.err = t.error;
  const send = t.calls.find((c) => c.name === "send_message");
  const deniedText = t.results.map((r) => r.text).join(" | ");
  const honest = /没有|不存在|找不到/.test(t.text) || /没有|不存在/.test(deniedText);
  if (t.error) rec.mode = "抛错";
  else if (!send) rec.mode = "不调用工具（直接拒绝）";
  else {
    rec.actualId = String(send.args.agentId);
    if (rec.actualId === GHOST) rec.mode = honest ? "照发→工具拒绝→如实汇报" : "照发→工具拒绝→汇报含糊";
    else rec.mode = `擅自改成别的 id(${rec.actualId})`;
  }
  rec.ok = rec.mode === "照发→工具拒绝→如实汇报";
  return finish(sink, host, rec, [t]);
}

// ─────────────────────────────────────────────────────────────
const variants: Array<{ name: string; n: number; fn: (i: number) => Promise<RunRec> }> = [
  { name: "V1", n: N.v1, fn: v1 },
  { name: "V2", n: N.v2, fn: v2 },
  { name: "V3", n: N.v3, fn: v3 },
  { name: "V4", n: N.v4, fn: v4 },
  { name: "V5", n: N.v5, fn: v5 },
];

const all: RunRec[] = [];
for (const v of variants) {
  sink.section(`${v.name} × ${v.n}`);
  const idx = Array.from({ length: v.n }, (_, i) => i + 1);
  const recs = await pool(idx, CONC, async (i) => {
    const r = await v.fn(i);
    console.log(`${r.ok ? "✓" : "✗"} ${r.variant}#${i} mode=${r.mode} expected=${r.expectedId ?? "-"} actual=${r.actualId ?? "-"} ${r.ms}ms $${r.cost.toFixed(6)}`);
    return r;
  });
  all.push(...recs);
  const ok = recs.filter((r) => r.ok).length;
  const modes = recs.reduce<Record<string, number>>((a, r) => ({ ...a, [r.mode]: (a[r.mode] ?? 0) + 1 }), {});
  const cost = recs.reduce((a, r) => a + r.cost, 0);
  const tok = recs.reduce((a, r) => a + r.tokens, 0);
  const ms = recs.reduce((a, r) => Math.max(a, r.ms), 0);
  sink.add({
    id: `E1-${v.name}`,
    question: `${v.name}：${v.name === "V1" ? "id 写在 prompt 里" : v.name === "V2" ? "id 只在工具结果里（要求复用）" : v.name === "V3" ? "同时 4 个 id 需要区分" : v.name === "V4" ? "隔 5 轮后再用该 id" : "给一个不存在的 id"}`,
    method: "node audit/22-topology-live/e1-id-addressing.ts（真模型 deepseek-v4.1-flash，从 session.messages 读实际发送的 agentId）",
    observed: `${ok}/${v.n} 成功（${ci(ok, v.n)}）；失败模式分布 ${JSON.stringify(modes)}；本轮合计 ${tok} token / $${cost.toFixed(5)}；单次最长墙钟 ${ms}ms`,
    verdict: ok === v.n ? "OK" : ok >= v.n * 0.8 ? "PARTIAL" : "GAP",
    conclusion: `${v.name} 成功率 ${ok}/${v.n}。${ok === v.n ? "在本次样本里没有失败。" : `失败 ${v.n - ok} 次，模式：${JSON.stringify(modes)}。`}`,
    data: { ok, n: v.n, modes, recs },
  });
  sink.ledger(`runs-${v.name}`, recs);
}

const total = all.reduce((a, r) => a + r.cost, 0);
const totalTok = all.reduce((a, r) => a + r.tokens, 0);
sink.ledger("total", { runs: all.length, tokens: totalTok, cost: total });
console.log(`\nE1 结束：${all.length} 次真模型运行，合计 ${totalTok} token / $${total.toFixed(5)}`);
console.log(`→ ${sink.path}`);
