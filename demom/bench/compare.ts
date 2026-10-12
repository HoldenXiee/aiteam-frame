// 对照表：读两边的 JSONL，出主设计 §5 要的那张表。
//
// ★ 只读 JSONL，**不重跑** ★（主设计 §5）：判据改了可以拿旧数据重判，不用再花钱。
// 所以 JSONL 里存的是**原始事实**（每个 agent 的用量、工具流水、逐项判据结果），不是算好的分数。
//
// 跑法：
//   node demom/bench/compare.ts                           自动挑 runs/ 里最新的 A 与 B
//   node demom/bench/compare.ts runs/A-x.jsonl runs/B-y.jsonl
//
// ★ 表里最有信息量的不是「谁赢」，是「两张形状图长什么样」★（主设计 §3.3）。

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "./measure.ts";
import { judgeText, type Verdict } from "./task.ts";

/**
 * ★ 拿旧数据重判 ★
 *
 * JSONL 里存了 `reportText` 全文，所以判据改了**不用重跑**——直接拿存的产物重新判。
 * 实测价值：去重判据从「按节」改成「按条目」后，20 次旧运行的结论整个翻过来，
 * 而重判耗时 < 1 秒（重跑要 2 小时）。
 *
 * 如果记录里没有 `reportText`（早期版本），退回用当时存的 verdict。
 */
function rejudge(r: RunRecord): Verdict {
  if (typeof r.reportText === "string" || r.reportText === null) {
    return judgeText(r.reportText ?? null);
  }
  return r.verdict;
}

const here = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(dirname(here), "runs");

function load(p: string): RunRecord[] {
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunRecord);
}

/** 自动挑最新的一批（按文件名里嵌入的 ISO 时间戳排） */
function latest(prefix: "A-" | "B-"): string | undefined {
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
    .sort();
  return files.length ? join(RUNS_DIR, files[files.length - 1]) : undefined;
}

/**
 * 收集要合并的文件。
 *
 * ★ 支持「分段收集」★：数据收集可能被中断，所以允许把同一边的多个 JSONL 合起来分析。
 * 用法：`compare.ts --A runs/A-main-1.jsonl,runs/A-main-2.jsonl --B runs/B-main-1.jsonl`
 * 不给参数就自动挑最新的一个。
 */
function pickFiles(): { a: string[]; b: string[] } {
  const aArg = process.argv.find((x) => x.startsWith("--A=") || x.startsWith("--A"))?.split("=")[1];
  const bArg = process.argv.find((x) => x.startsWith("--B=") || x.startsWith("--B"))?.split("=")[1];
  const split = (s?: string) =>
    s
      ? s
          .split(",")
          .map((x) => (x.includes("/") || x.includes("\\") ? x : join(RUNS_DIR, x)))
      : [];
  const a = split(aArg);
  const b = split(bArg);
  if (a.length || b.length) return { a, b };

  // 位置参数：前一半 A、后一半 B（按 lab 字段自动分）
  const positional = process.argv.slice(2).filter((x) => !x.startsWith("--"));
  if (positional.length) {
    const a2: string[] = [];
    const b2: string[] = [];
    for (const p of positional) {
      const path = p.includes("/") || p.includes("\\") ? p : join(RUNS_DIR, p);
      const rows = load(path);
      if (rows[0]?.lab === "A-cluster") a2.push(path);
      else b2.push(path);
    }
    return { a: a2, b: b2 };
  }

  const la = latest("A-");
  const lb = latest("B-");
  return { a: la ? [la] : [], b: lb ? [lb] : [] };
}

const picked = pickFiles();
const aPaths = picked.a;
const bPaths = picked.b;

if (!aPaths.length || !bPaths.length) {
  console.log("找不到数据。先跑两边：node demom/labA-cluster/run.ts / node demom/labB-workflow/run.ts");
  process.exit(1);
}

const A = aPaths.flatMap(load);
const B = bPaths.flatMap(load);

// ─────────────────────────────────────────────────────────────
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (n: number, d = 1) => n.toFixed(d);
const pct = (rows: RunRecord[]) => `${rows.filter((r) => rejudge(r).ok).length}/${rows.length}`;

function row(label: string, a: string, b: string): string {
  return `  ${label.padEnd(22)}│ ${a.padEnd(26)}│ ${b}`;
}

console.log(`\n对照表 —— 同一个任务 T，两种解法`);
console.log(`  A = 自由集群   ${aPaths.map((p) => p.split(/[\\/]/).pop()).join(", ")}  (${A.length} 次)`);
console.log(`  B = 固定流程   ${bPaths.map((p) => p.split(/[\\/]/).pop()).join(", ")}  (${B.length} 次)`);
console.log(`  ${"═".repeat(22)}╪${"═".repeat(27)}╪${"═".repeat(26)}`);
console.log(row("", "A 自由集群", "B 固定流程"));
console.log(`  ${"─".repeat(22)}┼${"─".repeat(27)}┼${"─".repeat(26)}`);

// ── 结果（§5 问题 1）──
console.log(row("ok 次数", pct(A), pct(B)));
const avgAgentsA = avg(A.map((r) => r.agentCount));
const agentsB = B[0]?.agentCount ?? 0;
console.log(row("agent 数", `${fmt(avgAgentsA)}（${Math.min(...A.map((r) => r.agentCount))}–${Math.max(...A.map((r) => r.agentCount))}，变量）`, `${agentsB}（常数 = 阶段数）`));
console.log(row("工具调用", fmt(avg(A.map((r) => r.toolCalls)), 1) + " 次", fmt(avg(B.map((r) => r.toolCalls)), 1) + " 次"));
console.log(row("耗时", fmt(avg(A.map((r) => r.secs))) + "s", fmt(avg(B.map((r) => r.secs))) + "s"));

// ── 代价（§5 问题 2）──
console.log(`  ${"─".repeat(22)}┼${"─".repeat(27)}┼${"─".repeat(26)}`);
console.log(row("tokens", String(Math.round(avg(A.map((r) => r.totalTokens)))), String(Math.round(avg(B.map((r) => r.totalTokens))))));
console.log(row("cost (USD)", avg(A.map((r) => r.costUsd)).toFixed(4), avg(B.map((r) => r.costUsd)).toFixed(4)));
console.log(row("报告字数", String(Math.round(avg(A.map((r) => rejudge(r).reportChars)))) , String(Math.round(avg(B.map((r) => rejudge(r).reportChars))))));

// ── 形状（§5 问题 3 —— 本实验真正的因变量）──
console.log(`  ${"─".repeat(22)}┼${"─".repeat(27)}┼${"─".repeat(26)}`);
console.log(row("最大委派深度", fmt(avg(A.map((r) => r.maxDepth)), 2), fmt(avg(B.map((r) => r.maxDepth)), 2)));
console.log(row("委派次数", fmt(avg(A.map((r) => r.delegations)), 2), "0（没有委派，只有边）"));
console.log(row("触预算闸", `${A.filter((r) => r.budgetHit).length}/${A.length}`, "0（阶段数固定，不会失控）"));
console.log(row("崩/轮失败", `${A.filter((r) => r.crashed).length}/${A.length}`, `${B.filter((r) => r.crashed).length}/${B.length}`));

// ── 重复劳动（检测「多个人读了同一份材料」）──
// 需要 callsDetailed/readPaths（新记录才有）；旧记录显示「—」
function dupReads(rows: RunRecord[]): string {
  const vals: number[] = [];
  const totalReads: number[] = [];
  for (const r of rows) {
    const all = r.agents.flatMap((a) => a.readPaths ?? []);
    if (!all.length) continue;
    const byPath = new Map<string, number>();
    for (const p of all) byPath.set(p, (byPath.get(p) ?? 0) + 1);
    vals.push([...byPath.values()].filter((n) => n >= 2).length);
    totalReads.push(all.length);
  }
  if (!vals.length) return "—（旧记录无参数）";
  return `${fmt(avg(vals), 1)} 份被≥2人读 / 共读 ${Math.round(avg(totalReads))} 次`;
}
console.log(row("重复劳动", dupReads(A), dupReads(B)));

// ── 逐项判据（看清差在哪一项，不只看总分）──
console.log(`\n逐项判据通过率`);
const items: [string, (r: RunRecord) => boolean][] = [
  ["① 覆盖 5 主题", (r) => rejudge(r).covered],
  ["④ 无编造 id", (r) => rejudge(r).idsValid],
  ["② 去重（全部组）", (r) => rejudge(r).deduped],
  ["③ 矛盾成对（全部组）", (r) => rejudge(r).contradictionPaired],
  ["干扰材料未盗用", (r) => rejudge(r).distractorClean],
];
for (const [label, f] of items) {
  const a = `${A.filter(f).length}/${A.length}`;
  const b = `${B.filter(f).length}/${B.length}`;
  console.log(row(label, a, b));
}

// ── 逐组难度：哪一组埋点最难被发现（后面分析的抓手）──
const groupKeys = new Set<string>([
  ...A.flatMap((r) => rejudge(r).dedupDetail?.map((d) => d.group.join("≡")) ?? []),
  ...B.flatMap((r) => rejudge(r).dedupDetail?.map((d) => d.group.join("≡")) ?? []),
]);
if (groupKeys.size) {
  console.log(`\n逐组通过率（重复组 —— 哪一组最难去干净）`);
  for (const key of groupKeys) {
    const rate = (rows: RunRecord[]) => {
      const hit = rows.filter((r) => rejudge(r).dedupDetail?.some((d) => d.group.join("≡") === key && d.ok)).length;
      return `${hit}/${rows.length}`;
    };
    console.log(row(`  ${key}`, rate(A), rate(B)));
  }
}
const contraKeys = new Set<string>([
  ...A.flatMap((r) => rejudge(r).contradictionDetail?.map((d) => d.group.join("vs")) ?? []),
  ...B.flatMap((r) => rejudge(r).contradictionDetail?.map((d) => d.group.join("vs")) ?? []),
]);
if (contraKeys.size) {
  console.log(`\n逐组通过率（矛盾组 —— 哪一组最难成对）`);
  for (const key of contraKeys) {
    const rate = (rows: RunRecord[]) => {
      const hit = rows.filter((r) => rejudge(r).contradictionDetail?.some((d) => d.group.join("vs") === key && d.ok)).length;
      return `${hit}/${rows.length}`;
    };
    console.log(row(`  ${key}`, rate(A), rate(B)));
  }
}

// ── 形状画像：A 到底分工成什么样（每次不同，这本身就是数据）──
console.log(`\nA 的形状分布（每次都不一样 —— 这本身就是数据）`);
for (const r of A) {
  const tree = r.agents.map((a) => `${"  ".repeat(a.depth - 1)}${a.role}`).join(" · ");
  console.log(`  ${rejudge(r).ok ? "✓" : "✗"} ${r.agentCount} 个：${tree}`);
}

// ── 结论提示（不下结论，只指出证据强度）──
console.log(`\n证据强度自检`);
const minN = Math.min(A.length, B.length);
if (minN < 3) console.log(`  ⚠ 只有 ${minN} 次，**不出结论**（主设计 §5：低于 3 次标 ?）`);
const dOk = Math.abs(A.filter((r) => rejudge(r).ok).length / A.length - B.filter((r) => rejudge(r).ok).length / B.length);
if (minN >= 3 && dOk === 0) {
  console.log(`  ⚠ 两边 ok 率相同 —— 若想区分，看形状与代价那两栏（可能本任务两种形态都做得完）`);
}
if (minN >= 3 && dOk > 0) {
  console.log(`  → 两边 ok 率差 ${(dOk * 100).toFixed(0)} 个百分点，样本 ${minN} 次，可写进结论`);
}
console.log(`\n结论请写进 demom/结论.md，回答主设计 §5 的三个问题。不写「A 比 B 好」。`);
