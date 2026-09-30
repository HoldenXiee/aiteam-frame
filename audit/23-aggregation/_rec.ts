// 第 23 部分共用：数据落盘 + 并发池 + 真模型单次调用封装。
// 真模型脚本禁止 import test/helpers.ts（它会改 AITEAM_AGENT_DIR）。本文件不碰环境变量。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "../../src/index.ts";
import type { AgentTool } from "../../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_PATH = join(HERE, "data.json");

export interface Spending {
  /** 累计真实花费（美元） */
  cost: number;
  /** 累计 token */
  tokens: number;
  /** 真实 API 调用次数 */
  calls: number;
}

/** 读-改-写 data.json：每个脚本把自己的那一节塞进去 */
export function saveSection(name: string, payload: unknown, spend?: Spending): void {
  const cur: { sections: Record<string, unknown>; spend: Record<string, unknown>; updatedAt?: string } = existsSync(DATA_PATH)
    ? JSON.parse(readFileSync(DATA_PATH, "utf-8"))
    : { sections: {}, spend: {} };
  cur.sections[name] = payload;
  if (spend) cur.spend[name] = { cost: Number(spend.cost.toFixed(6)), tokens: spend.tokens, calls: spend.calls };
  cur.updatedAt = new Date().toISOString();
  writeFileSync(DATA_PATH, JSON.stringify(cur, null, 2), "utf-8");
  console.log(`\n→ ${DATA_PATH} 新增 sections.${name}${spend ? `（花费 $${spend.cost.toFixed(5)} / ${spend.tokens} tok / ${spend.calls} 次调用）` : ""}`);
}

/** 并发池：最多 limit 个任务同时进行，保序返回 */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const FLASH = "opencode-go/deepseek-v4.1-flash";

export interface RunOpts {
  thinking?: string;
  /** 只给这些工具（customTools 会被并入非空白名单） */
  tools?: string[];
  customTools?: AgentTool[];
}

export interface RunOut {
  text: string;
  ms: number;
  error?: string;
  thinkingEffective: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
}

/** 一次真模型调用：新建 agent → prompt → 收集文本/用量/耗时。异常也返回（不打断整批） */
export async function runOnce(task: string, opts: RunOpts = {}): Promise<RunOut> {
  const t0 = Date.now();
  try {
    const a = await createAgent({
      model: FLASH,
      ...(opts.thinking ? { thinking: opts.thinking as never } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.customTools ? { customTools: opts.customTools } : {}),
    });
    const eff = a.session.thinkingLevel;
    const r = await a.prompt(task);
    const u = r.usage;
    a.dispose();
    return {
      text: r.text,
      ms: Date.now() - t0,
      ...(r.error ? { error: r.error } : {}),
      thinkingEffective: eff,
      usage: {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        totalTokens: u.totalTokens,
        cost: u.cost.total,
      },
    };
  } catch (e) {
    return {
      text: "",
      ms: Date.now() - t0,
      error: `抛出：${(e as Error).message}`,
      thinkingEffective: opts.thinking ?? "(默认)",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    };
  }
}

export function accumulate(spend: Spending, runs: RunOut[]): Spending {
  for (const r of runs) {
    spend.cost += r.usage.cost;
    spend.tokens += r.usage.totalTokens;
    spend.calls += 1;
  }
  return spend;
}

export const section = (t: string) => console.log(`\n═══ ${t} ═══`);
export const pct = (a: number, b: number) => `${a}/${b}`;
