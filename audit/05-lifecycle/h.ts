// 第 5 部分共用小工具。只读 src/ 与 audit/ 既有基建，不修改任何东西。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent, type AgentHost, type ControlledAgent } from "../../src/index.ts";
import { record as rawRecord, section, num, type Finding } from "../_harness.ts";
import { makeEnv, type Env } from "../_faux.ts";

export { section, num };
export type { Env, Finding };

const HERE = dirname(fileURLToPath(import.meta.url));
let collected: Finding[] = [];

/** 与 _harness.record 同签名，额外把发现攒下来，供 dumpTo 落到本目录 */
export function record(f: Omit<Finding, "id"> & { id?: string }): void {
  rawRecord(f);
  collected.push({ id: f.id ?? "-", ...f } as Finding);
}

/** 把本脚本的原始发现写到 audit/05-lifecycle/raw/<name>.json */
export function dumpTo(name: string, extra: Record<string, unknown> = {}): string {
  const dir = join(HERE, "raw");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ script: name, ...extra, findings: collected }, null, 2), "utf-8");
  return path;
}

export const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
export const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");
export const heapMB = () => num(process.memoryUsage().heapUsed / 1048576, 3);

const rawResources = () =>
  (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ?? [];
const rawHandles = () =>
  ((process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? []).map(
    (h) => (h as { constructor?: { name?: string } })?.constructor?.name ?? "?",
  );
export const resources = (): string[] => {
  const r = rawResources();
  return r.length ? r : rawHandles();
};
export const resourceKinds = (): Record<string, number> =>
  resources().reduce<Record<string, number>>((a, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {});

export const gc = (): boolean => {
  const fn = (globalThis as unknown as { gc?: () => void }).gc;
  fn?.();
  return typeof fn === "function";
};

/** 最小二乘斜率（单位/次迭代） */
export function slope(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return Number.NaN;
  const mx = (n - 1) / 2;
  const my = xs.reduce((a, b) => a + b, 0) / n;
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    a += (i - mx) * (xs[i] - my);
    b += (i - mx) ** 2;
  }
  return b ? num(a / b, 6) : Number.NaN;
}
export const median = (xs: number[]) => num([...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0, 2);
export const mean = (xs: number[]) => num(xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1), 3);

export function alive<T>(fn: () => T): T | string {
  try {
    return fn();
  } catch (e) {
    return `THROW: ${(e as Error).message}`;
  }
}

export async function settle<T>(p: Promise<T>, timeoutMs = 3000): Promise<{ state: string; value?: T; error?: string }> {
  return Promise.race([
    p.then(
      (value) => ({ state: "resolved", value }),
      (e) => ({ state: "rejected", error: (e as Error).message }),
    ),
    sleep(timeoutMs).then(() => ({ state: "TIMEOUT" })),
  ]);
}

// ── 建环境与分身 ──────────────────────────────────────────────
export interface Ctx {
  env: Env;
  defaults: { model: string; agentDir: string; cwd: string };
  host(extra?: Record<string, unknown>): AgentHost;
  mk(extra?: Record<string, unknown>): Promise<ControlledAgent>;
  mkTop(host: AgentHost, extra?: Record<string, unknown>): Promise<ControlledAgent>;
  mkChild(host: AgentHost, parent: ControlledAgent, member?: string): Promise<ControlledAgent>;
  close(): Promise<void>;
}

export async function setup(models: string | Array<{ id: string; contextWindow?: number }> = "echo"): Promise<Ctx> {
  const env = await makeEnv(models as never);
  const defaults = { model: env.model, agentDir: env.agentDir, cwd: env.cwd };
  const { createAgentHost } = await import("../../src/index.ts");
  const host = (extra: Record<string, unknown> = {}) =>
    createAgentHost({
      defaults,
      members: { w: { description: "工人" }, boss: { description: "组长", tools: ["spawn_agent", "send_message"] } },
      maxAgents: 100000,
      maxDepth: 2,
      modelRuntime: env.runtime,
      ...extra,
    });
  return {
    env,
    defaults,
    host,
    mk: (extra = {}) => createAgent({ ...defaults, ...extra }, { modelRuntime: env.runtime }),
    mkTop: (h, extra = {}) =>
      createAgent({ ...defaults, tools: ["spawn_agent", "send_message"], ...extra }, { host: h, modelRuntime: env.runtime }),
    mkChild: (h, parent, member = "w") => createAgent({ ...defaults }, { host: h, parent, member, modelRuntime: env.runtime }),
    close: () => env.close(),
  };
}

/** spawn_agent 工具的真实调用入口（与库内签名一致） */
export async function callSpawn(
  agent: ControlledAgent,
  host: AgentHost,
  member: string,
  task: string,
): Promise<{ text: string; agentId?: string; listLen: number }> {
  const { createSpawnAgentTool } = await import("../../src/tools/spawn-agent.ts");
  const tool = createSpawnAgentTool({ agent, host });
  const out = (await tool.execute("c", { member, task } as never, undefined, undefined, undefined as never)) as {
    content: Array<{ text?: string }>;
    details?: { agentId?: string };
  };
  const text = textOf(out);
  return { text, agentId: out.details?.agentId ?? /它的分身 id 是 ([A-Za-z0-9_-]+)/.exec(text)?.[1], listLen: host.list().length };
}

export async function callSend(
  agent: ControlledAgent,
  host: AgentHost,
  agentId: string,
  message: string,
): Promise<string> {
  const { createSendMessageTool } = await import("../../src/tools/send-message.ts");
  const tool = createSendMessageTool({ agent, host });
  const out = (await tool.execute("c", { agentId, message } as never, undefined, undefined, undefined as never)) as {
    content: Array<{ text?: string }>;
  };
  return textOf(out);
}

// ── 拓扑导出（设计者侧唯一手段：list() + parentId） ──────────────
export interface TopoRow {
  id: string;
  member?: string;
  parentId?: string;
  /** 导出时父节点是否解析得到（host.get(parentId)） */
  exportedParent: string | undefined;
  isRoot: boolean;
  exportedDepth: number;
  trueDepth: number;
  status: string;
}

/** trueRegistry：所有创建过的分身（含已回收）—— 设计者手边不会有这个，审计用来算「真实深度」 */
export function exportTopology(host: AgentHost, trueRegistry: Map<string, ControlledAgent>): TopoRow[] {
  const walk = (a: ControlledAgent, resolve: (id: string) => ControlledAgent | undefined) => {
    let d = 0;
    let cur = a;
    const seen = new Set<string>();
    while (cur.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      const p = resolve(cur.parentId);
      if (!p) {
        // 02-topology 的写法：解析不到就停，且不再计数（导出侧最常见的实现）
        break;
      }
      d += 1;
      cur = p;
    }
    return d;
  };
  return host.list().map((a) => ({
    id: a.id,
    member: a.member,
    parentId: a.parentId,
    exportedParent: a.parentId ? host.get(a.parentId)?.id : undefined,
    isRoot: !a.parentId || !host.get(a.parentId),
    exportedDepth: walk(a, (id) => host.get(id)),
    trueDepth: walk(a, (id) => trueRegistry.get(id)),
    status: a.status,
  }));
}

/** 02-topology.ts 里那个 descendantCount 的同款实现（设计者会这么写） */
export function descendantCount(host: AgentHost, a: ControlledAgent): number {
  return host.list().filter((x) => {
    let cur: ControlledAgent | undefined = x;
    const seen = new Set<string>();
    while (cur?.parentId && !seen.has(cur.parentId)) {
      if (cur.parentId === a.id) return true;
      seen.add(cur.parentId);
      cur = host.get(cur.parentId);
      if (!cur) return false;
    }
    return false;
  }).length;
}

export function topoSummary(rows: TopoRow[]) {
  return {
    nodes: rows.length,
    roots: rows.filter((r) => r.isRoot).length,
    rootsWithParentId: rows.filter((r) => r.isRoot && r.parentId).length,
    maxExportedDepth: Math.max(0, ...rows.map((r) => r.exportedDepth)),
    maxTrueDepth: Math.max(0, ...rows.map((r) => r.trueDepth)),
    depthMismatch: rows.filter((r) => r.exportedDepth !== r.trueDepth).map((r) => `${r.id}:${r.exportedDepth}vs${r.trueDepth}`),
  };
}
