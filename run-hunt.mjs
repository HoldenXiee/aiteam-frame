#!/usr/bin/env node
/**
 * ★★★★★ 每天点一下就跑 hunt（不限时 · 不限制）
 *
 * 用法：双击「跑hunt.cmd」等价于 `node run-hunt.mjs`
 *   node run-hunt.mjs                 一直跑（窗口 7 天 ≈ 不限），Ctrl+C 或「停hunt」才收尾
 *   node run-hunt.mjs --verbose       把集群的每一行都打到控制台（默认只打心跳）
 *   node run-hunt.mjs --minutes=600   这次只跑 10 小时
 *   node run-hunt.mjs --dry           只搭装置不投递（零模型成本）
 *
 * ─────────────────────────────────────────────────────────────
 * ★★★ 2026-10-27 · **控制台改成"只看得出它在动"，全文进日志**
 *
 *   设计者原话：减少打印日志，只保留能看出在运行的行（如第几个 tick），
 *   其余放本地文件，另配一个可视化脚本看数据。
 *
 *   ⇒ 控制台只打四类：
 *     ① 启动横幅（配置 + 日志路径）
 *     ② **心跳**（默认每 30 秒一行）：tick 数 · 实验条数 · outbox 份数 · 专家在跑 · 多久没活动
 *     ③ 关键事件（马上打）：收尾开始 / 收尾完成 / 快照 / 报错 / 成本
 *     ④ 退出摘要
 *   其余全部进 `logs/hunt-YYYY-MM-DD.log`（一行不丢），可视化脚本从日志与落盘读数出图。
 *
 * ★ 心跳里那项「多久没活动」是**故意的**：它就是"集群卡住了"的可判据信号
 *   （历史上三次冻死都是"日志一片空白"，肉眼在那时看不出任何东西）。
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB_REL = process.env.HUNT_LAB || "research/labfirst/hunt";
const LAB = join(HERE, LAB_REL);
const LOCK = join(LAB, "work", "_cluster.lock");
const TOPO = join(LAB, "work", "_topology.log");
const EXPS = join(LAB, "work", "experiments.jsonl");
const LOG_DIR = join(HERE, "logs");

const argv = process.argv.slice(2);
const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const dry = argv.includes("--dry");
const verbose = argv.includes("--verbose");
const minutes = Number(arg("minutes") ?? 0);
const heartbeatSec = Number(arg("heartbeat") ?? 30);

// ── ① 已经在跑吗（不抢锁、不并发）────────────────────────────────
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
if (existsSync(LOCK)) {
  const raw = readFileSync(LOCK, "utf8").trim();
  const pid = Number(/pid=(\d+)/.exec(raw)?.[1] ?? NaN);
  if (Number.isFinite(pid) && pidAlive(pid)) {
    console.log(
      [
        "═".repeat(62),
        `★ 已经在跑了（PID ${pid}）。**不重复启动** —— 并发会毁数据。`,
        `  · 看它在干什么：双击「看时间线.cmd」，或 tail ${LAB_REL}/work/_topology.log`,
        `  · 想停它：双击「停hunt.cmd」`,
        "═".repeat(62),
      ].join("\n"),
    );
    process.exit(0);
  }
  console.log(`★ 陈旧锁（pid=${pid || "?"} 已不在）⇒ 集群自己会接管。`);
}

// ── ② 环境：能放松的都放松 ──────────────────────────────────────
const env = {
  ...process.env,
  HUNT_FIRE_CONCURRENCY: process.env.HUNT_FIRE_CONCURRENCY ?? "8",
  EXTERNAL_MS: process.env.EXTERNAL_MS ?? "300000", // 5 分钟：网上探索权重更大
  EXTERNAL_MAX: process.env.EXTERNAL_MAX ?? "9999",
  PHENOMENON_MS: process.env.PHENOMENON_MS ?? "720000",
  HUNT_CLOSE_CAP_MS: process.env.HUNT_CLOSE_CAP_MS ?? "180000",
};

const secs = minutes > 0 ? Math.round(minutes * 60) : 7 * 24 * 3600;

const now = new Date();
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
mkdirSync(LOG_DIR, { recursive: true });
const LOG = join(LOG_DIR, `hunt-${day}.log`);

// ── ②b 轮转：**不许清空上一轮的日志**（纪律⑩：旧数据不能随便丢）
//
//   ★ 实测代价：这一版之前，每启动一次 `_topology.log` 就被清空
//     ⇒ 我把设计者跑的那 6 小时那轮日志**当场覆盖了**，时间线只能从已生成的 HTML 里看。
//   ★★ 现在：启动前若 `_topology.log` 非空 ⇒ 归档到 `work/runs/topology-<时间>.log`。
mkdirSync(join(LAB, "work", "runs"), { recursive: true });
try {
  if (existsSync(TOPO) && readFileSync(TOPO, "utf8").trim()) {
    const iso = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = join(LAB, "work", "runs", `topology-${iso}.log`);
    const { renameSync } = await import("node:fs");
    renameSync(TOPO, dest);
  }
} catch (e) {
  console.log(`  ⚠ 归档上一轮日志失败（不影响本轮）：${e && e.message ? e.message : String(e)}`);
}

// ── ③ 启动横幅（这是控制台上唯一一段长文本）─────────────────────
const banner = [
  "═".repeat(62),
  `★ hunt 集群 · ${now.toLocaleString()}`,
  `  空间 ${LAB_REL} · 窗口 ${minutes > 0 ? `${minutes} 分钟` : "不限（7 天 ≈ 永久）"}`,
  `  专家并发 ${env.HUNT_FIRE_CONCURRENCY} · 外网每 ${Math.round(Number(env.EXTERNAL_MS) / 60000)} 分钟一次`,
  `  完整日志  ${LOG}`,
  `  可视化    双击「看时间线.cmd」（跑多久都能看，包含卡住时的空窗）`,
  `  ★ 控制台只打心跳；想逐行看：node run-hunt.mjs --verbose`,
  "═".repeat(62),
].join("\n");
console.log(banner);
appendFileSync(LOG, banner + "\n", "utf8");

// ── ④ 起进程 ────────────────────────────────────────────────────
const args = ["tsx", "research/clusters/hunt/index.ts", `--secs=${secs}`];
if (dry) args.push("--dry");

const child =
  process.platform === "win32"
    ? // ★ 不用 `shell: true` + args（Node 会报 DEP0190 且引号行为不稳）：
      //   直接给 cmd.exe 一条**完整命令行**
      spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npx ${args.join(" ")}`], {
        cwd: HERE,
        env,
        stdio: ["inherit", "pipe", "pipe"],
        windowsVerbatimArguments: true,
      })
    : spawn("npx", args, { cwd: HERE, env, stdio: ["inherit", "pipe", "pipe"] });

const startedAt = Date.now();
const stat = { ticks: 0, experts: 0, results: 0, tools: {}, errors: 0, lastEventAt: Date.now(), expSeen: -1 };

const countExps = () => {
  try {
    return readFileSync(EXPS, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
};
const countOutbox = () => {
  try {
    return readdirSync(join(LAB, "outbox")).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
};

/** 一行 → 全部进日志；控制台只挑关键事件 */
const handleLine = (line) => {
  if (!line.trim()) return;
  appendFileSync(LOG, line + "\n", "utf8");
  if (verbose) process.stdout.write(line + "\n");

  stat.lastEventAt = Date.now();
  // ★ 两种行都要认：
  //   · 落盘日志：`2026-10-27T06:13:33.804Z  fire  libsmith ← …`
  //   · 控制台：  `  fire        libsmith ← …`（没有时间戳）
  //   ★ 我第一次只认了带时间戳的那种 ⇒ 心跳里 tick 永远是 0（假读数）。
  const kind = (() => {
    const withTs = /^\d{4}-\d{2}-\d{2}T\S+\s+(\S+)/.exec(line);
    if (withTs) return withTs[1];
    const plain = /^\s*(tick:beat|rule:[a-zA-Z]+|tool:[a-z_]+|fire|result|error|window|close|snapshot|cost|flow|seat|setup|todo|readout|lib|auth)(?![a-z])/.exec(line);
    return plain?.[1] ?? "";
  })();
  if (process.env.HUNT_DEBUG_KIND) console.error(`[kind] ${JSON.stringify(kind)} ← ${JSON.stringify(line.slice(0, 46))}`);
  if (kind === "tick:beat" || kind === "rule:tick") stat.ticks++;
  else if (kind === "fire") stat.experts++;
  else if (kind === "result") stat.results++;
  else if (kind.startsWith("tool:")) {
    const t = kind.slice(5);
    stat.tools[t] = (stat.tools[t] ?? 0) + 1;
  } else if (kind === "error") {
    stat.errors++;
    console.log(`  ⛔ ${line.slice(0, 150)}`);
  } else if (kind === "window" || kind === "close" || kind === "snapshot" || kind === "cost" || kind === "rule:done") {
    console.log(`  ▸ ${line.slice(0, 150)}`);
  }
};

let buf = "";
const onData = (b) => {
  buf += b.toString();
  const parts = buf.split("\n");
  buf = parts.pop() ?? "";
  for (const l of parts) handleLine(l.replace(/\r$/, ""));
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);

// ── ⑤ 心跳：一行说清"它还活着吗、进展到哪"──────────────────────
const hhmmss = (d = new Date()) => d.toTimeString().slice(0, 8);
const dur = (ms) => {
  const s = Math.floor(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
const beat = setInterval(() => {
  const quiet = Date.now() - stat.lastEventAt;
  const tools = Object.entries(stat.tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_experiment|_content|_search/g, (s) => s.replace("_", ""))} ${v}`)
    .join(" · ");
  // ★ "静默" 超过 4 分钟就标红：这就是"卡住了"的可判据信号
  const flag = quiet > 4 * 60_000 ? ` ⚠ 静默 ${dur(quiet)}（可能卡住了）` : "";
  console.log(
    `  ${hhmmss()} · 已跑 ${dur(Date.now() - startedAt)} · tick ${stat.ticks} · 实验 ${countExps()} · outbox ${countOutbox()} · 专家 ${stat.experts}/完 ${stat.results}${tools ? ` · ${tools}` : ""}${flag}`,
  );
}, heartbeatSec * 1000);

// Ctrl+C：让集群自己收尾
process.on("SIGINT", () => {
  console.log("\n★ Ctrl+C ⇒ 通知集群进收尾（落账 / 回流 / 删锁）…");
  child.kill("SIGINT");
});

child.on("exit", (code) => {
  clearInterval(beat);
  const tail = (() => {
    try {
      return readFileSync(TOPO, "utf8").split("\n").filter((l) => l.includes("rule:done")).pop();
    } catch {
      return undefined;
    }
  })();
  console.log(
    [
      "═".repeat(62),
      `★ 退出码 ${code} · 跑了 ${dur(Date.now() - startedAt)} · tick ${stat.ticks} · 专家 ${stat.experts}`,
      `  outbox ${countOutbox()} 份 · 结构化实验 ${countExps()} 条 · 报错 ${stat.errors}`,
      tail ? `  ${tail.slice(0, 110)}` : "  ⚠ 没有 `rule:done` ⇒ 不是正常收尾（可能被强杀）",
      `  完整日志 ${LOG}`,
      `  ★ 看时间线：双击「看时间线.cmd」`,
      "═".repeat(62),
    ].join("\n"),
  );
  process.exit(code ?? 0);
});
