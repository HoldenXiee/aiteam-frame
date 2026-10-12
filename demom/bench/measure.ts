// 统一埋点与指标抽取。
//
// ★ 两边实验**都用这个文件量自己**，不许各自上报。★
// 理由（主设计「还能设计什么」第 3 条）：计量一旦各写一份，就会各自偷懒，
// 而「谁更省」正是本实验要回答的三个问题之一。
//
// 难点：A 的子 agent 是**运行期才起的**，父进程得在它诞生那一刻挂钩。
// 所以这里提供一个 `meter` 对象，实验室在每次 `createAgent` 之后调 `meter.watch(agent)`。
// B 的 5 个阶段跑之前就数得出，但走同一条路 —— 口径一致比省事重要。

import type { Agent } from "../../src/index.ts";
import type { Usage } from "../../src/index.ts";

/** 一次工具调用的摘要（工具名 + 关键参数）—— 检测「重复劳动」靠它 */
export interface CallRecord {
  tool: string;
  /** 关键参数：read/write → 路径；spawn → 角色；note → 长度。没用的就不存 */
  arg: string;
}

/** 把工具入参压成一行摘要（不同工具看的字段不同） */
function summarizeInput(tool: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "read":
    case "write":
      return String(o.path ?? o.file ?? "?");
    case "spawn":
      return String(o.role ?? "?");
    case "note":
      return `${String(o.text ?? "").length}字符`;
    default:
      return "";
  }
}

/** 单个 agent 的观测结果 */
export interface AgentRecord {
  id: string;
  /** 它在实验室里的角色标签（A 是花名册角色，B 是阶段名） */
  role: string;
  /** 谁派的它（A 用；B 恒为 null） */
  parent: string | null;
  /** 它在委派图里的深度（父 = 1） */
  depth: number;
  toolCalls: number;
  distinctTools: string[];
  /** 每次工具调用的顺序流水（形状图的原素材） */
  calls: string[];
  /** ★ 带参数的工具调用流水（检测重复劳动用）—— 旧记录里没有这个字段 ★ */
  callsDetailed?: CallRecord[];
  /** 这个 agent 读过的文件路径（去重后的）—— 直接用来算「几个人读了同一份」 */
  readPaths?: string[];
  usage: Usage;
  error?: string;
}

/** 一次完整运行的记录 —— 落成 runs/ 里的一行 JSONL */
export interface RunRecord {
  lab: "A-cluster" | "B-workflow";
  tag: string;
  /** A 的变体名（base / nodup…）；B 恒为 undefined */
  variant?: string;
  startedAt: string;
  secs: number;
  /** 抛出的异常（不是 RunResult.error，那是「轮失败」，这是「实验崩了」） */
  crashed?: string;

  agents: AgentRecord[];
  agentCount: number;

  // ── 汇总（口径统一：全部 agent 累加） ──
  toolCalls: number;
  inTokens: number;
  outTokens: number;
  totalTokens: number;
  costUsd: number;

  // ── 形状（主设计 §3.3：这次对比真正的因变量） ──
  maxDepth: number;
  /** A 的委派边数（B 恒为 0 —— 它没有委派，只有边） */
  delegations: number;
  /** 是否触到了预算闸（A 的护栏有没有真的起作用） */
  budgetHit: boolean;

  verdict: import("./task.ts").Verdict;

  /**
   * 产物全文。
   *
   * ★ 存全文而不是只存哈希，是为了**后面做定性分析**（研究的要求：先收集数据，再分析）★
   * 只存哈希只能回答「两次一样吗」，回答不了「它到底怎么分节的 / 去重那一条写成什么样」。
   * 体积可接受（约 1–2KB/次，JSON.stringify 会把换行转义）。
   */
  reportText: string | null;

  /**
   * 护栏记录：哪些阶段因为工具调用超限被中止（防失控）。
   * 空/undefined = 这次没触发。它的作用与 A 的 `budgetHit` 同构 ——
   * 让「护栏到底有没有干活」在数据里露出来（研究记录 §6 第 5 条抱怨过它从未触发）。
   */
  guarded?: string[];
  /** 这次跑过的**纯代码阶段**及其结果（B 的结构性优势：确定性步骤） */
  codeStages?: { id: string; result: string }[];

  /**
   * share 变体：注进下游的**上下文轨迹**字符数。
   * 这是「轨迹共享」相对「走文件」的直接代价 —— 两种交接机制的分岔就在这里。
   */
  sharedTraceChars?: number;
  /** share 变体：哪几个阶段共享了谁的轨迹（形如 `S4-成文←S2-去重+S3-查矛盾(24条)`） */
  sharedFrom?: string[];
  /** 审批门拦下的重复读（库的 permissions.gate 在工作） */
  repeatBlocks?: string[];
  /** talk 变体：agent 之间互相问的记录（形如 `A-root-1→A-scout-3`） */
  asks?: string[];
  /** steer 变体：中途纠正（io.steer）拉了几把、什么时侯拉的 */
  steered?: string[];
  /** ledger 变体：外部工作台里记下了多少份材料（context.override 注了多少） */
  ledgerReads?: number;
}

/** 累加器：实验室把每个 agent 交给它，它负责量 */
export class Meter {
  readonly records: AgentRecord[] = [];
  /** 跑过的纯代码阶段（不是 agent，不进 records；单独记，否则它们在数据里隐身） */
  readonly codeStages: { id: string; result: string }[] = [];

  /** 记一个纯代码阶段的结果（无 agent、无 token，但它是流程的一部分） */
  noteCodeStage(id: string, result: string): void {
    this.codeStages.push({ id, result });
  }
  private readonly unsubs: (() => void)[] = [];
  budgetHit = false;

  /** 挂一个 agent。**每次 createAgent 之后必须调**，否则它的用量不进总数。 */
  watch(agent: Agent, meta: { role: string; parent?: string | null; depth?: number }): void {
    const rec: AgentRecord = {
      id: agent.id,
      role: meta.role,
      parent: meta.parent ?? null,
      depth: meta.depth ?? 1,
      toolCalls: 0,
      distinctTools: [],
      calls: [],
      callsDetailed: [],
      readPaths: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    this.records.push(rec);

    // 工具调用流水：形状图的原素材（用的是库的按名收窄监听，不是 onAny）
    const off = agent.on("tool_call", (e) => {
      rec.toolCalls += 1;
      rec.calls.push(e.toolName);
      if (!rec.distinctTools.includes(e.toolName)) rec.distinctTools.push(e.toolName);
      // 带参数的一层：用于检测「多个人读了同一份材料」这种重复劳动
      const arg = summarizeInput(e.toolName, (e as { input?: unknown }).input);
      rec.callsDetailed!.push({ tool: e.toolName, arg });
      if (e.toolName === "read" && arg && !rec.readPaths!.includes(arg)) rec.readPaths!.push(arg);
    });
    this.unsubs.push(off);
  }

  /**
   * 收尾：把每个 agent 的**全生命周期累计**用量收下来。
   *
   * ⚠️ 必须在 dispose 之前调 —— dispose 之后 reading 不到。
   * ⚠️ 用 agent.usage 而不是 RunResult.usage：一个 agent 可能被 prompt 多次（A 的子 agent 会），
   *    RunResult 只是其中一次；全生命周期累计才是这个 agent 的真实代价。
   */
  settle(): void {
    for (const rec of this.records) {
      const a = this.agents.get(rec.id);
      if (a) rec.usage = cloneUsage(a.usage);
    }
  }

  /** id → agent（settle 时用） */
  private readonly agents = new Map<string, Agent>();

  /** 活着的 agent（跑完要真的 dispose，否则进程悬住） */
  liveAgents(): Agent[] {
    return [...this.agents.values()];
  }

  watchAndKeep(agent: Agent, meta: { role: string; parent?: string | null; depth?: number }): void {
    this.watch(agent, meta);
    this.agents.set(agent.id, agent);
  }

  /** 全部退订（跑完必须调，不然监听器挂着） */
  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }
}

function cloneUsage(u: Usage): Usage {
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    totalTokens: u.totalTokens,
    cost: { ...u.cost },
  };
}

/** 把 Meter 收成一行的汇总部分 */
export function summarize(meter: Meter, extra: { budgetHit?: boolean } = {}) {
  const as = meter.records;
  const sum = (f: (r: AgentRecord) => number) => as.reduce((n, r) => n + f(r), 0);
  return {
    agentCount: as.length,
    toolCalls: sum((r) => r.toolCalls),
    inTokens: sum((r) => r.usage.input),
    outTokens: sum((r) => r.usage.output),
    totalTokens: sum((r) => r.usage.totalTokens),
    costUsd: sum((r) => r.usage.cost.total),
    maxDepth: as.reduce((n, r) => Math.max(n, r.depth), 0),
    delegations: as.filter((r) => r.parent !== null).length,
    budgetHit: extra.budgetHit ?? meter.budgetHit,
  };
}
