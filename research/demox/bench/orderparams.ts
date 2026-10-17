// G0-1 · 序参量搜索：在一堆可观测量里，哪个能解释「系统成不成」的方差？
//
// 跑法：node demox/bench/orderparams.ts
//
// 为什么是这个文件：demox 的第一条要先回答一个**前置问题** ——
// 后面每组实验都要控制某个变量，而"控制哪个"必须由数据说了算，不能靠人眼从表里看。
// demom 就是吃了这个亏：`nodup` 想砍「root 重复读材料」，看起来完全合理，
// 结果 4/6 → 0/2 —— 因为那个变量根本不是支配变量。
//
// ★ 判据只有一个来源 ★
// 从 `demom/bench/task.ts` import `judgeText`，**不自己写第二份**。
// 理由（demom 主设计）：判据一旦两边各写一份，就一定会在某次「差一点点」里被分别放松。
// 判据改过 6 次（demom §3），所以旧记录里存的 `verdict` 一律不信，全部用当前判据重判。
//
// ★ 样本口径（这是本文件最重要的一段）★
// demom/runs/ 里 58 行，其中 3 行是预跑（14 份材料的旧语料，任务不同）→ 正式 55 行。
// 55 行里有 6 行的 `reportText` 是 null。查证：
//   · 6 行的 stored verdict 都是 `产物不存在：report.md`；
//   · 6 行**全部**早于 2026-10-12（路径文本修复 + runner 诊断**都是那次提交才进的**，
//     `git log -S"路径歧义，不是能力失败"` 只有一个结果）；
//   · demom §4.1 独立记录了同一件事：「任务文本写 work/report.md，而 cwd 就是 work/
//     → 模型写到 work/work/report.md → 判据读不到 → 记成能力失败」。
// 所以这 6 行里，除 1 行是连接错误（真基础设施失败）外，5 行是**测量假象**。
//
// 处置：**主样本剔除这 6 行，并同时给出「把它们算作失败」的敏感性结果。**
// 为什么必须剔除：它们全部是 B 的记录，且与任何结构变量无关 ——
// 留在池子里只会把所有关联**衰减**掉，并且人为制造一条「lab/variant → 失败」的伪关联。
// 但剔除也要留痕：本文件把两类都打印出来，谁都不许偷偷过滤。

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeText } from "../../demom/bench/task.ts";
import type { RunRecord } from "../../demom/bench/measure.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(dirname(dirname(here)), "demom", "runs");

// ─────────────────────────────────────────────────────────────
// 1. 加载 + 分类
// ─────────────────────────────────────────────────────────────

type SampleClass = "usable" | "artifact-missing" | "infra-fail";

interface Row {
  file: string;
  row: number;
  lab: string;
  variant: string;
  cls: SampleClass;
  /** 分类依据（写进输出，不许静默） */
  why: string;
  r: RunRecord;
  /** 用**当前判据**重判的结果 */
  v: ReturnType<typeof judgeText>;
}

const INFRA = /Connection error|崩了|crash/i;

const rows: Row[] = [];
for (const f of readdirSync(RUNS_DIR)) {
  if (!f.endsWith(".jsonl")) continue;
  // 预跑用的是 14 份材料的旧语料 —— 任务不同，不是同一实验，一律不进样本
  if (/-(pre|pre2)-/.test(f)) continue;
  const lines = readFileSync(join(RUNS_DIR, f), "utf8").split("\n");
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    const r = JSON.parse(l) as RunRecord;
    const v = judgeText(r.reportText ?? null);
    let cls: SampleClass = "usable";
    let why = "";
    if (r.reportText === null) {
      if (INFRA.test(String(r.crashed ?? ""))) {
        cls = "infra-fail";
        why = String(r.crashed).slice(0, 60);
      } else {
        cls = "artifact-missing";
        why = "产物不存在，无崩溃、无诊断（早于 2026-10-12 的路径歧义）";
      }
    }
    rows.push({ file: f, row: i, lab: r.lab, variant: r.variant ?? "base", cls, why, r, v });
  });
}

console.log(`\n加载 ${rows.length} 行（已排除 3 条预跑）`);
const byClass = new Map<SampleClass, Row[]>();
for (const x of rows) byClass.set(x.cls, [...(byClass.get(x.cls) ?? []), x]);
for (const [c, xs] of byClass) console.log(`  ${c.padEnd(18)} ${xs.length} 行`);
console.log(`\n被剔除的行（每条都要看得见）：`);
for (const x of [...(byClass.get("artifact-missing") ?? []), ...(byClass.get("infra-fail") ?? [])]) {
  console.log(`  ${x.cls.padEnd(18)} ${x.lab}/${x.variant}  ${x.file.slice(0, 22)}[${x.row}]  ${x.why}`);
}

// ─────────────────────────────────────────────────────────────
// 2. 特征抽取：把每条记录摊成一堆**候选序参量**
//
// 设计原则：
//   · 只用**系统层面**的量（不看单个 agent 的文本内容）—— 这是 demox 的立场。
//   · lab-agnostic 优先；lab-specific 的（如按角色取）标注出来，且只在 lab 内报。
//   · 全部是「成本/规模/形态」三类：demom 的可观测量本来就只有这三类。
// ─────────────────────────────────────────────────────────────

interface Features {
  [k: string]: number | undefined;
}

/** 某个角色（A: 'root'；B: 'S2-去重'）的读数 */
function roleFeature(r: RunRecord, role: string, pick: (a: RunRecord["agents"][number]) => number | undefined): number | undefined {
  const a = (r.agents ?? []).find((x) => x.role === role);
  return a ? pick(a) : undefined;
}

function extract(r: RunRecord): Features {
  const agents = r.agents ?? [];
  const totalTok = r.totalTokens || 0;
  const totalCalls = r.toolCalls || 0;
  const sum = (f: (a: typeof agents[number]) => number) => agents.reduce((s, a) => s + f(a), 0);
  const max = (f: (a: typeof agents[number]) => number) => (agents.length ? Math.max(...agents.map(f)) : 0);

  const readsOf = (a: typeof agents[number]) => a.readPaths?.length ?? 0;
  const hasReadData = agents.some((a) => a.readPaths);
  // ★ 缺数据 ≠ 读了 0 份 ★
  // 2026-10-09 那批记录没有 readPaths 字段（量具还没加），而 `readPaths?.length ?? 0`
  // 会把它当成「真的一份都没读」—— 直接是一个**假的 0**，会把视野类特征的 AUC 拉向无信号。
  // 这正是 demom §3 那一族错误（“把缺当成错”）。所以单角色读数一律用这个版本：
  // 无该字段 → undefined（从该特征的样本里剔除），空数组 → 真的 0。
  const readsOfMaybe = (a: typeof agents[number]) => (a.readPaths === undefined ? undefined : a.readPaths.length);

  // 系统中所有 agent 读过的文件并集 —— 系统层面的「视野」
  const union = new Set<string>();
  for (const a of agents) for (const p of a.readPaths ?? []) union.add(p);
  const readsTotal = hasReadData ? sum(readsOf) : undefined;
  const readsUnion = hasReadData ? union.size : undefined;

  // 「判断者」与「落盘者」的视野。
  // demom 的结论是「全局判断需要全局视野」，而判断点在两个 lab 里位置不同：
  //   A 不分离 → 判断和执行都是 root；B 分离 → 判断在 S2、落盘在 S4。
  // 所以这个量是 **lab-specific** 的，只在 lab 内比较才有意义（下面会分开算）。
  const judgeReads = r.lab === "A-cluster" ? roleFeature(r, "root", readsOfMaybe) : roleFeature(r, "S2-去重", readsOfMaybe);
  const writerReads = r.lab === "A-cluster" ? roleFeature(r, "root", readsOfMaybe) : roleFeature(r, "S4-成文", readsOfMaybe);

  return {
    // ── 规模 / 形态 ──
    agentCount: r.agentCount,
    maxDepth: r.maxDepth,
    delegations: r.delegations,
    toolCalls: r.toolCalls,
    // ── 成本 ──
    totalTokens: r.totalTokens,
    inTokens: r.inTokens,
    outTokens: r.outTokens,
    secs: r.secs,
    // ── 集中度（系统科学问「是少数节点在主导，还是摊平」）──
    tokenConcentration: totalTok ? max((a) => a.usage.totalTokens) / totalTok : undefined,
    callConcentration: totalCalls ? max((a) => a.toolCalls) / totalCalls : undefined,
    tokensMax: max((a) => a.usage.totalTokens),
    callsMax: max((a) => a.toolCalls),
    // ── 视野 / 重复劳动（demom 的核心发现）──
    readsTotal,
    readsUnion,
    readsMax: hasReadData ? max(readsOf) : undefined,
    readsRedundancy: readsTotal && readsUnion ? readsTotal / readsUnion : undefined,
    agentsReading: hasReadData ? agents.filter((a) => readsOf(a) > 0).length : undefined,
    judgeReads,
    writerReads,
    // ── 宽度 ──
    toolsPerAgentMax: max((a) => a.distinctTools.length),
    // ── 与产物直接相关的读数（⚠ 可能与 ok 反向因果：写得多可能因为它做对了）──
    reportChars: r.reportText?.length,
  };
}

// ─────────────────────────────────────────────────────────────
// 3. 统计：AUC（秩基，不假设分布，对重尾免疫）
//
// 为什么用 AUC 而不是相关/回归：
//   · 结局是二值（ok/不 ok），且样本小（n<60）；
//   · 特征全是重尾（token 73k–5.7M），线性回归会被几个点主导；
//   · AUC 是纯秩的，任何单调变换都不改变它 → 不需要 log 变换这种主观步骤；
//   · 解释直观：0.5 = 无信号，1.0 = 完全分开，0.0 = 完全反向（也说明有信号）。
// ─────────────────────────────────────────────────────────────

/** 秩（并列取平均秩），用于 AUC */
function ranks(xs: number[]): number[] {
  const idx = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].x === idx[i].x) j++;
    const avg = (i + j) / 2 + 1; // 1-based
    for (let k = i; k <= j; k++) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}

/** AUC = P(正样本的分值 > 负样本的分值)（并列算 0.5） */
function auc(scores: number[], labels: boolean[]): number {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  if (!pos.length || !neg.length) return NaN;
  const r = ranks(scores);
  let sumPosRanks = 0;
  for (let i = 0; i < scores.length; i++) if (labels[i]) sumPosRanks += r[i];
  const n1 = pos.length, n0 = neg.length;
  return (sumPosRanks - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

/** 置换检验：p = P(|AUC_perm − 0.5| ≥ |AUC_obs − 0.5|)，双侧 */
function permP(scores: number[], labels: boolean[], iterations = 4000): number {
  const obs = Math.abs(auc(scores, labels) - 0.5);
  const n = labels.length;
  let hits = 0;
  // 简单 LCG，可复现（不用 Math.random —— 结果要能重跑出同一个数）
  let seed = 20261014;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const shuffled = labels.slice();
  for (let it = 0; it < iterations; it++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (Math.abs(auc(scores, shuffled) - 0.5) >= obs) hits++;
  }
  return hits / iterations;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Result {
  feature: string;
  n: number;
  auc: number;
  p: number;
  medOk: number;
  medFail: number;
  aucA: number;
  nA: number;
  aucB: number;
  nB: number;
  /** 该特征在哪些 lab 内是常量（常量 → AUC 无意义，只能是 0.5） */
  constIn: string[];
  /** 两个 lab 内部的 AUC 是否朝同一方向偏离 0.5（真序参量的必要条件） */
  agree: boolean | "n/a";
  /** 两 lab 取最小偏离量 —— 「必须两个 lab 内都成立」的排序分 */
  bothDev: number;
}

/** 单组内部的 AUC（样本内全同时返回 NaN，表示「这个 lab 里该量没有分辨力」） */
function aucIn(pairs: { f: number; ok: boolean }[]): number {
  const uniq = new Set(pairs.map((p) => p.f));
  if (uniq.size < 2) return NaN;
  return auc(pairs.map((p) => p.f), pairs.map((p) => p.ok));
}

/** 对一个特征跑完整分析（池化 AUC + 置换 p + 两个 lab 内部 AUC + 一致性） */
function analyze(name: string, rows: Row[], outcome: (r: Row) => boolean): Result {
  const pairs = rows
    .map((r) => ({ f: extract(r.r)[name], ok: outcome(r), lab: r.lab }))
    .filter((x) => x.f !== undefined && Number.isFinite(x.f)) as { f: number; ok: boolean; lab: string }[];

  const scores = pairs.map((p) => p.f);
  const labels = pairs.map((p) => p.ok);
  const A = pairs.filter((p) => p.lab === "A-cluster");
  const B = pairs.filter((p) => p.lab === "B-workflow");
  const aucA = aucIn(A);
  const aucB = aucIn(B);

  const constIn: string[] = [];
  if (A.length && Number.isNaN(aucA)) constIn.push("A");
  if (B.length && Number.isNaN(aucB)) constIn.push("B");

  // 一致性：两个 lab 都能算出 AUC 时，看是否同向偏离 0.5（同一侧即为同向）
  let agree: boolean | "n/a" = "n/a";
  if (Number.isFinite(aucA) && Number.isFinite(aucB)) {
    agree = (aucA - 0.5) * (aucB - 0.5) > 0;
  }
  const bothDev =
    Number.isFinite(aucA) && Number.isFinite(aucB)
      ? Math.min(Math.abs(aucA - 0.5), Math.abs(aucB - 0.5))
      : 0;

  return {
    feature: name,
    n: pairs.length,
    auc: auc(scores, labels),
    p: permP(scores, labels),
    medOk: median(pairs.filter((p) => p.ok).map((p) => p.f)),
    medFail: median(pairs.filter((p) => !p.ok).map((p) => p.f)),
    aucA,
    nA: A.length,
    aucB,
    nB: B.length,
    constIn,
    agree,
    bothDev,
  };
}

// ─────────────────────────────────────────────────────────────
// 4. 跑：主样本 / 敏感性 / 两个结局
// ─────────────────────────────────────────────────────────────

const FEATURES = [
  "agentCount", "maxDepth", "delegations", "toolCalls",
  "totalTokens", "inTokens", "outTokens", "secs",
  "tokenConcentration", "callConcentration", "tokensMax", "callsMax",
  "readsTotal", "readsUnion", "readsMax", "readsRedundancy", "agentsReading",
  "judgeReads", "writerReads", "toolsPerAgentMax", "reportChars",
];

const main = rows.filter((x) => x.cls === "usable");
const all = rows; // 敏感性：把假象也当成失败

function report(title: string, rs: Row[], outcome: (r: Row) => boolean, note = "") {
  console.log(`\n${"═".repeat(112)}`);
  console.log(`${title}   n=${rs.length}   ok=${rs.filter(outcome).length}/${rs.length}${note ? "   " + note : ""}`);
  console.log("═".repeat(112));
  const results = FEATURES.map((f) => analyze(f, rs, outcome)).filter((x) => x.n >= 6);
  // 按 |AUC-0.5| 排序 —— 偏离 0.5 越远越有信号
  results.sort((a, b) => Math.abs(b.auc - 0.5) - Math.abs(a.auc - 0.5));

  // Benjamini-Hochberg FDR（多重比较必须处理：21 个特征不能只看最小的那个 p）
  const byP = results.slice().sort((a, b) => a.p - b.p);
  const m = byP.length;
  const q = new Map<string, number>();
  let prev = 1;
  for (let i = m - 1; i >= 0; i--) {
    const val = Math.min(prev, (byP[i].p * m) / (i + 1));
    q.set(byP[i].feature, val);
    prev = val;
  }

  console.log(
    "特征".padEnd(20) + "n".padEnd(4) + "AUC".padEnd(7) + "p".padEnd(8) + "q(BH)".padEnd(8) +
    "AUC_A(n)".padEnd(12) + "AUC_B(n)".padEnd(12) + "同向".padEnd(6) + "失败中位数".padEnd(13) + "成功中位数",
  );
  console.log("─".repeat(112));
  const fmt = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2)) : "—");
  for (const r of results) {
    const star = q.get(r.feature)! < 0.05 ? "★" : q.get(r.feature)! < 0.10 ? "·" : " ";
    const agreeMark = r.agree === true ? "YES" : r.agree === false ? "NO" : "n/a";
    console.log(
      (r.feature + star).padEnd(20) +
        String(r.n).padEnd(4) +
        r.auc.toFixed(3).padEnd(7) +
        r.p.toFixed(3).padEnd(8) +
        q.get(r.feature)!.toFixed(3).padEnd(8) +
        `${fmt(r.aucA)}(${r.nA})`.padEnd(12) +
        `${fmt(r.aucB)}(${r.nB})`.padEnd(12) +
        agreeMark.padEnd(6) +
        fmt(r.medFail).padEnd(13) +
        fmt(r.medOk),
    );
  }
  console.log("★ q<0.05   · q<0.10   AUC>0.5 越大越容易成功；<0.5 越大越容易失败");
  console.log("AUC_A/AUC_B = 只在单个 lab 内算（— = 该 lab 内该量是常量，无分辨力）。");
  console.log("同向 YES = 两个 lab 内部都朝同一侧偏离 0.5 —— 这是「真序参量」的必要条件，不是充分条件。");

  // ── 只看两 lab 内都成立的（bothDev 排序）——这是本文最该信的一张排序 ──
  const both = results.filter((r) => r.agree === true).sort((a, b) => b.bothDev - a.bothDev);
  console.log(`\n  ── 两 lab 内同向的（${both.length}/${results.length} 个特征）──`);
  if (!both.length) console.log("     （一个都没有 —— 所有池化关联都只来自 lab 之间的差别）");
  for (const r of both.slice(0, 8)) {
    console.log(
      `     ${r.feature.padEnd(20)} AUC_A=${fmt(r.aucA)}(${r.nA})  AUC_B=${fmt(r.aucB)}(${r.nB})  ` +
        `最小偏离=${r.bothDev.toFixed(3)}  q=${q.get(r.feature)!.toFixed(3)}`,
    );
  }
  return results.map((r) => ({ ...r, q: q.get(r.feature)! }));
}

// ok 与 deduped 是不是同一条判据？（若相同，说明去重是唯一的约束）
const okIsDedup = main.filter((r) => r.v.ok === r.v.deduped).length;

const out = {
  generatedAt: new Date().toISOString(),
  note: "主样本剔除 6 条测量假象（5 条路径歧义 + 1 条连接错误）；敏感性含全部。判据来自 demom/bench/task.ts 的 judgeText。",
  caveats: [
    "探索性特征筛选，不是确认性检验：n=49、2 个 lab、14 个变体。",
    "视野类特征（reads*）只在非 base 变体上可得（缺 readPaths 的 10 条恰好是全部 A/main 6 条 + B/main 4 条）→ 它们与「变体」系统混淆。",
    "池化 AUC 会被 lab 基线差异污染（A 有委派、B 恒为 0），所以只信「两 lab 内同向」那一栏。",
    `ok 与 deduped 在主样本里一致的有 ${okIsDedup}/${main.length} 条 —— 不一致越多，说明其它判据项也在起作用。`,
  ],
  counts: { loaded: rows.length, usable: main.length, artifactMissing: (byClass.get("artifact-missing") ?? []).length, infraFail: (byClass.get("infra-fail") ?? []).length },
  primary_ok: report("【主样本】结局 = 五项全过（ok）", main, (r) => r.v.ok),
  primary_dedup: report("【主样本】结局 = 去重那一项过（deduped）—— 这是 demom 里唯一真正拉开差距的判据", main, (r) => r.v.deduped),
  sensitivity_ok: report("【敏感性】结局 = ok，但把 6 条测量假象也当成失败（看口径影响多大）", all, (r) => r.v.ok, "⚠ 此栏含测量假象，不当结论"),
};
writeFileSync(join(here, "orderparams-out.json"), JSON.stringify(out, null, 2));
console.log(`\n结果已写入 demox/bench/orderparams-out.json`);

// ─────────────────────────────────────────────────────────────
// 5. 关键对照：知道「设计」（变体）能预测多少 vs 知道「测量量」能预测多少
//
// 这是 G0-1 真正要回答的问题的一个侧面：
//   如果「变体身份」比任何单个连续量预测得都准，那方差在**设计选择**里（那是人改的东西），
//   而不在**我们测的那些宏观量**里 —— 这直接解释了为什么找不到一个漂亮的序参量。
//
// 用留一（LOO）均值做分，避免用同一条记录自己的结局预测自己。
// ─────────────────────────────────────────────────────────────
function looGroupScore(rs: Row[], keyOf: (r: Row) => string, outcome: (r: Row) => boolean): number[] {
  // 每组的总数与命中数，然后就留一修正
  const tot = new Map<string, number>();
  const hit = new Map<string, number>();
  for (const r of rs) {
    const k = keyOf(r);
    tot.set(k, (tot.get(k) ?? 0) + 1);
    hit.set(k, (hit.get(k) ?? 0) + (outcome(r) ? 1 : 0));
  }
  return rs.map((r) => {
    const k = keyOf(r);
    const n = tot.get(k)! - 1;
    const h = hit.get(k)! - (outcome(r) ? 1 : 0);
    // 该组只剩自己 → 退回全局均值（否则分数无信息，等价于 0.5）
    return n > 0 ? h / n : 0.5;
  });
}

console.log(`\n${"─".repeat(112)}`);
console.log("关键对照：预测能力来自「设计」还是来自「测量量」？（主样本，结局 = ok）");
console.log("─".repeat(112));
{
  // ★ 所有模型都在**同一个子集**上算 ★
  // 否则 judgeReads 缺失的 9 条被填成 0.5，各行的样本就不一样，AUC 不可比。
  // 子集 = 有 judgeReads 的 40 条（即排除了缺 readPaths 的 A/base 6 条 + B/base 3 条）。
  const sub = main.filter((r) => extract(r.r).judgeReads !== undefined);
  const labels = sub.map((r) => r.v.ok);
  console.log(`  （共同子集 n=${sub.length}，ok=${labels.filter(Boolean).length}）`);
  const models: [string, number[]][] = [
    ["知道是哪个 lab（A/B）", looGroupScore(sub, (r) => r.lab, (r) => r.v.ok)],
    ["知道是哪个变体（lab+variant）", looGroupScore(sub, (r) => `${r.lab}/${r.variant}`, (r) => r.v.ok)],
    ["知道有多少 agent", sub.map((r) => extract(r.r).agentCount ?? 0.5)],
    ["知道最大单 agent 调用数 callsMax", sub.map((r) => extract(r.r).callsMax ?? 0.5)],
    ["知道判断者读了几份 judgeReads", sub.map((r) => extract(r.r).judgeReads ?? 0.5)],
    ["知道总 token（成本）", sub.map((r) => extract(r.r).totalTokens ?? 0.5)],
    ["掷硬币（参考）", sub.map(() => 0.5)],
  ];
  for (const [name, scores] of models) {
    const a = auc(scores, labels);
    console.log(`  ${name.padEnd(34)} AUC = ${Number.isFinite(a) ? a.toFixed(3) : "—"}`);
  }
  console.log("  读法：若某个单量 ≥ 变体身份，说明它已经把『设计差异』吸收进去了 ——");
  console.log("  这既可能是真信号，也可能是该量本身就是变体决定的（= 处置剂量，而非观测量）。");
  console.log("  必须看单 lab 内 AUC + 逐变体分布才能区分。两者不可混同。");
}

// ── judgeReads 逐变体分布：它是「观测量」还是「设计者早就写好的处置剂量」？──
console.log(`\n  判断者视野（judgeReads）逐变体分布 —— 看它是不是变体决定的：`);
{
  const g = new Map<string, number[] | "missing">();
  for (const r of main) {
    const v = extract(r.r).judgeReads;
    const k = `${r.lab}/${r.variant}`;
    const cur = g.get(k);
    if (v === undefined) {
      if (cur === undefined) g.set(k, "missing");
    } else {
      g.set(k, cur === undefined || cur === "missing" ? [v] : [...cur, v]);
    }
  }
  for (const [k, v] of [...g.entries()].sort()) {
    console.log(`     ${k.padEnd(24)} ${v === "missing" ? "缺 readPaths（老记录）" : `[${v.slice().sort((a, b) => a - b).join(", ")}]`}`);
  }
  console.log("     若分布按变体分块（某个变体恒高/恒低）→ 它是设计写死的剂量，不是从系统里量出来的状态。");
}

// ── judgeReads 分箱 × 成功率：找反例（有没有「看得少但仍成」的）──
console.log(`\n  判断者视野分箱 —— 成功率是不是单调的？（单调 = 支持剂量-反应；有坑 = 反对）`);
{
  const bins: [string, (v: number) => boolean][] = [
    ["0 份", (v) => v === 0],
    ["1–16 份", (v) => v >= 1 && v <= 16],
    ["17–30 份", (v) => v >= 17 && v <= 30],
    ["31–44 份", (v) => v >= 31 && v <= 44],
    ["45+ 份", (v) => v >= 45],
  ];
  for (const lab of ["A-cluster", "B-workflow"]) {
    const line: string[] = [];
    for (const [name, test] of bins) {
      const xs = main.filter((r) => r.lab === lab && extract(r.r).judgeReads !== undefined && test(extract(r.r).judgeReads!));
      line.push(xs.length ? `${name}=${xs.filter((r) => r.v.ok).length}/${xs.length}` : `${name}=—`);
    }
    console.log(`     ${lab.padEnd(12)} ${line.join("   ")}`);
  }
  console.log("     ⚠ 注意看 B 的「1–16 份」那个格：若那里成功率不低，则「看得少 → 必失败」不成立。");
}

console.log(`\n${"─".repeat(112)}`);
console.log("基线（先看这个，再看上面的排序）");
console.log("─".repeat(112));
const g = new Map<string, Row[]>();
for (const x of main) {
  const k = `${x.lab}/${x.variant}`;
  g.set(k, [...(g.get(k) ?? []), x]);
}
for (const [k, xs] of [...g.entries()].sort()) {
  console.log(
    `${k.padEnd(24)} n=${String(xs.length).padEnd(3)} ok=${String(xs.filter((r) => r.v.ok).length).padEnd(3)} ` +
      `agent均=${(xs.reduce((s, r) => s + r.r.agentCount, 0) / xs.length).toFixed(1).padEnd(5)} ` +
      `token均=${Math.round(xs.reduce((s, r) => s + r.r.totalTokens, 0) / xs.length).toLocaleString("en-US")}`,
  );
}
