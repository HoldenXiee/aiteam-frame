// 第 22 部分（拓扑的活体审计）共享脚手架。
// 纪律：本文件只 import src/ 与 node 内置模块 —— 绝不 import audit/_faux.ts
// （它会在 import 时设置 AITEAM_AGENT_DIR，把真模型指向假 provider）。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, "data");
mkdirSync(DATA_DIR, { recursive: true });

/** 用户指定的唯一真模型 */
export const FLASH = "opencode-go/deepseek-v4.1-flash";

// ─────────────── 真模型用的干净 cwd ───────────────
export function workDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `aiteam22-${tag}-`));
}

// ─────────────── 从 session.messages 取 ground truth ───────────────
// 这是最可信的一侧：模型**实际发出**的工具调用与**实际收到**的工具结果。
export interface ToolCallRec {
  name: string;
  args: Record<string, unknown>;
}
export interface ToolResultRec {
  name: string;
  text: string;
  isError: boolean;
}

export function messagesLen(agent: { session: { messages: unknown[] } }): number {
  return agent.session.messages.length;
}

export function toolCallsIn(session: { messages: any[] }, from = 0): ToolCallRec[] {
  const out: ToolCallRec[] = [];
  for (const m of session.messages.slice(from)) {
    if (m?.role !== "assistant") continue;
    for (const c of m.content ?? []) {
      if (c?.type === "toolCall") out.push({ name: c.name, args: (c.arguments ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

export function toolResultsIn(session: { messages: any[] }, from = 0): ToolResultRec[] {
  const out: ToolResultRec[] = [];
  for (const m of session.messages.slice(from)) {
    if (m?.role !== "toolResult") continue;
    out.push({
      name: m.toolName,
      text: (m.content ?? []).map((c: any) => c?.text ?? "").join(""),
      isError: !!m.isError,
    });
  }
  return out;
}

/** 跑一轮，返回这一轮新发生的工具调用/结果 + 用量 */
export interface Turn {
  ms: number;
  text: string;
  error?: string;
  calls: ToolCallRec[];
  results: ToolResultRec[];
  tokens: number;
  cost: number;
}
export async function turn(agent: any, text: string): Promise<Turn> {
  const from = messagesLen(agent);
  const t0 = Date.now();
  let r: any;
  try {
    r = await agent.prompt(text);
  } catch (err) {
    return {
      ms: Date.now() - t0,
      text: "",
      error: `THROW: ${(err as Error).message}`,
      calls: toolCallsIn(agent.session, from),
      results: toolResultsIn(agent.session, from),
      tokens: 0,
      cost: 0,
    };
  }
  return {
    ms: Date.now() - t0,
    text: r.text ?? "",
    error: r.error,
    calls: toolCallsIn(agent.session, from),
    results: toolResultsIn(agent.session, from),
    tokens: r.usage?.totalTokens ?? 0,
    cost: r.usage?.cost?.total ?? 0,
  };
}

// ─────────────── 假 agentDir（让真模型名指向本地假服务，用于计数 429/请求时序，零成本） ───────────────
export function fakeAgentDir(tag: string, baseUrl: string, apiKey = "sk-pool-test"): string {
  const dir = mkdtempSync(join(tmpdir(), `aiteam22-${tag}-agent-`));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "opencode-go": {
          name: "Fake opencode-go",
          baseUrl,
          api: "openai-completions",
          apiKey,
          models: [
            {
              id: "deepseek-v4.1-flash",
              name: "DeepSeek V4.1 Flash (fake)",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        },
      },
    }),
    "utf-8",
  );
  return dir;
}

// ─────────────── 并发闸门（纪律：真模型并发 ≤2） ───────────────
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─────────────── Wilson 95% 置信区间（小样本比例的分区间） ───────────────
export function wilson(success: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const z = 1.96;
  const p = success / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - half) / d), hi: Math.min(1, (centre + half) / d) };
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const ci = (s: number, n: number) => `95%CI [${pct(wilson(s, n).lo)}–${pct(wilson(s, n).hi)}]`;

// ─────────────── 结果收集与落盘 ───────────────
export interface Finding {
  id: string;
  question: string;
  method: string;
  observed: string;
  data?: unknown;
  verdict: "OK" | "GAP" | "PARTIAL" | "INFO";
  conclusion: string;
}

/** 真模型花费总账：$ 与 token，按脚本累加 */
export interface SpendBook {
  byScript: Record<string, { usd: number; tokens: number; calls: number }>;
}

export function makeSink(name: string) {
  const findings: Finding[] = [];
  let section = "";
  const ledgers: Record<string, unknown> = {};
  const save = () => {
    writeFileSync(join(DATA_DIR, `${name}.json`), JSON.stringify({ name, findings, ledgers }, null, 2), "utf-8");
  };
  return {
    section(title: string) {
      section = title;
      console.log(`\n\x1b[1m═══ ${title} ═══\x1b[0m`);
    },
    /** 落一条结论 */
    add(f: Omit<Finding, "id"> & { id?: string }, opts: { silent?: boolean } = {}) {
      const finding: Finding = { id: f.id ?? "-", ...f } as Finding;
      findings.push(finding);
      if (!opts.silent) {
        const badge = {
          OK: "\x1b[32m✓ OK \x1b[0m",
          GAP: "\x1b[31m✗ GAP\x1b[0m",
          PARTIAL: "\x1b[33m~PART\x1b[0m",
          INFO: "\x1b[36m·INFO\x1b[0m",
        }[finding.verdict];
        console.log(`${badge} [${finding.id}] ${finding.question}`);
        console.log(`     ${finding.observed}`);
        console.log(`     → ${finding.conclusion}`);
      }
      save();
      return finding;
    },
    /** 原始账目（每轮输出都落盘，脚本崩了也不丢） */
    ledger(key: string, value: unknown) {
      ledgers[key] = value;
      save();
      return value;
    },
    findings,
    save,
    path: join(DATA_DIR, `${name}.json`),
    sectionName: () => section,
  };
}

export type Sink = ReturnType<typeof makeSink>;
