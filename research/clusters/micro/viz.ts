/**
 * ★★★★★ hunt 时间线可视化（2026-10-27）
 *
 * 为什么要它：设计者要"便于分析集群有什么问题"。
 * 而 `_topology.log` 是**一万多行文本**，人眼在里面找"哪里卡住了、谁一次没跑、外网调用多不多"
 * 基本做不到。这份脚本把它变成**一条能拖的时间线**：
 *
 *   · 时间轴：可拖动 / 可播放（拖到任意时刻，看那一时刻的集群长什么样）
 *   · 席位泳道：3 个研究员 + 每位专家（fire ▶ … result · N 字）= 谁在什么时候在跑
 *   · 工具点：`record_experiment` / `review_experiment` / `web_search` … 各自一个小点
 *   · 拓扑边：challenge / consult / 回流 在那一刻发生在谁和谁之间
 *   · 计数：到那一刻为止的实验数、各类工具次数、专家次数
 *   · **自动找病**：tick 空窗（冻结）、0 次派活的席位、收尾后仍失败的投递、报错行
 *
 * ★ 全部离线：读落盘，生成**一个自包含 HTML**（无外部依赖、无网络），双击即看。
 * ★★ 纪律⑦：数据是纯函数算的，同一份日志任何时候重算结果一致。
 *
 * 用法：
 *   npm run viz                        # 生成 logs/hunt-timeline.html
 *   npx tsx research/clusters/micro/viz.ts <lab> [--open]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const LAB = (() => {
  const a = process.argv[2];
  if (a && !a.startsWith("--")) return a.startsWith("/") || /^[A-Za-z]:/.test(a) ? a : join(REPO, a);
  return join(REPO, process.env.HUNT_LAB || "research/labfirst/hunt");
})();

type Ev = {
  /** 毫秒时间戳 */
  t: number;
  kind: string;
  /** 席位（专家名 / 研究员 key）——能解析出来才有 */
  seat?: string;
  /** 工具名 */
  tool?: string;
  /** 原文（截断）*/
  text: string;
};

// ★ 可以指定某一轮：`viz.ts <lab> --log=work/runs/topology-2026-10-27T06-11-14.log`
//   ★★ 想看历史轮：`viz.ts <lab> --list`
const wantLog = process.argv.find((a) => a.startsWith("--log="))?.split("=")[1];
const runsDir = join(LAB, "work", "runs");
if (process.argv.includes("--list")) {
  const files = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.startsWith("topology-") && f.endsWith(".log")).sort() : [];
  console.log(`★ ${LAB.replace(REPO, "")} 的历史轮次（${files.length} 个）：`);
  for (const f of files) {
    const p = join(runsDir, f);
    const txt = readFileSync(p, "utf8");
    const n = txt.split(String.fromCharCode(10)).filter(Boolean).length;
    const head = (txt.split(String.fromCharCode(10))[0] ?? "").slice(0, 19);
    console.log(`  · work/runs/${f}　${head}　${n} 行`);
  }
  console.log("");
  console.log(`用法：npx tsx research/clusters/micro/viz.ts ${LAB.replace(REPO, "")} --log=work/runs/<文件名>`);
  process.exit(0);
}
const topoPath = wantLog
  ? wantLog.startsWith("/") || /^[A-Za-z]:/.test(wantLog)
    ? wantLog
    : join(LAB, wantLog)
  : join(LAB, "work", "_topology.log");
if (!existsSync(topoPath)) {
  console.error(`⛔ 找不到日志：${topoPath}`);
  process.exit(1);
}
const raw = readFileSync(topoPath, "utf8").split("\n").filter((l) => l.trim());

/** ★ 专家席位名（按出现频率排序，不用写死）*/
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

const events: Ev[] = [];
for (const line of raw) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(\S+)\s*(.*)$/.exec(line);
  if (!m) continue;
  const t = Date.parse(m[1]!);
  if (!Number.isFinite(t)) continue;
  const kind = m[2]!;
  const rest = m[3] ?? "";
  let seat: string | undefined;
  let tool: string | undefined;
  if (kind === "tool:" || kind.startsWith("tool:")) {
    tool = kind.slice(5);
  } else if (kind === "fire" || kind === "result" || kind === "rule:fire") {
    seat = KNOWN_SEATS.find((s) =>
      kind === "fire" ? rest.startsWith(s) : new RegExp(`(^|[^a-z-])${s}([^a-z-]|$)`).test(rest),
    );
  }
  events.push({ t, kind, seat, tool, text: line.slice(0, 220) });
}

const t0 = events[0]?.t ?? Date.now();
const t1 = events[events.length - 1]?.t ?? t0;
const span = Math.max(1, t1 - t0);

// ── 席位泳道：fire ▶ … result 配对（按席位，先到先配）────────────────
type Span = { seat: string; from: number; to: number; chars?: number };
const spans: Span[] = [];
const openFire = new Map<string, number>();
for (const e of events) {
  if (e.kind === "fire" && e.seat) {
    if (!openFire.has(e.seat)) openFire.set(e.seat, e.t);
  } else if (e.kind === "result" && e.seat) {
    const from = openFire.get(e.seat);
    const chars = Number(/(\d+)\s*字/.exec(e.text)?.[1] ?? 0);
    if (from !== undefined) {
      spans.push({ seat: e.seat, from, to: e.t, chars });
      openFire.delete(e.seat);
    } else {
      spans.push({ seat: e.seat, from: e.t, to: e.t, chars });
    }
  }
}
// 没等到 result 的（收尾时被丢的）—— 用日志末尾封口，并标记
for (const [seat, from] of openFire) spans.push({ seat, from, to: t1, chars: -1 });

// ── tick 心跳（找空窗 = 冻结）────────────────────────────────────
const ticks = events.filter((e) => e.kind === "tick:beat" || e.kind === "rule:tick").map((e) => e.t);
const gaps: { from: number; to: number; min: number }[] = [];
for (let i = 1; i < ticks.length; i++) {
  const d = ticks[i]! - ticks[i - 1]!;
  if (d > 8 * 60_000) gaps.push({ from: ticks[i - 1]!, to: ticks[i]!, min: Math.round(d / 60000) });
}

// ── 工具账 ──────────────────────────────────────────────────────
const tools: Record<string, number> = {};
for (const e of events) if (e.tool) tools[e.tool] = (tools[e.tool] ?? 0) + 1;

// ── 结构化实验（时间点上加标记）─────────────────────────────────
type Exp = { id: string; t: number; project: string; by: string; outcome: string; verdict: string };
const exps: Exp[] = [];
try {
  for (const l of readFileSync(join(LAB, "work", "experiments.jsonl"), "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as Record<string, string>;
    exps.push({
      id: r.id ?? "?",
      t: Date.parse(r.recordedAt || r.at || "") || 0,
      project: r.project ?? "?",
      by: r.by ?? "?",
      outcome: r.outcome ?? "?",
      verdict: r.phenomenonVerdict ?? "?",
    });
  }
} catch {
  /* 没有实验账也能看时间线 */
}

// ── 自动找病（这些都是"有名字的"判据，不是感觉）──────────────────
const errors = events.filter((e) => e.kind === "error");
const seatFired: Record<string, number> = {};
for (const e of events) if (e.kind === "fire" && e.seat) seatFired[e.seat] = (seatFired[e.seat] ?? 0) + 1;
const deadSeats = KNOWN_SEATS.filter((s) => !seatFired[s]);
const deadTools = ["record_experiment", "review_experiment", "port_run", "spawn_line", "consult", "web_search"].filter(
  (t) => !tools[t],
);
// ★ 太短的一轮里"某席位 0 次"是正常的（还没轮到它），别当成问题报
const shortRun = span < 20 * 60_000;
const problems = [
  ...gaps.map((g) => `★ tick 空窗 ${g.min} 分钟（${new Date(g.from).toLocaleTimeString()} → ${new Date(g.to).toLocaleTimeString()}）—— 这一段时间集群可能被卡住`),
  ...errors.map((e) => `⛔ 报错：${e.text.replace(/^\S+\s+error\s*/, "").slice(0, 120)}`),
  ...(shortRun
    ? []
    : [
        ...deadSeats.map((s) => `★ 席位「${s}」整轮 **0 次**派活 —— 要么不需要它，要么它没接上`),
        ...deadTools.map((t) => `★ 工具「${t}」整轮 **0 次**调用`),
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
  t0,
  t1,
  span,
  events: events.map((e) => ({ t: e.t - t0, kind: e.kind, seat: e.seat, tool: e.tool, text: e.text })),
  spans: spans.map((s) => ({ seat: s.seat, from: s.from - t0, to: s.to - t0, chars: s.chars })),
  ticks: ticks.map((t) => t - t0),
  exps: exps.map((e) => ({ ...e, t: e.t - t0 })),
  problems,
  summary: {
    durationMin: Math.round(span / 60000),
    lines: raw.length,
    ticks: ticks.length,
    experts: spans.length,
    errors: errors.length,
    tools,
    seats: [...new Set(spans.map((s) => s.seat))],
    outbox: outboxCount,
    gaps: gaps.length,
  },
};

const html = renderHtml(data);
mkdirSync(join(REPO, "logs"), { recursive: true });
const out = join(REPO, "logs", "hunt-timeline.html");
writeFileSync(out, html, "utf8");
console.log(
  [
    `★ 时间线已生成：${out}`,
    `  · ${data.summary.durationMin} 分钟 · ${data.summary.lines} 行日志 · ${data.summary.ticks} 次 tick · ${data.summary.experts} 次专家`,
    `  · 实验 ${exps.length} 条 · outbox ${outboxCount} 份 · 报错 ${errors.length} 条 · 空窗 ${gaps.length} 处`,
    problems.length ? `  · ★ 自动找到 ${problems.length} 处可疑（页面左侧「它自己找出的问题」）` : "  · ★ 没找到可疑处",
  ].join("\n"),
);
if (process.argv.includes("--open")) {
  const { execFile } = await import("node:child_process");
  execFile(process.platform === "win32" ? "cmd" : "open", process.platform === "win32" ? ["/c", "start", "", out] : [out]);
}

// ══════════════════════════════════════════════════════════════
// HTML（自包含 · 无依赖 · 深色 · 可拖时间轴）
// ══════════════════════════════════════════════════════════════
function renderHtml(d: typeof data): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>hunt 时间线 · ${d.lab}</title>
<style>
:root{--bg:#0f1216;--panel:#171b21;--line:#2a313a;--fg:#d7dee7;--dim:#8b97a6;--accent:#5ac8fa;--warn:#ffb020;--bad:#ff5f56;--ok:#3ddc84}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
header{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:baseline;flex-wrap:wrap}
h1{font-size:14px;margin:0;font-weight:600}
.tag{color:var(--dim)}
.wrap{display:grid;grid-template-columns:1fr 320px;gap:0;height:calc(100vh - 46px)}
.main{overflow:auto;padding:12px 14px}
.side{border-left:1px solid var(--line);overflow:auto;padding:12px}
.row{display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
button:hover{border-color:var(--accent)}
input[type=range]{width:100%}
canvas{display:block;background:var(--panel);border:1px solid var(--line);border-radius:8px}
.k{color:var(--dim)}
.big{font-size:20px;color:var(--accent)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:12px}
.card h2{font-size:12px;margin:0 0 8px;color:var(--dim);font-weight:600;letter-spacing:.04em}
.legend span{display:inline-block;margin-right:10px;color:var(--dim)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:middle}
.esc{color:var(--bad)} .warn{color:var(--warn)} .ok{color:var(--ok)}
pre{margin:0;white-space:pre-wrap;word-break:break-all;color:var(--dim);font-size:12px}
table{border-collapse:collapse;width:100%}
td{padding:2px 6px 2px 0;vertical-align:top}
td.n{text-align:right;color:var(--accent)}
.hl{background:#1d2630}
</style></head><body>
<header>
  <h1>hunt 时间线</h1>
  <span class="tag">${d.lab}</span>
  <span class="tag">${new Date(d.t0).toLocaleString()} → ${new Date(d.t1).toLocaleTimeString()}（${d.summary.durationMin} 分钟）</span>
</header>
<div class="wrap">
  <div class="main">
    <div class="row">
      <button id="play">▶ 播放</button>
      <button id="prev" title="上一个事件">⟨ 上一件</button>
      <button id="next" title="下一个事件">下一件 ⟩</button>
      <span class="k">倍速</span>
      <input id="speed" type="range" min="1" max="120" value="60" style="width:120px">
      <span id="speedv" class="k">60×</span>
      <span class="big" id="clock">--:--:--</span>
      <span class="tag" id="elapsed"></span>
    </div>
    <input id="scrub" type="range" min="0" max="1000" value="0">
    <canvas id="strip" height="54" style="width:100%;margin-bottom:10px"></canvas>
    <canvas id="lanes" height="240" style="width:100%;margin-bottom:10px"></canvas>
    <canvas id="topo" height="260" style="width:100%"></canvas>
    <div class="legend" style="margin-top:8px">
      <span><i style="background:var(--ok)"></i>专家在跑</span>
      <span><i style="background:var(--warn)"></i>跑完但没等到 result（被丢）</span>
      <span><i style="background:var(--accent)"></i>tick</span>
      <span><i style="background:var(--bad)"></i>报错</span>
      <span><i style="background:#c792ea"></i>工具调用</span>
      <span><i style="background:#ffd166"></i>结构化实验</span>
    </div>
  </div>
  <div class="side">
    <div class="card"><h2>到这一刻为止</h2>
      <table id="counters"></table>
    </div>
    <div class="card"><h2>它自己找出的问题</h2>
      <div id="problems"></div>
    </div>
    <div class="card"><h2>最近事件</h2>
      <div id="recent"></div>
    </div>
  </div>
</div>
<script>
const D = ${JSON.stringify(d).replace(/</g, "\\u003c")};
const $ = (id) => document.getElementById(id);
const T0 = 0, T1 = D.span;
let cur = 0, playing = false, speed = 60, last = 0;

const SEATS = D.summary.seats.slice().sort();
const COLORS = {};
const PAL = ['#3ddc84','#5ac8fa','#c792ea','#ffd166','#ff9f43','#f76c6c','#7bd389','#9aa7ff'];
SEATS.forEach((s,i)=>COLORS[s]=PAL[i%PAL.length]);

function fmt(ms){const d=new Date(D.t0+ms);return d.toTimeString().slice(0,8)}
function fmtMin(ms){return Math.round(ms/60000)+' 分'}

// ── 计数器：二分找 <= cur ───────────────────────────────────────
function upto(arr, key){let lo=0,hi=arr.length;while(lo<hi){const m=(lo+hi)>>1;if(arr[m][key]<=cur)lo=m+1;else hi=m}return lo}
const toolNames = Object.keys(D.summary.tools).sort();

function drawCounters(){
  const eN = upto(D.exps,'t');
  const tN = toolNames.map(n=>({n,c:D.events.filter(e=>e.tool===n && e.t<=cur).length}));
  const expIn = D.spans.filter(s=>s.from<=cur&&cur<=s.to).length;
  const rows = [
    ['时间', fmt(cur)],
    ['tick 累计', upto(D.ticks.map(t=>({t})),'t')],
    ['专家在跑', expIn],
    ['专家累计', D.spans.filter(s=>s.from<=cur).length],
    ['结构化实验', eN+' / '+D.exps.length],
    ...tN.map(x=>['tool · '+x.n, x.c]),
  ];
  $('counters').innerHTML = rows.map(([k,v])=>'<tr><td class=k>'+k+'</td><td class=n>'+v+'</td></tr>').join('');
}

function drawRecent(){
  const ev = D.events.filter(e=>e.t<=cur).slice(-14).reverse();
  $('recent').innerHTML = ev.map(e=>{
    const c = e.kind==='error'?'esc':(e.tool?'':(e.kind.startsWith('tick')?'':''));
    return '<div class="'+c+'"><span class=k>'+fmt(e.t)+'</span> <b>'+e.kind+'</b> '+
      (e.seat?'<span style="color:'+(COLORS[e.seat]||'#fff')+'">'+e.seat+'</span> ':'')+
      esc(e.text.replace(/^\S+\s+\S+\s*/,'')).slice(0,110)+'</div>';
  }).join('');
}
function esc(s){return (s||'').replace(/[<>&]/g,m=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]))}

function canvasW(c){const r=c.getBoundingClientRect();c.width=r.width*devicePixelRatio;c.height=c.height||c.clientHeight;const x=c.getContext('2d');x.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);return {x,w:r.width,h:c.clientHeight}}

// ── ① 顶部条：tick 密度 + 空窗 + 报错 + 工具点 ──────────────────
function drawStrip(){
  const {x,w,h}=canvasW($('strip'));
  x.clearRect(0,0,w,h);
  const px=(t)=>t/T1*w;
  // 空窗（红带）
  const gaps=[]; for(let i=1;i<D.ticks.length;i++){const d=D.ticks[i]-D.ticks[i-1]; if(d>8*60000) gaps.push([D.ticks[i-1],D.ticks[i]])}
  x.fillStyle='rgba(255,95,86,.18)';for(const [a,b] of gaps) x.fillRect(px(a),0,Math.max(2,px(b)-px(a)),h);
  // tick 小竖线
  x.strokeStyle='#5ac8fa99';x.beginPath();for(const t of D.ticks){const X=px(t);x.moveTo(X,4);x.lineTo(X,h-4)}x.stroke();
  // 工具点（紫色，画在上半）
  x.fillStyle='#c792ea';for(const e of D.events) if(e.tool){x.fillRect(px(e.t)-1,6,2,6)}
  // 实验点（黄色，下半）
  x.fillStyle='#ffd166';for(const e of D.exps){x.fillRect(px(e.t)-1,h-14,2,8)}
  // 报错（红）
  x.fillStyle='#ff5f56';for(const e of D.events) if(e.kind==='error'){x.fillRect(px(e.t)-1,10,3,h-20)}
  // 光标
  x.fillStyle='#fff';x.fillRect(px(cur)-1,0,2,h);
}

// ── ② 席位泳道 ──────────────────────────────────────────────────
function drawLanes(){
  const {x,w,h}=canvasW($('lanes'));
  x.clearRect(0,0,w,h);
  const laneH=Math.max(14,Math.floor((h-8)/Math.max(1,SEATS.length)));
  const px=(t)=>t/T1*w;
  x.font='11px ui-monospace,monospace';
  SEATS.forEach((s,i)=>{
    const y=4+i*laneH;
    x.fillStyle='#8b97a6';x.fillText(s,2,y+laneH-4);
    // 泳道底
    x.fillStyle='#1b2027';x.fillRect(96,y,laneH-6>0?w-96:0,laneH-4);
    for(const sp of D.spans.filter(v=>v.seat===s)){
      const a=px(sp.from), b=Math.max(a+2,px(sp.to));
      x.fillStyle = sp.chars===(-1) ? '#ffb020' : (COLORS[s]||'#3ddc84');
      x.globalAlpha=.85;x.fillRect(96+a,y-0,b,laneH-5);x.globalAlpha=1;
    }
    // 现在在跑的高亮
    for(const sp of D.spans.filter(v=>v.seat===s&&v.from<=cur&&cur<=v.to)){
      x.strokeStyle='#fff';x.strokeRect(96+px(sp.from),y-0,Math.max(2,px(sp.to)-px(sp.from)),laneH-5);
    }
  });
  x.fillStyle='#fff';x.fillRect(96+px(cur),0,1,h);
}

// ── ③ 拓扑：谁和谁在说话（近 15 分钟内的 challenge/consult/回流）──
function drawTopo(){
  const {x,w,h}=canvasW($('topo'));
  x.clearRect(0,0,w,h);
  const cx=w/2, cy=h/2, R=Math.min(w,h)*0.34;
  const nodes = ['3 位研究员','hands-on','falsifier','instrument-skeptic',...SEATS];
  const uniq=[...new Set(nodes)];
  const pos={};
  uniq.forEach((s,i)=>{const a=-Math.PI/2+i*2*Math.PI/uniq.length;pos[s]={x:cx+R*Math.cos(a),y:cy+R*Math.sin(a)}});
  // 边：challenge / consult / 回流 在最近窗口内
  const W=15*60000;
  const rel = D.events.filter(e=>e.t<=cur&&e.t>cur-W&&(e.kind==='tool:challenge'||e.kind==='tool:consult'||e.kind==='flow'));
  x.font='11px ui-monospace,monospace';
  for(const [s,p] of Object.entries(pos)){
    const active = rel.some(e=>(e.text||'').includes(s));
    x.beginPath();x.arc(p.x,p.y,active?9:6,0,7);
    x.fillStyle = active ? '#5ac8fa' : '#2a313a';x.fill();
    x.fillStyle='#d7dee7';x.fillText(s,p.x+12,p.y+4);
  }
  // 画几条"发言"线（从中心往说话的人）
  rel.slice(-24).forEach((e,i)=>{
    const target=Object.keys(pos).find(k=>(e.text||'').includes(k));
    if(!target)return;
    const p=pos[target];
    x.strokeStyle='rgba(90,200,250,'+(0.15+0.5*(i/Math.max(1,rel.length))).toFixed(2)+')';
    x.beginPath();x.moveTo(cx,cy);x.lineTo(p.x,p.y);x.stroke();
  });
  x.fillStyle='#8b97a6';x.fillText('近 15 分钟：挑战 / 请教 / 回流（线越亮越新）',10,16);
}

function drawProblems(){
  $('problems').innerHTML = D.problems.length
    ? D.problems.map(p=>'<div style="margin-bottom:6px" class="'+((p.startsWith('⛔'))?'esc':'warn')+'">'+esc(p)+'</div>').join('')
    : '<div class="ok">★ 没找到可疑处</div>';
}

function drawAll(){drawCounters();drawRecent();drawStrip();drawLanes();drawTopo();$('clock').textContent=fmt(cur);$('elapsed').textContent='已过 '+fmtMin(cur)+' / '+fmtMin(T1)}

function setCur(t){cur=Math.max(0,Math.min(T1,t));$('scrub').value=String(Math.round(cur/T1*1000));drawAll()}

$('scrub').addEventListener('input',e=>{playing=false;$('play').textContent='▶ 播放';setCur(Number(e.target.value)/1000*T1)});
$('play').addEventListener('click',()=>{playing=!playing;$('play').textContent=playing?'⏸ 暂停':'▶ 播放';last=performance.now()});
$('speed').addEventListener('input',e=>{speed=Number(e.target.value);$('speedv').textContent=speed+'×'});
$('next').addEventListener('click',()=>{const n=D.events.find(e=>e.t>cur);if(n)setCur(n.t)});
$('prev').addEventListener('click',()=>{const p=[...D.events].reverse().find(e=>e.t<cur-1);if(p)setCur(p.t)});
$('problems').addEventListener('click',()=>{});

function loop(now){
  if(playing){
    const dt=(now-last)||16;last=now;
    // 倍速的含义：**整段时间线用 (600/倍速) 秒放完**（60× ⇒ 10 秒走完全程）
    const rate=T1 * speed / 600;
    let n=cur+rate*(dt/1000);
    if(n>=T1){n=T1;playing=false;$('play').textContent='▶ 播放'}
    setCur(n);
  }
  requestAnimationFrame(loop);
}
drawProblems();drawAll();requestAnimationFrame(loop);
window.addEventListener('resize',drawAll);
</script>
</body></html>`;
}
