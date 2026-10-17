// IV · 分析方法：标准读数集 + 谁最能预测失败
//
// ★ 为什么先做这个（实验计划第五版 ①）
//   N4/N5 说明：我现在的读数（verdict.ok 一个布尔）对**成本**与**坏模式**完全不敏感。
//   12 个组全找到和 40 倍 token 才找到，judgment 都是 ok。
//   ⇒ **先有量尺，后面的实验才有分辨率。**
//
// ★ 这也是 DESIGN.md ④ 类（遇到什么类型情况，可以怎么去分析）的产出 ——
//   产出是**方法**，不是做法。而本项目此前一条方法型成果都没有。
//
// ★ 本脚本完全离线，零 API 成本。
//
// 读数的定义（每个都尽量只用一份 run 内的信息，可自动算）：
//   q            质量分（质量度量结果.md 的三成分乘积）
//   fab          编造 ID 数
//   repeatRead   重复读率（同一 agent 内同文件读 >1 次的部分）
//   dirRead      读目录率
//   xAgentRead   ★ 跨 agent 重复读率（N1）
//   costPerGroup 每找到一组的 token（成本效率）
//   tokenSpread  ★ 同一实验内的 token 离散度（N5：胖 rep）
//   callsPerGroup 每组的调用数
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RD = "research/demox/runs";

function isDir(s0: string): boolean {
  const s = s0.trim();
  if (!s) return false;
  if (/[\\/]$/.test(s)) return true;
  if (/^(\.|\.\.|\/|[a-z]:)$/i.test(s)) return true;
  if (/\.(md|js|json|txt|ts)$/i.test(s)) return false;
  const l = s.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return !l.includes(".");
}
function norm(p: string): string {
  const s = p.replace(/\\/g, "/").toLowerCase().replace(/^.*\/(demox|demom)\/work\//, "");
  const o: string[] = [];
  for (const x of s.split("/")) {
    if (x === "." || x === "") continue;
    if (x === "..") {
      o.pop();
      continue;
    }
    o.push(x);
  }
  return o.join("/");
}

type Run = {
  exp: string;
  rep: number;
  agents: number;
  ok: boolean;
  token: number;
  secs: number;
  q: number;
  fab: number;
  repeatRead: number;
  dirRead: number;
  xAgentRead: number;
  totalReads: number;
  groupsFound: number;
  groupsTotal: number;
  /** ★ 人的工作量（人工队列长度）—— 族 A 引入的第一等指标 */
  humanQueue: number;
  /** ★ 路由召回 / 精确（族 A） */
  escRecall: number;
  escPrecision: number;
};

const runs: Run[] = [];
for (const f of readdirSync(RD).filter((x) => x.endsWith(".jsonl"))) {
  for (const line of readFileSync(join(RD, f), "utf8").trim().split("\n")) {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const rd = r.verdict?.readings;
    if (!rd) continue;
    // ★ 人的工作量（族 A）—— 没有队列的任务记 undefined，**不是 0**
    const rw = r.structured?._routing;
    const humanQueue = typeof rw?.humanQueue === "number" ? rw.humanQueue : NaN;
    // 质量分（与 quality.ts 同口径）
    const gT = rd.groupsTotal ?? rd.defectsTotal;
    const gF = rd.groupsFound ?? rd.truePositives;
    const gFa = rd.groupsFalse ?? rd.falsePositives ?? 0;
    const fab = rd.idsFabricated ?? 0;
    let q = NaN;
    if (gT !== undefined && gF !== undefined) {
      const recall = gT > 0 ? gF / gT : 1;
      const precision = 1 - gFa / Math.max(gF, 1);
      q = Math.max(0, recall) * Math.max(0, Math.min(1, precision));
    }
    // 行为读数
    let totalReads = 0,
      repeatRead = 0,
      dirRead = 0,
      xAgentRead = 0;
    const fileReaders = new Map<string, Set<number>>();
    (r.agents || []).forEach((a: any, idx: number) => {
      const m = new Map<string, number>();
      for (const c of a.callsDetailed || []) {
        if (c.tool !== "read") continue;
        totalReads++;
        const arg = String(c.arg);
        if (isDir(arg)) dirRead++;
        const k = norm(arg);
        m.set(k, (m.get(k) || 0) + 1);
        if (!fileReaders.has(k)) fileReaders.set(k, new Set());
        fileReaders.get(k)!.add(idx);
      }
      repeatRead += [...m.values()].reduce((s, v) => s + Math.max(0, v - 1), 0);
    });
    // 跨 agent：被 ≥2 个不同 agent 读过的文件，其 read 次数
    const perFile = new Map<string, number>();
    for (const a of r.agents || [])
      for (const c of a.callsDetailed || []) if (c.tool === "read") {
        const k = norm(String(c.arg));
        perFile.set(k, (perFile.get(k) || 0) + 1);
      }
    for (const [k, n] of perFile) if ((fileReaders.get(k)?.size ?? 0) >= 2) xAgentRead += n;

    runs.push({
      exp: r.experiment,
      rep: r.rep ?? 0,
      agents: r.shape?.agentCount ?? 0,
      ok: !!r.verdict?.ok,
      token: r.totalTokens ?? 0,
      secs: r.secs ?? 0,
      q,
      fab,
      repeatRead,
      dirRead,
      xAgentRead,
      totalReads,
      groupsFound: gF ?? 0,
      groupsTotal: gT ?? 0,
      // ★ 族 A 的三个读数：人的工作量 + 路由的两个方向
      humanQueue,
      escRecall: typeof rd.recall === "number" ? rd.recall : NaN,
      escPrecision: typeof rd.precision === "number" ? rd.precision : NaN,
    });
  }
}

console.log(`总 run: ${runs.length}   通过 ${runs.filter((r) => r.ok).length}   失败 ${runs.filter((r) => !r.ok).length}\n`);

/** 一个读数作为「失败预测器」有多好？ */
function evaluate(name: string, get: (r: Run) => number, higherMeansWorse: boolean) {
  const valid = runs.filter((r) => Number.isFinite(get(r)));
  if (!valid.length) return null;
  const vals = valid.map(get);
  // 用阈值扫描找最佳切分点
  const sorted = [...new Set(vals)].sort((a, b) => a - b);
  let best = { thr: NaN, prec: 0, rec: 0, f1: 0 };
  for (const thr of sorted) {
    const predFail = valid.map((r) => (higherMeansWorse ? get(r) > thr : get(r) < thr));
    const fails = valid.map((r) => !r.ok);
    const tp = predFail.filter((p, i) => p && fails[i]).length;
    const fp = predFail.filter((p, i) => p && !fails[i]).length;
    const fn = predFail.filter((p, i) => !p && fails[i]).length;
    const prec = tp + fp ? tp / (tp + fp) : 0;
    const rec = tp + fn ? tp / (tp + fn) : 0;
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    if (f1 > best.f1) best = { thr, prec, rec, f1 };
  }
  // AUC 的秩相关近似
  const okVals = valid.filter((r) => r.ok).map(get);
  const failVals = valid.filter((r) => !r.ok).map(get);
  let auc = 0;
  if (okVals.length && failVals.length) {
    let wins = 0;
    for (const fv of failVals) for (const ov of okVals) if (higherMeansWorse ? fv > ov : fv < ov) wins++;
    auc = wins / (okVals.length * failVals.length);
  }
  return { name, n: valid.length, ...best, auc };
}

const readings: { name: string; get: (r: Run) => number; dir: boolean }[] = [
  { name: "quality (质量分)", get: (r) => r.q, dir: false },
  { name: "idsFabricated (N4)", get: (r) => r.fab, dir: true },
  { name: "repeatReadRate", get: (r) => (r.totalReads ? r.repeatRead / r.totalReads : 0), dir: true },
  { name: "dirReadRate", get: (r) => (r.totalReads ? r.dirRead / r.totalReads : 0), dir: true },
  { name: "xAgentReadRate (N1)", get: (r) => (r.totalReads ? r.xAgentRead / r.totalReads : 0), dir: true },
  { name: "token", get: (r) => r.token, dir: true },
  { name: "secs", get: (r) => r.secs, dir: true },
  { name: "tokenPerGroup", get: (r) => (r.groupsFound > 0 ? r.token / r.groupsFound : Infinity), dir: true },
  // ★ 族 A：★ **人的工作量** —— 第一等指标（「人花了多少劳动」直接可测）
  { name: "humanQueue (人的工作量)", get: (r) => r.humanQueue, dir: true },
  { name: "escRecall (该推的推了)", get: (r) => r.escRecall, dir: false },
  { name: "escPrecision (没多推)", get: (r) => r.escPrecision, dir: false },
];

console.log("读数                     n    最佳阈值   精确率  召回率   F1     AUC");
const results = readings.map((x) => evaluate(x.name, x.get, x.dir)).filter(Boolean) as NonNullable<ReturnType<typeof evaluate>>[];
for (const e of results.sort((a, b) => b.f1 - a.f1))
  console.log(
    `${e.name.padEnd(24)} ${String(e.n).padStart(4)}  ${String(e.thr).slice(0, 9).padStart(10)}  ` +
      `${(e.prec * 100).toFixed(1).padStart(6)}%  ${(e.rec * 100).toFixed(1).padStart(6)}%  ${e.f1.toFixed(3)}  ${e.auc.toFixed(3)}`,
  );

// ★ 成本盲区：同质量分的 run，成本能差多少
console.log("\n★ 现有判据（ok）看不见的东西：");
const okRuns = runs.filter((r) => r.ok && r.token > 0);
const byQ = new Map<string, number[]>();
for (const r of okRuns) {
  const k = Number.isFinite(r.q) ? r.q.toFixed(2) : "n/a";
  if (!byQ.has(k)) byQ.set(k, []);
  byQ.get(k)!.push(r.token);
}
console.log("  质量分    run数     token 中位      token 最大 / 最小");
for (const [k, v] of [...byQ.entries()].sort()) {
  const s = [...v].sort((a, b) => a - b);
  const ratio = s[0] > 0 ? (s[s.length - 1] / s[0]).toFixed(1) : "n/a";
  console.log(`  ${k.padEnd(8)} ${String(v.length).padStart(5)}  ${String(s[Math.floor(s.length / 2)]).padStart(10)}     ${ratio}x`);
}
