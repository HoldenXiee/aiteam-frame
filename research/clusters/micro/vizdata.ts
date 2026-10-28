/**
 * 研究数据导出器 —— 给 `viz-ui/`（React 前端）吃的**一份** JSON
 *
 * ★★★ 为什么单独一个文件而不是前端自己去读仓库：
 *   ① 前端要能**双击打开**（file:// 下不能 fetch 本地文件）⇒ 必须"手动选一个文件"，
 *      那就得有一个**自包含**的数据文件；
 *   ② 「哪些字段要画」是**内容判断**，属于研究助手（框架层），不该散在 UI 代码里；
 *   ③ 数据一冻结，前端就能离线重看历史某一版，不用仓库回滚。
 *
 * ★★ 与 `viz.ts`（旧的时间线 HTML）的区别：
 *   旧的那份只把**账的计数**画出来（产物/争辩/实验几条线），
 *   设计者原话：「为什么没有集群自己做实验、运行实验的内容（包括实验内部的内容也要可视化）」。
 *   ⇒ 这份**必须带上每条实验的内部**：载体目录、真跑的命令、真实输出、退出码、耗时、对照。
 *
 * 用法：`npx tsx research/clusters/micro/vizdata.ts [--out=路径]`
 *   ★ 默认写到 `viz-ui/data/hunt.json`（gitignored —— 可随时再生）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

// ───────────────────────────── 路径 ─────────────────────────────

const REPO = process.cwd();
const LAB = process.env.HUNT_LAB
  ? process.env.HUNT_LAB.startsWith("/") || /^[A-Za-z]:/.test(process.env.HUNT_LAB)
    ? process.env.HUNT_LAB
    : join(REPO, process.env.HUNT_LAB)
  : join(REPO, "research/labfirst/hunt");

const WORK = join(LAB, "work");
const OUTBOX = join(LAB, "outbox");
const EXTERNAL_DIR = join(REPO, "research/docs/研究员提供的网上文章");

const warn: string[] = [];

// ───────────────────────────── 小工具 ─────────────────────────────

function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  if (!existsSync(path)) {
    warn.push(`缺账：${path}`);
    return [];
  }
  const rows: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s) as T);
    } catch {
      /* 坏行跳过：账是追加写的，中途崩过会有半行 */
    }
  }
  return rows;
}

const ms = (s: unknown): number | null => {
  if (typeof s !== "string" || !s) return null;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : null;
};

const clip = (s: unknown, n: number): string => {
  const t = typeof s === "string" ? s : "";
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

/** 文件树里按后缀收集（带深度与数量上限 —— 踩过全树扫把 tick 卡死的坑） */
function listFiles(dir: string, ext: string, maxFiles = 4000): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (out.length >= maxFiles || depth > 3 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(ext)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

// ───────────────────────────── 类型（= 前端契约） ─────────────────────────────

export interface Carrier {
  dir: string;
  cmd: string;
  exit: number | null;
  /** 这次执行的真实输出（原样，可能很长）—— ★ 实验内部的核心 */
  out: string;
  outLines: number;
  ranAt: number | null;
  /** 从 `port.jsonl` 里按「目录+命令」配到的耗时（毫秒）；配不到 = null，不是 0 */
  ms: number | null;
}

export interface Exp {
  id: string;
  at: number | null;
  recordedAt: number | null;
  by: string;
  project: string;
  outcome: string;
  verdict: string;
  reviewedBy: string;
  reviewNote: string;
  claim: string;
  killCondition: string;
  expected: string;
  expectedAtLine: number;
  prereg: string;
  preregBeforeRun: boolean | null;
  phenomenon: string;
  phenomenonAbsent: string;
  model: string;
  conjecture: string;
  conjectureState: string;
  conjectureEvidence: string;
  source: string;
  externalCheck: string;
  control: { dir: string; cmd: string; exit: number | null; at: number | null } | null;
  controlAbsent: string;
  carriers: Carrier[];
  /** 载体总耗时（只算配到的） */
  runMs: number;
}

export interface VizData {
  meta: {
    generatedAt: number;
    lab: string;
    counts: Record<string, number>;
    warn: string[];
    /** ★ 哪些账本存在、几行 —— 前端要能说"这一格没有数据"而不是画个 0 */
    sources: { name: string; path: string; rows: number; bytes: number }[];
  };
  span: { t0: number; t1: number };
  experiments: Exp[];
  projects: { id: string; n: number; alive: number; dead: number; parked: number }[];
  /** 真跑过的命令（`port.jsonl`）—— 有耗时的运行记录 */
  runs: {
    at: number | null;
    by: string;
    carrier: string;
    cmd: string;
    exit: number | null;
    ms: number | null;
    out: string;
    claim: string;
  }[];
  /** 出生封口（`seals.jsonl`）：PREREG/驱动/判据各自的 sha + 窗口两端 */
  seals: {
    batch: string;
    prereg: string;
    driver: string;
    t0: number | null;
    t1: number | null;
    ms: number | null;
    rowsWritten: number | null;
    startBytes: number | null;
    endBytes: number | null;
  }[];
  challenges: {
    at: number | null;
    by: string;
    to: string;
    artifact: string;
    claim: string;
    verdict: string;
  }[];
  debates: { at: number | null; to: string; text: string; chars: number }[];
  errata: { id: string; target: string; wrong: string; by: string; at: string; ref: string; status: string }[];
  /** 产物：全文（前端搜索/阅读用）+ 它引用了哪些实验 */
  products: { name: string; t: number | null; kb: number; text: string; cites: string[] }[];
  /** 设计者投递的网上材料（集群的输入，不是产出） */
  external: { name: string; t: number | null; kb: number; text: string }[];
  /** 库修订（集群自己的 lib 副本漂移） */
  librev: { at: number | null; fp: string; files: number; note: string }[];
  /** 心跳里的成本行（原文 + 解出来的数） */
  cost: { t: number | null; text: string; tokM: number | null; usd: number | null }[];
  /** 拓扑日志事件（规则触发 / 工具调用 / 派活）—— 它"此刻在干什么" */
  events: { t: number | null; kind: string; sub: string; detail: string }[];
}

// ───────────────────────────── 采集 ─────────────────────────────

const experimentsRaw = readJsonl<Record<string, unknown>>(join(WORK, "experiments.jsonl"));
const portRaw = readJsonl<Record<string, unknown>>(join(WORK, "port.jsonl"));
const sealsRaw = readJsonl<Record<string, unknown>>(join(WORK, "seals.jsonl"));
const chalRaw = readJsonl<Record<string, unknown>>(join(WORK, "challenges.jsonl"));
const debateRaw = readJsonl<Record<string, unknown>>(join(WORK, "debate.jsonl"));
const errataRaw = readJsonl<Record<string, unknown>>(join(WORK, "errata-draft.jsonl"));
const librevRaw = readJsonl<Record<string, unknown>>(join(WORK, "_lib-rev.jsonl"));

/** 耗时索引：`目录|命令` → ms（port.jsonl 里带真耗时） */
const msByRun = new Map<string, number>();
for (const r of portRaw) {
  const k = `${String(r.carrier ?? "")}|${String(r.cmd ?? "")}`;
  const v = typeof r.ms === "number" ? r.ms : null;
  if (v !== null && !msByRun.has(k)) msByRun.set(k, v);
}

const experiments: Exp[] = experimentsRaw.map((r) => {
  const carriersRaw = Array.isArray(r.carriers) ? (r.carriers as Record<string, unknown>[]) : [];
  const carriers: Carrier[] = carriersRaw.map((c) => {
    const dir = String(c.dir ?? "");
    const cmd = String(c.cmd ?? "");
    const out = typeof c.head === "string" ? c.head : "";
    const hit = msByRun.get(`${dir}|${cmd}`);
    return {
      dir,
      cmd,
      exit: typeof c.exit === "number" ? c.exit : null,
      out,
      outLines: out ? out.split("\n").length : 0,
      ranAt: typeof c.ranAt === "number" ? c.ranAt : null,
      ms: hit ?? null,
    };
  });
  const controlRaw = r.control as Record<string, unknown> | undefined;
  const control =
    controlRaw && typeof controlRaw === "object"
      ? {
          dir: String(controlRaw.dir ?? ""),
          cmd: String(controlRaw.cmd ?? ""),
          exit: typeof controlRaw.exit === "number" ? controlRaw.exit : null,
          at: ms(controlRaw.at),
        }
      : null;
  return {
    id: String(r.id ?? "?"),
    at: ms(r.at),
    recordedAt: ms(r.recordedAt),
    by: String(r.by ?? ""),
    project: String(r.project ?? "?"),
    outcome: String(r.outcome ?? "未声明"),
    verdict: String(r.phenomenonVerdict ?? "未声明"),
    reviewedBy: String(r.reviewedBy ?? ""),
    reviewNote: String(r.reviewNote ?? ""),
    claim: String(r.claim ?? ""),
    killCondition: String(r.killCondition ?? ""),
    expected: String(r.expected ?? ""),
    expectedAtLine: typeof r.expectedAtLine === "number" ? r.expectedAtLine : 0,
    prereg: String(r.prereg ?? ""),
    preregBeforeRun: typeof r.preregBeforeRun === "boolean" ? r.preregBeforeRun : null,
    phenomenon: String(r.phenomenon ?? ""),
    phenomenonAbsent: String(r.phenomenonAbsent ?? ""),
    model: String(r.model ?? ""),
    conjecture: String(r.conjecture ?? ""),
    conjectureState: String(r.conjectureState ?? "未声明"),
    conjectureEvidence: String(r.conjectureEvidence ?? ""),
    source: String(r.source ?? ""),
    externalCheck: String(r.externalCheck ?? ""),
    control,
    controlAbsent: String(r.controlAbsent ?? ""),
    carriers,
    runMs: carriers.reduce((a, c) => a + (c.ms ?? 0), 0),
  };
});

const projectsMap = new Map<string, { id: string; n: number; alive: number; dead: number; parked: number }>();
for (const e of experiments) {
  const p = projectsMap.get(e.project) ?? { id: e.project, n: 0, alive: 0, dead: 0, parked: 0 };
  p.n += 1;
  if (e.outcome === "活") p.alive += 1;
  else if (e.outcome === "死") p.dead += 1;
  else if (e.outcome === "挂起") p.parked += 1;
  projectsMap.set(e.project, p);
}
const projects = [...projectsMap.values()].sort((a, b) => b.n - a.n);

const runs = portRaw.map((r) => ({
  at: ms(r.at),
  by: String(r.by ?? ""),
  carrier: String(r.carrier ?? ""),
  cmd: String(r.cmd ?? ""),
  exit: typeof r.exit === "number" ? r.exit : null,
  ms: typeof r.ms === "number" ? r.ms : null,
  out: typeof r.head === "string" ? r.head : "",
  claim: String(r.claim ?? ""),
}));

const seals = sealsRaw.map((r) => {
  const t0 = ms(r.t0);
  const t1 = ms(r.t1);
  return {
    batch: String(r.batch ?? ""),
    prereg: String(r.prereg ?? ""),
    driver: String(r.driver ?? ""),
    t0,
    t1,
    ms: t0 !== null && t1 !== null ? t1 - t0 : null,
    rowsWritten: typeof r.rowsWritten === "number" ? r.rowsWritten : null,
    startBytes: typeof r.startBytes === "number" ? r.startBytes : null,
    endBytes: typeof r.endBytes === "number" ? r.endBytes : null,
  };
});

const challenges = chalRaw.map((r) => ({
  at: ms(r.at),
  by: String(r.by ?? ""),
  to: String(r.to ?? ""),
  artifact: String(r.artifact ?? ""),
  claim: String(r.claim ?? ""),
  verdict: String(r.verdict ?? ""),
}));

const debates = debateRaw.map((r) => ({
  at: ms(r.at),
  to: String(r.to ?? ""),
  text: typeof r.text === "string" ? r.text : "",
  chars: typeof r.chars === "number" ? r.chars : 0,
}));

const errata = errataRaw.map((r) => ({
  id: String(r.id ?? ""),
  target: String(r.target ?? ""),
  wrong: String(r.wrong ?? ""),
  by: String(r.by ?? ""),
  at: String(r.at ?? ""),
  ref: String(r.ref ?? ""),
  status: String(r.status ?? ""),
}));

const librev = librevRaw.map((r) => ({
  at: ms(r.at),
  fp: String(r.fp ?? ""),
  files: r.files && typeof r.files === "object" ? Object.keys(r.files as object).length : 0,
  note: String(r.note ?? ""),
}));

// ── 产物（全文）──
const products = listFiles(OUTBOX, ".md", 2000)
  .map((p) => {
    const st = statSync(p);
    const text = readFileSync(p, "utf8");
    const cites = [...new Set(text.match(/\bE\d{1,4}\b/g) ?? [])].slice(0, 40);
    return { name: basename(p), t: st.mtimeMs, kb: Math.round(st.size / 1024), text, cites };
  })
  .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));

// ── 外部材料（设计者投递的网上文章）──
const external = existsSync(EXTERNAL_DIR)
  ? listFiles(EXTERNAL_DIR, ".md", 500).map((p) => {
      const st = statSync(p);
      return { name: basename(p), t: st.mtimeMs, kb: Math.round(st.size / 1024), text: readFileSync(p, "utf8") };
    })
  : [];

// ── 成本行（来自心跳日志）──
//
// ★★ 实测：心跳日志里的成本行**没有时间戳**（`  cost  本轮研究席：0.60M token · $0.26`），
//    整份 pretty 日志里一条 ISO 时间都没有 ⇒ `t = null`（**未声明**，不是 0）。
//    （纪律㉛：问"那时候是多少"只能读那时候的记录；记录里没有时间，就不许猜一个。）
const cost: VizData["cost"] = [];
for (const lf of listFiles(join(REPO, "logs"), ".log", 200)) {
  for (const line of readFileSync(lf, "utf8").split("\n")) {
    const m = /^\s*cost\s+(.*)$/.exec(line);
    if (!m) continue;
    const body = m[1] ?? "";
    const tokM = /([\d.]+)M token/.exec(body);
    const usd = /\$([\d.]+)/.exec(body);
    cost.push({
      t: null,
      text: clip(`${basename(lf)} · ${body}`, 400),
      tokM: tokM ? Number(tokM[1]) : null,
      usd: usd ? Number(usd[1]) : null,
    });
  }
}
cost.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));

// ── 拓扑事件（规则/工具/派活）──
const events: VizData["events"] = [];
for (const lf of listFiles(join(WORK, "runs"), ".log", 400)) {
  if (!basename(lf).startsWith("topology-")) continue;
  for (const line of readFileSync(lf, "utf8").split("\n")) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s{2}(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [kind, sub] = (m[2] ?? "").split(":");
    events.push({ t: ms(m[1]), kind: kind ?? "", sub: sub ?? "", detail: clip(m[3], 300) });
  }
}
if (existsSync(join(WORK, "_topology.log"))) {
  for (const line of readFileSync(join(WORK, "_topology.log"), "utf8").split("\n")) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s{2}(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [kind, sub] = (m[2] ?? "").split(":");
    events.push({ t: ms(m[1]), kind: kind ?? "", sub: sub ?? "", detail: clip(m[3], 300) });
  }
}
events.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));

// ── 时间跨度与来源清单 ──
const stamps: number[] = [];
for (const e of experiments) for (const t of [e.at, e.recordedAt]) if (t !== null) stamps.push(t);
for (const r of runs) if (r.at !== null) stamps.push(r.at);
for (const s of seals) for (const t of [s.t0, s.t1]) if (t !== null) stamps.push(t);
for (const c of challenges) if (c.at !== null) stamps.push(c.at);
for (const p of products) if (p.t !== null) stamps.push(p.t);
for (const e of events) if (e.t !== null) stamps.push(e.t);
for (const e of external) if (e.t !== null) stamps.push(e.t);
const t0 = stamps.length ? Math.min(...stamps) : Date.now();
const t1 = stamps.length ? Math.max(...stamps) : Date.now();

const sources = [
  ["experiments.jsonl", experimentsRaw.length],
  ["port.jsonl", portRaw.length],
  ["seals.jsonl", sealsRaw.length],
  ["challenges.jsonl", chalRaw.length],
  ["debate.jsonl", debateRaw.length],
  ["errata-draft.jsonl", errataRaw.length],
  ["_lib-rev.jsonl", librevRaw.length],
  ["outbox/*.md", products.length],
  ["外部材料", external.length],
  ["成本行", cost.length],
  ["拓扑事件", events.length],
].map(([name, rows]) => {
  const p = join(WORK, String(name));
  return { name: String(name), path: p, rows: Number(rows), bytes: existsSync(p) ? statSync(p).size : 0 };
});

const data: VizData = {
  meta: {
    generatedAt: Date.now(),
    lab: LAB,
    counts: {
      实验: experiments.length,
      真跑的命令: runs.length,
      出生封口: seals.length,
      争辩: challenges.length,
      长文辩论: debates.length,
      勘误: errata.length,
      产物: products.length,
      外部材料: external.length,
      拓扑事件: events.length,
      成本行: cost.length,
    },
    warn,
    sources,
  },
  span: { t0, t1 },
  experiments,
  projects,
  runs,
  seals,
  challenges,
  debates,
  errata,
  products,
  external,
  librev,
  cost,
  events,
};

// ───────────────────────────── 写出 ─────────────────────────────

const outArg = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
const outPath = outArg ? (outArg.startsWith("/") || /^[A-Za-z]:/.test(outArg) ? outArg : join(REPO, outArg)) : join(REPO, "viz-ui/data/hunt.json");
mkdirSync(join(outPath, ".."), { recursive: true });
const json = JSON.stringify(data);
writeFileSync(outPath, json, "utf8");

const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;
console.log(`★ 数据导出：${outPath}`);
console.log(`  · ${kb(json.length)} · 实验 ${experiments.length} 条（载体 ${experiments.reduce((a, e) => a + e.carriers.length, 0)} 次运行）`);
console.log(`  · 真跑命令 ${runs.length} · 封口 ${seals.length} · 争辩 ${challenges.length} · 产物 ${products.length} · 外部材料 ${external.length}`);
console.log(`  · 跨度 ${new Date(t0).toLocaleString()} → ${new Date(t1).toLocaleString()}`);
const noOut = experiments.filter((e) => e.carriers.some((c) => !c.out.trim())).length;
if (noOut) console.log(`  · ⚠ ${noOut} 条实验有载体但没记输出（前端会标「没记」，不当 0）`);
if (warn.length) console.log(`  · ⚠ 缺账 ${warn.length} 处：${warn.slice(0, 3).join(" / ")}`);
