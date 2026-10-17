// 变体汇总：把所有实验变体放在一张表里比。
//
// ★ 只读 JSONL，用**当前判据**重判（`judgeText`）★ —— 判据改过几轮，旧记录不能信当时的 verdict。
//
// 跑法：node demom/bench/variants.ts
//
// 为什么需要它：`compare.ts` 是「A vs B 两边对照」，这个是「所有变体横向排」——
// 研究要回答的是「怎么让集群更好」，那必须把 base / nodup / preserve 摆在一张表上。

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord } from "./measure.ts";
import { judgeText } from "./task.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(dirname(here), "runs");

interface Row {
  lab: string;
  variant: string;
  ok: boolean;
  agents: number;
  deleg: number;
  toks: number;
  secs: number;
  chars: number;
  v: ReturnType<typeof judgeText>;
  dedup: { group: string[]; ok: boolean }[];
}

const rows: Row[] = [];
for (const f of readdirSync(RUNS_DIR)) {
  if (!f.endsWith(".jsonl") || /-(pre|pre2)-/.test(f)) continue; // 预跑不算正式数据
  for (const l of readFileSync(join(RUNS_DIR, f), "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as RunRecord;
    const v = judgeText(r.reportText ?? null);
    rows.push({
      lab: r.lab,
      variant: r.variant ?? "base",
      ok: v.ok,
      agents: r.agentCount,
      deleg: r.delegations,
      toks: r.totalTokens,
      secs: r.secs,
      chars: v.reportChars,
      v,
      dedup: v.dedupDetail,
    });
  }
}

const key = (r: Row) => `${r.lab}${r.variant !== "base" ? "/" + r.variant : ""}`;
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = key(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}

const avg = (rs: Row[], f: (r: Row) => number) => (rs.length ? Math.round(rs.reduce((a, b) => a + f(b), 0) / rs.length) : 0);
const cnt = (rs: Row[], f: (r: Row) => boolean) => `${rs.filter(f).length}/${rs.length}`;

console.log(`\n变体汇总（用**当前判据**重判，n=${rows.length} 条记录）`);
console.log(
  "变体".padEnd(22) +
    "n  ok    agent  委派  tokens    秒    字数   覆盖 编造 去重 矛盾 干扰",
);
console.log("─".repeat(108));
for (const [k, rs] of groups) {
  console.log(
    k.padEnd(22) +
      String(rs.length).padEnd(3) +
      cnt(rs, (r) => r.ok).padEnd(6) +
      String(avg(rs, (r) => r.agents)).padEnd(7) +
      String(avg(rs, (r) => r.deleg)).padEnd(5) +
      String(avg(rs, (r) => r.toks)).padEnd(9) +
      String(avg(rs, (r) => r.secs)).padEnd(7) +
      String(avg(rs, (r) => r.chars)).padEnd(7) +
      cnt(rs, (r) => r.v.covered).padEnd(5) +
      cnt(rs, (r) => r.v.idsValid).padEnd(5) +
      cnt(rs, (r) => r.v.deduped).padEnd(5) +
      cnt(rs, (r) => r.v.contradictionPaired).padEnd(5) +
      cnt(rs, (r) => r.v.distractorClean),
  );
}

// ── 去重逐组：哪一组最难 ──
console.log(`\n去重逐组通过率`);
const groupNames = [...new Set(rows.flatMap((r) => r.dedup.map((d) => d.group.join("≡"))))];
console.log("变体".padEnd(22) + groupNames.map((g) => g.padEnd(16)).join(""));
console.log("─".repeat(22 + groupNames.length * 16));
for (const [k, rs] of groups) {
  const cells = groupNames.map((g) => {
    const hit = rs.filter((r) => r.dedup.some((d) => d.group.join("≡") === g && d.ok)).length;
    return `${hit}/${rs.length}`.padEnd(16);
  });
  console.log(k.padEnd(22) + cells.join(""));
}

console.log(`\n⚠ 样本量提醒：n<3 的变体只算线索，不算结论。`);
