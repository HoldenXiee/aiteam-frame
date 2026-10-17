// ①b · 合并规则对照（**离线、零成本**）
//
// ★ 为什么可以离线做
//   redundant 系统已经把**每一份的原始答案**存进了 structured._redundancy.perCopyDetail。
//   所以"换一种合并规则结果会怎样"是纯函数问题 —— **不需要重跑任何 agent**。
//
// ★ 要对照的四种规则
//   strict  严格交集   —— N 份都同意才算（当前实现）
//   majority 多数投票  —— ≥ceil(N/2) 份同意就算
//   union   并集       —— 任一份提到就算
//   weighted 一致性加权 —— 一致的直接收；有分歧的那一组**标出来不合并**
//
// ★ 判据怎么给"部分合并的组"打分
//   判据 judgeDup 只认**完全匹配**的组。所以对每个候选组，要看它能不能对上真组：
//     真组 {M5,M6}，候选 {M5,M6,M23,M24} → 判据会算作"漏了 M5≡M6 和 M23≡M24"，且产生假组。
//   这里直接复现判据的口径：把候选组规范化，与真组集合比对。
import { readFileSync } from "node:fs";

type Groups = string[][]; // 每组是排序后的 id 数组

/** 把 "M5+M6" 形式的 key 转回数组 */
const toArr = (k: string) => k.split("+").sort();

/** 判据口径：完全匹配的组才算命中 */
function score(pred: Groups, truth: Groups) {
  const tset = new Set(truth.map((g) => [...g].sort().join("+")));
  const pset = new Set(pred.map((g) => [...g].sort().join("+")));
  let found = 0, falsePos = 0;
  for (const p of pset) (tset.has(p) ? found++ : falsePos++);
  const missed = [...tset].filter((t) => !pset.has(t));
  const recall = tset.size ? found / tset.size : 1;
  const precision = pset.size ? found / pset.size : 1;
  return { found, falsePos, missed, recall, precision, quality: recall * precision };
}

/** 四种合并规则 */
export function merge(rule: string, copies: string[][]): Groups {
  const sets = copies.map((c) => new Set(c));
  const N = sets.length;
  if (rule === "strict") {
    const out = new Set(sets[0] ?? []);
    for (const s of sets.slice(1)) for (const g of [...out]) if (!s.has(g)) out.delete(g);
    return [...out].map(toArr);
  }
  if (rule === "majority") {
    const count = new Map<string, number>();
    for (const s of sets) for (const g of s) count.set(g, (count.get(g) ?? 0) + 1);
    const need = Math.ceil(N / 2);
    return [...count.entries()].filter(([, c]) => c >= need).map(([g]) => toArr(g));
  }
  if (rule === "union") {
    const out = new Set<string>();
    for (const s of sets) for (const g of s) out.add(g);
    return [...out].map(toArr);
  }
  if (rule === "split") {
    // ★ 分裂偏好：若某候选组是另一个候选组的**真超集**（且更常见的那一侧更小），取**更小的**那份。
    //   依据：实测里错的答案总是把两组**并成一组**（合并），对的答案更细。
    //   所以"更细的分法"应当优先 —— 这是从数据里读出来的方向，不是我事先猜的。
    const count = new Map<string, number>();
    for (const s of sets) for (const g of s) count.set(g, (count.get(g) ?? 0) + 1);
    const keys = [...count.keys()];
    // 先把每个 key 拆成"原子组"：若 A ⊃ B 则 A 不是原子
    const atoms = keys.filter((a) => !keys.some((b) => b !== a && a.includes(b) && count.get(b)! >= 1));
    return atoms.map(toArr);
  }
  if (rule === "weighted") {
    // 一致（全部提到）的直接收；有分歧的**不合并**，另存进 _disputed
    const count = new Map<string, number>();
    for (const s of sets) for (const g of s) count.set(g, (count.get(g) ?? 0) + 1);
    return [...count.entries()].filter(([, c]) => c === N).map(([g]) => toArr(g));
  }
  throw new Error(`未知规则 ${rule}`);
}

/** 分歧组（用于 weighted 的输出） */
export function disputed(copies: string[][]): string[] {
  const sets = copies.map((c) => new Set(c));
  const count = new Map<string, number>();
  for (const s of sets) for (const g of s) count.set(g, (count.get(g) ?? 0) + 1);
  return [...count.entries()].filter(([, c]) => c > 0 && c < sets.length).map(([g]) => g);
}

// ── 读已有数据，离线对照 ──
if (process.argv[1]?.endsWith("merge.ts")) {
  const recs = readFileSync("research/demox/runs/redundant-T-A.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const truthOf = (pairs: number): Groups => {
    // 真组：M1M2, M3M4, ... （buildDupTask 的构造：相邻两份是一组）
    const out: Groups = [];
    for (let i = 1; i <= pairs * 2; i += 2) out.push([`M${i}`, `M${i + 1}`]);
    return out;
  };
  const rules = ["strict", "majority", "union", "split"];
  console.log("=== ①b 合并规则对照（离线，零成本）===\n");
  console.log("pairs copies 规则      命中/真组  假组  漏  召回  精确  质量分");
  for (const pairs of [4, 8, 12]) {
    const rs = recs.filter((r) => Number(r.params.corpusPairs) === pairs && r.structured?._redundancy?.perCopyDetail);
    if (!rs.length) continue;
    for (const rule of rules) {
      let agg = { found: 0, falsePos: 0, miss: 0, recall: 0, precision: 0, quality: 0, n: 0 };
      for (const r of rs) {
        const det = r.structured._redundancy.perCopyDetail as string[][];
        const pred = merge(rule, det);
        const sc = score(pred, truthOf(pairs));
        agg.found += sc.found; agg.falsePos += sc.falsePos; agg.miss += sc.missed.length;
        agg.recall += sc.recall; agg.precision += sc.precision; agg.quality += sc.quality; agg.n++;
      }
      const n = agg.n;
      console.log(
        `${String(pairs).padStart(5)} ${String(rs.length).padStart(6)} ${rule.padEnd(9)} ` +
          `${String(agg.found)}/${pairs * n}   ${String(agg.falsePos).padStart(3)}  ${String(agg.miss).padStart(2)}  ` +
          `${(agg.recall / n).toFixed(3)}  ${(agg.precision / n).toFixed(3)}  ${(agg.quality / n).toFixed(3)}`,
      );
    }
    // weighted 是预览模式（不合并分歧），单独说
    const withDisp = rs.filter((r) => disputed(r.structured._redundancy.perCopyDetail).length > 0);
    if (withDisp.length) {
      console.log(`      └ ★ 有分歧的轮次 ${withDisp.length}/${rs.length}，` +
        `分歧组：${withDisp.map((r) => disputed(r.structured._redundancy.perCopyDetail).join("/")).join("; ")}`);
    }
  }
}
