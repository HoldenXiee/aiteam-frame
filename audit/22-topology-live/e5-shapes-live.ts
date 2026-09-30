// E5：形态抽查 —— 用真模型跑 test/shapes.test.ts 里表达过的形态。
// 选 3 种最有代表性的：
//   形态 6  两团队争辩 + 裁决（子树嵌套 + 只能由主持人转发 + judge）
//   形态 10 层级汇报（层层汇总上报）
//   形态 4  监督者 + 工人池（分身复用：同一分身被反复投递 —— 恰好落在已知盲区 1 上）
// 关注点：会不会卡住 / 会不会跑偏 / token 会不会爆掉。
// 跑法：node audit/22-topology-live/e5-shapes-live.ts [--only=6]   （真模型，并发 1）
import { createAgent, createAgentHost, type AgentHost } from "../../src/index.ts";
import { createSpawnAgentTool } from "../../src/tools/spawn-agent.ts";
import { FLASH, makeSink, turn, workDir, type Turn } from "./_lib.ts";

const sink = makeSink("e5-shapes-live");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").split("=")[1];
const cwd = workDir("e5");
const row = (label: string, t: Turn) =>
  `${label}: ${t.ms}ms ${t.tokens}tok $${t.cost.toFixed(6)} calls=${JSON.stringify(t.calls.map((c) => c.name))}${t.error ? ` ERROR=${t.error.slice(0, 60)}` : ""}`;

// ─────────────── 形态 6：两团队争辩 + 裁决 ───────────────
async function shape6() {
  sink.section("形态 6：两团队争辩 + 裁决");
  const host: AgentHost = createAgentHost({
    defaults: { model: FLASH },
    members: {
      leadA: { description: "正方队长：主张用微服务拆分，可以再招人", tools: ["spawn_agent", "send_message"] },
      leadB: { description: "反方队长：主张单体优先，可以再招人", tools: ["spawn_agent", "send_message"] },
      memberA: { description: "正方队员：只给支持微服务的一条论据" },
      memberB: { description: "反方队员：只给支持单体的一条论据" },
      judge: { description: "裁判：听完双方论据后给出唯一结论" },
    },
    maxAgents: 12,
    maxDepth: 2,
  } as never);
  const top = await createAgent({ model: FLASH, cwd, tools: ["spawn_agent", "send_message"] }, { host });

  const t1 = await turn(
    top,
    "请用 spawn_agent 分别让 leadA 和 leadB 各带一个队员收集论据（每人只出一条），让它俩各自汇总后回报。",
  );
  const leads = host.list().filter((a) => a.member === "leadA" || a.member === "leadB");
  console.log(row("①组队+收集", t1));
  console.log(`   已建分身：${host.list().map((a) => `${a.member}#${a.id}(p=${a.parentId})`).join(", ")}`);

  const t2 = await turn(
    top,
    "现在用 send_message 把反方的结论转给正方队长、把正方的结论转给反方队长，让它们各自回应一次。",
  );
  console.log(row("②交叉转发", t2));
  await Promise.all(leads.map((l) => l.waitForIdle().catch(() => {})));
  const t3 = await turn(top, "最后用 spawn_agent 让 judge 听完双方论据后给出唯一结论。");
  console.log(row("③裁决", t3));

  const tokens = host.usage.totalTokens;
  const cost = host.usage.cost.total;
  const judge = host.list().find((a) => a.member === "judge");
  sink.add({
    id: "E5-shape6",
    question: "形态 6（两团队争辩+裁决）在真模型下会不会卡住/跑偏，token 会不会爆",
    method: "node audit/22-topology-live/e5-shapes-live.ts --only=6（真模型，3 轮主持人 turn）",
    observed: [
      row("①组队+收集", t1),
      row("②交叉转发", t2),
      row("③裁决", t3),
      `宿主：${host.list().length} 个分身（${host.list().map((a) => a.member).join(",")}）；聚合 ${tokens} token / $${cost.toFixed(5)}；总墙钟 ${t1.ms + t2.ms + t3.ms}ms`,
      `裁判产出=«${(judge?.lastResult?.text ?? "(无)").slice(0, 120)}»`,
    ].join("\n     "),
    verdict: t1.error || t2.error || t3.error ? "GAP" : "OK",
    conclusion: `3 轮全部走完，无抛错、无卡住。整形态 ${tokens} token / $${cost.toFixed(5)}（约 ${(tokens / 1000).toFixed(1)}k），墙钟 ${((t1.ms + t2.ms + t3.ms) / 1000).toFixed(1)}s。实测分身数=${host.list().map((a) => a.member).join(",")}。`,
    data: { t1, t2, t3, tokens, cost, members: host.list().map((a) => ({ id: a.id, member: a.member, parent: a.parentId })) },
  });
  sink.ledger("shape6", { t1, t2, t3, tokens, cost });
  host.dispose();
}

// ─────────────── 形态 10：层级汇报 ───────────────
async function shape10() {
  sink.section("形态 10：层级汇报");
  const host: AgentHost = createAgentHost({
    defaults: { model: FLASH },
    members: {
      leadA: { description: "组长 A：可以从组员 1、组员 2 里挑人，汇总后上报", tools: ["spawn_agent"] },
      leadB: { description: "组长 B：可以从组员 3 里挑人，汇总后上报", tools: ["spawn_agent"] },
      m1: { description: "组员 1：只给一条结论" },
      m2: { description: "组员 2：只给一条结论" },
      m3: { description: "组员 3：只给一条结论" },
    },
    maxAgents: 12,
    maxDepth: 2,
  } as never);
  const top = await createAgent({ model: FLASH, cwd, tools: ["spawn_agent"] }, { host });

  const t1 = await turn(
    top,
    "请用 spawn_agent 分别让 leadA 和 leadB 各带自己的人干活（leadA 带组员 1、组员 2；leadB 带组员 3），每人都只出一条一句话的结论，然后让两个组长把各自队员的结论汇总后回报给你。",
  );
  console.log(row("①组长带队", t1));
  const sumA = host.list().find((a) => a.member === "leadA")?.lastResult?.text ?? "";
  const sumB = host.list().find((a) => a.member === "leadB")?.lastResult?.text ?? "";
  const t2 = await turn(top, `现在请你把两份汇总再汇总成一份上报。\nA 组汇总：${sumA}\nB 组汇总：${sumB}`);
  console.log(row("②顶层汇总", t2));

  const tokens = host.usage.totalTokens;
  const cost = host.usage.cost.total;
  sink.add({
    id: "E5-shape10",
    question: "形态 10（层级汇报）在真模型下：组长会不会真的先汇总再上报",
    method: "node audit/22-topology-live/e5-shapes-live.ts --only=10",
    observed: [
      row("①组长带队", t1),
      row("②顶层汇总", t2),
      `实际分身：${host.list().map((a) => `${a.member}#${a.id}`).join(", ")}`,
      `A 组汇总=«${sumA.slice(0, 100)}»`,
      `B 组汇总=«${sumB.slice(0, 100)}»`,
      `顶层产出=«${t2.text.slice(0, 150)}»`,
      `聚合 ${tokens} token / $${cost.toFixed(5)}`,
    ].join("\n     "),
    verdict: t1.error || t2.error ? "GAP" : "OK",
    conclusion: `形态走完，无抛错。共起 ${host.list().length} 个分身，${tokens} token / $${cost.toFixed(5)}。注意：层级汇报能成立**靠的是 spawn_agent 同步返回文本**（组长看到队员输出），而不是层级本身有什么汇总机制。`,
    data: { t1, t2, tokens, cost, sumA, sumB, members: host.list().map((a) => ({ id: a.id, member: a.member, parent: a.parentId })) },
  });
  sink.ledger("shape10", { t1, t2, tokens, cost, sumA, sumB });
  host.dispose();
}

// ─────────────── 形态 4：监督者 + 工人池（分身复用 = 盲区 1） ───────────────
async function shape4() {
  sink.section("形态 4：监督者 + 工人池（同一分身被反复投递）");
  const host: AgentHost = createAgentHost({
    defaults: { model: FLASH },
    members: { worker: { description: "工人：做一句话的活，回答极简" } },
    maxAgents: 8,
    maxDepth: 1,
  } as never);
  const mgr = await createAgent({ model: FLASH, cwd, tools: ["spawn_agent", "send_message"] }, { host });

  const t1 = await turn(mgr, "请用 spawn_agent 让 worker 做第一件活：说出 1+1 等于几。只回一个数字。");
  const worker = host.list().find((a) => a.member === "worker");
  console.log(row("①建工人", t1));
  const rounds: Array<{ round: number; promptMs: number; before: string; after: string; note: string }> = [];
  for (let k = 2; k <= 4; k++) {
    const before = worker?.lastResult?.text ?? "";
    const beforeUsage = worker?.usage.totalTokens ?? 0;
    // 快照：投递之后 worker 的 assistant 消息里最后一条文本（读 session，比 lastResult 更可信）
    const snap = () => {
      const msgs = (worker?.session.messages ?? []) as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role !== "assistant") continue;
        const t = msgs[i].content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
        if (t) return t.trim();
      }
      return "";
    };
    const t = await turn(mgr, `现在用 send_message 让刚才那个 worker 做第 ${k} 件事：说出 ${k}+${k} 等于几。只回一个数字。`);
    const wait = await Promise.race([
      worker?.waitForIdle().then(() => "idle") ?? Promise.resolve("无工"),
      new Promise<string>((r) => setTimeout(() => r("timeout-8s"), 8000)),
    ]);
    const after = snap();
    const lastResult = (worker?.lastResult?.text ?? "").trim();
    const usageDelta = (worker?.usage.totalTokens ?? 0) - beforeUsage;
    const note = `等待=${wait}; worker.session 最后文本=${JSON.stringify(after)}; worker.lastResult=${JSON.stringify(lastResult)}; worker 用量Δ=${usageDelta}tok; 一致性=${after === lastResult ? "一致" : "**不一致**"}`;
    rounds.push({ round: k, promptMs: t.ms, before: before.slice(0, 30), after: after.slice(0, 30), note });
    console.log(`${row(`②第${k}轮`, t)} ${note}`);
  }
  const t5 = await turn(mgr, "刚才你一共让 worker 做了几件事？按顺序把它们各自的回答复述一遍。");
  console.log(row("③追责", t5));
  const tokens = host.usage.totalTokens;
  const cost = host.usage.cost.total;
  sink.add({
    id: "E5-shape4",
    question: "形态 4（监督者+工人池，同一分身被反复投递）在真模型下会不会串台/丢上下文",
    method: "node audit/22-topology-live/e5-shapes-live.ts --only=4（同一 worker 分身被投递 3 次）",
    observed: [
      row("①建工人", t1),
      ...rounds.map((r) => `第${r.round}轮：主持人 turn ${r.promptMs}ms；worker.lastResult 投递前=«${r.before}»；${r.note}`),
      row("③追责", t5),
      `追责产出=«${t5.text.slice(0, 200)}»`,
      `分身数=${host.list().length}（应为 2）；聚合 ${tokens} token / $${cost.toFixed(5)}`,
    ].join("\n     "),
    verdict: host.list().length === 2 ? (t1.error || t5.error ? "GAP" : "OK") : "PARTIAL",
    conclusion: `工人被复用 ${rounds.length} 次，分身数保持 ${host.list().length}（未随轮次增长）。${t1.error || t5.error ? `有抛错：${t1.error ?? t5.error}` : "全程无抛错"}。关键：send_message 只回「已投递」，主持人**拿不到回执** —— 它必须自己去读 worker 的状态，而“后一条回答能否被正确归因”见观察行里的一致性字段。`,
    data: { t1, rounds, t5, tokens, cost, workerId: worker?.id, workerUsage: worker?.usage, workerLast: worker?.lastResult },
  });
  sink.ledger("shape4", { t1, rounds, t5, tokens, cost });
  host.dispose();
}

if (ONLY === "6" || !ONLY) await shape6();
if (ONLY === "10" || !ONLY) await shape10();
if (ONLY === "4" || !ONLY) await shape4();

console.log(`\n→ ${sink.path}`);
