/**
 * ★★★★★ hunt 时间线 · 拓扑可视化（2026-10-27 第二版）
 *
 * 设计者的要求（逐条对应）：
 *   ① 「agent 拓扑要**逐步长出来**」⇒ 图是**累积**的：节点诞生才出现、边发生才连上，
 *      拖动时间轴就是重放"这张网怎么长起来的"。
 *   ② 「很多 agent、关系成为一张网」⇒ 节点 = 研究员 / 专家 / 长出来的支线；
 *      边 = 挑战 / 请教 / 回流 / 规则派活（后者让"规则 → 席位"也可见）。
 *   ③ 「数据太少、无法分析」⇒ 除了图，还出：
 *        · 每 5 分钟的条带（tick 频次 / 工具调用 / 新增边 / 新实验）
 *        · 每个节点的入度出度（谁被挑战最多、谁从没被找过）
 *        · 工具直方图、报错原文、可疑处
 *   ④ 「用前端库」⇒ **vis-network**（力导向，撑得住几百节点/边），构建时把它内联进 HTML。
 *
 * ★ 数据来源（全部落盘，纯函数，纪律⑦）：
 *   `work/_topology.log`（或 `work/runs/topology-*.log` 的某一轮）
 *   `work/experiments.jsonl`
 *   `outbox/`（份数）
 *
 * 用法：
 *   npm run viz                       # 当前这一轮
 *   npm run viz -- --list             # 列出归档的轮次
 *   npm run viz -- --log=work/runs/topology-2026-10-27T10-35-14.log
 *   npm run viz -- --open             # 生成后打开浏览器
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = process.cwd();
const LAB = (() => {
  const a = process.argv[2];
  if (a && !a.startsWith("--")) return a.startsWith("/") || /^[A-Za-z]:/.test(a) ? a : join(REPO, a);
  return join(REPO, process.env.HUNT_LAB || "research/labfirst/hunt");
})();
const runsDir = join(LAB, "work", "runs");

// ── --list ─────────────────────────────────────────────────────
if (process.argv.includes("--list")) {
  const files = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.startsWith("topology-") && f.endsWith(".log")).sort() : [];
  console.log(`★ ${LAB.replace(REPO, "")} 的历史轮次（${files.length} 个）：`);
  for (const f of files) {
    const txt = readFileSync(join(runsDir, f), "utf8");
    const n = txt.split(String.fromCharCode(10)).filter(Boolean).length;
    const head = (txt.split(String.fromCharCode(10))[0] ?? "").slice(0, 19);
    console.log(`  · work/runs/${f}　${head}　${n} 行`);
  }
  console.log("");
  console.log(`用法：npx tsx research/clusters/micro/viz.ts ${LAB.replace(REPO, "")} --log=work/runs/<文件名>`);
  process.exit(0);
}

const wantLog = process.argv.find((a) => a.startsWith("--log="))?.split("=")[1];
const topoPath = wantLog
  ? wantLog.startsWith("/") || /^[A-Za-z]:/.test(wantLog)
    ? wantLog
    : join(LAB, wantLog)
  : join(LAB, "work", "_topology.log");
if (!existsSync(topoPath)) {
  console.error(`⛔ 找不到日志：${topoPath}\n  ★ 用 --list 看有哪些归档轮次`);
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════
// 解析
// ══════════════════════════════════════════════════════════════
const raw = readFileSync(topoPath, "utf8").split(String.fromCharCode(10)).filter((l) => l.trim());

type Ev = { t: number; kind: string; seat?: string; tool?: string; from?: string; to?: string; text: string };
const events: Ev[] = [];
const KNOWN_SEATS = [
  "inspector",
  "archivist",
  "inspirer",
  "watchdog",
  "libsmith",
  "hands-on",
  "falsifier",
  "instrument-skeptic",
];

for (const line of raw) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(\S+)\s*(.*)$/.exec(line);
  if (!m) continue;
  const t = Date.parse(m[1]!);
  if (!Number.isFinite(t)) continue;
  const kind = m[2]!;
  const rest = m[3] ?? "";
  const e: Ev = { t, kind, text: line.slice(0, 300) };

  if (kind.startsWith("edge:")) {
    // `edge:challenge  hands-on→falsifier`
    const mm = /^\s*(\S+?)→(\S+)\s*$/.exec(rest);
    e.kind = kind;
    e.from = mm?.[1];
    e.to = mm?.[2];
  } else if (kind.startsWith("tool:")) {
    e.tool = kind.slice(5);
    e.to = rest.trim().split(/\s+/)[0]?.slice(0, 40);
  } else if (kind === "fire" || kind === "result") {
    e.seat = KNOWN_SEATS.find((s) => new RegExp(`(^|[^a-z-])${s}([^a-z-]|$)`).test(rest));
  } else if (kind === "seat") {
    e.seat = rest.trim();
  }
  events.push(e);
}

const t0 = events[0]?.t ?? Date.now();
const t1 = events[events.length - 1]?.t ?? t0;
const span = Math.max(1, t1 - t0);
const at = (ev: Ev) => ev.t - t0;

// ── 节点：谁在这个世界里出现过 ─────────────────────────────────
type Node = { id: string; role: string; born: number; died: number | null; fired: number; results: number };
const nodeMap = new Map<string, Node>();
/**
 * ★ 名字归一：`L3-researcher-hands-on-mvqlwvwd` → `hands-on`
 *   ★ 不归一会得到**同一件事两个节点**（一回流就多一个"新 agent"），图会骗人。
 */
const norm = (id: string): string => {
  const m = /researcher-(hands-on|falsifier|instrument-skeptic)/.exec(id);
  if (m) return m[1]!;
  // ★ 只剥"随机 id 后缀"（8 位且含数字）—— 别把 `instrument-skeptic` 剥成 `instrument`
  //   （我第一版就是 `-[a-z0-9]{6,}$` ⇒ 席位名被切掉一半，图上出现两个同名不同色的点）
  if (/[a-z0-9]{8}$/i.test(id) && /[0-9]/.test(id.slice(-8))) return id.slice(0, -9);
  return id;
};
const addNode = (rawId: string, role: string, born: number) => {
  const id = norm(rawId);
  const cur = nodeMap.get(id);
  if (cur) return cur;
  const n: Node = { id, role, born, died: null, fired: 0, results: 0 };
  nodeMap.set(id, n);
  return n;
};

// 研究员（setup 行里点名）
for (const e of events) {
  if (e.kind === "setup" && /研究席位/.test(e.text)) {
    for (const s of KNOWN_SEATS) if (e.text.includes(s)) addNode(s, "researcher", at(e));
  }
}
for (const e of events) {
  if (e.kind === "fire" && e.seat) {
    const n = addNode(e.seat, "researcher".includes(e.seat) ? "expert" : "expert", at(e));
    n.fired++;
  } else if (e.kind === "result" && e.seat) {
    const n = addNode(e.seat, "expert", at(e));
    n.results++;
  } else if (e.kind === "seat" && e.seat) {
    // `spawn 支线 line-xxx（spawn_line）`
    const mm = /line-[a-z0-9]+/i.exec(e.text);
    if (mm) addNode(mm[0], "line", at(e));
  }
}
// 规则节点（"规则派活"这条边的 from —— 让"规则如何在里面长出拓扑"看得见）
addNode("拓扑规则", "rules", 0);

// ── 边：累积的网 ───────────────────────────────────────────────
//
// ★ 两遍扫：先建**结构化边**（`edge:<kind> a→b`），再给**老日志**兜底。
//   ★ 我第一版一遍扫完 ⇒ `tool:challenge` 那一行比 `edge:challenge` 早几毫秒，
//     兜底逻辑以为"没有结构化边" ⇒ 凭空多出一个 `研究员→某人` 的伪边（27 条里 13 条是假的）。
type Edge = { from: string; to: string; kind: string; t: number };
const edges: Edge[] = [];
for (const e of events) {
  if (e.kind.startsWith("edge:") && e.from && e.to) {
    const kind = e.kind.slice(5);
    const from = norm(e.from);
    const to = norm(e.to);
    addNode(from, nodeMap.get(from)?.role ?? "researcher", at(e));
    addNode(to, nodeMap.get(to)?.role ?? "expert", at(e));
    edges.push({ from, to, kind, t: at(e) });
  } else if (e.kind === "fire" && e.seat) {
    edges.push({ from: "拓扑规则", to: norm(e.seat), kind: "rule-fire", t: at(e) });
  }
}
// 兜底：老日志（没有 edge: 行）用 tool:challenge 的 to 补一条，且**只在真的没有结构化边时**
for (const e of events) {
  if (e.kind !== "tool:challenge" || !e.to) continue;
  const near = edges.some((x) => x.kind === "challenge" && Math.abs(x.t - at(e)) < 2000);
  if (near) continue;
  addNode("研究员", "researcher", at(e));
  edges.push({ from: "研究员", to: norm(e.to), kind: "challenge", t: at(e) });
}
edges.sort((a, b) => a.t - b.t);

// ── 工具调用点 ─────────────────────────────────────────────────
type ToolEv = { t: number; name: string; to: string };
const toolEvs: ToolEv[] = events.filter((e) => e.tool).map((e) => ({ t: at(e), name: e.tool!, to: e.to ?? "" }));

// ── 实验 ───────────────────────────────────────────────────────
type Exp = { id: string; t: number; project: string; by: string; outcome: string; verdict: string };
const exps: Exp[] = [];
try {
  for (const l of readFileSync(join(LAB, "work", "experiments.jsonl"), "utf8").split(String.fromCharCode(10))) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as Record<string, string>;
    exps.push({
      id: r.id ?? "?",
      t: (Date.parse(r.recordedAt || r.at || "") || 0) - t0,
      project: r.project ?? "?",
      by: r.by ?? "?",
      outcome: r.outcome ?? "?",
      verdict: r.phenomenonVerdict ?? "?",
    });
  }
} catch {
  /* 没有实验账也能看 */
}

// ── 5 分钟条带（频次）──────────────────────────────────────────
const BIN = 5 * 60_000;
const nbins = Math.max(1, Math.ceil(span / BIN));
const bins = Array.from({ length: nbins }, (_, i) => ({
  i,
  t: i * BIN,
  ticks: 0,
  tools: 0,
  edges: 0,
  exps: 0,
}));
const binOf = (t: number) => Math.min(nbins - 1, Math.max(0, Math.floor(t / BIN)));
for (const e of events) {
  const b = bins[binOf(at(e))]!;
  if (e.kind === "tick:beat" || e.kind === "rule:tick") b.ticks++;
}
for (const e of toolEvs) bins[binOf(e.t)]!.tools++;
for (const e of edges) bins[binOf(e.t)]!.edges++;
for (const e of exps) if (e.t >= 0) bins[binOf(e.t)]!.exps++;

// ── 自动找病 ───────────────────────────────────────────────────
const tickTimes = events.filter((e) => e.kind === "tick:beat" || e.kind === "rule:tick").map(at);
const gaps: { from: number; to: number; min: number }[] = [];
for (let i = 1; i < tickTimes.length; i++) {
  const d = tickTimes[i]! - tickTimes[i - 1]!;
  if (d > 8 * 60_000) gaps.push({ from: tickTimes[i - 1]!, to: tickTimes[i]!, min: Math.round(d / 60000) });
}
const errors = events.filter((e) => e.kind === "error");
const tools: Record<string, number> = {};
for (const e of toolEvs) tools[e.name] = (tools[e.name] ?? 0) + 1;
const shortRun = span < 20 * 60_000;
// ★ 只查**专家**：研究员不出现在 `fire` 行里（它们是常驻的），把它算进来是假警报
const EXPERT_SEATS = ["inspector", "archivist", "inspirer", "watchdog", "libsmith"];
const deadSeats = EXPERT_SEATS.filter((s) => !nodeMap.get(s)?.fired);
const deadTools = ["record_experiment", "review_experiment", "port_run", "spawn_line", "consult", "web_search"].filter((t) => !tools[t]);
const problems = [
  ...gaps.map((g) => `★ tick 空窗 ${g.min} 分钟 —— 集群可能被卡住`),
  ...errors.map((e) => `⛔ ${e.text.replace(/^\S+\s+error\s*/, "").slice(0, 160)}`),
  ...(shortRun
    ? []
    : [
        ...deadSeats.map((s) => `★ 席位「${s}」整轮 0 次派活`),
        ...deadTools.map((t) => `★ 工具「${t}」整轮 0 次调用`),
      ]),
];

// ═══════════════════════════════════════
// ★★★★★ 研究内容（用户 2026-10-28：「时间线可以细化，可以多一个界面来展示研究内容及过程，这样我才能分析」）
//
//   ★ 之前的图只有**拓扑**（谁跟谁说话、工具调用多少次）—— 那看得出"有没有在动"，
//     **看不出它在研究什么**。要分析"研究过程"，必须把**实验本身**画进来：
//       · 每一条结构化实验（claim / killCondition / expected / 现象 / 判决 / 对照 exit）
//       · 每条产物（outbox 的 485 份）
//       · 每次争辩（谁挑战谁、挑战的是什么、判成什么）
//   ★★ 全部按**时间**排，和拓扑共用同一个时间游标 ⇒ 拖着看"这一刻它在研究什么"。
// ═══════════════════════════════════════
const clip = (v: unknown, n = 700): string => {
  const s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

type RU = {
  id: string; t: number; at: string; project: string; by: string; outcome: string;
  claim: string; kill: string; expected: string; phenomenon: string; verdict: string;
  state: string; control: string; carriers: number; reviewed: string; preregOk: boolean;
};
const researchExps: RU[] = [];
try {
  for (const l of readFileSync(join(LAB, "work", "experiments.jsonl"), "utf8").split(String.fromCharCode(10))) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as Record<string, unknown>;
    const when = String(r.at ?? r.recordedAt ?? "");
    const t = (Date.parse(when) || 0) - t0;
    const ctl = r.control as { exit?: number; cmd?: string } | undefined;
    researchExps.push({
      id: String(r.id ?? "?"),
      t: Number.isFinite(t) ? t : 0,
      at: when.slice(11, 19),
      project: String(r.project ?? "?"),
      by: String(r.by ?? "?"),
      outcome: String(r.outcome ?? "?"),
      claim: clip(r.claim),
      kill: clip(r.killCondition, 400),
      expected: clip(r.expected, 400),
      phenomenon: clip(r.phenomenon, 600),
      verdict: String(r.phenomenonVerdict ?? "未审"),
      state: String(r.conjectureState ?? "未声明"),
      control: ctl ? `exit=${ctl.exit} · ${clip(ctl.cmd, 90)}` : r.controlAbsent ? "无对照（已声明）" : "未声明",
      carriers: Array.isArray(r.carriers) ? r.carriers.length : 0,
      reviewed: String(r.reviewedBy ?? ""),
      preregOk: Boolean(r.preregBeforeRun),
    });
  }
} catch {
  /* 没有实验账也能看 */
}

const products = (() => {
  const dir = join(LAB, "outbox");
  const out: { name: string; t: number; kb: number; head: string }[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const p = join(dir, f);
      const st = statSync(p);
      let head = "";
      try {
        head = readFileSync(p, "utf8").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").slice(0, 260);
      } catch {
        /* skip */
      }
      out.push({ name: f.replace(/\.md$/, ""), t: st.mtimeMs - t0, kb: Math.round(st.size / 1024), head });
    }
  } catch {
    /* skip */
  }
  return out.sort((a, b) => a.t - b.t);
})();

const debates = (() => {
  const out: { t: number; by: string; to: string; verdict: string; claim: string; artifact: string }[] = [];
  try {
    for (const l of readFileSync(join(LAB, "work", "challenges.jsonl"), "utf8").split(String.fromCharCode(10))) {
      if (!l.trim()) continue;
      const r = JSON.parse(l) as Record<string, string>;
      out.push({
        t: (Date.parse(r.at ?? "") || 0) - t0,
        by: r.by ?? "?",
        to: r.to ?? "?",
        verdict: r.verdict ?? "",
        claim: clip(r.claim, 400),
        artifact: r.artifact ?? "",
      });
    }
  } catch {
    /* skip */
  }
  return out.sort((a, b) => a.t - b.t);
})();

// ★★★ 研究数据的时间轴必须**自己算**（2026-10-28 实测）
//   ★ 现象：泳道图里 134 条实验全挤在 x=0 —— 因为日志窗口只有 8 分钟，
//     而实验跨好几天，`t`（相对日志起点）全是负值 ⇒ 全被 clamp 到左边。
//   ★★ 判据：一个视图的时间轴必须覆盖**它要显示的数据**，不能借用别人的窗口。
const researchAxis: [number, number] = (() => {
  const ts = [
    ...researchExps.map((r) => t0 + r.t),
    ...products.map((p) => t0 + p.t),
    ...debates.map((d) => t0 + d.t),
  ].filter((x) => Number.isFinite(x) && x > 0);
  if (ts.length === 0) return [t0, t1];
  const lo = Math.min(...ts);
  const hi = Math.max(...ts);
  // 两端各留 1% 余量，避免点压在边框上
  const pad = Math.max(60_000, Math.round((hi - lo) * 0.01));
  return [lo - pad, hi + pad];
})();

const researchStats = (() => {
  const by = (k: (r: RU) => string) => {
    const m: Record<string, number> = {};
    for (const r of researchExps) m[k(r)] = (m[k(r)] ?? 0) + 1;
    return m;
  };
  return {
    exps: researchExps.length,
    products: products.length,
    debates: debates.length,
    outcomes: by((r) => r.outcome),
    verdicts: by((r) => r.verdict),
    states: by((r) => r.state),
    projects: by((r) => r.project),
  };
})();

const outboxCount = (() => {
  try {
    return readdirSync(join(LAB, "outbox")).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
})();

const data = {
  lab: LAB.replace(REPO, "").replace(/\\/g, "/"),
  log: topoPath.replace(REPO, "").replace(/\\/g, "/"),
  t0,
  t1,
  span,
  nodes: [...nodeMap.values()],
  edges,
  toolEvs,
  exps,
  bins,
  problems,
  gaps,
  events: events.map((e) => ({ t: at(e), kind: e.kind, seat: e.seat, tool: e.tool, text: e.text })),
  research: { exps: researchExps, products, debates, stats: researchStats, axis: researchAxis },
  summary: {
    durationMin: Math.round(span / 60000),
    lines: raw.length,
    ticks: tickTimes.length,
    experts: [...nodeMap.values()].filter((n) => n.role === "expert").length,
    nodes: nodeMap.size,
    edges: edges.length,
    tools,
    errors: errors.length,
    outbox: outboxCount,
    exps: exps.length,
  },
};

// ══════════════════════════════════════════════════════════════
// 生成 HTML（vis-network 内联）
// ══════════════════════════════════════════════════════════════
const VIS = (() => {
  const p = join(REPO, "node_modules", "vis-network", "standalone", "umd", "vis-network.min.js");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
})();

const html = renderHtml(data).replace("/*__VIS_NETWORK__*/", () => VIS);

// ★★★★★ 2026-10-28 · 生成器自检：页面里的 JS 必须能被解析
//
//   ★ 我刚踩的坑：往模板字符串里插了一段 JS，里面的换行转义被当成真换行 ⇒
//     生成的 HTML 整段脚本语法坏了。浏览器不会提示，表现是：
//     图画不出来、计数全空、时钟停在占位符上 —— 看起来像"数据没有"，其实是**页面死了**。
//   ★★ 这和纪律㉙ 是同一条（量具必须证明"该失败时会失败"）：一个"生成成功"的读数
//     必须先能被判成"生成了但坏了"。`new Function(js)` 就是那个判据（解析失败就抛）。
//   ★★★ 后果可数：坏页面会让我把"引擎没产出"误读成"集群没干活"。
{
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  const main = scripts[scripts.length - 1] ?? "";
  try {
    // 只解析、不执行（new Function 会在构造期做完整语法检查）
    if (!process.env.VIZ_SKIPCHECK) new Function(main);
  } catch (e) {
    throw new Error(
      `生成的时间线**脚本语法坏了**（浏览器会静默失败：图空白、时钟不动、计数全空）：${(e as Error).message}\n` +
        "  ★ 多半是往模板字符串里插 JS 时，转义写成了真换行 —— 模板里必须双写反斜杠。",
    );
  }
}

mkdirSync(join(REPO, "logs"), { recursive: true });
const out = join(REPO, "logs", "hunt-timeline.html");
writeFileSync(out, html, "utf8");
console.log(
  [
    `★ 时间线已生成：${out}`,
    `  · ${data.summary.durationMin} 分钟 · ${data.summary.lines} 行日志 · ${data.summary.ticks} tick · ${data.summary.nodes} 个 agent 节点 · ${data.summary.edges} 条关系边`,
    `  · 实验 ${exps.length} 条 · outbox ${outboxCount} 份 · 报错 ${errors.length} 条 · 空窗 ${gaps.length} 处`,
    VIS ? "  · vis-network 已内联（离线可看）" : "  ⚠ 没找到 vis-network ⇒ 图退化成静态列表（先 `npm i -D vis-network`）",
    problems.length ? `  · ★ 自动找到 ${problems.length} 处可疑` : "  · ★ 没找到可疑处",
  ].join("\n"),
);
if (process.argv.includes("--open")) {
  const { execFile } = await import("node:child_process");
  const args = process.platform === "win32" ? ["/c", "start", "", out] : [out];
  execFile(process.platform === "win32" ? "cmd" : "open", args);
}

function renderHtml(d: typeof data): string {
  const json = JSON.stringify(d).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>hunt 拓扑时间线 · ${d.lab}</title>
<style>
:root{--bg:#0d1014;--panel:#151a20;--line:#242c36;--fg:#dbe3ec;--dim:#8494a6;--accent:#57c8ff;--warn:#ffb020;--bad:#ff5f56;--ok:#3ddc84}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--fg);font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
/* ★★★★★ 2026-10-27 · **页面无限变高的 bug**
   ★ 症状：打开后高度一直涨、像卡死。
   ★ 根因：vis-network 默认 autoResize:true，而它所在的容器是 flex 里 flex:1 的项，
     没有 min-height:0 ⇒ 容器高度由内容（canvas）撑 ⇒ vis 又把 canvas 设成容器大小
     ⇒ **容器变高 → resize 事件 → vis 再变高**，死循环。
   ★★ 修：① 整页固定视口（body 用 grid 行，overflow:hidden）
          ② 每个可能被内容撑开的格子都写 min-height:0
          ③ 关掉 vis 的 autoResize，改由我们显式 setSize
   这一族和"观察者自己成了阻塞源"同类：**量具（画布）和容器互相定义尺寸。** */
body{display:grid;grid-template-rows:auto 1fr;height:100vh}
header{display:flex;gap:16px;align-items:baseline;padding:8px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
h1{margin:0;font-size:13px;font-weight:600;letter-spacing:.02em}
.dim{color:var(--dim)}
.wrap{display:grid;grid-template-columns:1fr 340px;min-height:0;overflow:hidden}
.left{display:grid;grid-template-rows:1fr auto auto;min-height:0;min-width:0;overflow:hidden}
#graph{position:relative;min-height:0;overflow:hidden;background:radial-gradient(circle at 50% 40%,#131a22,#0d1014 70%)}
.bar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid var(--line);flex-wrap:wrap}
button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 10px;cursor:pointer;font:inherit}
button:hover{border-color:var(--accent)}
input[type=range]{flex:1;min-width:120px}
.strip{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px 12px 10px}
.strip canvas{display:block;width:100%;height:56px;background:var(--panel);border:1px solid var(--line);border-radius:6px}
.side{border-left:1px solid var(--line);overflow:auto;min-height:0;padding:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:8px 10px;margin-bottom:10px}
.card h2{font-size:11px;margin:0 0 6px;color:var(--dim);letter-spacing:.06em;font-weight:600}
table{border-collapse:collapse;width:100%}
td{padding:1px 6px 1px 0;vertical-align:top}
td.n{text-align:right;color:var(--accent);white-space:nowrap}
.bar2{height:7px;background:#1d242d;border-radius:3px;overflow:hidden;margin-top:2px}
.bar2 i{display:block;height:100%;background:var(--accent)}
.tag{display:inline-block;padding:0 5px;border-radius:3px;background:#1d242d;color:var(--dim);margin-right:4px;font-size:11px}
.recent div{padding:1px 0;border-bottom:1px dotted #1d242d}
.esc{color:var(--bad)} .warn{color:var(--warn)} .ok{color:var(--ok)}
.big{font-size:15px;color:var(--accent)}
/* ── 页签（2026-10-28：一个文件里放四个视图，共用同一个时间游标）── */
.tabs{display:flex;gap:6px;margin-left:auto}
.tab{background:transparent;color:var(--dim);border:1px solid transparent;border-radius:6px;padding:3px 10px}
.tab.on{background:var(--panel);color:var(--fg);border-color:var(--accent)}
.view{display:none;min-height:0;overflow:hidden}
.view.on{display:grid}
/* 研究过程：泳道 */
#v-flow{grid-template-columns:1fr 330px;grid-template-rows:1fr}
#flowWrap{position:relative;overflow:auto;min-height:0;padding:6px 0}
#flowSvg{display:block}
.detail{border-left:1px solid var(--line);overflow:auto;min-height:0;padding:10px;background:#101519}
.detail h3{margin:0 0 6px;font-size:12px;color:var(--accent)}
.detail .k{color:var(--dim);font-size:11px;letter-spacing:.05em;margin-top:8px}
.detail .v{white-space:pre-wrap;word-break:break-word}
/* 研究内容：卡片 + 过滤 */
#v-cards{grid-template-columns:1fr;grid-template-rows:auto 1fr}
.filters{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line);align-items:center}
.filters input[type=text]{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:5px;padding:3px 8px;font:inherit;min-width:200px}
.chip{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:2px 9px;cursor:pointer;color:var(--dim)}
.chip.on{border-color:var(--accent);color:var(--fg)}
#cardList{overflow:auto;min-height:0;padding:10px 12px}
.ru{background:var(--panel);border:1px solid var(--line);border-left:3px solid #3d4a5a;border-radius:6px;padding:7px 10px;margin-bottom:7px;cursor:pointer}
.ru:hover{border-color:var(--accent)}
.ru .h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.ru .id{color:var(--accent);font-weight:600}
.ru .cl{margin-top:3px;color:var(--fg);opacity:.92}
.ru.open{border-left-color:var(--accent)}
.ru .more{display:none;margin-top:7px;border-top:1px dotted #263040;padding-top:6px}
.ru.open .more{display:block}
.ru.dead{border-left-color:var(--bad)}
.ru.hold{border-left-color:var(--warn)}
.pill{font-size:11px;padding:0 6px;border-radius:4px;background:#1d242d}
.pill.ok{color:var(--ok)} .pill.bad{color:var(--bad)} .pill.warn{color:var(--warn)} .pill.dim{color:var(--dim)}
/* 数字 */
#v-nums{grid-template-columns:1fr;grid-template-rows:auto 1fr}
#numsWrap{overflow:auto;min-height:0;padding:6px 14px;align-self:start}
</style></head><body>
<header>
  <h1>hunt 拓扑时间线</h1>
  <span class="dim">${d.lab}</span>
  <span class="dim">${new Date(d.t0).toLocaleString()} → ${new Date(d.t1).toLocaleTimeString()}（${d.summary.durationMin} 分钟）</span>
  <span class="dim">${d.summary.nodes} 节点 · ${d.summary.edges} 关系边</span>
  <span class="big" id="clock">--:--:--</span>
  <span class="tabs">
    <button class="tab on" data-view="topo">拓扑</button>
    <button class="tab" data-view="flow">研究过程</button>
    <button class="tab" data-view="cards">研究内容</button>
    <button class="tab" data-view="nums">数字</button>
  </span>
</header>
<div class="wrap view on" id="v-topo">
  <div class="left">
    <div id="graph"></div>
    <div class="bar">
      <button id="play">▶ 播放</button>
      <button id="b1">&lt;&lt; 5m</button>
      <button id="f1">5m &gt;&gt;</button>
      <button id="next">下一事件</button>
      <input id="scrub" type="range" min="0" max="1000" value="0">
      <span class="dim">倍速</span><input id="speed" type="range" min="1" max="120" value="40" style="width:90px">
      <span class="dim" id="speedv">40×</span>
    </div>
    <div class="strip">
      <canvas id="c1" title="每 5 分钟 tick 数"></canvas>
      <canvas id="c2" title="每 5 分钟工具调用"></canvas>
      <canvas id="c3" title="每 5 分钟新增关系边"></canvas>
      <canvas id="c4" title="每 5 分钟新实验"></canvas>
    </div>
  </div>
  <div class="side">
    <div class="card"><h2>到这一刻为止</h2><table id="counters"></table></div>
    <div class="card"><h2>工具调用</h2><div id="toolbars"></div></div>
    <div class="card"><h2>agent 关系（入/出）</h2><table id="degrees"></table></div>
    <div class="card"><h2>它自己找出的问题</h2><div id="problems"></div></div>
    <div class="card"><h2>最近事件</h2><div class="recent" id="recent"></div></div>
  </div>
</div>

<!-- ★ 研究过程：泳道（每条实验一个点，按项目分行，拖着看它在研究什么） -->
<div class="view" id="v-flow">
  <div id="flowWrap"><svg id="flowSvg"></svg></div>
  <!-- 范围切换在数字页签里，两个视图共用一个状态 -->
  <div class="detail" id="detail"><div class="dim">点一个点看它的全部字段（claim / killCondition / expected / 现象 / 对照 exit / 载体）。</div></div>
</div>

<!-- ★ 研究内容：可搜可筛的卡片 -->
<div class="view" id="v-cards">
  <div class="filters">
    <input id="q" type="text" placeholder="搜 claim / id / 项目 / 谁做的…">
    <span class="chip on" data-f="all">全部</span>
    <span class="chip" data-f="死">死</span>
    <span class="chip" data-f="挂起">挂起</span>
    <span class="chip" data-f="真意外">真意外</span>
    <span class="chip" data-f="补的">判「补的」</span>
    <span class="chip" data-f="未审">未审</span>
    <span class="chip" data-f="已验证">猜想已验证</span>
    <span class="dim" id="cardCount"></span>
  </div>
  <div id="cardList"></div>
</div>

<!-- ★ 数字：累计曲线（研究有没有在推进，一眼看得出） -->
<div class="view" id="v-nums">
  <div class="filters">
    <span class="chip on" data-norm="0">绝对数（可比较量级）</span>
    <span class="chip" data-norm="1">归一化（看形状）</span>
    <span class="chip" data-range="0">全部</span>
    <span class="chip on" data-range="72">最近 72 小时</span>
    <span class="chip" data-range="24">最近 24 小时</span>
    <span class="dim">★ 产物一直在长；实验/争辩是后段才出现的 —— 用归一化看趋势更清楚</span>
  </div>
  <div id="numsWrap"><svg id="numsSvg"></svg></div>
</div>
<script>/*__VIS_NETWORK__*/</script>
<script>
const D = ${json};
const $ = (id) => document.getElementById(id);
const T1 = D.span;
let cur = 0, playing = false, speed = 40, last = 0;

const ROLE_COLOR = { researcher:"#3ddc84", expert:"#57c8ff", line:"#c792ea", rules:"#ffb020" };
const EDGE_COLOR = { challenge:"#ff7b72", consult:"#d2a8ff", feedback:"#58a6ff", "rule-fire":"#3d4a5a" };

// ── vis-network：先用**全量图**算一次布局，再按时间揭示（拖动时布局不跳）──
const nodesDS = new vis.DataSet(D.nodes.map(n=>({
  id:n.id, label:n.id,
  group:n.role,
  value: 1 + (n.fired||0) + (n.results||0),
  color:{background:ROLE_COLOR[n.role]||"#888", border:"#0d1014"},
  font:{color:"#dbe3ec", size:13},
  shape: n.role==="rules" ? "box" : "dot",
})));
const edgesDS = new vis.DataSet(D.edges.map((e,i)=>({
  id:i, from:e.from, to:e.to,
  color:{color:EDGE_COLOR[e.kind]||"#556", opacity:0.55},
  width: e.kind==="rule-fire" ? 0.7 : 1.4,
  dashes: e.kind==="rule-fire",
  arrows:{to:{enabled:true, scaleFactor:0.5}},
  title: e.kind,
})));
const options = {
  // ★ autoResize 必须关：容器高度一旦由内容决定，它就和画布互相撑（页面无限变高）
  autoResize:false,
  physics:{ stabilization:{ iterations: 260, fit:true }, barnesHut:{ gravitationalConstant:-9000, springLength:120, springConstant:0.03, damping:0.4 } },
  interaction:{ hover:true, multiselect:false },
  nodes:{ scaling:{ min:6, max:34 } },
  edges:{ smooth:{ type:"continuous", roundness:0.35 } },
};
const network = new vis.Network($('graph'), {nodes:nodesDS, edges:edgesDS}, options);

// 按时间揭示（同时把"最近 5 分钟"的边点亮）
let ei = 0;
/** ★ 全量重设（初次、往回拖、以及"跳到某个时刻"都走它）—— 保证可见性和时间严格一致 */
function applyVisibility(t){
  edgesDS.update(D.edges.map((e,i)=>({
    id:i, hidden: e.t > t,
    color:{color:EDGE_COLOR[e.kind]||"#556", opacity: (t - e.t < 300000 && e.t <= t) ? 1 : 0.45},
    width: e.kind==="rule-fire" ? 0.7 : 1.5,
  })));
  nodesDS.update(D.nodes.map(n=>({id:n.id, hidden: n.born > t})));
  ei = 0; while (ei < D.edges.length && D.edges[ei].t <= t) ei++;
  cur = t;
}

function seek(t){
  if (t < cur) { // 往回拖：全部重设
    ei = 0;
    const upd = D.edges.map((e,i)=>({id:i, hidden: e.t > t, color:{color:EDGE_COLOR[e.kind]||"#556", opacity: e.t>t-300000?1:0.45}, width: e.kind==="rule-fire"?0.7:1.4 }));
    edgesDS.update(upd);
    nodesDS.update(D.nodes.map(n=>({id:n.id, hidden: n.born > t})));
    while (ei < D.edges.length && D.edges[ei].t <= t) ei++;
  } else {
    const fresh = [];
    while (ei < D.edges.length && D.edges[ei].t <= t) { fresh.push(ei); ei++; }
    if (fresh.length) {
      edgesDS.update(fresh.map(i=>({id:i, hidden:false, color:{color:(EDGE_COLOR[D.edges[i].kind]||"#556"), opacity:1}, width: D.edges[i].kind==="rule-fire"?0.7:2.2})));
    }
    nodesDS.update(D.nodes.filter(n=>n.born>cur && n.born<=t).map(n=>({id:n.id, hidden:false})));
  }
  cur = t;
}

function upto(arr, key){ let lo=0,hi=arr.length; while(lo<hi){const m=(lo+hi)>>1; if(arr[m][key]<=cur) lo=m+1; else hi=m;} return lo; }

function drawCounters(){
  const toolN = D.toolEvs.filter(e=>e.t<=cur);
  const expN = D.exps.filter(e=>e.t<=cur);
  const inRun = D.nodes.filter(n=>n.born<=cur);
  const rows = [
    ["时间", new Date(D.t0+cur).toTimeString().slice(0,8)],
    ["节点（已出现）", inRun.length+" / "+D.nodes.length],
    ["关系边", upto(D.edges,'t')+" / "+D.edges.length],
    ["tick 累计", D.events.filter(e=>(e.kind==='tick:beat'||e.kind==='rule:tick')&&e.t<=cur).length],
    ["工具调用", toolN.length],
    ["结构化实验", expN.length+" / "+D.exps.length],
  ];
  $('counters').innerHTML = rows.map(([k,v])=>'<tr><td class=dim>'+k+'</td><td class=n>'+v+'</td></tr>').join('');
  // 工具直方图
  const byName = {};
  for(const e of toolN) byName[e.name]=(byName[e.name]||0)+1;
  const max = Math.max(1,...Object.values(byName));
  $('toolbars').innerHTML = Object.entries(byName).sort((a,b)=>b[1]-a[1]).map(([k,v])=>
    '<div><span class=dim>'+k+'</span> <span class=n style="float:right">'+v+'</span><div class="bar2"><i style="width:'+(100*v/max)+'%"></i></div></div>').join('') || '<span class=dim>还没有</span>';
  // 入/出度
  const out={}, inc={};
  for(const e of D.edges) if(e.t<=cur){ out[e.from]=(out[e.from]||0)+1; inc[e.to]=(inc[e.to]||0)+1; }
  const ids = [...new Set([...Object.keys(out),...Object.keys(inc)])];
  $('degrees').innerHTML = ids.sort((a,b)=>((inc[b]||0)+(out[b]||0))-((inc[a]||0)+(out[a]||0)))
    .map(id=>'<tr><td>'+id+'</td><td class=n>'+(inc[id]||0)+'</td><td class=n>'+(out[id]||0)+'</td></tr>').join('')
    || '<tr><td class=dim>还没有关系</td></tr>';
}

function drawRecent(){
  const ev = D.events.filter(e=>e.t<=cur).slice(-16).reverse();
  $('recent').innerHTML = ev.map(e=>
    '<div><span class=dim>'+new Date(D.t0+e.t).toTimeString().slice(0,8)+'</span> <b>'+(e.kind||'')+'</b> '+
    esc((e.text||'').replace(/^\\S+\\s+\\S+\\s*/,'')).slice(0,120)+'</div>'
  ).join('');
}
// ═══════════════════════════════════════
// ★ 研究过程（泳道）+ 研究内容（卡片）+ 数字（累计曲线）
//   三者共用 cur —— 拖动时间轴，这三个视图同步只显示「那一刻之前发生的」
// ═══════════════════════════════════════
let rangeH = 72;  // 默认最近 72 小时（研究跨度 218h，全看会挤成一团；chip 里的默认高亮也换成 72）；否则只看"最近 N 小时"（研究跨度 218h，全看会挤成一团）
function axisNow(){
  const [a0, a1] = D.research.axis;
  if (!rangeH) return [a0, a1];
  const cut = a1 - rangeH * 3600000;
  return [Math.max(a0, cut), a1];
}
const OC = { "活":"#3ddc84", "挂起":"#ffb020", "死":"#ff5f6d" };
const VD = { "真意外":"#57c8ff", "补的":"#ff9f43", "未审":"#6b7a8c" };
let pickId = null;

function svg(tag, attrs, kids){
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for(const k in attrs) el.setAttribute(k, attrs[k]);
  for(const c of (kids||[])) el.appendChild(c);
  return el;
}
function txt(x,y,s,color,size=11){
  const t = svg("text",{x,y,"font-size":size,fill:color||"#8494a6","font-family":"ui-monospace,Consolas,monospace"});
  t.textContent = s; return t;
}

/** 泳道：y = 项目（按实验数排序），x = 时间；点大小 = 载体数，颜色 = 结局 */
function drawFlow(){
  const wrap = $("flowWrap");
  if(!wrap) return;
  const W = Math.max(600, wrap.clientWidth - 8), H = Math.max(260, wrap.clientHeight - 8);
  const padL = 96, padB = 26, padT = 18;
  const lanes = Object.entries(D.research.stats.projects).sort((a,b)=>b[1]-a[1]).map(([k])=>k);
  lanes.push("· 产物", "· 争辩");
  const laneH = Math.max(28, (H - padT - padB) / Math.max(1,lanes.length));
  // ★ 研究视图用**自己的**时间轴（R0..R1 = 研究数据的跨度），不借用日志窗口
  const [R0, R1] = axisNow();
  const xAbs = (abs) => padL + (Math.max(0,Math.min(1, (abs - R0) / (R1 - R0)))) * (W - padL - 14);
  const x = (rel) => xAbs(D.t0 + rel);          // 相对日志起点 → 绝对 → 轴上
  const nowAbs = D.t0 + cur;
  const y = (lane) => padT + lanes.indexOf(lane) * laneH + laneH/2;

  const root = $("flowSvg");
  root.innerHTML = "";
  root.setAttribute("width", W); root.setAttribute("height", padT + lanes.length*laneH + padB);

  lanes.forEach((ln,i)=>{
    root.appendChild(svg("rect",{x:24,y:padT+i*laneH,width:W-40,height:laneH-3,fill:i%2?"#12171d":"#151b22",rx:4}));
    const name = ln.startsWith("· ") ? ln.slice(2) : ln;
    const cnt = ln.startsWith("· ") ? "" : " ("+(D.research.stats.projects[ln]||0)+")";
    root.appendChild(txt(30, y(ln)+4, name + cnt, "#dbe3ec", 11));
  });
  const spanR = R1 - R0, tickMs = Math.max(60000, Math.ceil(spanR/8/60000)*60000);
  for(let a=R0;a<=R1;a+=tickMs){
    const gx = xAbs(a);
    root.appendChild(svg("line",{x1:gx,y1:padT,x2:gx,y2:padT+lanes.length*laneH,stroke:"#1d242d","stroke-width":1}));
    const d = new Date(a);
    const lab = spanR > 36*3600_000 ? (d.getMonth()+1)+"-"+d.getDate()+" "+String(d.getHours()).padStart(2,"0")+":00"
                                    : String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
    root.appendChild(txt(gx+2, padT+lanes.length*laneH+14, lab, "#6b7a8c", 10));
  }
  const jitter = {};
  for(const r of D.research.exps){
    if(r.t > cur) continue;
    // ★ 同一项目在相近时刻会有很多点重叠 ⇒ 按出现顺序上下错开（最远 ±0.34 车道高）
    const k0 = r.project; const idx = (jitter[k0] = (jitter[k0] ?? -1) + 1);
    const off = ((idx % 3) - 1) * laneH * 0.3;
    const cx = x(r.t), cy = y(r.project) + off;
    const r0 = 3 + Math.min(6, r.carriers * 1.5);
    const dot = svg("circle",{cx, cy: cy, r: r0, fill: OC[r.outcome]||"#8494a6", stroke: r.id===pickId?"#fff":"#0d1014","stroke-width": r.id===pickId?2:1});
    dot.style.cursor = "pointer";
    dot.addEventListener("click", ()=>{ pickId = r.id; showDetail(r); drawFlow(); });
    const ttl = svg("title",{});
    ttl.textContent = r.id+" · "+r.project+" · "+r.outcome+" · "+r.verdict+"\\n"+r.claim.slice(0,140);
    dot.appendChild(ttl);
    root.appendChild(dot);
    if(r.verdict === "补的") root.appendChild(svg("circle",{cx, cy, r: r0+2.5, fill:"none", stroke:VD["补的"],"stroke-width":1,opacity:.8}));
  }
  for(const p of D.research.products){
    if(p.t > cur) continue;
    const px = x(p.t), py = y("· 产物");
    const line = svg("line",{x1:px,y1:py-7,x2:px,y2:py+7,stroke:"#57c8ff","stroke-width":1.6,opacity:.85});
    line.style.cursor="pointer";
    const ttl = svg("title",{}); ttl.textContent = p.name + " · " + p.kb + "KB\\n" + p.head.slice(0,160);
    line.appendChild(ttl);
    line.addEventListener("click", ()=>{
      $("detail").innerHTML = '<h3>'+esc(p.name)+'</h3><div class="k">'+new Date(D.t0+p.t).toLocaleString()+' · '+p.kb+'KB</div><div class="v">'+esc(p.head)+'…</div>';
    });
    root.appendChild(line);
  }
  for(const dbg of D.research.debates){
    if(dbg.t > cur) continue;
    const px = x(dbg.t), py = y("· 争辩");
    const c = svg("rect",{x:px-2,y:py-2.5,width:4,height:5,fill:"#c792ea"});
    const ttl = svg("title",{}); ttl.textContent = dbg.by+" → "+dbg.to+" · "+dbg.verdict+"\\n"+dbg.claim.slice(0,160);
    c.appendChild(ttl); c.style.cursor="pointer";
    c.addEventListener("click", ()=>{
      $("detail").innerHTML = '<h3>争辩 '+esc(dbg.by)+' → '+esc(dbg.to)+'</h3><div class="k">'+esc(dbg.verdict)+'</div><div class="v">'+esc(dbg.claim)+'</div><div class="k">对象</div><div class="v">'+esc(dbg.artifact)+'</div>';
    });
    root.appendChild(c);
  }
  if(nowAbs >= R0 && nowAbs <= R1){
    root.appendChild(svg("line",{x1:xAbs(nowAbs),y1:padT,x2:xAbs(nowAbs),y2:padT+lanes.length*laneH,stroke:"#fff","stroke-width":1,opacity:.6}));
  }
  root.appendChild(txt(30, padT-4, "研究跨度 "+Math.round(spanR/3600000)+" 小时 · 已显示到 "+new Date(nowAbs).toLocaleString(), "#8494a6", 10));
}

function showDetail(r){
  const rows = [
    ["claim", r.claim], ["killCondition", r.kill],
    ["expected（PREREG 里逐字写过？"+(r.preregOk?"是":"否")+"）", r.expected],
    ["现象", r.phenomenon], ["同侪判决", r.verdict + (r.reviewed?"（"+r.reviewed+" 审）":"")],
    ["猜想状态", r.state], ["对照", r.control], ["载体数", String(r.carriers)],
  ];
  $("detail").innerHTML =
    '<h3>'+esc(r.id)+' · '+esc(r.project)+' · '+esc(r.by)+'</h3>'+
    '<span class="pill '+(r.outcome==="死"?"bad":r.outcome==="挂起"?"warn":"ok")+'">'+esc(r.outcome)+'</span> '+
    '<span class="pill">'+esc(r.at)+'</span>'+
    rows.map(([k,v])=>'<div class="k">'+esc(k)+'</div><div class="v">'+esc(v||"—")+'</div>').join("");
}

// ── 研究内容（卡片）──
let cardFilter = "all", cardQ = "";
function cardMatch(r){
  if(r.t > cur) return false;
  if(cardFilter === "死" && r.outcome !== "死") return false;
  if(cardFilter === "挂起" && r.outcome !== "挂起") return false;
  if(cardFilter === "真意外" && r.verdict !== "真意外") return false;
  if(cardFilter === "补的" && r.verdict !== "补的") return false;
  if(cardFilter === "未审" && r.verdict !== "未审") return false;
  if(cardFilter === "已验证" && r.state !== "已验证") return false;
  if(cardQ){
    const hay = (r.id+" "+r.project+" "+r.by+" "+r.claim+" "+r.phenomenon+" "+r.expected).toLowerCase();
    for(const w of cardQ.split(/\\s+/)) if(w && !hay.includes(w.toLowerCase())) return false;
  }
  return true;
}
function drawCards(){
  const list = $("cardList");
  if(!list) return;
  if(!$("v-cards").classList.contains("on")) return;
  const rows = D.research.exps.filter(cardMatch).slice().reverse();
  $("cardCount").textContent = rows.length+" / "+D.research.exps.length+" 条实验（截止这一刻）";
  list.innerHTML = rows.map(r=>{
    const cls = r.outcome==="死"?"dead":r.outcome==="挂起"?"hold":"";
    return '<div class="ru '+cls+'"><div class="h"><span class="id">'+esc(r.id)+'</span>'+
      '<span class="pill">'+esc(r.project)+'</span>'+
      '<span class="pill '+(r.outcome==="死"?"bad":r.outcome==="挂起"?"warn":"ok")+'">'+esc(r.outcome)+'</span>'+
      '<span class="pill '+(r.verdict==="补的"?"warn":r.verdict==="未审"?"dim":"")+'">'+esc(r.verdict)+'</span>'+
      '<span class="pill dim">'+esc(r.by)+'</span>'+
      '<span class="pill dim">载体 '+r.carriers+'</span>'+
      '<span class="dim">'+esc(r.at)+'</span></div>'+
      '<div class="cl">'+esc(r.claim.slice(0,220))+'</div>'+
      '<div class="more"><div class="k">killCondition</div><div class="v">'+esc(r.kill)+'</div>'+
      '<div class="k">expected（跑前写过？'+(r.preregOk?"是":"否")+'）</div><div class="v">'+esc(r.expected)+'</div>'+
      '<div class="k">现象</div><div class="v">'+esc(r.phenomenon)+'</div>'+
      '<div class="k">对照</div><div class="v">'+esc(r.control)+'</div>'+
      '<div class="k">猜想状态</div><div class="v">'+esc(r.state)+'</div></div></div>';
  }).join("") || '<div class="dim">这一刻还没有实验</div>';
  list.querySelectorAll(".ru").forEach(el=>el.addEventListener("click",()=>el.classList.toggle("open")));
}

// ── 数字：累计曲线 ──
let numsNorm = false;
function drawNums(){
  const root = $("numsSvg");
  if(!root || !$("v-nums").classList.contains("on")) return;
  const W = Math.max(700, $("numsWrap").clientWidth - 24), H = 400;
  root.innerHTML = ""; root.setAttribute("width", W); root.setAttribute("height", H);
  const padL = 46, padB = 28, padT = 16, padR = 170;
  const series = [
    ["实验（累计）", "#57c8ff", D.research.exps.map(r=>r.t)],
    ["产物（累计）", "#3ddc84", D.research.products.map(p=>p.t)],
    ["争辩（累计）", "#c792ea", D.research.debates.map(d=>d.t)],
    ["死的实验（累计）", "#ff5f6d", D.research.exps.filter(r=>r.outcome==="死").map(r=>r.t)],
    ["判「补的」（累计）", "#ffb020", D.research.exps.filter(r=>r.verdict==="补的").map(r=>r.t)],
  ].map(s=>({name:s[0],color:s[1],ts:s[2].filter(t=>t<=cur).sort((a,b)=>a-b)}));
  const maxY = numsNorm ? 1 : Math.max(1, ...series.map(s=>s.ts.length));
  const valOf = (sv, i) => numsNorm ? (i+1)/Math.max(1, sv.ts.length) : (i+1);
  const [N0, N1] = axisNow();
  const x = (rel)=> padL + (Math.max(0,Math.min(1,(D.t0+rel-N0)/(N1-N0))))*(W-padL-padR);
  const y = (v)=> padT + (1 - v/maxY)*(H-padT-padB);
  for(let i=0;i<=4;i++){
    const gy = y(maxY*i/4);
    root.appendChild(svg("line",{x1:padL,y1:gy,x2:W-padR,y2:gy,stroke:"#1d242d"}));
    root.appendChild(txt(padL-6, gy+4, String(Math.round(maxY*i/4)), "#6b7a8c", 10));
  }
  series.forEach((s,si)=>{
    if(!s.ts.length) return;
    // ★★★ 2026-10-28 · 别从原点起笔（那会画出一条**不存在的数据线**）
    //   ★ 现象：debate 的第一个点在第 72% 处，而我从「M padL,y(0)」起笔 ⇒
    //     图上多出一条横跨 0→72% 的假曲线 —— 看起来像"争辩从第一天就有"。
    //   ★★ 正确画法：先垂直落到第一个点，再从那里开始累计。
    const t0p = s.ts[0];
    let d = "M"+x(t0p)+","+y(0)+" L"+x(t0p)+","+y(valOf(s,0)*maxY);
    s.ts.forEach((t,i)=> d += " L"+x(t)+","+y(valOf(s,i)*maxY));
    root.appendChild(svg("path",{d,fill:"none",stroke:s.color,"stroke-width":1.8}));
    const lastT = s.ts[s.ts.length-1], lastV = valOf(s, s.ts.length-1)*maxY;
    root.appendChild(svg("circle",{cx:x(lastT),cy:y(lastV),r:2.6,fill:s.color}));
    root.appendChild(svg("rect",{x:W-padR+8,y:padT+si*20,width:9,height:9,fill:s.color,rx:2}));
    root.appendChild(txt(W-padR+22, padT+si*20+9, s.name+" = "+s.ts.length + (numsNorm?"（归一）":""), "#dbe3ec", 11));
  });
  // x 刻度（按研究跨度选步长）
  const spanN = N1 - N0, tickN = Math.max(60000, Math.ceil(spanN/7/3600000)*3600000);
  for(let a=N0;a<=N1;a+=tickN){
    const gx = padL + ((a-N0)/spanN)*(W-padL-padR);
    root.appendChild(svg("line",{x1:gx,y1:padT,x2:gx,y2:H-padB,stroke:"#161c23"}));
    const d=new Date(a);
    root.appendChild(txt(gx+2, H-padB+13, (d.getMonth()+1)+"-"+d.getDate()+" "+String(d.getHours()).padStart(2,"0")+":00", "#6b7a8c", 10));
  }
  // 当前时刻竖线
  const nx = padL + ((D.t0+cur-N0)/spanN)*(W-padL-padR);
  if(nx >= padL && nx <= W-padR) root.appendChild(svg("line",{x1:nx,y1:padT,x2:nx,y2:H-padB,stroke:"#fff","stroke-width":1,opacity:.45}));
  root.appendChild(txt(padL, padT-4, "累计曲线（截至光标 "+new Date(D.t0+cur).toLocaleString()+"）", "#8494a6", 11));
}

// ── 页签 ──
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("on", x===b));
  const v = b.dataset.view;
  document.querySelectorAll(".view").forEach(x=>x.classList.toggle("on", x.id === "v-"+v));
  if(v==="topo"){ fitGraph(); }
  if(v==="flow") drawFlow();
  if(v==="cards") drawCards();
  if(v==="nums") drawNums();
}));
const qEl = $("q");
if(qEl) qEl.addEventListener("input", ()=>{ cardQ = qEl.value.trim(); drawCards(); });
document.querySelectorAll(".chip[data-f]").forEach(c=>c.addEventListener("click",()=>{
  document.querySelectorAll(".chip[data-f]").forEach(x=>x.classList.toggle("on", x===c));
  cardFilter = c.dataset.f; drawCards();
}));
document.querySelectorAll(".chip[data-range]").forEach(c=>c.addEventListener("click",()=>{
  document.querySelectorAll(".chip[data-range]").forEach(x=>x.classList.toggle("on", x===c));
  rangeH = Number(c.dataset.range) || 0; drawNums(); drawFlow();
}));
document.querySelectorAll(".chip[data-norm]").forEach(c=>c.addEventListener("click",()=>{
  document.querySelectorAll(".chip[data-range]").forEach(c=>c.addEventListener("click",()=>{
  document.querySelectorAll(".chip[data-range]").forEach(x=>x.classList.toggle("on", x===c));
  rangeH = Number(c.dataset.range) || 0; drawNums(); drawFlow();
}));
document.querySelectorAll(".chip[data-norm]").forEach(x=>x.classList.toggle("on", x===c));
  numsNorm = c.dataset.norm === "1"; drawNums();
}));

function esc(s){return (s||'').replace(/[<>&]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]))}

// ── 4 个条带（纯 canvas，5 分钟一格）──
function drawBins(){
  const spec = [['c1','ticks','#57c8ff'],['c2','tools','#c792ea'],['c3','edges','#3ddc84'],['c4','exps','#ffd166']];
  for(const [id,key,color] of spec){
    const c=$(id), r=c.getBoundingClientRect();
    const W=Math.round(r.width*devicePixelRatio), H=Math.round(r.height*devicePixelRatio);
    if (c.width !== W) c.width = W;      // ★ 只在尺寸变了才重设（否则每帧清屏）
    if (c.height !== H) c.height = H;
    const x=c.getContext('2d'); x.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
    const w=r.width,h=r.height; x.clearRect(0,0,w,h);
    const max=Math.max(1,...D.bins.map(b=>b[key]));
    const bw=w/D.bins.length;
    for(const b of D.bins){
      const bh=(b[key]/max)*(h-14);
      x.fillStyle = (D.t0+b.t>D.t0+cur) ? '#2a323c' : color;
      x.fillRect(b.i*bw+1, h-bh-4, Math.max(1,bw-2), bh);
    }
    // 光标
    x.fillStyle='#fff'; x.fillRect((cur/T1)*w, 0, 1, h);
    // 标题
    x.fillStyle='#8494a6'; x.font='10px ui-monospace'; x.fillText(key+' / 5min  max '+max, 6, 11);
  }
}

function drawProblems(){
  $('problems').innerHTML = D.problems.length
    ? D.problems.map(p=>'<div class="'+(p.startsWith('⛔')?'esc':'warn')+'" style="margin-bottom:5px">'+esc(p)+'</div>').join('')
    : '<div class="ok">★ 没找到可疑处</div>';
}

function drawAll(){ drawCounters(); drawRecent(); drawBins(); $('clock').textContent=new Date(D.t0+cur).toTimeString().slice(0,8); }

function setCur(t){ t=Math.max(0,Math.min(T1,t)); seek(t); $('scrub').value=String(Math.round(t/T1*1000)); drawAll(); }

$('scrub').addEventListener('input', e=>{ playing=false; $('play').textContent='▶ 播放'; setCur(Number(e.target.value)/1000*T1); });
$('play').addEventListener('click', ()=>{ playing=!playing; $('play').textContent=playing?'⏸ 暂停':'▶ 播放'; last=performance.now(); });
$('speed').addEventListener('input', e=>{ speed=Number(e.target.value); $('speedv').textContent=speed+'×'; });
$('b1').addEventListener('click', ()=>setCur(cur-300000));
$('f1').addEventListener('click', ()=>setCur(cur+300000));
$('next').addEventListener('click', ()=>{ const n=D.events.find(e=>e.t>cur); if(n) setCur(n.t); });

function loop(now){
  if(playing){
    const dt=(now-last)||16; last=now;
    const rate=T1*speed/600;              // 倍速 N ⇒ 整段用 600/N 秒放完
    let n=cur+rate*(dt/1000);
    if(n>=T1){ n=T1; playing=false; $('play').textContent='▶ 播放'; }
    setCur(n);
  }
  requestAnimationFrame(loop);
}
function fitGraph(){
  const el = $('graph');
  const w = Math.max(200, el.clientWidth), h = Math.max(160, el.clientHeight);
  network.setSize(w+"px", h+"px");
  network.redraw();
}
network.once('stabilizationIterationsDone', ()=>{
  network.setOptions({physics:{enabled:false}});
  fitGraph();
  // ★ 布局用**全量图**算好（这样拖动时点不跳），算完立刻按 t=0 只显示"已经发生的"
  // ★ 从 URL 定位到某一刻（单位**秒**，人可以敲）：...html#t=900 或 ?t=900 = 第 15 分钟
  const q = new URLSearchParams(location.search).get("t") ?? (/#t=([0-9]+)/.exec(location.hash) || [])[1];
  const want = (Number(q ?? 0) || 0) * 1000;
  // ★ 页签也能从 URL 指定：...html#view=flow&t=900（方便你直接打开"研究过程"）
  const vw = new URLSearchParams(location.search).get("view") ?? (/#view=([a-z]+)/.exec(location.hash) || [])[1];
  if (vw) { const b = document.querySelector('.tab[data-view="'+vw+'"]'); if (b) b.click(); }
  // ★ 也能直接定位到某一条实验：...html?view=flow&pick=E134
  const pk = new URLSearchParams(location.search).get("pick") ?? (/pick=([A-Za-z0-9_-]+)/.exec(location.hash) || [])[1];
  if (pk) { const r0 = D.research.exps.find(x=>x.id===pk); if (r0) { pickId = r0.id; showDetail(r0); drawFlow(); } }
  applyVisibility(0);
  setCur(Number.isFinite(want) ? want : 0);
});
drawProblems(); drawAll(); requestAnimationFrame(loop);
window.addEventListener('resize', ()=>{ fitGraph(); drawBins(); });
</script>
</body></html>`;
}
