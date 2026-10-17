// ③ 质量度量：把二值判据合成一个连续质量分
//
// ★ 为什么要连续分
//   现在的 verdict.ok 是布尔的，画不出「投入-质量」曲线（曲线需要"多好"连续可变）。
//
// ★ 质量的三个可判成分（都已在 readings 里，不用重跑）
//   召回 recall   = groupsFound / groupsTotal      （该找到的找到了多少）
//   精确 precision = 1 - groupsFalse / max(groupsFound,1) （找到的里面有多少是假的）
//   不编造 honesty = 1 - idsFabricated / max(groupsTotal,1)（有没有编造不存在的编号）
//
// ★ 合成为单一分（0-1）
//   quality = recall × precision × honesty
//   —— 用乘法（不是加权平均），因为三者是「与」关系：
//      漏了一半 或 一半是假的 或 编造了编号，产物都不能用。
//
// ★ 为什么不重跑就够
//   这些计数已经在所有历史 run 的 verdict.readings 里。
//   所以这一步是**零成本**的，还能顺便看曲线的雏形。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RD = "research/demox/runs";

export type Quality = {
  recall: number;
  precision: number;
  honesty: number;
  quality: number;
  /** 三成分里有没有缺失数据（★ 缺数据 ≠ 0） */
  missing: boolean;
};

export function qualityOf(readings: Record<string, number | undefined>): Quality {
  const gFound = readings.groupsFound;
  const gTotal = readings.groupsTotal;
  const gFalse = readings.groupsFalse;
  const fab = readings.idsFabricated;
  // ★ 缺数据要标出来，不能当 0
  const missing = gFound === undefined || gTotal === undefined || gFalse === undefined || fab === undefined;
  if (missing) return { recall: NaN, precision: NaN, honesty: NaN, quality: NaN, missing: true };

  const recall = gTotal > 0 ? (gFound as number) / (gTotal as number) : 1;
  // 没找到任何组时，把 precision 记为 1（没有假阳性可言）—— 但 recall=0 会把它乘成 0
  const denom = Math.max(gFound as number, 1);
  const precision = 1 - (gFalse as number) / denom;
  const honesty = 1 - (fab as number) / Math.max(gTotal as number, 1);
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return {
    recall: clamp(recall),
    precision: clamp(precision),
    honesty: clamp(honesty),
    quality: clamp(recall) * clamp(precision) * clamp(honesty),
    missing: false,
  };
}

// ---- 扫全部历史 run，按实验分组 ----
type Row = { experiment: string; rep: number; quality: Quality; totalTokens: number; secs: number; ok: boolean; params: Record<string, unknown> };
const rows: Row[] = [];
for (const f of readdirSync(RD).filter((x) => x.endsWith(".jsonl"))) {
  const txt = readFileSync(join(RD, f), "utf8").trim();
  if (!txt) continue;
  for (const line of txt.split("\n")) {
    let r: { experiment?: string; rep?: number; totalTokens?: number; secs?: number; params?: Record<string, unknown>; verdict?: { ok?: boolean; readings?: Record<string, number> } };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const rd = r.verdict?.readings;
    if (!rd) continue;
    rows.push({
      experiment: r.experiment ?? f,
      rep: r.rep ?? 0,
      quality: qualityOf(rd),
      totalTokens: r.totalTokens ?? NaN,
      secs: r.secs ?? NaN,
      ok: !!r.verdict?.ok,
      params: r.params ?? {},
    });
  }
}

// 按实验聚合
const byExp = new Map<string, Row[]>();
for (const r of rows) {
  if (!byExp.has(r.experiment)) byExp.set(r.experiment, []);
  byExp.get(r.experiment)!.push(r);
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const med = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

console.log("=== ③ 质量度量：用已有 run 回算（零成本）===\n");
console.log("实验名             n   通过率   质量(均)  质量(中)  召回   精确   不编造   中位token");
for (const [exp, rs] of [...byExp.entries()].sort()) {
  const q = rs.filter((r) => !r.quality.missing);
  const okRate = rs.length ? rs.filter((r) => r.ok).length / rs.length : NaN;
  console.log(
    `${exp.padEnd(18)} ${String(rs.length).padStart(2)}  ${(okRate * 100).toFixed(0).padStart(5)}%  ` +
      `${avg(q.map((r) => r.quality.quality)).toFixed(3).padStart(8)}  ` +
      `${med(q.map((r) => r.quality.quality)).toFixed(3).padStart(8)}  ` +
      `${avg(q.map((r) => r.quality.recall)).toFixed(3).padStart(5)}  ` +
      `${avg(q.map((r) => r.quality.precision)).toFixed(3).padStart(5)}  ` +
      `${avg(q.map((r) => r.quality.honesty)).toFixed(3).padStart(6)}  ` +
      `${String(Math.round(med(rs.map((r) => r.totalTokens)))).padStart(9)}`,
  );
}

// 关键观察：二值通过率 vs 连续质量分，哪个区分度更高？
console.log("\n=== ★ 关键检验：连续质量分比二值判据更有区分度吗？ ===\n");
const allQ = rows.filter((r) => !r.quality.missing);
const nOk = allQ.filter((r) => r.ok).length;
const okSet = new Set(allQ.filter((r) => r.ok).map((r) => r.quality.quality));
const failSet = new Set(allQ.filter((r) => !r.ok).map((r) => r.quality.quality));
console.log(`总 run 数: ${allQ.length}   二值"通过": ${nOk} (${((nOk / allQ.length) * 100).toFixed(0)}%)`);
console.log(`  通过的 run 里，质量分有 ${okSet.size} 个不同取值 → ${[...okSet].map((x) => x.toFixed(2)).join(", ")}`);
console.log(`  未过的 run 里，质量分有 ${failSet.size} 个不同取值 → ${[...failSet].map((x) => x.toFixed(2)).join(", ")}`);
console.log(`\n  全体质量分: 均 ${avg(allQ.map((r) => r.quality.quality)).toFixed(3)}  中位 ${med(allQ.map((r) => r.quality.quality)).toFixed(3)}`);
const sq = allQ.map((r) => r.quality.quality);
const variance = avg(sq.map((x) => (x - avg(sq)) ** 2));
console.log(`  方差 ${variance.toFixed(4)}  标准差 ${Math.sqrt(variance).toFixed(3)}`);

// 相关性：投入 vs 质量
console.log("\n=== ★ 投入 vs 质量（曲线的雏形）===\n");
const withTok = allQ.filter((r) => Number.isFinite(r.totalTokens) && r.totalTokens > 0);
const rank = (a: number[]) => {
  const idx = a.map((v, i) => [v, i] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out = new Array(a.length).fill(0);
  idx.forEach(([, i], k) => (out[i] = k));
  return out;
};
const pearson = (a: number[], b: number[]) => {
  const ma = avg(a), mb = avg(b);
  const num = avg(a.map((x, i) => (x - ma) * (b[i] - mb)));
  const da = Math.sqrt(avg(a.map((x) => (x - ma) ** 2)));
  const db = Math.sqrt(avg(b.map((x) => (x - mb) ** 2)));
  return da && db ? num / (da * db) : NaN;
};
const sp = pearson(rank(withTok.map((r) => r.totalTokens)), rank(withTok.map((r) => r.quality.quality)));
console.log(`Spearman(投入, 质量) = ${sp.toFixed(3)}   (n=${withTok.length})`);
console.log(sp > 0.2 ? "  → 正相关：多投入似乎买到质量" : sp < -0.2 ? "  → ★ 负相关：多投入反而更差" : "  → ★ 几乎无关：『多投入就更好』在这个样本上不成立");

// 按 token 分档看质量
console.log("\n按投入分档（四等分）:");
const sorted = [...withTok].sort((a, b) => a.totalTokens - b.totalTokens);
const q1 = Math.floor(sorted.length / 4);
for (let i = 0; i < 4; i++) {
  const seg = sorted.slice(i * q1, i === 3 ? sorted.length : (i + 1) * q1);
  if (!seg.length) continue;
  console.log(
    `  第${i + 1}档 token ${String(seg[0].totalTokens).padStart(7)}–${String(seg[seg.length - 1].totalTokens).padStart(7)}  n=${String(seg.length).padStart(2)}  ` +
      `质量 ${avg(seg.map((r) => r.quality.quality)).toFixed(3)}  通过率 ${((seg.filter((r) => r.ok).length / seg.length) * 100).toFixed(0)}%`,
  );
}
