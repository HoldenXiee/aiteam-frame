// 故障注入：每次只注入一个，看整条链的实际表现，并记录「设计者要多少额外代码才能优雅处理」。
// 为了让故障是唯一变量，这三个场景都用 B 那种「不重叠投递」的驱动方式（SafeMember）。
//   F1 一个成员必然失败（F1a 模型名不存在=构造期抛 / F1b 子分身首轮 prompt 失败）
//   F2 一个成员极慢（customTool 里 sleep 25s）
//   F3 中途 kill 中间层（dispose 正在跑 spawn_agent 的 sub 分身）
// 跑法：node audit/25-e2e-stress/faults.ts [f1|f2|f3|all]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent, createAgentHost, type AgentHost, type ControlledAgent, type MemberSpec } from "../../src/index.ts";
import { assistantTexts, findMember, FLASH, GLM, MIMO, QWEN, short, sleep, toolCalls, toolResultTexts, attachTracer, makeTracer } from "./cluster.ts";
import { SafeMember } from "./safe.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WHICH = (process.argv[2] ?? "all").toLowerCase();
const results: any = { scenarios: [] };
const log: string[] = [];
const say = (s: string) => { console.log(s); log.push(s); };

const slowProbe = defineTool({
  name: "slow_probe",
  label: "慢探针",
  description: "在服务端阻塞 25 秒后返回一句话。无参数。",
  parameters: Type.Object({}),
  execute: async () => {
    await sleep(25_000);
    return { content: [{ type: "text" as const, text: "慢探针已完成：耗时 25 秒。" }], details: {} };
  },
});

const SAFE_HOST_ROLE =
  "你是顶层主持人，只做三件事：挑人、派活、收集。派活一律用 spawn_agent。做完后把拿到的内容原样贴出来，不要补写、不要推测、不要替成员编结论。";

async function newTeam(members: Record<string, MemberSpec>, label: string) {
  const host = createAgentHost({ members, maxAgents: 20, maxDepth: 3, budgetTokens: 5_000_000 });
  const tr = makeTracer(label);
  attachTracer(host, tr);
  const top = await createAgent({ model: FLASH, role: SAFE_HOST_ROLE, tools: ["spawn_agent", "send_message"] }, { host, member: "host" });
  return { host, top, tr };
}

// ─────────────── F1：一个成员必然失败 ───────────────
async function f1() {
  say("\n═══════ F1 一个成员必然失败 ═══════");
  const emptyDir = mkdtempSync(join(tmpdir(), "aiteam-empty-agentdir-"));
  const members: Record<string, MemberSpec> = {
    ok_worker: { description: "正常工人", role: "用一句话回答被交办的问题，不要读文件。", model: QWEN, tools: [] },
    bad_model: { description: "坏工人（模型名不存在）", role: "用一句话回答。", model: "opencode-go/no-such-model-xyz", tools: [] },
    bad_auth: { description: "坏工人（凭证目录是空的）", role: "用一句话回答。", model: QWEN, tools: [], agentDir: emptyDir },
  };
  const { host, top, tr } = await newTeam(members, "f1");
  const t0 = Date.now();
  const out: any = { label: "F1", phases: [], spawnResults: [], agentErrors: [], hostText: "" };
  top.on("error", (e) => out.agentErrors.push(String((e as any).message ?? e)));

  // R1：一条消息里同时派 3 个（好的、坏模型、坏凭证）→ 看坏的两个怎么呈现、好的受不受影响
  const p1 = top.prompt(
    "第 1 轮：在一条消息里同时发起 3 个 spawn_agent 调用，member 分别是 ok_worker、bad_model、bad_auth，" +
    "task 都写「用一句话回答：1+1 等于几？」。每次调用返回后把返回文本原样贴出来（包括报错）。",
  );
  let r1: any = null, r1err: string | null = null;
  try { r1 = await p1; } catch (e) { r1err = (e as Error).message; }
  out.phases.push({ name: "R1", ms: Date.now() - t0, throwAtDriver: r1err });
  out.hostText = short(r1?.text, 1200);
  say(`  R1 墙钟 ${Date.now() - t0}ms；驱动层抛错=${r1err ?? "无"}`);
  say(`  R1 顶层文本：${short(r1?.text, 500)}`);
  say(`  error 事件：${JSON.stringify(out.agentErrors)}`);

  const sr = toolResultTexts(top.session).filter((t) => t.includes("已让成员") || t.includes("Error") || t.includes("错误"));
  out.spawnResults = sr.map((t) => ({ head: short(t, 260) }));
  say(`  工具结果 ${sr.length} 条：`);
  for (const t of sr) say(`    · ${short(t, 220)}`);

  // R2：让顶层汇总 —— 看它会不会把失败成员编成有内容
  const r2 = await top.prompt("第 2 轮：把上面三个成员各自交回的结论汇总成三行，每行写「成员名 → 结论」。如果某个成员没给出结论，必须写「未取得结论」并说明原因，不许替他编。");
  out.r2Text = short(r2.text, 900);
  say(`  R2 汇总：${short(r2.text, 500)}`);
  out.hallucinated = !/未取得结论|失败|错误|不存在|没有取得/.test(r2.text);
  say(`  是否把失败成员编出内容（未提到失败/未取得）= ${out.hallucinated}`);

  out.hostUsage = host.usage.totalTokens;
  out.cost = Number(host.usage.cost.total.toFixed(6));
  out.rounds = tr.rounds.map((r) => ({ member: r.member, ms: r.ms, tokens: r.tokens, error: r.error }));
  out.survivors = host.list().map((a) => a.member);
  out.activeCount = host.activeCount;
  say(`  存活分身：${JSON.stringify(out.survivors)}  用量 ${out.hostUsage} tok  $${out.cost}`);
  results.scenarios.push(out);
  host.dispose();
  return out;
}

// ─────────────── F2：一个成员极慢 ───────────────
async function f2() {
  say("\n═══════ F2 一个成员极慢（阻塞 25s）═══════");
  const members: Record<string, MemberSpec> = {
    fast1: { description: "快工人 1", role: "用一句话回答。", model: QWEN, tools: [] },
    fast2: { description: "快工人 2", role: "用一句话回答。", model: GLM, tools: [] },
    fast3: { description: "快工人 3", role: "用一句话回答。", model: MIMO, tools: [] },
    slow_worker: {
      description: "慢工人：必须先调用 slow_probe 工具，再回答",
      role: "你只有一个工具 slow_probe。你必须先调用它（它要跑 25 秒），拿到结果后再用一句话回答。",
      model: FLASH,
      customTools: [slowProbe],
      tools: ["slow_probe"],
    },
  };
  const { host, top, tr } = await newTeam(members, "f2");
  const out: any = { label: "F2" };

  // 基线：只派三个快工人
  const tFast = Date.now();
  await top.prompt("在一条消息里同时发起 3 个 spawn_agent 调用：fast1、fast2、fast3，task 都写「用一句话回答：2+2 等于几？」。全部返回后把三句话原样贴出。");
  out.fastOnlyMs = Date.now() - tFast;
  const fastRounds = tr.rounds.filter((r) => ["fast1", "fast2", "fast3"].includes(r.member ?? ""));
  out.fastRounds = fastRounds.map((r) => ({ member: r.member, ms: r.ms }));
  say(`  [基线] 3 个快工人：顶层墙钟 ${out.fastOnlyMs}ms；各轮 ${fastRounds.map((r) => `${r.member}=${r.ms}ms`).join(" ")}`);

  // 加一个慢工人（同一条消息里派 4 个）
  const tMix = Date.now();
  await top.prompt(
    "在一条消息里同时发起 4 个 spawn_agent 调用：fast1、fast2、fast3、slow_worker，" +
    "前三个 task 写「用一句话回答：3+3 等于几？」，slow_worker 的 task 写「先调用 slow_probe，再用一句话回答」。全部返回后把四句话原样贴出。",
  );
  out.mixedMs = Date.now() - tMix;
  const slowRound = tr.rounds.filter((r) => r.member === "slow_worker");
  out.slowRounds = slowRound.map((r) => ({ ms: r.ms, tokens: r.tokens, t: r.t }));
  const fastAfter = tr.rounds.filter((r) => ["fast1", "fast2", "fast3"].includes(r.member ?? "")); 
  out.fastEndTimes = fastAfter.map((r) => ({ member: r.member, endT: r.t }));
  const slowAgent = findMember(host, "slow_worker");
  out.slowToolCalls = slowAgent ? toolCalls(slowAgent.session).map((c) => c.name) : [];
  say(`  slow_worker 实际调用的工具：${JSON.stringify(out.slowToolCalls)}`);
  say(`  [混跑] 顶层墙钟 ${out.mixedMs}ms；slow_worker 轮长 ${slowRound.map((r) => r.ms + "ms").join(",")}；fast 结束时刻 ${fastAfter.map((r) => r.member + "@" + r.t).join(" ")}`);
  say(`  → 快分支是否被推迟到慢分支之后才结束：见上面 fast 各轮的结束时刻 vs slow 的结束时刻 ${slowRound.map((r) => r.t).join(",")}`);

  out.hostUsage = host.usage.totalTokens;
  out.cost = Number(host.usage.cost.total.toFixed(6));
  results.scenarios.push(out);
  host.dispose();
  return out;
}

// ─────────────── F3：中途 kill 中间层 ───────────────
async function f3() {
  say("\n═══════ F3 中途 kill 中间层（dispose 正在跑 spawn_agent 的 sub）═══════");
  const members: Record<string, MemberSpec> = {
    lead: {
      description: "组长：带一个 sub，sub 带一个 leaf",
      role: "你是组长。第一步用 spawn_agent 派给 sub，task 写「按你的角色说明向下派活并把 leaf 的结论交回」；拿到返回后写一句话小结。",
      model: QWEN,
      tools: ["spawn_agent", "send_message"],
    },
    sub: {
      description: "中间层：带一个 leaf",
      role: "你是中间层。用 spawn_agent 派给 leaf，task 写「用一句话回答：框架里 maxDepth 默认是几？」；拿到返回后原样交回。",
      model: GLM,
      tools: ["spawn_agent", "send_message"],
    },
    leaf: { description: "底层工人", role: "用一句话回答被交办的问题。", model: MIMO, tools: [] },
  };
  const { host, top, tr } = await newTeam(members, "f3");
  const out: any = { label: "F3" };

  // R1：派组长 → 组长派 sub → sub 派 leaf。在 sub 还在跑的时候把它 dispose 掉
  const p1 = top.prompt("用 spawn_agent 派给 lead，task 写「按你的角色说明组建小组并交回小结」。拿到返回后原样贴出。");
  let killed: any = { done: false };
  const killer = (async () => {
    for (let i = 0; i < 300; i++) {
      const mid = findMember(host, "sub");
      const lf = findMember(host, "leaf");
      if (mid && lf && lf.status === "running") {
        const before = { mid: mid.id, leaf: lf.id, leafParent: lf.parentId, midStatus: mid.status };
        mid.dispose();
        return { ...before, killedAt: Date.now(), listAfter: host.list().map((a) => a.member), midInList: !!host.list().find((a) => a.id === before.mid) };
      }
      await sleep(120);
    }
    return { timeout: true };
  })();
  let r1: any = null, r1err: string | null = null;
  try { r1 = await p1; } catch (e) { r1err = (e as Error).message; }
  killed = { ...killed, ...(await killer) };
  out.kill = killed;
  out.r1 = { driverThrow: r1err, hostText: short(r1?.text, 700) };
  say(`  kill 时刻：${JSON.stringify(killed)}`);
  say(`  R1 驱动层抛错=${r1err ?? "无"}；顶层文本=${short(r1?.text, 400)}`);
  const lead = findMember(host, "lead");
  const leaf = host.list().find((a) => a.member === "leaf");
  out.afterKill = { leadId: lead?.id, leafId: leaf?.id, leafParent: leaf?.parentId, leafInList: !!leaf, midInList: !!host.list().find((a) => a.member === "sub") };
  say(`  kill 后：lead=${lead?.id} leaf=${leaf?.id}（parent=${leaf?.parentId}）leaf 仍在 list=${!!leaf}`);

  // R2：让组长给 leaf（真正的后代）投递一条消息 —— 基线 G 预测：被拒且理由事实错误
  if (lead && leaf) {
    const r2 = await top.prompt(
      `第 2 轮：用 send_message 给分身 ${leaf.id} 投一条消息「请再确认一次你的答案」。把 send_message 的返回原文贴出来，一个字都不要改。`,
    );
    const sends = toolResultTexts(top.session).filter((t) => t.includes("投递") || t.includes("后代"));
    out.r2 = { hostText: short(r2.text, 600), sendResults: sends.map((t) => short(t, 260)) };
    say(`  R2 send_message 返回：${JSON.stringify(out.r2.sendResults)}`);
  }

  // R3：能不能优雅收场 —— 让顶层给出「谁还活着」的清单
  const r3 = await top.prompt(
    "第 3 轮：报告一下这次任务的结果。如果中间有分身被回收导致链路断了，必须明确指出断在哪里、谁收不到消息；不要假装任务成功。",
  );
  out.r3Text = short(r3.text, 800);
  say(`  R3 顶层收场：${short(r3.text, 500)}`);

  out.hostUsage = host.usage.totalTokens;
  out.cost = Number(host.usage.cost.total.toFixed(6));
  out.listAtEnd = host.list().map((a) => `${a.member}(${a.id})<-${a.parentId ?? "-"}`);
  out.rounds = tr.rounds.map((r) => ({ member: r.member, ms: r.ms, error: r.error }));
  results.scenarios.push(out);
  host.dispose();
  return out;
}

if (WHICH === "all" || WHICH === "f1") await f1();
if (WHICH === "all" || WHICH === "f2") await f2();
if (WHICH === "all" || WHICH === "f3") await f3();

const totalCost = results.scenarios.reduce((a: number, s: any) => a + (s.cost ?? 0), 0);
results.totalCost = Number(totalCost.toFixed(6));
say(`\n故障注入合计花费 $${totalCost.toFixed(6)}`);
mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, `data-faults-${WHICH}.json`), JSON.stringify(results, null, 2), "utf-8");
writeFileSync(join(HERE, `log-faults-${WHICH}.txt`), log.join("\n"), "utf-8");
console.log(`写出 data-faults-${WHICH}.json / log-faults-${WHICH}.txt`);
process.exit(0);
