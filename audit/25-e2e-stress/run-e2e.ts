// 同一个真任务、同一套 11 个异构成员、同一拓扑，用两种写法各跑一遍。
//   A 写法 = 最自然的写法（设计者不看任何警告）：轮次进行中直接 send 给忙碌的分身；
//            投递审查意见后用 send + 紧跟 prompt；结果一律读 lastResult。
//   B 写法 = 按基线 K 自己推的「安全投递纪律」（见 safe.ts）：串行化 + 忙闲判别 + 游标读回。
// 跑法：node audit/25-e2e-stress/run-e2e.ts a
//       node audit/25-e2e-stress/run-e2e.ts b
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlledAgent } from "../../src/index.ts";
import {
  buildTeam, CLARIFY_TAG, findMember, inspectReport, short, sleep, toolCalls, toolResultTexts, type Trace,
} from "./cluster.ts";
import { SafeMember, type AskOutcome } from "./safe.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODE = (process.argv[2] ?? "a").toLowerCase();
const RUN_ID = `${MODE}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
const OUT_DIR = join(HERE, "out", RUN_ID);
process.env.AITEAM_STRESS_OUT = OUT_DIR;
mkdirSync(OUT_DIR, { recursive: true });

const log: string[] = [];
const say = (s: string) => { console.log(s); log.push(s); };

interface Delivery {
  name: string;
  /** 第 1 轮进行中，向两个正忙的组长追加一条澄清消息 */
  clarifyWhileBusy(leads: ControlledAgent[], msg: string): Promise<{ raw: any; throws: string | null; texts: string[] }>;
  /** 把审查意见投给（此刻空闲的）组长，拿回修订小结 */
  revise(member: ControlledAgent, msg: string): Promise<{ raw: any; throws: string | null; texts: string[]; via: string }>;
}

const naive: Delivery = {
  name: "A-自然写法",
  async clarifyWhileBusy(leads, msg) {
    const raws: any[] = [];
    let throws: string | null = null;
    try {
      for (const l of leads) raws.push(await l.send(msg));
    } catch (e) { throws = (e as Error).message; }
    return { raw: raws, throws, texts: leads.map((l) => String(l.lastResult?.text ?? "")) };
  },
  async revise(member, msg) {
    // 最自然的「投递一条要求然后让组长继续」：send 之后紧跟 prompt
    let throws: string | null = null;
    let via = "send";
    const raw = await member.send(msg);
    try {
      await member.prompt(`请按上面的审查意见给出修订后的小结。`);
      via = "send+prompt";
    } catch (e) {
      throws = (e as Error).message;
      via = "send(仅此) + prompt 抛错后的兜底 waitForIdle";
      await member.waitForIdle();
    }
    return { raw, throws, texts: [String(member.lastResult?.text ?? "")], via };
  },
};

function makeSafeDelivery(agents: Map<string, ControlledAgent>): Delivery {
  const safe = new Map<string, SafeMember>();
  const sm = (a: ControlledAgent) => {
    let s = safe.get(a.id);
    if (!s) { s = new SafeMember(a); safe.set(a.id, s); }
    return s;
  };
  const pack = (o: AskOutcome) => ({ raw: { delivered: "safe" }, throws: o.throwMessage, texts: o.texts, outcome: o });
  return {
    name: "B-安全投递纪律",
    async clarifyWhileBusy(leads, msg) {
      // 纪律：不在别人（spawn_agent）起的轮次里插队 —— 忙则等它静下来再投
      const outs = await Promise.all(leads.map((l) => sm(l).ask(msg)));
      return { raw: outs.map((o) => ({ waitedForIdle: o.waitedForIdle })), throws: null, texts: outs.flatMap((o) => o.texts) };
    },
    async revise(member, msg) {
      const o = await sm(member).ask(`${msg}\n\n请按上面的审查意见给出修订后的小结。`);
      return { raw: { delivered: "safe", ms: o.ms }, throws: o.throwMessage, texts: o.texts, via: "SafeMember.ask(cursor)" };
    },
  };
}

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(150);
  }
  say(`  !! 等待超时：${label}`);
  return false;
}

// ───────────────── 主流程 ─────────────────
const { host, top, tr } = await buildTeam({ outDir: OUT_DIR, maxAgents: 20, budgetTokens: 5_000_000 });
const safeCache = new Map<string, SafeMember>();
const safeOf = (a: ControlledAgent) => {
  let s = safeCache.get(a.id);
  if (!s) { s = new SafeMember(a); safeCache.set(a.id, s); }
  return s;
};
const deliveryB: Delivery = {
  name: "B-安全投递纪律",
  async clarifyWhileBusy(leads, msg) {
    const outs = await Promise.all(leads.map((l) => safeOf(l).ask(msg)));
    return { raw: outs.map((o) => ({ waitedForIdle: o.waitedForIdle })), throws: null, texts: outs.flatMap((o) => o.texts) };
  },
  async revise(member, msg) {
    const o = await safeOf(member).ask(`${msg}\n\n请按上面的审查意见给出修订后的小结。`);
    return { raw: { delivered: "safe", ms: o.ms }, throws: o.throwMessage, texts: o.texts, via: "SafeMember.ask(cursor)" };
  },
};
const D: Delivery = MODE === "b" ? deliveryB : naive;
void makeSafeDelivery;

const record: any = { runId: RUN_ID, mode: MODE, delivery: D.name, outDir: OUT_DIR, phases: [], actions: [], clarifySends: null, revisions: null };
const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = Date.now();
  say(`\n── ${name} ──`);
  const out = await fn();
  const ms = Date.now() - t0;
  record.phases.push({ name, ms, hostUsage: host.usage.totalTokens, cost: Number(host.usage.cost.total.toFixed(6)) });
  say(`  [${name}] 墙钟 ${ms}ms ｜ 宿主累计 ${host.usage.totalTokens} tok ｜ $${host.usage.cost.total.toFixed(6)}`);
  return out;
};

say(`run=${RUN_ID}  写法=${D.name}  成员=${Object.keys((await import("./cluster.ts")).memberSpecs()).length} 个  maxAgents=20 maxDepth=3`);

// ── R1：顶层一条消息里并行派两个组长 ──
const r1 = await phase("R1 顶层并行派两个组长（两组长各自再往下派两层）", async () => {
  const p = top.prompt(
    "现在开始第 1 轮：只用一条消息同时发起两个 spawn_agent 调用（member 分别是 lead_cap 与 lead_limit），" +
    "task 都写「按你的角色说明完成你负责那一面的调研，然后交回小结」。等两个都返回后，把两份小结原样贴出来。",
  );
  // 设计者在第 1 轮进行中追加澄清（真实场景：想到一个补充要求）
  const clarP = (async () => {
    const ok = await waitFor(() => {
      const a = findMember(host, "lead_cap"), b = findMember(host, "lead_limit");
      return !!a && !!b && (a.status === "running" || a.isStreaming) && (b.status === "running" || b.isStreaming);
    }, 30_000, "两个组长进入忙碌态");
    if (!ok) return null;
    const leads = [findMember(host, "lead_cap")!, findMember(host, "lead_limit")!];
    const t = Date.now();
    const res = await D.clarifyWhileBusy(
      leads,
      `${CLARIFY_TAG} 补充要求：请在结论里额外提一句 src/agent/events.ts 的作用。`,
    );
    return { atBusy: true, ms: Date.now() - t, ...res };
  })();
  const res = await p;
  const clar = await clarP;
  record.clarifySends = clar
    ? { ms: clar.ms, throws: clar.throws, raw: clar.raw, textHeads: clar.texts.map((t) => short(t, 80)) }
    : { skipped: true };
  return { promptText: res.text, usage: res.usage.totalTokens, cost: res.usage.cost.total };
});
record.actions.push({ round: "R1", hostTextHead: short(r1.promptText, 400) });

// 谁在派活：从 host 的 session 里把 spawn_agent 的工具结果抠出来（ground truth）
const spawnResults = toolResultTexts(top.session).filter((t) => t.includes("已让成员"));
record.r1SpawnToolResults = spawnResults.map((t) => ({
  head: short(t, 60),
  hasCapTag: t.includes("【CAP-组小结】"),
  hasLimitTag: t.includes("【LIMIT-组小结】"),
  hasClarifyTag: t.includes(CLARIFY_TAG),
  body: t.slice(0, 700),
}));
say(`  spawn_agent 工具结果 ${spawnResults.length} 条：` +
  spawnResults.map((t) => `[CAP=${t.includes("【CAP-组小结】")} LIMIT=${t.includes("【LIMIT-组小结】")} 澄清串台=${t.includes(CLARIFY_TAG)}]`).join(" "));

// ── R2：审查员挑错 ──
const r2 = await phase("R2 顶层派 reviewer 挑错", async () => {
  const res = await top.prompt(
    "第 2 轮：用 spawn_agent 把上面两份小结交给 reviewer 审查。task 要写明「以下是两份组内小结，请按你的角色说明挑错」，并把两份小结原文附在 task 里。" +
    "reviewer 返回后，把它的意见原样贴出来。",
  );
  return { text: res.text, usage: res.usage.totalTokens, cost: res.usage.cost.total };
});
const reviewTexts = toolResultTexts(top.session).filter((t) => t.includes("已让成员「reviewer」"));
record.r2 = { hostTextHead: short(r2.text, 400), reviewerBody: short(reviewTexts.at(-1), 900), spawnCount: reviewTexts.length };
say(`  reviewer 意见：${short(reviewTexts.at(-1), 260)}`);

// host 上下文里现在有什么（交付物的上限由它决定）
const leadCap = findMember(host, "lead_cap")!;
const leadLimit = findMember(host, "lead_limit")!;
const subCap = findMember(host, "sub_cap")!;
const subLimit = findMember(host, "sub_limit")!;
record.topology = host.list().map((a) => ({ id: a.id, member: a.member, parent: a.parentId, status: a.status, tokens: a.usage.totalTokens }));

// ── R3：把审查意见发回两个组长，收修订 ──
const r3 = await phase("R3 顶层把审查意见回灌给两个组长，收修订小结", async () => {
  const critique = short(reviewTexts.at(-1), 700);
  const askCap = `【审查意见】${critique}\n\n你是能力组组长，请据此修订你上一轮的组内小结，修订后仍以【CAP-组小结】开头。`;
  const askLimit = `【审查意见】${critique}\n\n你是极限组组长，请据此修订你上一轮的组内小结，修订后仍以【LIMIT-组小结】开头。`;
  const [c, l] = await Promise.all([D.revise(leadCap, askCap), D.revise(leadLimit, askLimit)]);
  return { cap: c, limit: l };
});
record.revisions = {
  cap: { throws: r3.cap.throws, via: r3.cap.via, texts: r3.cap.texts.map((t) => short(t, 300)), raw: r3.cap.raw },
  limit: { throws: r3.limit.throws, via: r3.limit.via, texts: r3.limit.texts.map((t) => short(t, 300)), raw: r3.limit.raw },
};
say(`  CAP 修订（via=${r3.cap.via}）：${short(r3.cap.texts[0], 200)}`);
say(`  LIMIT 修订（via=${r3.limit.via}）：${short(r3.limit.texts[0], 200)}`);
if (r3.cap.throws) say(`  !! CAP 投递抛错：${r3.cap.throws}`);
if (r3.limit.throws) say(`  !! LIMIT 投递抛错：${r3.limit.throws}`);

// ── R4：让写手落盘 ──
const capRevision = r3.cap.texts.join("\n") || "(组长没有给出修订)";
const limitRevision = r3.limit.texts.join("\n") || "(组长没有给出修订)";
const r4 = await phase("R4 顶层派写手把全部内容落盘成 report.md", async () => {
  const res = await top.prompt(
    "第 3 轮：修订小结到了。\n\n=== 能力组修订小结 ===\n" + short(capRevision, 1500) +
    "\n\n=== 极限组修订小结 ===\n" + short(limitRevision, 1500) +
    "\n\n=== 审查员意见 ===\n" + short(reviewTexts.at(-1), 700) +
    "\n\n现在用 spawn_agent 让 writer 把上述全部内容整理成 report.md 落盘。report.md 的绝对输出路径是 " + join(OUT_DIR, "report.md") +
    "，task 里要写明这个绝对路径，也要包含上面这些原文。writer 返回后把它的确认原样贴出来。",
  );
  return { text: res.text, usage: res.usage.totalTokens, cost: res.usage.cost.total };
});
record.r4 = { hostTextHead: short(r4.text, 400), writerBody: short(toolResultTexts(top.session).filter((t) => t.includes("writer")).at(-1), 600) };
const writerAgent = findMember(host, "writer");
record.writerCwd = writerAgent ? writerAgent.session.sessionManager.getCwd() : null;
record.writerToolCalls = writerAgent ? toolCalls(writerAgent.session).map((c) => ({ name: c.name, inputPath: String((c.input as any)?.path ?? (c.input as any)?.file_path ?? "") })) : [];

const report = inspectReport(OUT_DIR);
record.report = { exists: report.exists, path: report.path, bytes: report.bytes, headings: report.headings, hasCapTag: report.hasCapTag, hasLimitTag: report.hasLimitTag, hasClarifyTag: report.hasClarifyTag, hasMetrics: report.hasMetrics };
say(`\n落盘验收：exists=${report.exists} bytes=${report.bytes} headings=${JSON.stringify(report.headings)}`);
say(`  CAP标签=${report.hasCapTag} LIMIT标签=${report.hasLimitTag} 澄清串台标记=${report.hasClarifyTag} 实测输出=${report.hasMetrics}`);

// ── 收尾账目 ──
record.rounds = host.list().map((a) => ({ id: a.id, member: a.member, parent: a.parentId, status: a.status, tokens: a.usage.totalTokens, cost: Number(a.usage.cost.total.toFixed(6)) }));
record.hostUsage = host.usage;
record.hostCost = host.usage.cost;
record.trace = tr;
record.wallMs = Date.now() - tr.startedAt;
record.peakConcurrent = computePeak(tr);
record.safeStats = [...safeCache.entries()].map(([id, s]) => ({ id, serializeWaits: s.serializeWaits }));

function computePeak(t: Trace): number {
  const deltas = t.rounds.map((r) => ({ t: r.roundStart, d: 1 })).concat(t.rounds.map((r) => ({ t: r.t, d: -1 })));
  deltas.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, peak = 0;
  for (const x of deltas) { cur += x.d; peak = Math.max(peak, cur); }
  return peak;
}

say(`\n═══ ${D.name} 总账 ═══`);
say(`  总墙钟 ${record.wallMs}ms ｜ 总 token ${host.usage.totalTokens} ｜ 总花费 $${host.usage.cost.total.toFixed(6)}`);
say(`  同刻在跑最多的轮数（按轮次区间重叠估算）= ${record.peakConcurrent}`);
say(`  每轮明细（轮起点 / 轮终点 / 轮长）：`);
for (const r of tr.rounds) say(`    t=${String(r.roundStart).padStart(6)}→${String(r.t).padStart(6)}ms  长=${r.ms}ms  ${r.member}(${r.agent})  ${r.tokens}tok  $${r.cost}  ${r.error ? "ERR:" + short(r.error, 40) : ""}  「${short(r.textHead, 50)}」`);

writeFileSync(join(HERE, `log-${RUN_ID}.txt`), log.join("\n"), "utf-8");
writeFileSync(join(HERE, `data-${RUN_ID}.json`), JSON.stringify(record, null, 2), "utf-8");

host.dispose();
process.exit(0);
