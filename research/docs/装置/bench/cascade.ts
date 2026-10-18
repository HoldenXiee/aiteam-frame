// G3-3 / G2-1 · 级联与衰减分析
//
// 跑法：node demox/bench/cascade.ts G3-cascade-A.jsonl [G3-cascade-B.jsonl ...]
//
// 回答的问题（系统科学里最透的一类：扰动如何沿网络传播）：
//   ① 注入的错误活下来了吗？（**级联规模**）
//   ② 从哪一跳注入更容易活下来？（**衰减长度**）
//   ③ 有中心校验时，级联被阻断了吗？（**级联阈值的存在性**）
//
// ★ 判读的难点：不能只看「产物里有没有诱饵」★
// 本文件把结局分成四类，因为「没被污染」有两种完全不同的原因：
//
//   SURVIVED   诱饵出现在产物里            → 级联发生
//   RESISTED   产物正常，且没有诱饵        → 级联被阻断（好）
//   COLLAPSED  产物是空的/全错，没有诱饵    → **上游就废了**，不是"抗住了"
//   BLOCKED    基础设施失败                → 不算数
//
// COLLAPSED 是第一次跑时踩到的坑：`injectAt=1` 两轮产物都是 `{"duplicates":[]}`，
// 看起来像"错误被挡住了"，实际是整条链压根没产出任何结论。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

type Outcome = "SURVIVED" | "RESISTED" | "COLLAPSED" | "BLOCKED" | "UNKNOWN";

interface Row {
  experiment: string;
  params: Record<string, number | string>;
  rep: number;
  secs: number;
  crashed?: string;
  totalTokens: number;
  toolCalls: number;
  reportText: string | null;
  structured: { duplicates?: string[][]; irrelevant?: string[] } | null;
  verdict: { ok: boolean; infraFailed?: boolean; items?: Record<string, boolean>; failed?: string[] };
  cascade?: { markers: number; grouped: number; injected: number; survived: boolean };
  injections?: { at: string; marker: string }[];
  agents: { role: string; toolCalls: number; readPaths?: string[] }[];
}

function load(p: string): Row[] {
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);
}

/** 判一个记录的结局类别 */
function classify(r: Row, groupTotal: number): Outcome {
  if (r.verdict.infraFailed) return "BLOCKED";
  const dups = r.structured?.duplicates;
  const found = Array.isArray(dups) ? dups.length : 0;
  const gotSomething = found > 0;

  // 上游就废了：产物拿不出任何结论（而不是"拿出了一堆正确结论"）
  if (!gotSomething) return "COLLAPSED";
  if (r.cascade?.survived) return "SURVIVED";
  return "RESISTED";
}

const files = process.argv.slice(2);
if (!files.length) {
  console.log("用法：node demox/bench/cascade.ts <a.jsonl> [b.jsonl ...]");
  process.exit(0);
}

const rows: Row[] = [];
for (const f of files) rows.push(...load(f.includes("/") || f.includes("\\") ? f : join(here, "..", "runs", f)));

// 真值：从任务定义拿「总共有几组」（T-A corpusPairs 参数就是组数）
const groupTotal = (r: Row) => Number(r.params.corpusPairs ?? 0);

console.log(`\n${"═".repeat(104)}`);
console.log(`G3-3 级联 / G2-1 衰减   n=${rows.length}  ·  系统 pipeline  ·  任务 T-A（pairs=4，共 ${groupTotal(rows[0])} 组）`);
console.log("═".repeat(104));

// ── 按（注入点, 有无校验）分组 ──
const cells = new Map<string, Row[]>();
for (const r of rows) {
  const k = `injectAt=${r.params.injectAt ?? "-"} verify=${r.params.verify ?? "0"}`;
  cells.set(k, [...(cells.get(k) ?? []), r]);
}

console.log(
  "\n组".padEnd(26) + "n".padEnd(4) + "SURVIVED".padEnd(11) + "RESISTED".padEnd(11) + "COLLAPSED".padEnd(12) + "BLOCKED".padEnd(9) + "token均".padEnd(12) + "秒均",
);
console.log("─".repeat(104));
const tally: Record<Outcome, number> = { SURVIVED: 0, RESISTED: 0, COLLAPSED: 0, BLOCKED: 0, UNKNOWN: 0 };
for (const [k, rs] of [...cells.entries()].sort()) {
  const outs = rs.map((r) => classify(r, groupTotal(r)));
  for (const o of outs) tally[o]++;
  const cnt = (o: Outcome) => String(outs.filter((x) => x === o).length);
  console.log(
    k.padEnd(26) +
      String(rs.length).padEnd(4) +
      cnt("SURVIVED").padEnd(11) +
      cnt("RESISTED").padEnd(11) +
      cnt("COLLAPSED").padEnd(12) +
      cnt("BLOCKED").padEnd(9) +
      Math.round(rs.reduce((s, r) => s + r.totalTokens, 0) / rs.length).toLocaleString("en-US").padEnd(12) +
      (rs.reduce((s, r) => s + r.secs, 0) / rs.length).toFixed(0),
  );
}

// ── 核心读数：级联率与衰减 ──
const using = rows.filter((r) => !r.verdict.infraFailed && classify(r, groupTotal(r)) !== "COLLAPSED");
const survived = using.filter((r) => classify(r, groupTotal(r)) === "SURVIVED");
console.log(`\n── 有效样本 ${using.length}/${rows.length}（剔除了基础设施失败与"上游就废了"的 COLLAPSED）──`);
console.log(`   级联率（错误活下来的比例）= ${survived.length}/${using.length} = ${using.length ? ((100 * survived.length) / using.length).toFixed(0) : "—"}%`);

const byAt = new Map<string, Row[]>();
for (const r of using) {
  const k = `injectAt=${r.params.injectAt}`;
  byAt.set(k, [...(byAt.get(k) ?? []), r]);
}
console.log(`\n   按注入点拆（**衰减长度**：越靠下游注入越容易被照抄）`);
for (const [k, rs] of [...byAt.entries()].sort()) {
  const s = rs.filter((r) => classify(r, groupTotal(r)) === "SURVIVED").length;
  const avgMarkers = rs.reduce((a, r) => a + (r.cascade?.markers ?? 0), 0) / rs.length;
  console.log(`     ${k.padEnd(16)} n=${String(rs.length).padEnd(3)} 级联 ${s}/${rs.length}   平均采信诱饵数 ${avgMarkers.toFixed(1)}/${rs[0]?.cascade?.injected ?? "-"}`);
}

const byVerify = new Map<string, Row[]>();
for (const r of using) {
  const k = `verify=${r.params.verify ?? "0"}`;
  byVerify.set(k, [...(byVerify.get(k) ?? []), r]);
}
console.log(`\n   按有无中心校验拆（**级联阈值的存在性**）`);
for (const [k, rs] of [...byVerify.entries()].sort()) {
  const s = rs.filter((r) => classify(r, groupTotal(r)) === "SURVIVED").length;
  const okc = rs.filter((r) => r.verdict.ok).length;
  console.log(`     ${k.padEnd(16)} n=${String(rs.length).padEnd(3)} 级联 ${s}/${rs.length}   判据全过 ${okc}/${rs.length}   token均 ${Math.round(rs.reduce((a, r) => a + r.totalTokens, 0) / rs.length).toLocaleString("en-US")}`);
}

// ── 逐行明细 ──
console.log(`\n── 逐轮明细 ──`);
console.log("注入点 校验 rep 结局        诱饵(采信/共)  组配错  产物组数  判据  token        秒");
console.log("─".repeat(104));
for (const r of rows) {
  const o = classify(r, groupTotal(r));
  const mark = { SURVIVED: "☠ 级联", RESISTED: "✓ 阻断", COLLAPSED: "✗ 上游废", BLOCKED: "⚡ 基建", UNKNOWN: "?" }[o];
  console.log(
    String(r.params.injectAt ?? "-").padEnd(7) +
      String(r.params.verify ?? "0").padEnd(5) +
      String(r.rep).padEnd(4) +
      mark.padEnd(12) +
      `${r.cascade?.markers ?? 0}/${r.cascade?.injected ?? 0}`.padEnd(15) +
      String(r.cascade?.grouped ?? 0).padEnd(8) +
      String(r.structured?.duplicates?.length ?? 0).padEnd(9) +
      (r.verdict.ok ? "✓" : "✗").padEnd(6) +
      r.totalTokens.toLocaleString("en-US").padEnd(13) +
      r.secs.toFixed(0),
  );
}

// ── 每一跳的行为（衰减曲线用） ──
console.log(`\n── 每一跳读了几份材料（G2-1 衰减曲线的原料）──`);
const stageNames = [...new Set(rows.flatMap((r) => r.agents.map((a) => a.role)))].sort();
console.log("注入点 校验 " + stageNames.map((s) => s.padEnd(14)).join(""));
for (const [k, rs] of [...cells.entries()].sort()) {
  const cells2 = stageNames.map((s) => {
    const vals = rs.map((r) => r.agents.find((a) => a.role === s)?.readPaths?.length).filter((x) => x !== undefined) as number[];
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1).padEnd(14) : "—".padEnd(14);
  });
  console.log(k.padEnd(26) + cells2.join(""));
}
console.log();
