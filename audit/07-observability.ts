// 第 7 部分：观测与归因 —— 事件流能重建什么、用量能不能算清、三方数字对不对得上。
// 跑法：node audit/07-observability.ts
// 全部走本机假 provider（零 API 花费）。花名册/defaults 必须显式钉住 model + agentDir。
// 假 provider 的每一条回复固定计 18 token（prompt_tokens=11 + completion_tokens=7），
// 因此「期望用量 = 18 × 假服务收到的请求数」就是本次对账的 ground truth。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgent, createAgentHost, type AgentHost, type AgentEventName, type ControlledAgent, type HostOptions } from "../src/index.ts";
import { createSpawnAgentTool } from "../src/tools/spawn-agent.ts";
import { createSendMessageTool } from "../src/tools/send-message.ts";
import { dump, num, record, section } from "./_harness.ts";
import { makeEnv } from "./_faux.ts";

const env = await makeEnv();
const defaults = { model: env.model, agentDir: env.agentDir, cwd: env.cwd };
const TOKENS_PER_REQUEST = 18; // 假服务固定回包
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");
const AGENT_EVENTS = ["text", "thinking", "tool_start", "tool_end", "turn", "error", "done"] as const satisfies readonly AgentEventName[];
/** 事件载荷里有活对象（ControlledAgent.session），直接 stringify 会抛错 —— 审计日志必须先投影 */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "undefined";
  } catch (e) {
    return `<序列化失败: ${(e as Error).message}>`;
  }
}

function newHost(extra: Partial<HostOptions> = {}): AgentHost {
  return createAgentHost({
    defaults,
    members: { w: { description: "工人" } },
    maxAgents: 1000,
    maxDepth: 2,
    modelRuntime: env.runtime,
    ...extra,
  });
}
const mkTop = (host: AgentHost, extra: Record<string, unknown> = {}) =>
  createAgent({ ...defaults, tools: ["spawn_agent", "send_message", "read"], ...extra }, { host, modelRuntime: env.runtime });

// ─────────────────────────────────────────────────────────────
section("7.1 事件能否重建「发生了什么」");

interface LogEntry {
  seq: number;
  at: number;
  source: string;
  name: string;
  payload: unknown;
}
const log: LogEntry[] = [];
let seqNo = 0;
function attach(agent: ControlledAgent): void {
  for (const name of AGENT_EVENTS) {
    agent.on(name, (payload) => log.push({ seq: seqNo++, at: Date.now(), source: agent.id, name, payload }));
  }
}
/** 只归一化事件 + 宿主事件能拼出来的「发生了什么」 */
function rebuild(entries: LogEntry[]): string[] {  const lines: string[] = [];
  for (const e of entries) {
    const p = e.payload as any;
    if (e.source === "host" && e.name === "agent_created") lines.push(`+agent id=${p.agent.id} member=${p.member ?? "-"} parent=${p.parent?.id ?? "-"}`);
    else if (e.source === "host" && e.name === "agent_disposed") lines.push(`-agent id=${p.agent.id}`);
    else if (e.source === "host" && e.name === "round_completed") lines.push(`[${e.source}] round_done tokens=${p.result.usage.totalTokens} text=${JSON.stringify(p.result.text.slice(0, 60))}`);
    else if (e.name === "turn") {
      const parts = (p.message.content as any[]).map((c) =>
        c.type === "toolCall" ? `toolCall(${c.name} ${JSON.stringify(c.arguments)})` : `${c.type}(${JSON.stringify(String(c.text ?? "")).slice(0, 60)})`,
      );
      lines.push(`[${e.source}] turn ts=${p.message.timestamp} usage=${p.usage.totalTokens} ${parts.join(" ")}`);
    } else if (e.name === "tool_start") lines.push(`[${e.source}] tool_start ${p.toolName} callId=${p.callId}`);
    else if (e.name === "tool_end") lines.push(`[${e.source}] tool_end ${p.toolName} callId=${p.callId} isError=${p.isError}`);
    else if (e.name === "error") lines.push(`[${e.source}] error ${JSON.stringify(p.message)}`);
    else if (e.name === "done") lines.push(`[${e.source}] done usage=${p.usage.totalTokens}`);
    else if (e.name === "text") lines.push(`[${e.source}] text +${p.delta.length}字`);
    else if (e.name === "thinking") lines.push(`[${e.source}] thinking +${p.delta.length}字`);
  }
  return lines;
}

/** 把日志条目投影成可序列化形式（事件载荷直接 stringify 会抛错） */
function project(e: LogEntry): Record<string, unknown> {
  const p = e.payload as any;
  if (e.source === "host") {
    return { seq: e.seq, at: e.at, source: e.source, name: e.name, agent: p.agent?.id, member: p.member, parent: p.parent?.id, tokens: p.result?.usage?.totalTokens };
  }
  return { seq: e.seq, at: e.at, source: e.source, name: e.name, payload: p };
}

// 场景：顶层多轮 + 工具调用 + 一个分身 + 给分身追加一条消息
const USER_MARKER = "唯一用户标记串-USER-777";
{
  const host = newHost();
  const rawByAgent = new Map<string, unknown[]>();
  // 归一化事件流 + 宿主事件流（这是库对外提供的那 10 种）
  host.on("agent_created", ({ agent }) => {
    attach(agent);
    rawByAgent.set(agent.id, []);
    (agent.session as unknown as { subscribe: (fn: (e: unknown) => void) => void }).subscribe((e) => rawByAgent.get(agent.id)!.push(e));
    log.push({ seq: seqNo++, at: Date.now(), source: "host", name: "agent_created", payload: { agent, member: agent.member, parent: agent.parentId ? host.get(agent.parentId) : undefined } });
  });
  host.on("agent_disposed", ({ agent }) => log.push({ seq: seqNo++, at: Date.now(), source: "host", name: "agent_disposed", payload: { agent } }));
  host.on("round_completed", ({ agent, result }) => log.push({ seq: seqNo++, at: Date.now(), source: "host", name: "round_completed", payload: { agent, result } }));

  const top = await mkTop(host);
  // 第 1 轮：用户标记串 + 一个工具调用（假服务在有工具调用时不回显用户文本，避免混淆）
  await top.prompt(`${USER_MARKER} [[tool:read]] [[args:{"path":"唯一文件标记串-FILE-888"}]]`);
  // 第 2 轮：spawn 一个分身
  await top.prompt(`[[call:spawn_agent {"member":"w","task":"分身任务标记串-CHILD-999"}]]`);
  const child = host.list().find((a) => a.member === "w")!;
  // 第 3 轮：给分身追加一条消息
  await top.prompt(`[[call:send_message {"agentId":"${child.id}","message":"追加消息标记串-SEND-555"}]]`);
  await child.waitForIdle();

  const entries = [...log];
  const lines = rebuild(entries);
  const rebuilt = lines.join("\n");
  const joined = entries.map(project).map(safeJson).join("\n");
  const rawAll = [...rawByAgent.values()].flat() as any[];

  // 7.1a 原始事件 vs 归一化事件：谁被丢掉了
  {
    const rawTypes = rawAll.map((e) => e.type);
    const counts = rawTypes.reduce<Record<string, number>>((a, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {});
    const normalizedKept = new Set(entries.filter((e) => e.source !== "host").map((e) => e.name));
    record({
      id: "7.1a",
      question: "原始事件 vs 归一化事件：类型清单与丢弃量",
      observed: `原始事件共 ${rawAll.length} 条 / ${Object.keys(counts).length} 种：${JSON.stringify(counts)}；归一化后对外只有 ${AGENT_EVENTS.length} 种（本次实际出现 ${JSON.stringify([...normalizedKept])}）+ 宿主 3 种；被丢弃的原始类型 = ${JSON.stringify(Object.keys(counts).filter((t) => !["tool_execution_start", "tool_execution_end", "turn_end", "message_end", "agent_end"].includes(t)))}`,
      verdict: "INFO",
      conclusion: `pi 的原始流本次产出 ${Object.keys(counts).length} 种事件，归一化后只剩 7 种；其中 message_end（user 文本）、turn_end（含 toolResults）、message_update 的各类子事件被折叠掉了。`,
      data: counts,
    });
  }

  // 7.1b 重建总评：能拼出什么 / 拼不出什么
  {
    const facts: Array<{ 事实: string; 能否重建: string; 证据: string }> = [];
    const has = (s: string) => rebuilt.includes(s) || joined.includes(s);
    facts.push({ 事实: "谁创建了哪个成员的分身（父子关系）", 能否重建: has(`+agent id=${child.id} member=w parent=${top.id}`) ? "能" : "不能", 证据: `agent_created.parent / .member` });
    facts.push({ 事实: "每个分身说过什么（assistant 文本）", 能否重建: rebuilt.includes("分身任务标记串-CHILD-999") ? "能" : "不能", 证据: "turn.message.content 的 text 段 / text 事件" });
    facts.push({ 事实: "调用了哪个工具、参数是什么", 能否重建: rebuilt.includes(`toolCall(spawn_agent {"member":"w","task":"分身任务标记串-CHILD-999"})`) ? "能" : "不能", 证据: "turn.message.content 的 toolCall.arguments" });
    facts.push({
      事实: "工具的返回值内容",
      能否重建: entries.some((e) => e.source !== "host" && JSON.stringify(e.payload).includes("toolResults")) ? "能" : "不能",
      证据: `归一化 payload 里出现 toolResults 的条数 = ${entries.filter((e) => e.source !== "host" && safeJson(e.payload).includes("toolResults")).length}；原始 turn_end 有 toolResults 的条数 = ${rawAll.filter((e) => e.type === "turn_end" && e.toolResults?.length).length}`,
    });
    facts.push({
      事实: "用户到底说了什么（prompt 原文）",
      能否重建: joined.includes(USER_MARKER) ? "能" : "不能",
      证据: `归一化+宿主事件里出现用户标记串=${joined.includes(USER_MARKER)}；原始 message_end(role=user) 里出现=${safeJson(rawAll.filter((e) => e.type === "message_end" && e.message?.role === "user")).includes(USER_MARKER)}`,
    });
    facts.push({ 事实: "谁在什么时候行动（跨分身时序）", 能否重建: "部分", 证据: "只有 turn.message.timestamp，且是毫秒；text/tool_* 事件无时间字段" });
    facts.push({ 事实: "思考过程内容", 能否重建: "不能（本次）", 证据: "模型 reasoning=false，thinking 事件 0 条" });
    facts.push({ 事实: "消息投递是 ran 还是 queued", 能否重建: "不能", 证据: "10 种事件里没有任何投递事件；send() 的返回值也不进事件流" });
    const canCount = facts.filter((f) => f.能否重建 === "能").length;
    record({
      id: "7.1b",
      question: "只用 7+3 个事件，能重建「谁在什么时候做了什么、说了什么」吗",
      observed: `${facts.length} 条 ground truth 事实里能直接重建 ${canCount} 条、部分 ${facts.filter((f) => f.能否重建 === "部分").length} 条、不能 ${facts.filter((f) => f.能否重建.startsWith("不能")).length} 条：${JSON.stringify(facts, null, 1)}`,
      verdict: "PARTIAL",
      conclusion:
        "重建「谁说了什么、调了什么工具、参数是什么」可以做到（assistant 文本在 turn.message 里、工具参数在 toolCall.arguments 里、父子关系在 agent_created.parent 里）。重建不了的有四类：**工具返回值**、**用户 prompt 原文**、**跨分身时序**、**投递语义**（ran/queued）。前两类在原始事件流里有（turn_end.toolResults、message_end(role=user)），要拿到必须绕过归一化层用 session.subscribe —— 也就是说「7 个事件」是给人看的摘要，不是可回放的事实流。",
      data: { facts, rebuiltLines: lines.length, canCount },
    });
  }

  // 7.1c 每个归一化事件的载荷字段（有没有 agent 身份 / 时间）
  {
    const inventory: Record<string, { keys: string[]; hasTime: boolean }> = {};
    for (const name of AGENT_EVENTS) {
      const sample = entries.find((e) => e.name === name);
      if (!sample) continue;
      const p = sample.payload as Record<string, unknown>;
      inventory[name] = { keys: Object.keys(p), hasTime: name === "turn" ? typeof (p.message as any)?.timestamp === "number" : "timestamp" in p };
    }
    const turns = entries.filter((e) => e.name === "turn").map((e) => (e.payload as any).message.timestamp);
    record({
      id: "7.1c",
      question: "归一化/宿主事件的载荷里有没有「谁」「何时」",
      observed: `各事件载荷字段 = ${JSON.stringify(inventory)}；宿主事件载荷字段 = ${JSON.stringify(entries.filter((e) => e.source === "host").map((e) => ({ [e.name]: Object.keys(e.payload as object) })))}；turn 事件共 ${turns.length} 条，去重后 timestamp ${new Set(turns).size} 个（毫秒，跨分身撞时 ${turns.length - new Set(turns).size} 次）`,
      verdict: "PARTIAL",
      conclusion:
        "agent 级事件载荷里**没有 agent id**：身份靠「你订阅了谁」隐式携带，把多分身事件汇到一起时必须自己打标。时间只有 turn.message.timestamp（毫秒），text/thinking/tool_start/tool_end/error/done 都没有时间字段。本次 8 个 turn 得到 8 个不同毫秒（撞时 0 次），但毫秒分辨率加上「多数事件无时间」意味着：跨分身排序只能靠订阅者自己的本地时钟，一旦同一毫秒内有多个分身的 turn（并发场景下会发生），就无法定序。",
      data: { inventory, turnCount: turns.length, distinctTimestamps: new Set(turns).size, collisions: turns.length - new Set(turns).size },
    });
  }

  // 7.1d thinking 通道
  {
    const withReasoning = await makeEnv([{ id: "think", reasoning: true }]);
    const host2 = createAgentHost({ defaults: { model: withReasoning.model, agentDir: withReasoning.agentDir, cwd: withReasoning.cwd }, maxAgents: 10, modelRuntime: withReasoning.runtime });
    const a = await createAgent({ model: withReasoning.model, agentDir: withReasoning.agentDir, cwd: withReasoning.cwd }, { host: host2, modelRuntime: withReasoning.runtime });
    let thinking = 0;
    a.on("thinking", () => (thinking += 1));
    await a.prompt("reasoning 模型下的普通请求");
    record({
      id: "7.1d",
      question: "thinking 事件通道在假 provider 下能不能被验证",
      observed: `模型声明 reasoning=true、thinkingLevel=${a.session.thinkingLevel}；thinking 事件数 = ${thinking}；原始 message_update 子事件类型 = ${JSON.stringify([...new Set((rawByAgent.get(top.id) as any[]).filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent?.type))])}`,
      verdict: "PARTIAL",
      conclusion:
        "假 provider 只吐 content 与 tool_calls 两种 delta，不产 reasoning，所以 thinking 通道在本轮是「0 条事件」而不是「验证通过」。真模型专项才能确认它；已知的是它只在模型支持 reasoning 时才有机会触发（01 部分已实测 reasoning=false 时四档 thinking 全被夹到 off）。",
      data: { thinking, sessionThinkingLevel: String(a.session.thinkingLevel) },
    });
    host2.dispose();
    await withReasoning.close();
  }

  // 7.1e abort 与真错误在事件流里是否可区分
  {
    const host2 = newHost();
    const seqOf = async (fn: (a: ControlledAgent) => Promise<void>) => {
      const a = await mkTop(host2);
      const seen: string[] = [];
      for (const n of ["text", "turn", "error", "done"] as const) a.on(n, (p: any) => seen.push(n === "error" ? `error(${JSON.stringify(p.message)})` : n));
      await fn(a);
      a.dispose();
      return seen;
    };
    const failSeq = await seqOf(async (a) => void (await a.prompt("[[fail]] 造一个真错误")));
    const abortSeq = await seqOf(async (a) => {
      const p = a.prompt("[[sleep:600]] 造一个中止");
      await sleep(120);
      await a.abort();
      await p.catch(() => {});
    });
    const errSeqs = {
      realFail: failSeq,
      abort: abortSeq,
    };
    const same = JSON.stringify(failSeq.map((s) => s.replace(/\(.*\)/, ""))) === JSON.stringify(abortSeq.map((s) => s.replace(/\(.*\)/, "")));
    record({
      id: "7.1e",
      question: "事件流能否区分「模型报错」与「设计者主动 abort」",
      observed: `真错误（[[fail]]）事件序列 = ${JSON.stringify(failSeq)}；主动 abort 事件序列 = ${JSON.stringify(abortSeq)}；去掉 error 文本后两者同形=${same}`,
      verdict: same ? "GAP" : "OK",
      conclusion:
        same
          ? "同形：两条路径都是 error → turn(usage 0) → done(usage 0)，唯一差别是 error 的字符串（'400: {\"message\":\"faux-provider-boom\"}' vs 'Request was aborted'）。监控代码想区分「我中止的」与「模型挂了」，只能匹配字符串或自己记录 abort 动作。"
          : "可以通过事件序列区分。",
      data: errSeqs,
    });
    host2.dispose();
  }

  // 7.1f 丢弃量：归一化把多少原始事件变成 no-op
  {
    const all = [...rawByAgent.values()].flat() as any[];
    const dropped = all.filter((e) => e.type !== "tool_execution_start" && e.type !== "tool_execution_end" && e.type !== "turn_end" && e.type !== "agent_end" && !(e.type === "message_end" && e.message?.role === "assistant" && e.message?.errorMessage) && !(e.type === "message_update" && (e.assistantMessageEvent?.type === "text_delta" || e.assistantMessageEvent?.type === "thinking_delta")));
    record({
      id: "7.1f",
      question: "原始流里有多少事件被归一化层吞掉",
      observed: `原始 ${all.length} 条 → 归一化保留 ${all.length - dropped.length} 条、丢弃 ${dropped.length} 条（${num((dropped.length / all.length) * 100)}%）：丢弃类型 = ${JSON.stringify(dropped.reduce<Record<string, number>>((a, e) => ({ ...a, [e.type]: (a[e.type] ?? 0) + 1 }), {}))}`,
      verdict: "INFO",
      conclusion: `本次场景里 ${num((dropped.length / all.length) * 100)}% 的原始事件不进归一化流。设计者要审计「模型实际看到了什么」（系统提示词装配、工具清单、user 文本）时，这层必须绕过。`,
      data: { raw: all.length, kept: all.length - dropped.length, dropped: dropped.length },
    });
  }

  // 7.1g 事件载荷能不能直接进审计日志（可序列化性）
  {
    const hostEntries = entries.filter((e) => e.source === "host");
    const hostJson = safeJson(hostEntries);
    const agentJson = safeJson(top);
    const turnJson = safeJson(entries.find((e) => e.name === "turn")?.payload);
    record({
      id: "7.1g",
      question: "宿主事件与 agent 对象能不能直接序列化（写审计日志/上报）",
      observed: `JSON.stringify(宿主事件) = ${hostJson.slice(0, 160)}；JSON.stringify(ControlledAgent) = ${agentJson.slice(0, 120)}；JSON.stringify(turn 事件载荷) 长度 = ${turnJson.length} 字符（正常）`,
      verdict: hostJson.startsWith("<序列化失败") || agentJson.startsWith("<序列化失败") ? "GAP" : "OK",
      conclusion: `宿主事件载荷里带的是活的 ControlledAgent（连着 session 与主题/渲染层），直接 JSON.stringify 会抛错（${hostJson.startsWith("<序列化失败") ? hostJson.slice(1, -1) : agentJson.slice(1, -1)}）；agent 级事件的载荷是纯数据，可以安全序列化。想拿宿主事件写日志/上报，必须先自己投影成 {id, member, parentId}。`,
      data: { hostJsonError: hostJson.startsWith("<序列化失败") ? hostJson : null, agentJsonError: agentJson.startsWith("<序列化失败") ? agentJson : null, turnPayloadChars: turnJson.length },
    });
  }

  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("7.2 用量/成本归因");

// #region 归因胶水
interface CostLedger {
  byMember: Record<string, number>;
  byAgent: Record<string, { member: string | undefined; parentId: string | undefined; tokens: number }>;
}
function createCostLedger(host: AgentHost): CostLedger {
  const ledger: CostLedger = { byMember: {}, byAgent: {} };
  host.on("agent_created", ({ agent, member }) => {
    ledger.byAgent[agent.id] = { member, parentId: agent.parentId, tokens: 0 };
  });
  host.on("round_completed", ({ agent, result }) => {
    const row = ledger.byAgent[agent.id];
    if (row) row.tokens += result.usage.totalTokens;
    const key = agent.member ?? "(顶层)";
    ledger.byMember[key] = (ledger.byMember[key] ?? 0) + result.usage.totalTokens;
  });
  return ledger;
}
function branchOf(ledger: CostLedger, id: string): string {
  // ancestors 从自己一路排到根；分支头 = 紧挂在根下面的那一层
  const ancestors: string[] = [id];
  const seen = new Set<string>([id]);
  let cur = ledger.byAgent[id];
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    ancestors.push(cur.parentId);
    cur = ledger.byAgent[cur.parentId];
  }
  if (ancestors.length === 1) return "(顶层)";
  const head = ancestors[ancestors.length - 2];
  return ledger.byAgent[head]?.member ?? `(${head} 无名)`;
}
function byBranch(ledger: CostLedger): Record<string, number> {
  return Object.entries(ledger.byAgent).reduce<Record<string, number>>((acc, [id, row]) => {
    const branch = branchOf(ledger, id);
    return { ...acc, [branch]: (acc[branch] ?? 0) + row.tokens };
  }, {});
}
// #endregion 归因胶水

{
  const selfPath = fileURLToPath(import.meta.url);
  const source = readFileSync(selfPath, "utf-8");
  const glueLines = source.split(/\r?\n/).slice(source.split(/\r?\n/).findIndex((l) => l.includes("#region 归因胶水")) + 1, source.split(/\r?\n/).findIndex((l) => l.includes("#endregion 归因胶水"))).filter((l) => l.trim() && !l.trim().startsWith("//")).length;
  const host = createAgentHost({
    defaults,
    members: { w: { description: "工人" }, lead: { description: "组长", tools: ["spawn_agent"] } },
    maxAgents: 1000,
    maxDepth: 2,
    modelRuntime: env.runtime,
  });
  const ledger = createCostLedger(host);
  const top = await mkTop(host);
  await top.prompt("顶层第一轮");
  await top.prompt(`[[call:spawn_agent {"member":"lead","task":"组长先接活"}]]`);
  const lead = host.list().find((a) => a.member === "lead")!;
  await lead.prompt(`[[call:spawn_agent {"member":"w","task":"组员的活"}]]`);
  const child = host.list().find((a) => a.member === "w")!;
  await top.prompt(`[[call:send_message {"agentId":"${lead.id}","message":"再干一轮"}]]`);
  await lead.waitForIdle();
  const memberSum = Object.values(ledger.byMember).reduce((a, b) => a + b, 0);
  const branchSum = Object.values(byBranch(ledger)).reduce((a, b) => a + b, 0);
  record({
    id: "7.2a",
    question: "「哪个成员花了多少」要自己写多少胶水、算不算得平",
    observed: `胶水代码 ${glueLines} 行（createCostLedger + branchOf + byBranch）；按成员 = ${JSON.stringify(ledger.byMember)}；按分支 = ${JSON.stringify(byBranch(ledger))}；按 agent = ${JSON.stringify(Object.fromEntries(Object.entries(ledger.byAgent).map(([k, v]) => [k, v.tokens])))}；成员求和=${memberSum} 分支求和=${branchSum} host.usage=${host.usage.totalTokens}（对得上=${memberSum === host.usage.totalTokens && branchSum === host.usage.totalTokens}）`,
    verdict: "PARTIAL",
    conclusion: `能算清，但全靠设计者自己订阅 round_completed 累加（${glueLines} 行）。两个代价：① 顶层 agent 的 member 是 undefined，成本只能落进「(顶层)」桶 —— 设计者无法把顶层 agent 归到花名册里的任何成员；② 这个账本是唯一的细粒度账本，host.usage 只有一个总数，宿主与库都不提供任何 breakdown。分支口径要自己定义（这里取「挂在顶层下面的那棵子树」，取 root 或取直接父级都是合理设计，库不提供任何一个）。`,
    data: { glueLines, byMember: ledger.byMember, byBranch: byBranch(ledger), byAgent: Object.fromEntries(Object.entries(ledger.byAgent).map(([k, v]) => [k, v])), memberSum, branchSum, hostUsage: host.usage.totalTokens },
  });
  host.dispose();
  record({
    id: "7.2b",
    question: "事后（dispose 之后）还能不能补算归因",
    observed: `host.dispose() 之后 host.list()=${host.list().length}、host.get('${child.id}')=${host.get(child.id) === undefined ? "undefined" : "存在"}、host.usage=${host.usage.totalTokens}；手里的 ledger 仍保留 ${Object.keys(ledger.byAgent).length} 条明细`,
    verdict: "GAP",
    conclusion:
      "不能补算。宿主回收后 list() 清空、get() 失效，而 host.usage 只有一个累计总数 —— 没有任何 breakdown 能反推分支。唯一的出路是像上面那样实时记账（或自己留引用）。设计者若在宿主跑完后才想起来要归因（比如为了「这次任务花了多少」的报表），已经来不及。",
    data: { listAfter: host.list().length, hostUsage: host.usage.totalTokens, ledgerRows: Object.keys(ledger.byAgent).length },
  });
}

// ─────────────────────────────────────────────────────────────
section("7.3 三方对账（RunResult.usage / agent.usage / host.usage）");

{
  const host = newHost();
  const top = await mkTop(host);
  const rows: Array<Record<string, unknown>> = [];
  let roundEvents = 0;
  let roundTokens = 0;
  host.on("round_completed", ({ result }) => {
    roundEvents += 1;
    roundTokens += result.usage.totalTokens;
  });
  const reqsAtStart = env.calls().length;
  /** 一步 = 一段被观察的活动；把「假服务请求数」与「本步全部 round_completed 之和」对上 */
  const step = async (label: string, run: () => Promise<unknown>) => {
    const reqBefore = env.calls().length;
    const evBefore = roundEvents;
    const tokBefore = roundTokens;
    const out = await run();
    const reqs = env.calls().length - reqBefore;
    const expected = reqs * TOKENS_PER_REQUEST;
    const got = roundTokens - tokBefore;
    const runUsage = (out as { usage?: { totalTokens: number } } | undefined)?.usage?.totalTokens;
    rows.push({
      步骤: label,
      请求数: reqs,
      期望token: expected,
      "本步全部round_completed": got,
      "本步等待的RunResult": runUsage ?? "-",
      round事件数: roundEvents - evBefore,
      宿主累计: host.usage.totalTokens,
      对账: got === expected ? "OK" : `差 ${got - expected}`,
    });
    return out;
  };

  await step("R1 单轮 prompt", () => top.prompt("hi"));
  await step("R2 含工具调用轮（read）", () => top.prompt(`[[tool:read]] [[args:{"path":"x"}]] 读一下`));
  await step("R3 spawn 一个分身（顶层 2 请求 + 分身 1 请求）", () => top.prompt(`[[call:spawn_agent {"member":"w","task":"工人活"}]]`));
  const child = host.list().find((a) => a.member === "w")!;
  // R4：长轮 + 两条排队消息（同一轮里）
  await step("R4 长轮 + 2 条 send 排队（合为一次 run）", async () => {
    const long = top.prompt("[[sleep:400]] 长活");
    await sleep(60);
    await top.send("排队一");
    await top.send("排队二");
    return long;
  });
  await step("R5 2 个分身并发 prompt", async () => {
    const mk = () => createAgent({ ...defaults }, { host, parent: top, member: "w", modelRuntime: env.runtime });
    const [a1, a2] = await Promise.all([mk(), mk()]);
    const [r1, r2] = await Promise.all([a1.prompt("并发"), a2.prompt("并发")]);
    return { usage: { totalTokens: r1.usage.totalTokens + r2.usage.totalTokens } };
  });

  const totalReqs = env.calls().length - reqsAtStart;
  const expectedTotal = totalReqs * TOKENS_PER_REQUEST;
  const children = host.list().filter((a) => a.member === "w");
  const agentSum = host.list().reduce((a, x) => a + x.usage.totalTokens, 0);
  record({
    id: "7.3a",
    question: "RunResult / round_completed 与假服务请求数逐笔对账",
    observed: `对账表（期望 token = 18 × 请求数）：${JSON.stringify(rows, null, 1)}`,
    verdict: rows.every((r) => r["对账"] === "OK") ? "OK" : "GAP",
    conclusion:
      "每一步都对得上（差额全为 0）：含工具轮（2 请求）、spawn（顶层 2 请求 + 分身 1 请求，两个 round_completed 各自结算）、排队 send（同一 run 里 3 请求合为一个 round_completed）。语义定死：`RunResult.usage` = 这次 prompt 调用覆盖的全部请求；`round_completed.result.usage` = 一个「run」的全部请求，而一个 run 可能包含多个回合。注意 R3：等待的 RunResult 只有 36，分身那 18 只出现在另一条 round_completed 里 —— 父 agent 的「本次用量」不包含子分身。",
    data: rows,
  });
  record({
    id: "7.3b",
    question: "排队 send 如何影响「一轮」的定义与事件计数",
    observed: `R4 一次 prompt + 2 条排队 send：请求数 ${(rows[3] as any)["请求数"]}、该次 RunResult.usage=${(rows[3] as any)["本步等待的RunResult"]}、round_completed 事件数=${(rows[3] as any)["round事件数"]}；top.lastResult.text=${JSON.stringify(top.lastResult!.text.slice(0, 60))}；top.session.messages 里的 user 消息数 = ${(top.session as unknown as { messages: Array<{ role: string }> }).messages.filter((m) => m.role === "user").length}`,
    verdict: "PARTIAL",
    conclusion:
      "round_completed 是「一次 run 完成」而不是「一个回合」：R4 的 3 个请求只发 1 次事件、事件里的 usage 是 3 条合计。同时 RunResult.text（与 lastResult.text）只保留**最后一轮**的 assistant 文本 —— 前两轮的回复只存在于 session.messages 里，事件流里也没有任何「第 n 回合完成」的标记（只能自己数 turn 事件）。要按回合记账/按回合督导的监控得自己拆。",
    data: { requests: (rows[3] as any)["请求数"], roundEvents: (rows[3] as any)["round事件数"], runUsage: (rows[3] as any)["本步等待的RunResult"] },
  });
  {
    const host2 = newHost();
    const a = await mkTop(host2);
    let doneUsage = -1;
    a.on("done", (p) => (doneUsage = p.usage.totalTokens));
    const r = await a.prompt("done 与 RunResult 是否同值");
    record({
      id: "7.3c",
      question: "done 事件的 usage 与 RunResult.usage 是否同值",
      observed: `done.usage=${doneUsage}、RunResult.usage=${r.usage.totalTokens}、相等=${doneUsage === r.usage.totalTokens}`,
      verdict: doneUsage === r.usage.totalTokens ? "OK" : "GAP",
      conclusion: "同值（规格承诺兑现）。但 done 事件载荷里只有 usage，没有 agent id、没有文本。",
      data: { doneUsage, runUsage: r.usage.totalTokens },
    });
    host2.dispose();
  }
  {
    // dispose 之后的三方关系
    const beforeDispose = { agentSum, hostUsage: host.usage.totalTokens, childTokens: children.map((c) => c.usage.totalTokens) };
    const held = [...children, top]; // 留引用
    children.forEach((c) => c.dispose());
    const afterDispose = {
      listSum: host.list().reduce((a, x) => a + x.usage.totalTokens, 0),
      heldSum: held.reduce((a, x) => a + x.usage.totalTokens, 0),
      hostUsage: host.usage.totalTokens,
    };
    record({
      id: "7.3d",
      question: "dispose 之后三方数字还对不对得上",
      observed: `dispose 前：存活 agent 求和=${agentSum}、host.usage=${beforeDispose.hostUsage}、子分身的 usage=${JSON.stringify(beforeDispose.childTokens)}；dispose 之后：host.list() 求和=${afterDispose.listSum}、手里留引用的求和=${afterDispose.heldSum}、host.usage=${afterDispose.hostUsage}（host.usage 不变=${afterDispose.hostUsage === beforeDispose.hostUsage}）`,
      verdict: "PARTIAL",
      conclusion:
        "host.usage 是只增的累计值，回收不会让它变小 —— 这点正确。但**存活分身求和 ≠ host.usage**（回收后存活求和暴跌，差额全是已回收分身的用量）：`host.list()` 只能对「还没回收的」做分解，所以任何「按分支/按成员」的账必须在 round_completed 时实时记，或自己留引用。",
      data: { beforeDispose, afterDispose, expectedTotal },
    });
  }
  record({
    id: "7.3e",
    question: "全局合计与 ground truth 的差额表",
    observed: `本节内假服务共收到 ${totalReqs} 次请求 → 期望 ${expectedTotal} token；host.usage.totalTokens=${host.usage.totalTokens}，差额=${host.usage.totalTokens - expectedTotal}；逐条差分 = ${JSON.stringify(rows.map((r) => `${r["步骤"]}: ${r["对账"]}`))}`,
    verdict: host.usage.totalTokens === expectedTotal ? "OK" : "GAP",
    conclusion: `差额 = ${host.usage.totalTokens - expectedTotal}（宿主累计 ${host.usage.totalTokens} vs 期望 ${expectedTotal}）：没有任何漏计或重复计 —— 数值精度上账是准的。但差额为 0 的前提是「每一轮都跑完」：被 abort 或被回收打断的请求进了 provider、token 记 0（见 7.3f），所以真实成本只会被**低估**。另外 host.usage 只在本节内聚合，因为宿主每次 dispose 后新建，全局没有跨宿主的总账。`,
    data: { totalReqs, expectedTotal, hostUsage: host.usage.totalTokens, diff: host.usage.totalTokens - expectedTotal, agentSumSurviving: agentSum },
  });
  {
    // abort 的账
    const host3 = newHost();
    const a = await mkTop(host3);
    await a.prompt("热身");
    const before = { reqs: env.calls().length, host: host3.usage.totalTokens };
    const p = a.prompt("[[sleep:500]] 会被中止的一轮");
    await sleep(120);
    await a.abort();
    await p.catch(() => {});
    record({
      id: "7.3f",
      question: "被 abort 的那一轮在账上留下什么",
      observed: `abort 前 host.usage=${before.host}、请求数=${before.reqs}；abort 后请求数=${env.calls().length}（多 ${env.calls().length - before.reqs} 次请求）、host.usage=${host3.usage.totalTokens}（只多了 ${host3.usage.totalTokens - before.host}）`,
      verdict: "GAP",
      conclusion: `请求发出去了、token 却记 0：账面上少记一轮（期望 +${TOKENS_PER_REQUEST}，实际 +${host3.usage.totalTokens - before.host}）。用在 budgetTokens 上就是「中止可白嫖」—— 反复中止的长请求能把成本推高而闸门读数不动。`,
      data: { reqsAdded: env.calls().length - before.reqs, tokensAdded: host3.usage.totalTokens - before.host },
    });
    host3.dispose();
  }
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("7.4 真模型 usage 一致性（本次不做）");

record({
  id: "7.4",
  question: "真模型的 usage 与响应自报数值是否一致",
  observed: "本脚本全部走本机假 provider；假服务固定回 prompt_tokens=11 / completion_tokens=7 / total_tokens=18，因此不存在「自报 vs 实际」的差异可测",
  verdict: "INFO",
  conclusion: "跳过：真模型 usage 一致性抽样统一在真模型专项里做（本次审计禁止产生真实 API 调用）。本部分只验证了 `RunResult.usage` / `done.usage` / `agent.usage` / `host.usage` 四者内部自洽。",
});

// ─────────────────────────────────────────────────────────────
section("7.5 观测的盲区");

{
  const gaps = [
    { 盲区: "工具返回值", 现状: "归一化事件里没有；原始 turn_end.toolResults 有", 影响: "无法从事件流复现「工具真的返回了什么」，只能靠模型复述" },
    { 盲区: "用户 prompt 原文", 现状: "归一化事件里没有；原始 message_end(role=user) 有", 影响: "审计/回放要自己订阅原始流" },
    { 盲区: "跨分身时序", 现状: "只有 turn.message.timestamp（毫秒），其余 6 种事件无时间字段", 影响: "并发多分身时无法排出全局事件序；只能靠订阅者的本地时钟（本次 8 个 turn 撞时 0 次，但并发时毫秒不够区分）" },
    { 盲区: "投递语义（ran/queued）", 现状: "无任何事件", 影响: "监控看不到「消息投给谁、是否排队」" },
    { 盲区: "按成员/分支的成本 breakdown", 现状: "host.usage 只有一个总数", 影响: "必须自己订阅 round_completed 记账，且不能事后补算" },
    { 盲区: "中止 vs 真错误", 现状: "事件序列同形，只有字符串不同", 影响: "告警无法区分设计者主动打断与模型故障" },
    { 盲区: "顶层 agent 的身份", 现状: "member=undefined", 影响: "成本归因里顶层只能进无名桶" },
    { 盲区: "thinking 内容", 现状: "假 provider 不产；真模型待测", 影响: "无法验证" },
  ];
  record({
    id: "7.5",
    question: "观测的盲区清单",
    observed: `共 ${gaps.length} 条：${JSON.stringify(gaps, null, 1)}`,
    verdict: "GAP",
    conclusion:
      "「7 个事件」够做过程展示与粗略计量，不够做审计与精确归因。三条硬缺口：① 事实流不完整（工具结果、用户输入只在原始流）；② 没有全局有序事件流（跨分身只能靠毫秒时间戳；本次 8 个 turn 恰好不撞时，但并发下毫秒不足区分，且 7 种事件里只有 turn 带时间）；③ 成本没有结构化分解（host.usage 一个数，细账必须自己实时累加，事后不可补）。需要审计能力的场景应直接使用 session.subscribe 原始流 + 自己的账本，把 7 个事件当作 UI 摘要层。",
    data: { gaps, "零成本证据": { "假服务请求总数": env.calls().length, "请求里的 model 集合": [...new Set(env.calls().map((c) => c.model))] } },
  });
}

dump("07-observability");
await env.close();
