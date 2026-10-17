// 实验室 A 的运行入口：跑一次自由集群，落一行 JSONL。
//
// 跑法：
//   node demom/bench/prep.ts                先铺现场（每次跑之前都要）
//   node demom/labA-cluster/run.ts          跑一次
//   node demom/labA-cluster/run.ts --tag x  给这批数据起个名
//   node demom/labA-cluster/run.ts --repeat 5   连跑 5 次（每次重铺现场）
//
// ★ 自由在哪 ★：下面这个 root agent 只知道「任务是什么」和「有哪几个角色可用」，
// **没有任何一步叫「第 1 步」**。谁派给谁、派几次、什么时候停，全由它自己决定。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lab, MODEL, cwd } from "../env.ts";
import { judge, TASK_BRIEF, type Verdict } from "../bench/task.ts";
import { Meter, summarize, type RunRecord } from "../bench/measure.ts";
import { checkScene, resetScene } from "../bench/prep.ts";
import { ROSTER, spawnTool, listCorpus, noteTool, draftsExtension, newBudget, readDrafts, newRegistry, peersTool, askTool, type SpawnLog } from "./cluster.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(dirname(here), "runs");

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const TAG = arg("--tag", "A")!;
const REPEAT = Number(arg("--repeat", "1"));
/**
 * 变体：一次只改一件事（主设计纪律）。
 *
 *   base   —— 原版（root 能自己 read，也能 spawn）
 *   nodup  —— ★ 改进假设 1 ★：把 read 从 root 手里拿掉。
 *             观察：root 每轮自己读 42–49 份材料，而 5 个 scout 又各自读一遍 —— 重复劳动。
 *             拿掉 read 后它只能用 read_drafts 看下游成果，**被迫真的分工**。
 *             代价：它也无法核对材料原文了（这正是要观测的取舍）。
 *   talk   —— ★ 改进假设 2 ★：用库的高级功能给集群补上「双向通信」与「轨迹共享」。
 *             ① 通讯录 + `peers` + `ask`：agent 之间可以**直接互问**，而不只是单向派活；
 *             ② `spawn` 交回子 agent 的**完整上下文轨迹**，而不只是它写下的结论。
 *             它检验的问题：集群的失败是不是也能像 B 那样，靠「交接机制」修好？
 */
const VARIANT = arg("--variant", "base")!;

/** 各变体的 root 工具白名单 */
function rootTools(): string[] {
  const base = ["list_corpus", "read", "write", "note", "read_drafts", "spawn"];
  if (VARIANT === "nodup") return base.filter((t) => t !== "read");
  if (VARIANT === "talk") return [...base, "peers", "ask"];
  if (VARIANT === "ledger") return base;
  return base;
}

/**
 * ★ ledger 变体：给 agent 装一个「外部工作台」（已读清单）★
 *
 * 动机（从实测形状里看出来的）：A 的最优形状是 **root 自己读完全部材料**（45 次 read），
 * 而任务最难的一步（去重）需要**跨材料比较**。45 份材料的内容远超可靠记忆范围 ——
 * 读到后面会忘前面（root 的 role 里那句「你会遗忘前面」说的就是这个）。
 *
 * 库给的两个面正好能做一个**不占大脑的工作台**：
 *   · `agent.on("tool_call")` —— 实时知道它读了哪份材料（不需要它自己记）
 *   · `context.override`   —— 把「已读清单」注进**每一轮**发给模型的内容
 *
 * 效果：不管读了 5 份还是 45 份，模型永远看得到一份**自己读过什么的索引**，
 * 而不用靠记忆去维持 —— 这正好把「跨材料比较」从「记忆任务」降成「看清单」。
 *
 * ⚠️ 它**不改历史**（override 只改本轮发出的内容），也不替模型做任何判断。
 */
function attachLedger(agent: import("../../src/index.ts").Agent, label: string) {
  const read = new Set<string>();
  agent.on("tool_call", (e) => {
    if (e.toolName !== "read") return;
    const inp = e.input as { path?: unknown; file?: unknown } | undefined;
    const p = String(inp?.path ?? inp?.file ?? "");
    if (!p) return;
    // 只记材料编号 + 标题（文件名本身就是一份现成的摘要）
    const name = p.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
    if (name.startsWith("M")) read.add(name);
  });
  agent.context.override((messages) => {
    if (!read.size) return messages;
    const list = [...read].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const index = `【${label}：你已经读过的材料，共 ${list.length} 份】\n${list.join("\n")}`;
    return [{ role: "user", content: index } as import("../../src/index.ts").AgentMessage, ...messages];
  });
  return () => read.size;
}

/** 跑一次完整的集群 */
async function runOnce(n: number): Promise<RunRecord> {
  resetScene(); // ★ 每轮之前重置，否则第 N 轮会看到第 N-1 轮的 draft/ 与 report.md（静默污染）
  const meter = new Meter();
  const budget = newBudget();
  const spawnLog: SpawnLog[] = [];
  const registry = newRegistry();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const talk = VARIANT === "talk";

  // ★ 根 agent：它自己就是一个「协调者」角色，也拿 spawn —— 也可以什么都不派，自己干完 ★
  //
  // ⚠️ 下面这段 role 里有一句硬约束（「你一个人读不完」）—— 这是**措施 2**（见 A README §10）。
  //    背景：44 份材料之前的那轮预跑，root 只起了 1 个 agent、delegations=0（集群形态压根没出现）。
  //    这句只说「不分工的后果」，不给步骤 —— 怎么分工仍然是它自己决定。
  const root = await lab.createAgent({
    id: `A-root-${n}`,
    model: MODEL,
    role:
      "你是一个自由集群的协调者。你可以自己动手，也可以用 spawn 把活派给花名册里的角色。" +
      "怎么分工、派几次、要不要并行、什么时候收工，都由你决定。" +
      `可选角色：${[...ROSTER.keys()].join("、")}。` +
      "\n重要：corpus/ 里的材料很多，单靠自己一份份读完会超出你的上下文上限（读到后面会遗忘前面）。" +
      "所以你必须用 spawn 把材料分给不同的角色去看，让它们各自看一部分、只把结论带回来 —— 这正是分给它们的原因。" +
      "注意：每个角色交回的成果如果没落进 draft/，你之后就看它不见了 —— 让它们用 note 工具记下来。" +
      // ★ talk 变体：把「可以互问」这件事说出来 ★
      // 实测：不给这句，模型**一次都不会用** peers/ask（工具确实挂着、也真能用，它就是不选）。
      // 这与最初的 spawn 一样 —— 不给「你一个人读不完」它就不分工。
      // 说明：**库给的是机制，用不用是策略层（role 文本）的事。**
      (talk
        ? "\n另外：你有 peers 和 ask 两个工具 —— peers 列出集群里已经在场的其他 agent，" +
          "ask 可以直接向其中任意一个提问并拿到回答（不用重新派活）。" +
          "当某份材料的内容牵涉到别人手上那一块、或者你需要确认一件事时，用它去问，比你重读一遍便宜。"
        : ""),
    permissions: { only: rootTools() },
    tools: {
      custom: [
        listCorpus,
        noteTool("root"),
        spawnTool({
          depth: 1,
          budget,
          log: spawnLog,
          parentId: `A-root-${n}`,
          meterWatch: (a, meta) => meter.watchAndKeep(a, meta),
          registry: talk ? registry : undefined,
          traceShare: talk,
          extraTools: talk
            ? (childId) => [peersTool(registry, childId), askTool({ registry, selfId: childId, budget, log: spawnLog })]
            : undefined,
        }),
        ...(talk ? [peersTool(registry, `A-root-${n}`), askTool({ registry, selfId: `A-root-${n}`, budget, log: spawnLog })] : []),
      ],
    },
    extensions: [draftsExtension()],
  });
  meter.watchAndKeep(root, { role: "root", parent: null, depth: 1 });
  registry.add({ id: root.id, role: "root（协调者）", task: "统筹全局", agent: root });
  const ledgerSize = VARIANT === "ledger" ? attachLedger(root, "工作台") : undefined;

  let crashed: string | undefined;
  try {
    const res = await root.io.prompt(TASK_BRIEF);
    if (res.error) crashed = `root 这一轮失败：${res.error}`;
    budget.note(root.id, root.usage.totalTokens);
  } catch (e) {
    crashed = `集群崩了：${(e as Error).message}`;
  }

  // 收尾：先 settle 拿全生命周期用量，再 dispose
  meter.settle();
  const sum = summarize(meter, { budgetHit: budget.hit });
  meter.dispose();
  // ⚠️ 所有 agent（含子 agent）都要真的 dispose，否则进程悬住
  for (const a of meter.liveAgents()) a.dispose();

  const verdict: Verdict = judge(cwd);

  return {
    lab: "A-cluster",
    tag: TAG,
    variant: VARIANT,
    startedAt,
    secs: (Date.now() - t0) / 1000,
    crashed,
    agents: meter.records,
    ...sum,
    verdict,
    reportText: existsSync(join(cwd, "report.md")) ? readFileSync(join(cwd, "report.md"), "utf8") : null,
    asks: talk && registry.asked.length ? registry.asked.map((a) => `${a.from}→${a.to}`) : undefined,
    ledgerReads: ledgerSize ? ledgerSize() : undefined,
  };
}

// ─────────────────────────────────────────────────────────────
mkdirSync(RUNS_DIR, { recursive: true });

resetScene(); // 先清掉上一轮的残留，再检查现场（否则「上一轮的 report.md 还在」会把检查卡住）
const scene = checkScene();
if (!scene.ok) {
  console.log("[A] 现场没就绪，先跑 node demom/bench/prep.ts");
  for (const l of scene.lines) console.log(l);
  process.exit(1);
}

console.log(`[A] 自由集群 × ${REPEAT} 次，tag=${TAG}`);
console.log(`    模型 ${MODEL}（与 B 必须同一个）`);
console.log(`    花名册：${[...ROSTER.keys()].join(", ")}`);

// ★ 先定文件名，**每跑完一轮就立即追加一行** ★
//
// 为什么不是跑完 5 轮再一次性写：实测踩过 —— 后台进程在第 3 轮被杀，
// 前两轮共 28 分钟的成品因为只在内存里而全丢。研究数据收集必须能容忍中断。
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(RUNS_DIR, `A-${TAG}-${stamp}.jsonl`);

const rows: RunRecord[] = [];
for (let i = 1; i <= REPEAT; i++) {
  process.stdout.write(`    [${i}/${REPEAT}] 跑… `);
  const rec = await runOnce(i);
  rows.push(rec);
  appendFileSync(out, JSON.stringify(rec) + "\n", "utf8"); // ← 立即落盘
  const shape = `${rec.agentCount} 个 agent / 深 ${rec.maxDepth} / 委派 ${rec.delegations}`;
  console.log(`${rec.secs.toFixed(1)}s  ${shape}  ${rec.verdict.ok ? "✓ ok" : "✗ " + rec.verdict.failed[0]}`);
}

// 形状画像：A 最有信息量的一屏（draft 里落下来的委派图）
console.log(`\n[A] 形状画像（这是 A 的因变量，主设计 §3.3）`);
for (const r of rows) {
  console.log(`    ${r.agentCount} 个 agent，最大深度 ${r.maxDepth}，委派 ${r.delegations} 次，工具调用 ${r.toolCalls} 次，${r.totalTokens} tokens`);
  for (const a of r.agents) {
    const pad = "  ".repeat(a.depth - 1);
    console.log(`      ${pad}${a.role}(${a.id}) 工具[${a.distinctTools.join(",") || "无"}]`);
  }
  if (r.budgetHit) console.log(`      ⚠ 触到了预算闸`);
  if (r.crashed) console.log(`      ✗ ${r.crashed}`);
}

const okCount = rows.filter((r) => r.verdict.ok).length;
const avgAgents = (rows.reduce((n, r) => n + r.agentCount, 0) / rows.length).toFixed(1);
console.log(`\n[A] ${okCount}/${rows.length} 次 ok；平均 ${avgAgents} 个 agent；平均 ${(rows.reduce((n, r) => n + r.secs, 0) / rows.length).toFixed(1)}s`);
console.log(`    产物：runs/${out.split(/[\\/]/).pop()}`);

// 草稿留档：中间产物是「它怎么一步步做出来的」的直接证据，JSONL 里只有工具流水，没有内容
const draftDump = join(RUNS_DIR, `A-${TAG}-${stamp}-drafts.txt`);
appendFileSync(draftDump, readDrafts(), "utf8");
console.log(`    草稿留档：runs/${draftDump.split(/[\\/]/).pop()}`);
