// demox 测量层：把一次运行摊成事实（不是分数）。
//
// 设计来自 G0-1 的实际数据需求，不是照抄 demom：
//   ① demom 的字段够用，但有几个**缺了就变假数据**的坑，这里在类型上堵住；
//   ② demox 要测的是**系统层面的量**（结构、注入、反馈），所以新增了三类字段。
//
// ★ 一条铁律（G0-1 抓到的真 bug）★
// `a.readPaths?.length ?? 0` 会把「这个字段还没被量」变成「真的读了 0 份」——
// 一个**假的 0**，它把视野类特征的 AUC 从 1.00 拉平到 0.50。
// 所以本文件的约定是：**没量到 → undefined，量到空 → 0。**
// 类型上用 `number | undefined`（不是可选属性）来强制每个读取点都处理这种情况。
//
// 跑法：跑实验的 runner import 本文件的 `Meter`，每次 createAgent 之后调 `meter.watch()`。

import type { Agent, Usage } from "../../../src/index.ts";
import { appendFileSync, mkdirSync } from "node:fs";

// ─────────────────────────────────────────────────────────────
// 1. 一行记录的形状
// ─────────────────────────────────────────────────────────────

/** 一次工具调用的摘要 */
export interface CallRecord {
  tool: string;
  /** 关键参数：read/write → 路径；spawn → 角色。没用的不存 */
  arg: string;
  /** 该调用发生在哪个阶段/角色（demox 的实验大多是阶段化的） */
  by: string;
}

export interface AgentRecord {
  id: string;
  /** 角色标签（A 是花名册角色，B 是阶段名，demox 实验各自命名） */
  role: string;
  parent: string | null;
  /** 委派图里的深度（根 = 1） */
  depth: number;
  toolCalls: number;
  distinctTools: string[];
  calls: string[];
  callsDetailed: CallRecord[];
  /** ★ 没量到是 undefined，不是 [] ★ —— 空数组表示「量了，一份没读」 */
  readPaths: string[] | undefined;
  /** ★ 全生命周期累计（不是单轮）★ */
  usage: Usage;
  error?: string;
}

/** 结构快照：这次运行长出来的形状（系统科学要的那一层） */
export interface ShapeRecord {
  agentCount: number;
  maxDepth: number;
  /** 委派边数 */
  delegations: number;
  /** 每个 agent 的（角色, token）—— 算集中度用 */
  perAgentTokens: { role: string; tokens: number }[];
  /** 每个 agent 的（角色, 工具调用数） */
  perAgentCalls: { role: string; calls: number }[];
  /** 委派图：谁派了谁 */
  edges: { from: string; to: string }[];
}

/** 注入记录：扰动实验（G2-1 衰减 / G3-3 级联）用 */
export interface InjectionRecord {
  /** 注入点（哪个阶段/角色） */
  at: string;
  /** 注入了什么（人话） */
  what: string;
  /** 被注入的假事实/假结论的标识（判据靠它追踪污染） */
  marker: string;
}

export interface RunRecord {
  /** 实验名（对应 demox/bench/scan.ts 的一次扫描） */
  experiment: string;
  /** 这一轮的参数值（扫描器的自变量） */
  params: Record<string, number | string>;
  /** 重复序号（同一参数跑的第几次）—— 方差分解靠它 */
  rep: number;
  startedAt: string;
  secs: number;
  /** 实验崩了（不是轮失败）。轮失败在 agents[].error */
  crashed?: string;

  agents: AgentRecord[];
  shape: ShapeRecord;

  // ── 汇总（口径：所有 agent 累加）──
  toolCalls: number;
  inTokens: number;
  outTokens: number;
  totalTokens: number;
  costUsd: number;

  // ── 护栏 / 反馈（G1 控制论那一组的数据源）──
  /** 触发过的护栏：[{stage, calls, cap, action}] */
  guarded: { stage: string; calls: number; cap: number; action: string }[];
  /** io.steer 记录：什么时候、因为什么、拉了几次 */
  steered: { stage: string; calls: number; reason: string; grace?: number }[];
  /** 审批门拦下的调用 */
  gates: string[];

  // ── 注入（扰动实验用）──
  injections?: InjectionRecord[];

  // ── 产物 ──
  /** 产物全文（存全文不只存哈希 —— 判据改了要能不重跑就重判） */
  reportText: string | null;
  /** 产物的**结构化**输出（如果任务要求 JSON）—— 保真度实验用 */
  structured: unknown;

  /** 这次运行的判据结果（纯函数产出，可重判） */
  verdict: unknown;
}

// ─────────────────────────────────────────────────────────────
// 2. Meter：挂到每个 agent 上
// ─────────────────────────────────────────────────────────────

export class Meter {
  readonly records: AgentRecord[] = [];
  readonly injections: InjectionRecord[] = [];
  readonly guarded: { stage: string; calls: number; cap: number; action: string }[] = [];
  readonly steered: { stage: string; calls: number; reason: string; grace?: number }[] = [];
  readonly gates: string[] = [];
  /** 委派图 */
  readonly edges: { from: string; to: string }[] = [];
  budgetHit = false;

  private readonly unsubs: (() => void)[] = [];
  /** 跑完就 dispose 的 agent，settle 时统一收用量 */
  private readonly live: Agent[] = [];

  /**
   * 挂一个 agent。**每次 createAgent 之后必须调**。
   *
   * `measured` 说明这一轮**量具是否可用** —— 见文件头那条铁律：
   * 若某个变体是在量具加进来之前跑的，readPaths 必须记 undefined 而不是 []。
   * 这里默认量具可用（demox 全是新跑的数据，不会有 demom 那个历史问题）。
   */
  watch(agent: Agent, meta: { role: string; parent?: string | null; depth?: number }, opts?: { measureReads?: boolean }): void {
    const measureReads = opts?.measureReads ?? true;
    const rec: AgentRecord = {
      id: agent.id,
      role: meta.role,
      parent: meta.parent ?? null,
      depth: meta.depth ?? 1,
      toolCalls: 0,
      distinctTools: [],
      calls: [],
      callsDetailed: [],
      // ★ 关键：量具关掉时记 undefined，**不是 []** ★
      readPaths: measureReads ? [] : undefined,
      usage: emptyUsage(),
    };
    this.records.push(rec);
    this.live.push(agent);
    if (meta.parent) this.edges.push({ from: meta.parent, to: agent.id });

    const off = agent.on("tool_call", (e) => {
      rec.toolCalls += 1;
      rec.calls.push(e.toolName);
      if (!rec.distinctTools.includes(e.toolName)) rec.distinctTools.push(e.toolName);
      const arg = summarizeInput(e.toolName, (e as { input?: unknown }).input);
      rec.callsDetailed.push({ tool: e.toolName, arg, by: rec.role });
      // 只有量具可用时才记 read —— 关掉时 readPaths 恒为 undefined
      if (measureReads && e.toolName === "read" && arg) {
        // ⚠ 路径要规范化：实测同一个文件会被写成 `corpus/M7.md` / `M7.md` / `corpus/M7`
        // 三种形式，不归一就会被当成**三份不同的材料** —— “读了几份”这个指标直接虚高。
        // （这是 G0-1 那个“假 0” bug 的亲戚：同一个量因表示形式不统一而算不准。）
        const key = normalizeReadPath(arg);
        if (key && !rec.readPaths!.includes(key)) rec.readPaths!.push(key);
      }
    });
    this.unsubs.push(off);
  }

  /** 记一次注入（扰动实验） */
  noteInjection(at: string, what: string, marker: string): void {
    this.injections.push({ at, what, marker });
  }

  /** 记一次护栏触发 */
  noteGuard(stage: string, calls: number, cap: number, action: string): void {
    this.guarded.push({ stage, calls, cap, action });
  }

  /** 记一次中途纠正 */
  noteSteer(stage: string, calls: number, reason: string, grace?: number): void {
    this.steered.push({ stage, calls, reason, grace });
  }

  /** 记一次审批门拦截 */
  noteGate(what: string): void {
    this.gates.push(what);
  }

  /**
   * 收尾：把用量从活着的 agent 上读下来。
   *
   * ⚠️ 必须在 dispose **之前**调 —— dispose 之后读不到。
   * ⚠️ 用 agent.usage（全生命周期）而不是 RunResult.usage：一个 agent 可能被 prompt 多次。
   */
  settle(): void {
    for (const a of this.live) {
      const rec = this.records.find((r) => r.id === a.id);
      if (rec) rec.usage = a.usage;
    }
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }

  /** 直接 dispose 全部（收尾用） */
  dispose(): void {
    for (const a of this.live) {
      try {
        a.dispose();
      } catch {
        /* 已 dispose 过就算了 */
      }
    }
    this.live.length = 0;
  }

  /** 结构快照 —— 系统科学要的那一层 */
  shape(): ShapeRecord {
    const tokens = this.records.map((r) => ({ role: r.role, tokens: r.usage.totalTokens }));
    const calls = this.records.map((r) => ({ role: r.role, calls: r.toolCalls }));
    return {
      agentCount: this.records.length,
      maxDepth: this.records.length ? Math.max(...this.records.map((r) => r.depth)) : 0,
      delegations: this.edges.length,
      perAgentTokens: tokens,
      perAgentCalls: calls,
      edges: this.edges.slice(),
    };
  }

  /** 汇总（口径：全部 agent 累加） */
  summarize(): { toolCalls: number; inTokens: number; outTokens: number; totalTokens: number; costUsd: number } {
    return {
      toolCalls: this.records.reduce((s, r) => s + r.toolCalls, 0),
      inTokens: this.records.reduce((s, r) => s + r.usage.input, 0),
      outTokens: this.records.reduce((s, r) => s + r.usage.output, 0),
      totalTokens: this.records.reduce((s, r) => s + r.usage.totalTokens, 0),
      costUsd: this.records.reduce((s, r) => s + r.usage.cost.total, 0),
    };
  }
}

// `emptyUsage` 库里有（src/agent/usage.ts）但**不在 src/index.ts 的导出面里**
// （入口只导出 createLab + 类型）。所以 demox 自己留一份，形状与库里的一字不差。
function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
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
      // 通用：取第一个字符串值（扰动/注入类自定义工具靠它留痕）
      for (const v of Object.values(o)) if (typeof v === "string") return v.slice(0, 60);
      return "";
  }
}

/**
 * 规范化 read 的路径，用于「读材料份数」这类计数。
 *
 * 实测同一个文件会被模型写成多种形式：
 *     D:/.../demox/work/corpus/M7.md
 *     corpus/M7.md
 *     M7.md
 *     corpus/M7          ← 没扩展名
 * 不归一的话，同一个文件会被计成 3–4 个不同的条目。
 *
 * 归一规则：取最后一段（basename），去掉扩展名，大写。
 * 局限：不同子目录下的同名文件会被合并 —— 对当前所有任务（单层 corpus/）不构成问题，
 * 换成多层目录的任务时要改成保留目录前缀。
 */
export function normalizeReadPath(p: string): string {
  if (!p || p === "?") return "";
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.replace(/\.(md|txt|json)$/i, "").toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// 3. 落盘 / 读取：JSONL，一次运行一行
// ─────────────────────────────────────────────────────────────

export function appendRun(dir: string, rec: RunRecord, file: string): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(`${dir}/${file}`, JSON.stringify(rec) + "\n");
}
