// 观测面（DESIGN「功能二：为分析研究提供材料」）—— ★ 与功能一「绝对操控」并列的那一半
//
// ★ 为什么加这个（见 `research/demox/重读DESIGN-新触发.md`）
//   DESIGN 把「功能二」写成与「功能一」并列的一半。而实际研究中，
//   我的量具只抓了 `tool_call` 一个字段（`measure.ts:160`），`onAny` 用了 **0 次**。
//
//   后果 —— 十几轮实验反复缺的，恰恰是这块：
//     · A1（override）：模型实际收到的消息里原文还在不在？→ **靠猜**（判据写错、生效 0 次都不知道）
//     · P11（账本）  ：它有没有真的看见那条账本？        → **靠猜**（挂错位置，26→26 才发现）
//     · O3（316 倍）  ：每一轮花了多少？                  → **拿不到**（只有全生命周期累计）
//     · N5（慢==胖）  ：每轮 token 分布                  → **拿不到**
//
// ★★ 核心判据：「模型实际收到了什么」是本学科**最基础的材料** ——
//    没有它就无法区分「它没听劝」和「它根本没收到」。**P11 与 A1 两次都栽在这个区分上。**
//
// ★ 本面的两条支柱
//   1. `wire()`  —— **每一轮真正发给模型的 messages**（用 `context_with_system` 事件）
//   2. `inflight` —— **干预生效性**：override / gate / onResult 各自被调用几次、最后一次的实参
import type { AgentMessage } from "../agent/types.ts";

/** 一轮 provider 请求的 wire 快照 */
export interface WireTurn {
  /** 第几次请求（本 agent 生命周期内，从 1 起） */
  n: number;
  /** 消息条数 */
  count: number;
  /** 各角色的条数 */
  roles: Record<string, number>;
  /** 全部消息的纯文本长度（不是 token，只是体量指标） */
  chars: number;
  /** 含 system 的消息条数（`context_with_system` 才看得到） */
  systemCount: number;
  /** 各消息的摘要（role + 前 N 字），可就地查阅 */
  preview: { role: string; len: number; head: string }[];
  /** 采集时刻（毫秒时间戳） */
  at: number;
}

/**
 * ★ 每轮的 token 用量（`message_end` 里 assistant 消息的 usage）。
 * 存在的理由：**O3 成本盲区的直接材料** ——
 * 实测「质量分 1.00 的 177 个 run，token 差 316 倍」，而当时只能拿到**全生命周期累计**，
 * 看不到「这场钱花在第几轮」。
 */
export interface TurnUsage {
  /** 第几轮（同一 agent 内自增） */
  n: number;
  /** 输入 token（本轮发给模型的） */
  input: number;
  /** 输出 token */
  output: number;
  /** 读缓存命中 */
  cacheRead: number;
  /** 写缓存 */
  cacheWrite: number;
  /** 推理 token */
  reasoning: number;
  /** 总 token */
  total: number;
  at: number;
}

/** 一个「干预点」的生效情况 —— ★ 治静默失败 */
export interface InjectionStat {
  /** 被调用次数 */
  calls: number;
  /** 返回了非 undefined 的次数（= 真的改了东西） */
  changed: number;
  /** 最后一次的实参摘要 */
  lastArgs: string;
  /** 最后一次的返回值摘要 */
  lastReturn: string;
}

export interface ObserveSurface {
  /** ★ 每一轮真正发给模型的 messages（`context_with_system`）。跑完即可读 */
  readonly wire: readonly WireTurn[];
  /** 最近一轮的 wire 快照 */
  readonly lastWire: WireTurn | undefined;
  /** ★ 每轮的 token 用量（不是全生命周期累计）—— O3 成本盲区的材料 */
  readonly turns: readonly TurnUsage[];
  /** 所有轮次的总 token（与 `agent.usage` 应当一致，但这里是**按轮可拆**的） */
  readonly totalTokens: number;
  /** ★ 干预生效性：每个注入点的调用计数与最后一次实参 */
  readonly injections: Readonly<Record<string, InjectionStat>>;
  /**
   * 记录一次干预调用。**库内部各面自己调**（override / gate / onResult），
   * 使用者不必手动调；这条公开是为了让使用者自定义的干预也能被统计。
   */
  noteInjection(name: string, args: unknown, returned: unknown): void;
  /** 清空已采集的 wire（配合 `context.reset()` 之类做分段分析） */
  clear(): void;
  readonly raw: Record<string, never>;
}

export interface ObserveDeps {
  /** 订阅 pi 事件（返回退订） */
  subscribe(name: string, fn: (event: unknown) => void): () => void;
  assertAlive(): void;
}

/** 一条消息的纯文本（content 可能是字符串 / 块数组；bashExecution 这类没有 content） */
function textOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return (content as { type?: string; text?: string }[])
      .map((b) => (b.type === "text" ? (b.text ?? "") : `[${b.type ?? "?"}]`))
      .join("");
  return "";
}

function head(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function createObserve(deps: ObserveDeps): ObserveSurface {
  const wire: WireTurn[] = [];
  const turns: TurnUsage[] = [];
  const injections: Record<string, InjectionStat> = {};
  let n = 0;
  let turnN = 0;

  // ★ 每轮 token（O3 的直接材料）。`message_end` 的 assistant 消息带 usage。
  deps.subscribe("message_end", (event) => {
    const msg = (event as { message?: { role?: string; usage?: Record<string, unknown> } }).message;
    if (!msg || msg.role !== "assistant") return;
    const u = msg.usage ?? {};
    const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
    turnN += 1;
    turns.push({
      n: turnN,
      input: num("input"),
      output: num("output"),
      cacheRead: num("cacheRead"),
      cacheWrite: num("cacheWrite"),
      reasoning: num("reasoning"),
      total: num("totalTokens") || num("input") + num("output"),
      at: Date.now(),
    });
  });

  deps.subscribe("context_with_system", (event) => {
    const messages = ((event as { messages?: unknown[] }).messages ?? []) as unknown[];
    n += 1;
    const roles: Record<string, number> = {};
    let chars = 0;
    let systemCount = 0;
    const preview = messages.map((m) => {
      const role = String((m as { role?: string }).role ?? "?");
      roles[role] = (roles[role] ?? 0) + 1;
      if (role === "system") systemCount += 1;
      const t = textOf(m);
      chars += t.length;
      return { role, len: t.length, head: head(t) };
    });
    wire.push({ n, count: messages.length, roles, chars, systemCount, preview, at: Date.now() });
  });

  return {
    get wire() {
      return wire;
    },
    get lastWire() {
      return wire[wire.length - 1];
    },
    get turns() {
      return turns;
    },
    get totalTokens() {
      return turns.reduce((s, t) => s + t.total, 0);
    },
    get injections() {
      return injections;
    },
    noteInjection(name, args, returned) {
      const stat = (injections[name] ??= { calls: 0, changed: 0, lastArgs: "", lastReturn: "" });
      stat.calls += 1;
      if (returned !== undefined && returned !== null && returned !== false) stat.changed += 1;
      try {
        stat.lastArgs = head(JSON.stringify(args) ?? String(args), 120);
      } catch {
        stat.lastArgs = String(args);
      }
      try {
        stat.lastReturn = head(JSON.stringify(returned) ?? String(returned), 120);
      } catch {
        stat.lastReturn = String(returned);
      }
    },
    clear() {
      deps.assertAlive();
      wire.length = 0;
      turns.length = 0;
      n = 0;
      turnN = 0;
    },
    get raw() {
      deps.assertAlive();
      return {} as Record<string, never>;
    },
  };
}
