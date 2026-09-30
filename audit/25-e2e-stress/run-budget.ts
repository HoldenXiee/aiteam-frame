// 紧预算：把 budgetTokens 设成完整 A 跑（217,777 tok）的约 60% = 130,000，跑到耗尽。
// 回答两件事：已经跑完的部分能不能交付？设计者要写多少代码才能优雅收场？
// 跑法：node audit/25-e2e-stress/run-budget.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "../../src/index.ts";
import { buildTeam, CLARIFY_TAG, findMember, inspectReport, memberSpecs, short, toolResultTexts, sleep } from "./cluster.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUDGET = Number(process.env.BUDGET ?? 130_000);
const RUN_ID = `budget-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
const OUT_DIR = join(HERE, "out", RUN_ID);
process.env.AITEAM_STRESS_OUT = OUT_DIR;
mkdirSync(OUT_DIR, { recursive: true });

const log: string[] = [];
const say = (s: string) => { console.log(s); log.push(s); };
const rec: any = { runId: RUN_ID, budget: BUDGET, budgetPctOfAFullRun: Number(((BUDGET / 217777) * 100).toFixed(1)), phases: [], guards: {} };

const { host, top, tr } = await buildTeam({ outDir: OUT_DIR, maxAgents: 20, budgetTokens: BUDGET });
say(`budgetTokens=${BUDGET}（完整 A 跑实测 217,777 tok 的 ${rec.budgetPctOfAFullRun}%）`);

// 每次投递前记录一下（设计者要做的事，框架不做）
const snap = (label: string) => {
  const u = host.usage.totalTokens;
  rec.phases.push({ label, hostUsage: u, overBudget: u >= BUDGET, overshoot: Number((u / BUDGET).toFixed(3)) });
  say(`  [${label}] host.usage=${u} / ${BUDGET}  超支 ${(u / BUDGET).toFixed(2)}×`);
};

// ── R1：A 写法（并行派两个组长 + 轮次进行中投递澄清 → 走 busy 通道）──
const t1 = Date.now();
const p1 = top.prompt(
  "现在开始第 1 轮：只用一条消息同时发起两个 spawn_agent 调用（lead_cap 与 lead_limit），" +
  "task 都写「按你的角色说明完成你负责那一面的调研，然后交回小结」。等两个都返回后把两份小结原样贴出来。",
);
let clarInfo: any = { skipped: true };
const clarP = (async () => {
  for (let i = 0; i < 300; i++) {
    const a = findMember(host, "lead_cap"), b = findMember(host, "lead_limit");
    if (a && b && (a.status === "running" || a.isStreaming) && (b.status === "running" || b.isStreaming)) {
      const before = host.usage.totalTokens;
      const leads = [a, b];
      const raws = [];
      for (const l of leads) raws.push(await l.send(`${CLARIFY_TAG} 补充要求：请在结论里额外提一句 src/agent/events.ts 的作用。`));
      return { before, after: host.usage.totalTokens, raws, busyPath: true };
    }
    await sleep(150);
  }
  return { skipped: true };
})();
let r1: any = null, r1Throw: string | null = null;
try { r1 = await p1; } catch (e) { r1Throw = (e as Error).message; }
clarInfo = await clarP;
rec.clarifyBusyPath = { ...clarInfo, raws: clarInfo.raws };
say(`  R1 墙钟 ${Date.now() - t1}ms ｜ 驱动层抛错=${r1Throw ?? "无"} ｜ busy 通道投递=${JSON.stringify(clarInfo.raws)}`);
say(`  busy 通道投递前后 host.usage：${clarInfo.before} → ${clarInfo.after}（投递本身不结算，结算发生在轮末）`);
snap("R1 结束");
rec.r1 = { throw: r1Throw, hostText: short(r1?.text, 400) };
const spawnRes = toolResultTexts(top.session).filter((t) => t.includes("已让成员"));
rec.r1SpawnToolResults = spawnRes.map((t) => ({ hasCapTag: t.includes("【CAP-组小结】"), hasLimitTag: t.includes("【LIMIT-组小结】"), hasClarifyTag: t.includes(CLARIFY_TAG), head: short(t, 150) }));

// ── R2：reviewer ──
const t2 = Date.now();
let r2: any = null, r2Throw: string | null = null;
try {
  r2 = await top.prompt("第 2 轮：用 spawn_agent 把上面两份小结交给 reviewer 审查，task 里附上两份小结原文。返回后原样贴出。");
} catch (e) { r2Throw = (e as Error).message; }
say(`  R2 墙钟 ${Date.now() - t2}ms ｜ 抛错=${r2Throw ?? "无"}`);
snap("R2 结束");
rec.r2 = { throw: r2Throw, hostText: short(r2?.text, 300) };
const reviewTexts = toolResultTexts(top.session).filter((t) => t.includes("reviewer"));

// ── R3：A 写法投递审查意见（send 空闲 → fire-and-forget → 预算检查在 prompt 里）──
const leadCap = findMember(host, "lead_cap"), leadLimit = findMember(host, "lead_limit");
let r3: any = { skipped: !leadCap };
if (leadCap && leadLimit) {
  const t3 = Date.now();
  const critique = short(reviewTexts.at(-1), 600);
  const errors: string[] = [];
  const un = leadCap.on("error", (e) => errors.push(String((e as any).message ?? e)));
  const un2 = leadLimit.on("error", (e) => errors.push(String((e as any).message ?? e)));
  const s1 = await leadCap.send(`【审查意见】${critique}\n请修订你的组内小结。`);
  const s2 = await leadLimit.send(`【审查意见】${critique}\n请修订你的组内小结。`);
  await sleep(2500);
  let promptThrow: string | null = null;
  try { await leadCap.prompt("再给一次修订后的小结。"); } catch (e) { promptThrow = (e as Error).message; }
  await sleep(1500);
  un(); un2();
  r3 = { sendResults: [s1, s2], sendMs: Date.now() - t3, errorsOnSendPath: errors, promptThrow, lastResultHead: short(leadCap.lastResult?.text, 200), hostUsageAfter: host.usage.totalTokens };
  say(`  R3 墙钟 ${Date.now() - t3}ms`);
  say(`  send 返回：${JSON.stringify([s1, s2])}`);
  say(`  send 路径上的 error 事件：${JSON.stringify(errors)}`);
  say(`  紧随其后的 prompt 抛错：${promptThrow ?? "无"}`);
  say(`  lead_cap.lastResult 文本（陈旧与否）：${short(leadCap.lastResult?.text, 160)}`);
  snap("R3 结束");
}
rec.r3 = r3;

// ── R4：顶层还想派写手落盘 ──
let r4Throw: string | null = null;
try {
  await top.prompt("第 3 轮：用 spawn_agent 让 writer 把两份修订小结写成 report.md。");
} catch (e) { r4Throw = (e as Error).message; }
say(`  R4 顶层 prompt 抛错：${r4Throw ?? "无（意外）"}`);
rec.r4Throw = r4Throw;
snap("R4 结束");
rec.preFallbackReport = (({ exists, bytes, headings }) => ({ exists, bytes, headings }))(inspectReport(OUT_DIR));
say(`  R4 结束时交付物状态：report.md exists=${rec.preFallbackReport.exists} bytes=${rec.preFallbackReport.bytes}`);

// ── R5：预算已耗尽，往空闲分身投递一条（空闲 send → fire-and-forget prompt → 检查处抛错被吞）──
{
  const lc = findMember(host, "lead_cap");
  const errs: string[] = [];
  const un = lc?.on("error", (e) => errs.push(String((e as any).message ?? e)));
  const before = host.usage.totalTokens;
  const s = await lc!.send("【耗尽后投递】请再补一句结论。");
  await sleep(2000);
  un?.();
  rec.postExhaustSend = { delivered: s.delivered, errorEvents: errs, usageBefore: before, usageAfter: host.usage.totalTokens, lastResultHead: short(lc!.lastResult?.text, 120), status: lc!.status };
  say(`  R5 耗尽后 send → ${JSON.stringify(s)}；error 事件=${JSON.stringify(errs)}；usage ${before}→${host.usage.totalTokens}`);
  say(`  R5 lastResult（读到的东西）：${short(lc!.lastResult?.text, 140)}`);
  snap("R5 结束");
}

// 预算耗尽后还能不能落盘？三种尝试，逐个记录需要多少额外代码
const fallback: any = { attempts: [] };

// 尝试 1：同一个宿主上直接建（不走 spawn_agent）
{
  let outcome = "";
  try {
    const w = await createAgent({ ...memberSpecs().writer }, { host, member: "writer" });
    try { const r = await w.prompt("写一句话到 report.md。"); outcome = `prompt 成功 text=${short(r.text, 60)}`; }
    catch (e) { outcome = `prompt 抛错：${(e as Error).message}`; }
  } catch (e) { outcome = `createAgent 抛错：${(e as Error).message}`; }
  fallback.attempts.push({ name: "同宿主直接 createAgent", outcome });
  say(`  [兜底1 同宿主直接 createAgent] ${outcome}`);
}

// 尝试 2：不挂宿主（预算检查来自 host，摘掉 host 就绕过去了）
{
  let outcome = "";
  let cost = 0;
  try {
    const w = await createAgent({ model: "opencode-go/deepseek-v4.1-flash", cwd: OUT_DIR, role: memberSpecs().writer.role, tools: ["write"] });
    const r = await w.prompt(`把这一句话写进 report.md（相对路径）：\n\n# 预算耗尽后的最小交付\n\n本次运行在 ${BUDGET} token 预算处被切断，此文件由摘掉 host 的救火分身写出。`);
    cost = r.usage.cost.total;
    outcome = `成功 text=${short(r.text, 80)} 花费 $${cost.toFixed(6)}`;
    w.dispose();
  } catch (e) { outcome = `抛错：${(e as Error).message}`; }
  fallback.attempts.push({ name: "摘掉 host 新建分身", outcome, costOutsideBudget: Number(cost.toFixed(6)) });
  say(`  [兜底2 摘掉 host] ${outcome}`);
}

// 尝试 3：直接问 host 还剩多少、还能不能读到已跑完的产出
fallback.hostUsageAtExhaust = host.usage.totalTokens;
fallback.overshoot = Number((host.usage.totalTokens / BUDGET).toFixed(2));
fallback.aliveAgents = host.list().map((a) => `${a.member}(${a.id})` );
fallback.capturedGroupSummaries = { cap: short(leadCap?.lastResult?.text, 200), limit: short(leadLimit?.lastResult?.text, 200) };
rec.fallback = fallback;
say(`  预算耗尽时：overshoot=${fallback.overshoot}×  存活分身=${JSON.stringify(fallback.aliveAgents)}`);

const report = inspectReport(OUT_DIR);
rec.report = { exists: report.exists, bytes: report.bytes, headings: report.headings, text: report.text };
say(`  最终 out 目录里有什么：report.md exists=${report.exists} bytes=${report.bytes} headings=${JSON.stringify(report.headings)}`);

// 优雅收场要写多少代码：数一下上面兜底块的行数（粗略）
rec.gracefulWindDownCodeLines = 24;
rec.hostUsage = host.usage.totalTokens;
rec.hostCost = host.usage.cost.total;
rec.wallMs = Date.now() - tr.startedAt;
say(`\n═══ 紧预算总账 ═══`);
say(`  预算 ${BUDGET} ｜ 实花 ${host.usage.totalTokens} tok（overshoot ${fallback.overshoot}×）｜ $${host.usage.cost.total.toFixed(6)}`);
say(`  墙钟 ${rec.wallMs}ms ｜ 阶段：${rec.phases.map((p: any) => p.label + "=" + p.hostUsage).join(" → ")}`);

writeFileSync(join(HERE, `data-${RUN_ID}.json`), JSON.stringify(rec, null, 2), "utf-8");
writeFileSync(join(HERE, `log-${RUN_ID}.txt`), log.join("\n"), "utf-8");
console.log(`写出 data-${RUN_ID}.json / log-${RUN_ID}.txt`);
host.dispose();
process.exit(0);
