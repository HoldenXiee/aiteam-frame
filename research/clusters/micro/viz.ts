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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const deadSeats = KNOWN_SEATS.filter((s) => !nodeMap.get(s)?.fired);
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
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
header{display:flex;gap:16px;align-items:baseline;padding:8px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
h1{margin:0;font-size:13px;font-weight:600;letter-spacing:.02em}
.dim{color:var(--dim)}
.wrap{display:grid;grid-template-columns:1fr 340px;height:calc(100% - 39px)}
.left{display:flex;flex-direction:column;min-width:0}
#graph{flex:1;min-height:260px;background:radial-gradient(circle at 50% 40%,#131a22,#0d1014 70%)}
.bar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid var(--line);flex-wrap:wrap}
button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 10px;cursor:pointer;font:inherit}
button:hover{border-color:var(--accent)}
input[type=range]{flex:1;min-width:120px}
.strip{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px 12px 10px}
.strip canvas{width:100%;height:56px;background:var(--panel);border:1px solid var(--line);border-radius:6px}
.side{border-left:1px solid var(--line);overflow:auto;padding:10px}
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
</style></head><body>
<header>
  <h1>hunt 拓扑时间线</h1>
  <span class="dim">${d.lab}</span>
  <span class="dim">${new Date(d.t0).toLocaleString()} → ${new Date(d.t1).toLocaleTimeString()}（${d.summary.durationMin} 分钟）</span>
  <span class="dim">${d.summary.nodes} 节点 · ${d.summary.edges} 关系边</span>
  <span class="big" id="clock">--:--:--</span>
</header>
<div class="wrap">
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
  physics:{ stabilization:{ iterations: 260 }, barnesHut:{ gravitationalConstant:-9000, springLength:120, springConstant:0.03, damping:0.4 } },
  interaction:{ hover:true, multiselect:false },
  nodes:{ scaling:{ min:6, max:34 } },
  edges:{ smooth:{ type:"continuous", roundness:0.35 } },
};
const network = new vis.Network($('graph'), {nodes:nodesDS, edges:edgesDS}, options);

// 按时间揭示（同时把"最近 5 分钟"的边点亮）
let ei = 0;
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
function esc(s){return (s||'').replace(/[<>&]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]))}

// ── 4 个条带（纯 canvas，5 分钟一格）──
function drawBins(){
  const spec = [['c1','ticks','#57c8ff'],['c2','tools','#c792ea'],['c3','edges','#3ddc84'],['c4','exps','#ffd166']];
  for(const [id,key,color] of spec){
    const c=$(id), r=c.getBoundingClientRect(); c.width=r.width*devicePixelRatio; c.height=r.height*devicePixelRatio;
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
network.once('stabilizationIterationsDone', ()=>{
  network.setOptions({physics:{enabled:false}});
  setCur(0);
});
drawProblems(); drawAll(); requestAnimationFrame(loop);
window.addEventListener('resize', drawAll);
</script>
</body></html>`;
}
