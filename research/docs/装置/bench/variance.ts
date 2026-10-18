// G0-3 · 方差基线：同一份系统代码跑 N 次，产出差异有多大？
//
// 跑法：node demox/bench/variance.ts <experiment.jsonl> [...]
//
// 为什么先做这个（docs/research 家族 1 第 1 条，标记 ● 完全空白）：
//   **这是整个范式的成立前提。** 如果同一份集群代码每次跑出来的东西都不一样，
//   那「用代码规范逻辑」就名不副实 —— 你规范的只是"参与者的集合"，不是"系统的行为"。
//   领域里没人在测方差，大家都在谈拓扑。
//
// 本文件回答四个问题：
//   ① 结局稳吗？（同一配置跑 N 次，通过率是多少）
//   ② 产物稳吗？（输出文本的差异度）
//   ③ 结构稳吗？（agent 数 / 工具调用数 / 委派图 的差异）
//   ④ 代价稳吗？（token 的极差）
//
// ★ 口径：基础设施失败（429/连接错误）**单独算一类**，不算能力失败 ★
// 这是 demom 用 6 次判据翻修换来的教训：先把测量假象摘出去，再看模型的方差。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

interface Verdictish {
  ok: boolean;
  infraFailed?: boolean;
  items?: Record<string, boolean>;
  readings?: Record<string, number>;
  failed?: string[];
}

interface Row {
  experiment: string;
  params: Record<string, number | string>;
  rep: number;
  secs: number;
  crashed?: string;
  totalTokens: number;
  toolCalls: number;
  reportText: string | null;
  structured: unknown;
  verdict: Verdictish;
  shape: { agentCount: number; maxDepth: number; delegations: number; perAgentCalls: { role: string; calls: number }[] };
  agents: { role: string; toolCalls: number; readPaths?: string[]; callsDetailed: { tool: string; arg: string }[] }[];
}

function load(path: string): Row[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);
}

// ── 统计小工具 ──
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
/** 变异系数：标准差 / 均值。量纲无关，用来横向比"哪个量最不稳" */
const cv = (xs: number[]) => (mean(xs) ? sd(xs) / mean(xs) : NaN);

/** Jaccard 相似度（集合） */
function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 1;
}

/** 把产物规范化成一个可比较的字符串（去空白、排序键） */
function canon(row: Row): string | null {
  if (row.structured && typeof row.structured === "object") {
    const o = row.structured as { duplicates?: string[][] };
    if (Array.isArray(o.duplicates)) {
      const gs = o.duplicates.map((g) => g.map((x) => String(x).toUpperCase()).sort().join("+")).sort();
      return JSON.stringify(gs);
    }
  }
  if (row.reportText) return row.reportText.replace(/\s+/g, " ").trim();
  return null;
}

function analyze(name: string, rows: Row[]) {
  const usable = rows.filter((r) => !r.verdict.infraFailed);
  const infra = rows.filter((r) => r.verdict.infraFailed);
  const ok = usable.filter((r) => r.verdict.ok);

  console.log(`\n${"═".repeat(100)}`);
  console.log(`${name}   n=${rows.length}（可用 ${usable.length} · 基础设施失败 ${infra.length}）`);
  console.log("═".repeat(100));

  if (infra.length) {
    console.log(`  ⚡ 基础设施失败 ${infra.length} 轮（**不算能力失败**，已从下面的口径里剔除）：`);
    for (const r of infra) console.log(`     rep=${r.rep}  ${String(r.crashed ?? "?").slice(0, 70)}`);
  }

  if (!usable.length) {
    console.log("  （没有可用轮次）");
    return;
  }

  // ① 结局稳定性
  console.log(`\n  ① 结局：${ok.length}/${usable.length} 通过  （通过率 ${(100 * ok.length / usable.length).toFixed(0)}%）`);
  const itemNames = [...new Set(usable.flatMap((r) => Object.keys(r.verdict.items ?? {})))];
  if (itemNames.length) {
    console.log(`     逐项（分母 = 可用轮次）：`);
    for (const it of itemNames) {
      const hit = usable.filter((r) => r.verdict.items?.[it]).length;
      console.log(`       ${it.padEnd(18)} ${hit}/${usable.length}`);
    }
  }

  // ② 产物稳定性
  const canons = usable.map(canon);
  const nonNull = canons.filter(Boolean) as string[];
  const uniqOutputs = new Set(nonNull);
  console.log(`\n  ② 产物：${nonNull.length}/${usable.length} 轮有产物；其中**互不相同的有 ${uniqOutputs.size} 种**`);
  if (nonNull.length >= 2) {
    // 两两 Jaccard（按字符 3-gram 集合，对措辞差异敏感）
    const shingles = nonNull.map((t) => {
      const s = new Set<string>();
      for (let i = 0; i + 3 <= t.length; i++) s.add(t.slice(i, i + 3));
      return s;
    });
    let sum = 0, cnt = 0;
    for (let i = 0; i < shingles.length; i++)
      for (let j = i + 1; j < shingles.length; j++) {
        sum += jaccard(shingles[i], shingles[j]);
        cnt++;
      }
    console.log(`     两两相似度（字符 3-gram Jaccard）均值 = ${(sum / cnt).toFixed(3)}   1.0 = 完全相同`);
  }

  // ③ 结构稳定性
  console.log(`\n  ③ 结构：`);
  const shapeRows: [string, number[]][] = [
    ["agent 数", usable.map((r) => r.shape.agentCount)],
    ["最大深度", usable.map((r) => r.shape.maxDepth)],
    ["委派边数", usable.map((r) => r.shape.delegations)],
    ["工具调用总数", usable.map((r) => r.toolCalls)],
    ["读材料份数（单 agent 视角）", usable.map((r) => r.agents[0]?.readPaths?.length ?? NaN).filter((x) => !Number.isNaN(x))],
    ["产物字符数", usable.map((r) => (r.reportText ?? "").length)],
  ];
  console.log(`     ${"量".padEnd(26)}${"均值".padEnd(10)}${"标准差".padEnd(10)}${"变异系数 CV".padEnd(12)}取值`);
  for (const [label, xs] of shapeRows) {
    if (!xs.length) continue;
    console.log(
      `     ${label.padEnd(24)}${mean(xs).toFixed(1).padEnd(10)}${(Number.isNaN(sd(xs)) ? "—" : sd(xs).toFixed(1)).padEnd(10)}` +
        `${(Number.isNaN(cv(xs)) ? "—" : cv(xs).toFixed(3)).padEnd(12)}[${[...new Set(xs)].sort((a, b) => a - b).join(", ")}]`,
    );
  }

  // ④ 代价稳定性
  console.log(`\n  ④ 代价：`);
  const toks = usable.map((r) => r.totalTokens);
  const secs = usable.map((r) => r.secs);
  const sortedT = toks.slice().sort((a, b) => a - b);
  console.log(`     token     均值 ${Math.round(mean(toks)).toLocaleString("en-US")}  CV ${cv(toks).toFixed(3)}  极差 ${(sortedT[sortedT.length - 1] / sortedT[0]).toFixed(2)}×  [${sortedT[0].toLocaleString("en-US")} … ${sortedT[sortedT.length - 1].toLocaleString("en-US")}]`);
  console.log(`     墙钟秒数  均值 ${mean(secs).toFixed(0)}s  CV ${cv(secs).toFixed(3)}`);
  console.log(`     成本      $${usable.reduce((s, r) => s + (r as unknown as { costUsd: number }).costUsd, 0).toFixed(6)}（免费档应为 0）`);

  // ⑤ 成不成，跟什么连在一起（同一次扫描内的粗关联）
  console.log(`\n  ⑤ 成功轮 vs 失败轮（同配置内对照）：`);
  const fail = usable.filter((r) => !r.verdict.ok);
  if (!fail.length) console.log("     （没有失败轮 —— 这个配置太简单，没有区分度）");
  else if (!ok.length) console.log("     （没有成功轮）");
  else {
    const cmp: [string, (r: Row) => number][] = [
      ["工具调用数", (r) => r.toolCalls],
      ["读材料份数", (r) => r.agents[0]?.readPaths?.length ?? 0],
      ["token", (r) => r.totalTokens],
      ["秒数", (r) => r.secs],
      ["产物字符数", (r) => (r.reportText ?? "").length],
    ];
    for (const [label, f] of cmp) {
      const a = ok.map(f), b = fail.map(f);
      console.log(`     ${label.padEnd(16)} 成功 ${mean(a).toFixed(1).padStart(9)}   失败 ${mean(b).toFixed(1).padStart(9)}`);
    }
  }
}

// ── CLI ──
const files = process.argv.slice(2);
if (!files.length) {
  console.log("用法：node demox/bench/variance.ts <experiment.jsonl> [...]");
  console.log("      文件路径相对 demox/runs/，例如：G0-3-flat.jsonl");
  process.exit(0);
}
for (const f of files) {
  const path = f.includes("/") || f.includes("\\") ? f : join(here, "..", "runs", f);
  const rows = load(path);
  analyze(f.split(/[\\/]/).pop()!, rows);
}
console.log();
