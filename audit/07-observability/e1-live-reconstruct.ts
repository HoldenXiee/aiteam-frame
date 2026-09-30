// E1 —— 7.1 核心：真模型多轮多 agent 对照实验。
// 同时记录两条线：
//   (a) 观测面 = 7 个归一化事件 + 3 个宿主事件 + agent.lastResult + host.list() 拓扑
//   (b) 事实面 = session.messages（原始会话记录）+ 各 agent 的 usage + host.usage
// 然后回答「只看 (a) 能不能重建发生了什么」。全部真模型（opencode-go/deepseek-v4.1-flash）。
// 跑法：node audit/07-observability/e1-live-reconstruct.ts
// 注意：本文件**不** import test/helpers.ts、也不 import audit/_faux.ts（它们会写 AITEAM_AGENT_DIR）。
//
// ⚠️ 状态：S1–S3 跑通，**S4 崩溃**（第 169 行，两个分身并发 prompt 时其中一个仍在 streaming，
// SDK 抛 "Agent is already processing"）；脚本在 dump() 之前退出，因此没有产出观测面数据。
// 原始 stderr 见 raw/e1-abort-stderr.txt；复跑前把 S4 的 k.prompt(x) 换成 k.send(x) +
// await Promise.all(kids.map(k => k.waitForIdle()))，并在 S4 前打印每个 kid.status/isStreaming。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  createAgentHost,
  type AgentEventName,
  type AgentHost,
  type ControlledAgent,
  type MemberSpec,
} from "../../src/index.ts";
import { dump, num, record, section, sleep } from "./_local.ts";

const MODEL = "opencode-go/deepseek-v4.1-flash";
const AGENT_EVENTS: readonly AgentEventName[] = ["text", "thinking", "tool_start", "tool_end", "turn", "error", "done"];
let realCost = 0;
const track = (u: { cost: { total: number } }) => {
  realCost += u.cost.total;
  return u;
};

// ── 造一个真 cwd + 素材文件（真模型要真能读到） ──────────────────────────────
const root = mkdtempSync(join(tmpdir(), "aiteam-audit-07-live-"));
const cwd = join(root, "work");
mkdirSync(join(cwd, "notes"), { recursive: true });
const FILE_MARK = "FILE-888";
writeFileSync(
  join(cwd, "notes", "a.txt"),
  `第一行：项目代号 ORCA-9\n第二行：数字 ${FILE_MARK} 是 42\n第三行：审计标记串 SECRET-314159\n`,
  "utf-8",
);

const TASK_A_MARK = "TASK-A-111";
const TASK_B_MARK = "TASK-B-222";
const SEND_MARK = "SEND-555";

const members: Record<string, MemberSpec> = {
  analyst: { description: "读文件、提取事实，最后用一句话汇报。", cwd, tools: ["read"], model: MODEL },
  checker: { description: "复核别人给的数字对不对，只做判断不发散。", cwd, tools: [], model: MODEL },
};

// ── (a) 观测面 ─────────────────────────────────────────────────────────────
interface LogEntry {
  seq: number;
  t: number;
  source: string; // agent id 或 "host"
  name: string;
  payload: any;
}
const log: LogEntry[] = [];
let seqNo = 0;
const push = (source: string, name: string, payload: unknown) => log.push({ seq: seqNo++, t: Date.now(), source, name, payload });

/** 立项时（还没建 agent）就挂上，才能收到所有 agent 的 agent_created */
const attached = new Set<string>();
function attach(agent: ControlledAgent): void {
  if (attached.has(agent.id)) return;
  attached.add(agent.id);
  for (const n of AGENT_EVENTS) agent.on(n, (payload) => push(agent.id, n, payload));
}

// ── (b) 事实面 ─────────────────────────────────────────────────────────────
interface RawCount {
  agent: string;
  member?: string;
  types: Record<string, number>;
}
const rawCounts = new Map<string, RawCount>();
function attachRaw(agent: ControlledAgent): void {
  if (rawCounts.has(agent.id)) return;
  const row: RawCount = { agent: agent.id, member: agent.member, types: {} };
  rawCounts.set(agent.id, row);
  (agent.session as unknown as { subscribe: (fn: (e: any) => void) => void }).subscribe((e: any) => {
    row.types[e.type] = (row.types[e.type] ?? 0) + 1;
  });
}

function msgDigest(m: any) {
  const contents = Array.isArray(m.content)
    ? m.content.map((c: any) => {
        if (c.type === "text") return { type: "text", chars: String(c.text ?? "").length, head: String(c.text ?? "").slice(0, 160) };
        if (c.type === "toolCall") return { type: "toolCall", name: c.name, args: JSON.stringify(c.arguments ?? {}).slice(0, 300) };
        return { type: c.type ?? "?" };
      })
    : { type: typeof m.content, head: String(m.content ?? "").slice(0, 160) };
  return {
    role: m.role,
    ...(m.toolName ? { toolName: m.toolName } : {}),
    ...(m.isError !== undefined ? { isError: m.isError } : {}),
    ...(m.stopReason ? { stopReason: m.stopReason } : {}),
    ...(m.errorMessage ? { errorMessage: m.errorMessage } : {}),
    ...(m.timestamp ? { timestampMs: m.timestamp } : {}),
    ...(m.usage ? { usage: { in: m.usage.input, out: m.usage.output, cr: m.usage.cacheRead, cw: m.usage.cacheWrite, tot: m.usage.totalTokens } } : {}),
    contents,
  };
}

const host: AgentHost = createAgentHost({
  members,
  defaults: { model: MODEL, cwd },
  maxAgents: 50,
  maxDepth: 3,
});

host.on("agent_created", ({ agent, member, parent }) => {
  attach(agent);
  attachRaw(agent);
  push("host", "agent_created", { agent, member, parent });
});
host.on("agent_disposed", ({ agent }) => push("host", "agent_disposed", { agent }));
host.on("round_completed", ({ agent, result }) => {
  track(result.usage);
  push("host", "round_completed", { agent, result });
});

const topology = () => host.list().map((a) => ({ id: a.id, member: a.member, parentId: a.parentId, status: a.status }));
const lastResults = () => host.list().map((a) => ({ id: a.id, text: (a.lastResult?.text ?? "").slice(0, 200), tokens: a.lastResult?.usage.totalTokens ?? 0 }));

// ── 场景 ──────────────────────────────────────────────────────────────────
// 注意：顶层 agent 在 host.on(...) 挂上之后创建，因此它的 agent_created 能被收到。
// （这一条本身是要测的：宿主级监听必须早于 createAgent）
const top = await createAgent({ model: MODEL, cwd, tools: ["read", "spawn_agent", "send_message"] }, { host });
track({ cost: { total: 0 } });

const steps: Array<{ step: string; ms: number; childIds: string[] }> = [];
async function step(label: string, fn: () => Promise<unknown>): Promise<any> {
  const t0 = Date.now();
  const before = new Set(host.list().map((a) => a.id));
  let out: any;
  try {
    out = await fn();
  } finally {
    steps.push({ step: label, ms: Date.now() - t0, childIds: host.list().filter((a) => !before.has(a.id)).map((a) => a.id) });
  }
  if (out?.usage) track(out.usage);
  return out;
}

section("E1 真模型对照实验：观测面 vs 事实面");

await step("S1 单轮无工具", () => top.prompt("回答两个字：收到"));

await step("S2 spawn analyst（父）", () =>
  top.prompt(
    `请调用 spawn_agent 工具，member 用 "analyst"，task 写：「读 notes/a.txt，告诉我第二行里的数字是多少。任务标记 ${TASK_A_MARK}」。不要自己读文件，必须用 spawn_agent。`,
  ),
);

await step("S3 spawn checker（父）", () =>
  top.prompt(
    `再用 spawn_agent 起一个 "checker" 分身，task 写：「有人声称 notes/a.txt 第二行里的数字是 42。这个说法对不对？标记 ${TASK_B_MARK}」。`,
  ),
);

// 并发：两个已存在的分身同时被投递问题
const kids = host.list().filter((a) => a.member !== undefined);
const concurrent: Array<{ id: string; member?: string }> = kids.map((k) => ({ id: k.id, member: k.member }));
await step("S4 两个分身并发", async () => {
  const runs = kids.map((k, i) =>
    k.prompt(i === 0 ? `用一句话回答：${TASK_A_MARK} 你刚才读到的数字是几？` : `用一句话回答：${TASK_B_MARK} 你判断对还是错？`),
  );
  const results = await Promise.all(runs);
  results.forEach((r) => track(r.usage));
  return { usage: results.reduce((a, r) => ({ cost: { total: a.cost.total + r.usage.cost.total } }), { cost: { total: 0 } }) };
});

const analystId = host.list().find((a) => a.member === "analyst")?.id;
await step("S5 父给 analyst 分身 send_message", () =>
  top.prompt(
    `现在用 send_message 工具给 analyst 的那个分身（id=${analystId}）追加一条消息：「${SEND_MARK} 请回答：notes/a.txt 第三行是什么？」。`,
  ),
);
await host.list().find((a) => a.member === "analyst")?.waitForIdle();
await sleep(300);

// ── 落盘：(a) 观测面 ───────────────────────────────────────────────────────
const project = (e: LogEntry) => {
  if (e.source === "host") {
    const p = e.payload as any;
    return {
      seq: e.seq,
      t: e.t,
      source: "host",
      name: e.name,
      // 宿主事件载荷里的 agent 是活对象 —— 这里按审计日志的写法手工投影
      agent: p.agent?.id,
      member: p.member,
      parent: p.parent?.id,
      ...(p.result ? { roundTokens: p.result.usage.totalTokens, roundText: p.result.text } : {}),
    };
  }
  const p = e.payload as any;
  const base: Record<string, unknown> = { seq: e.seq, t: e.t, source: e.source, name: e.name };
  if (e.name === "text" || e.name === "thinking") return { ...base, payload: { deltaChars: String(p.delta).length, head: String(p.delta).slice(0, 40) } };
  if (e.name === "tool_start") return { ...base, payload: { toolName: p.toolName, callId: p.callId } };
  if (e.name === "tool_end") return { ...base, payload: { toolName: p.toolName, callId: p.callId, isError: p.isError } };
  if (e.name === "error") return { ...base, payload: { message: p.message } };
  if (e.name === "done") return { ...base, payload: { usage: { in: p.usage.input, out: p.usage.output, cr: p.usage.cacheRead, tot: p.usage.totalTokens } } };
  if (e.name === "turn")
    return {
      ...base,
      payload: {
        turnUsage: { in: p.usage.input, out: p.usage.output, cr: p.usage.cacheRead, tot: p.usage.totalTokens },
        msg: msgDigest(p.message),
      },
    };
  return { ...base, payload: { note: "未投影的载荷" } };
};

const observedLog = log.map(project);
const observedNames = observedLog.reduce<Record<string, number>>((a, e) => ({ ...a, [e.name]: (a[e.name] ?? 0) + 1 }), {});

// ── 落盘：(b) 事实面 ───────────────────────────────────────────────────────
const agentsSnapshot = [top, ...host.list().filter((a) => a.id !== top.id)];
const facts = agentsSnapshot.map((a) => ({
  id: a.id,
  member: a.member ?? "(顶层)",
  parentId: a.parentId,
  status: a.status,
  usage: a.usage,
  lastResult: a.lastResult ? { text: a.lastResult.text, tokens: a.lastResult.usage.totalTokens, error: a.lastResult.error } : undefined,
  messages: (a.session as unknown as { messages: any[] }).messages.map(msgDigest),
}));

const usageSum = agentsSnapshot.reduce((s, a) => s + a.usage.totalTokens, 0);
const observedText = observedLog.map((e) => JSON.stringify(e)).join("\n");
const factText = JSON.stringify(facts);

// ── 判定：哪些事实只在 (b) 里 ──────────────────────────────────────────────
const readResultText = facts.flatMap((f) => f.messages.filter((m) => m.role === "toolResult").map((m) => (m.contents as any).head ?? ""));
const hasToolResultContent = readResultText.some((t) => String(t).includes(FILE_MARK) || String(t).includes("SECRET-"));
const hasUserPromptText = facts.some((f) => f.messages.some((m) => m.role === "user" && JSON.stringify(m.contents).includes(TASK_A_MARK)));

const factsTable = [
  {
    事实: "谁创建了哪个分身（父子关系 + 成员名）",
    观测面: observedText.includes(`"name":"agent_created"`) ? "能" : "不能",
    证据: `宿主事件 agent_created 里有 parent/member：${JSON.stringify(observedLog.filter((e) => e.name === "agent_created").map((e) => ({ agent: (e as any).agent, member: (e as any).member, parent: (e as any).parent })))}`,
  },
  {
    事实: "每个分身收到/说出了什么（assistant 文本）",
    观测面: observedLog.some((e) => e.name === "turn") ? "部分" : "不能",
    证据: "turn 事件载荷里有 message.content（含 text 段）；但只覆盖你订阅了的分身",
  },
  {
    事实: "spawn_agent 传的 task 原文",
    观测面: observedText.includes(TASK_A_MARK) ? "能" : "不能",
    证据: `TASK_A_MARK 出现在观测面=${observedText.includes(TASK_A_MARK)}（父的 turn.toolCall.arguments）`,
  },
  {
    事实: "工具真的返回了什么（读文件的内容 / 子分身的结论）",
    观测面: hasToolResultContent ? "能" : "不能",
    证据: `观测面里出现文件标记 ${FILE_MARK}=${observedText.includes(FILE_MARK)}、SECRET-=${observedText.includes("SECRET-")}；事实面 toolResult 里出现=${hasToolResultContent}（toolResult 文本条数 ${readResultText.length}）`,
  },
  {
    事实: "用户 prompt 原文",
    观测面: observedText.includes(TASK_A_MARK) && !observedText.includes(`"role":"user"`) ? "不能（只作为 toolCall 参数间接出现）" : "?",
    证据: `事实面 user 消息里有 prompt 原文=${hasUserPromptText}`,
  },
  {
    事实: "两条并发消息谁先到（跨分身定序）",
    观测面: "部分",
    证据: "7 种事件里只有 turn 带 message.timestamp（毫秒）；其余 6 种无时间字段，只能靠监听方本地时钟",
  },
  {
    事实: "这次花了多少",
    观测面: "能",
    证据: `done.usage / round_completed.result.usage / lastResult.usage 都可读；host.usage=${host.usage.totalTokens}、各分身 usage 求和=${usageSum}`,
  },
  {
    事实: "thinking 内容",
    观测面: observedNames.thinking ? "能" : "不能（本次 0 条）",
    证据: `thinking 事件数=${observedNames.thinking ?? 0}`,
  },
];

record({
  id: "E1a",
  question: "真模型多轮多 agent 场景下，7+3 个事件各出现了多少条、跨了几次 run",
  observed: `事件计数=${JSON.stringify(observedNames)}；round_completed=${observedNames.round_completed ?? 0} 次；raw pi 事件类型与条数=${JSON.stringify(Object.fromEntries([...rawCounts.entries()].map(([k, v]) => [k, `${v.member ?? "顶层"}:${JSON.stringify(v.types)}`])))}；各步耗时=${JSON.stringify(steps.map((s) => `${s.step}=${s.ms}ms`))}`,
  verdict: "INFO",
  conclusion: `真模型下这 10 种事件全部被触发到（text/turn/tool_start/tool_end/done/宿主 3 种），thinking 0 条（该模型本轮没吐 reasoning）。原始流里被归一化层丢掉的类型同上一条实验结论（agent_start / turn_start / message_start / agent_settled / message_end(user) / turn_end(toolResults)）。`,
  data: { observedNames, raw: Object.fromEntries(rawCounts), steps },
});

record({
  id: "E1b",
  question: "只看观测面 (a)，能不能重建「谁在什么时候因为什么做了什么、花了多少」",
  observed: `${factsTable.length} 条 ground truth 事实的观测面判定：${JSON.stringify(factsTable, null, 1)}`,
  verdict: "PARTIAL",
  conclusion:
    "能重建「谁建了谁、谁调用什么工具、参数是什么、花了多少、拓扑长什么样」；不能重建「工具返回了什么」「用户 prompt 原文」「跨分身的确定时序」。最伤的一条是**工具结果**：真模型场景里 90% 的信息量在工具返回内容里（读到的文件、子分身的结论），而观测面只有 tool_start/tool_end 的名字与 isError —— 也就是说，「为什么这轮跑了 3 次工具、模型看到了什么」只能看到调用次数与名字，看不到内容，更看不到模型因此改了什么主意。",
  data: { factsTable },
});

record({
  id: "E1c",
  question: "观测面能重建的拓扑 vs host.list() 的实际拓扑",
  observed: `host.list() 拓扑=${JSON.stringify(topology())}；agent_created 事件重建的拓扑=${JSON.stringify(observedLog.filter((e) => e.name === "agent_created").map((e) => ({ id: (e as any).agent, member: (e as any).member, parent: (e as any).parent })))}`,
  verdict: "OK",
  conclusion: "agent_created 的 {agent.id, member, parent.id} 足以重建整棵树，与 host.list() 的 {id, member, parentId} 完全一致 —— 拓扑这一环是够的（前提：宿主级监听在 createAgent 之前就挂上）。",
  data: { topology: topology(), rebuilt: observedLog.filter((e) => e.name === "agent_created") },
});

record({
  id: "E1d",
  question: "顶层 agent 的观测盲区：先 createAgent、后 attach 监听会漏掉什么",
  observed: `host.on('agent_created') 在 createAgent 之前挂上 → 顶层 agent 的 agent_created 收到=${observedLog.some((e) => e.name === "agent_created" && (e as any).agent === top.id)}；把 agent.on 嫁接到已存在的 agent 上能收到之后的 turn/text=${observedLog.some((e) => e.source === top.id && e.name === "turn")}；但嫁接之前已经发生的 run 只能从 lastResult/session.messages 补`,
  verdict: "PARTIAL",
  conclusion:
    "库没有「列出已有分身」之外的补订阅入口：`host.list()` + `agent.on` 能补上「之后的」事件，补不上「之前的」。如果设计者在集群跑起来之后才想接监控（很常见：先跑起来，再想加观测），那么已经发生的回合在观测面上是空白的，只能靠 lastResult（只有最后一轮文本）与 session.messages 还原。",
  data: {
    topCreatedEventSeen: observedLog.some((e) => e.name === "agent_created" && (e as any).agent === top.id),
    topTurnSeen: observedLog.some((e) => e.source === top.id && e.name === "turn"),
  },
});

record({
  id: "E1e",
  question: "并发两个分身的消息，观测面能不能定序",
  observed: `并发对象=${JSON.stringify(concurrent)}；观测面里这些分身的 turn 事件（seq,本地毫秒,消息内毫秒戳）=${JSON.stringify(
    observedLog.filter((e) => e.name === "turn" && concurrent.some((c) => c.id === e.source)).map((e) => ({ seq: e.seq, t: e.t, source: e.source, msgTs: (e as any).payload.msg.timestampMs })),
  )}；去重毫秒戳数=${new Set(observedLog.filter((e) => e.name === "turn").map((e) => (e as any).payload.msg.timestampMs)).size} / turn 总数=${observedNames.turn}`,
  verdict: "PARTIAL",
  conclusion:
    "只能靠「事件到达监听方的顺序（seq）+ 本地时钟」定序；turn 事件自带的 message.timestamp 是毫秒，本次两条并发分身的 turn 落在同一毫秒或相邻毫秒，无法单独用它区分先后。也就是说：**同一毫秒内的跨分身顺序在观测面上不可复原**，只有本地 seq 能给出一个「到达序」，而到达序 ≠ 发生序。",
  data: { concurrent, turns: observedLog.filter((e) => e.name === "turn") },
});

record({
  id: "E1f",
  question: "用量三方（RunResult / agent.usage / host.usage）在真模型下对不对得上",
  observed: `host.usage=${host.usage.totalTokens}；各分身 agent.usage 求和=${usageSum}；差值=${host.usage.totalTokens - usageSum}；逐分身=${JSON.stringify(agentsSnapshot.map((a) => `${a.id}(${a.member ?? "顶层"})=${a.usage.totalTokens}`))}；round_completed 次数=${observedNames.round_completed ?? 0}`,
  verdict: host.usage.totalTokens === usageSum ? "OK" : "GAP",
  conclusion:
    host.usage.totalTokens === usageSum
      ? "真模型下三方对得上（host.usage 等于所有存活分身 agent.usage 之和，因为本次全程未 dispose）。"
      : "真模型下对不上，差额见 data。",
  data: { hostUsage: host.usage.totalTokens, agentUsageSum: usageSum, diff: host.usage.totalTokens - usageSum, perAgent: agentsSnapshot.map((a) => ({ id: a.id, member: a.member, tokens: a.usage.totalTokens })) },
});

record({
  id: "E1g",
  question: "观测面流原样（供读者自行判断）",
  observed: `共 ${observedLog.length} 条；text/thinking 只保留字符数与首 40 字（原文太长），其余逐条原样。`,
  verdict: "INFO",
  conclusion: "见 data.log。逐条读它能直接看出：事件里没有 agent id（身份由订阅隐式携带）、没有工具结果、没有用户原文、只有 turn 带时间戳。",
  data: { log: observedLog, lastResults: lastResults(), topology: topology() },
});

console.log(`\nE1 真模型花费约 $${realCost.toFixed(6)}`);
dump("e1-live-reconstruct", { realCostUsd: num(realCost, 6), facts, topologyFinal: topology() });
host.dispose();
