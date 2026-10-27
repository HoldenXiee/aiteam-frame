#!/usr/bin/env node
/**
 * ★★★★★ 每天点一下就跑 hunt（不限时 · 不限制）
 *
 * 用法（双击 `跑hunt.cmd` 等价于）：
 *   node run-hunt.mjs                # 默认：一直跑，直到你按 Ctrl+C 或点「停hunt.cmd」
 *   node run-hunt.mjs --minutes=600  # 想限一下也行（分钟）
 *   node run-hunt.mjs --dry          # 只搭装置不投递（零模型成本）
 *
 * ─────────────────────────────────────────────────────────────
 * ★ 这一版干了什么：
 *   把「我平时手动敲的那一串环境变量」固化成一个文件，并且**把所有能放松的都放松**：
 *
 *   | 限制 | 原来 | 现在 | 为什么 |
 *   |---|---|---|---|
 *   | 窗口时长 | `--secs=3900`（65 分钟）| **7 天**（≈不限）| 你要"不限时" |
 *   | 专家并发 | `HUNT_FIRE_CONCURRENCY=3` | **8** | 钱不是 KPI，并发是"广"的硬上限 |
 *   | 外部材料频次 | 15 分钟一次 | **5 分钟** | 设计者：**网上探索权重应该更大** |
 *   | 一个窗口最多问几次外部 | `EXTERNAL_MAX=6` | **9999** | 你说不要"只能几轮/几次" |
 *   | 审现象频次 | 7 分钟 | 12 分钟（积压≥5 自动压到 2.5 分钟）| 让它自己按欠账调速 |
 *   | 研究员个数 | 3（`--employees`）| **3（上限）** | ★ 只有三个角度，不是限制，是设计 |
 *
 * ★★ **故意保留的三条闸**（不是"限制"，是防止自己吃光自己）：
 *   ① `INSTRUMENT_REVIEW_MS` —— 自审间隔。纪律㊱：**任何"回头看"的规则必须有配额**，
 *      实测没有它的时候 57/60 份产出全在审装置，研究结论只有 1 条。
 *   ② `GENERALIZE_EVERY_N` —— 提炼节拍。同上，防止"提炼 → 产出 → 又提炼"的正反馈。
 *   ③ 单实例锁 `_cluster.lock` —— 两个会话同时写同一个 `work/` 会**毁数据**
 *      （2026-10-19 实测：outbox 出现同名不同内容、同一实验混两批样本）。这条**不能放开**。
 *   ④ tick 节流 5 分钟 —— 那是"观察"的节拍，不是产出上限。
 *
 * ★★★ 例行检查（脚本自己会做，不用你记）：
 *   · 已经在跑 ⇒ 打印"它在跑，不重复启动"然后退出（不抢锁、不并发）
 *   · 陈旧锁（PID 已死）⇒ 集群自己会接管，本脚本不动它
 *   · 日志同时进**控制台**和 `logs/hunt-YYYY-MM-DD.log`（两个都能看）
 *   · 结束时打一行收尾摘要（outbox 份数 / 结构化实验条数 / 本次退出码）
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB_REL = process.env.HUNT_LAB || "research/labfirst/hunt";
const LAB = join(HERE, LAB_REL);
const LOCK = join(LAB, "work", "_cluster.lock");
const LOG_DIR = join(HERE, "logs");

const argv = process.argv.slice(2);
const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const dry = argv.includes("--dry");
const minutes = Number(arg("minutes") ?? 0);

// ── ① 已经在跑吗（不抢锁、不并发）────────────────────────────────
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
if (existsSync(LOCK)) {
  const raw = readFileSync(LOCK, "utf8").trim();
  const pid = Number(/pid=(\d+)/.exec(raw)?.[1] ?? NaN);
  if (Number.isFinite(pid) && pidAlive(pid)) {
    console.log("═".repeat(66));
    console.log(`★ 已经在跑了（PID ${pid}）。**不重复启动** —— 并发会毁数据。`);
    console.log(`  · 想看它在干什么：tail ${join(LAB_REL, "work", "_topology.log")}`);
    console.log(`  · 想停它：双击「停hunt.cmd」，或 taskkill /PID ${pid} /F`);
    console.log(`  · 想换一个空间并行跑：set HUNT_LAB=research/labfirst/hunt-r2 再运行本脚本`);
    console.log("═".repeat(66));
    process.exit(0);
  }
  console.log(`★ 陈旧锁（pid=${pid || "?"} 已不在）⇒ 集群自己会接管，我不管它。`);
}

// ── ② 环境：把所有能放松的放松 ──────────────────────────────────
// ★ 只有"用户没自己设"时才覆盖（这样你临时 `set X=...` 仍然优先）
const env = {
  ...process.env,
  HUNT_FIRE_CONCURRENCY: process.env.HUNT_FIRE_CONCURRENCY ?? "8",
  EXTERNAL_MS: process.env.EXTERNAL_MS ?? "300000", // 5 分钟：网上探索权重更大
  EXTERNAL_MAX: process.env.EXTERNAL_MAX ?? "9999", // 不设"最多问几次"
  PHENOMENON_MS: process.env.PHENOMENON_MS ?? "720000", // 12 分钟（积压≥5 自动压到 2.5）
  HUNT_CLOSE_CAP_MS: process.env.HUNT_CLOSE_CAP_MS ?? "180000",
};

// ── ③ 窗口时长：默认 7 天（≈ 不限时）──────────────────────────
// ★ 为什么不传 Infinity：Node 的 setTimeout 上限 ≈ 24.8 天，超了会**立刻触发**。
//   7 天 = 604800s，安全。跑满 7 天还没停，说明你根本不需要停。
const secs = minutes > 0 ? Math.round(minutes * 60) : 7 * 24 * 3600;

const stamp = new Date();
const day = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(
  stamp.getDate(),
).padStart(2, "0")}`;
mkdirSync(LOG_DIR, { recursive: true });
const LOG = join(LOG_DIR, `hunt-${day}.log`);

// ── ④ 打印这一轮到底放开了什么（自己看一遍，免得以为还有闸）────
const banner = [
  "═".repeat(66),
  `★ hunt 集群 · ${stamp.toLocaleString()}`,
  `  空间        ${LAB_REL}`,
  `  窗口        ${minutes > 0 ? `${minutes} 分钟` : "7 天（≈不限时；想停按 Ctrl+C）"}`,
  `  研究员      3 个角度（hands-on / falsifier / instrument-skeptic）`,
  `  专家并发    ${env.HUNT_FIRE_CONCURRENCY}`,
  `  外部材料    每 ${Math.round(Number(env.EXTERNAL_MS) / 60000)} 分钟一次 · 上限 ${env.EXTERNAL_MAX} 次/窗口`,
  `  审现象      每 ${Math.round(Number(env.PHENOMENON_MS) / 60000)} 分钟（积压 ≥5 自动压到 2.5 分钟）`,
  `  日志        ${LOG}`,
  dry ? "  ★ --dry：只搭装置，不投递（零模型成本）" : "",
  `  保留的闸    自审间隔 / 提炼节拍 / 单实例锁 / tick 5 分钟（理由见本文件头部）`,
  "═".repeat(66),
]
  .filter(Boolean)
  .join("\n");
console.log(banner);
appendFileSync(LOG, banner + "\n", "utf8");

// ── ⑤ 起进程：stdout/stderr 同时进控制台与日志 ─────────────────
const args = ["tsx", "research/clusters/hunt/index.ts", `--secs=${secs}`];
if (dry) args.push("--dry");

const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, {
  cwd: HERE,
  env,
  stdio: ["inherit", "pipe", "pipe"],
  shell: process.platform === "win32",
});

const tee = (buf) => {
  const s = buf.toString();
  process.stdout.write(s);
  try {
    appendFileSync(LOG, s, "utf8");
  } catch {
    /* 记不上日志不影响跑 */
  }
};
child.stdout.on("data", tee);
child.stderr.on("data", tee);

// Ctrl+C：转发给子进程（让它走正常收尾，而不是硬杀）
process.on("SIGINT", () => {
  console.log("\n★ 收到 Ctrl+C ⇒ 通知集群进收尾（它会自己落账、回流、删锁）…");
  child.kill("SIGINT");
});

child.on("exit", (code) => {
  // ── ⑥ 收尾摘要：不看 stdout 也能知道这一轮干了什么 ────────────
  const read = (p, d = "") => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return d;
    }
  };
  const outbox = (() => {
    try {
      return readdirSync(join(LAB, "outbox")).filter((f) => f.endsWith(".md")).length;
    } catch {
      return "?";
    }
  })();
  const exps = (() => {
    const txt = read(join(LAB, "work", "experiments.jsonl"));
    return txt.split("\n").filter((l) => l.trim()).length;
  })();
  const tail = read(join(LAB, "work", "_topology.log"))
    .split("\n")
    .filter((l) => l.includes("rule:done"))
    .pop();
  const summary = [
    "",
    "═".repeat(66),
    `★ 退出码 ${code}`,
    `  outbox ${outbox} 份 · 结构化实验 ${exps} 条`,
    tail ? `  ${tail.slice(0, 110)}` : "  ⚠ 日志里没有 `rule:done` ⇒ 不是正常收尾（可能是被强杀）",
    `  完整日志：${LOG}`,
    `  读数：npm run exp`,
    "═".repeat(66),
  ].join("\n");
  console.log(summary);
  try {
    appendFileSync(LOG, summary + "\n", "utf8");
  } catch {
    /* ignore */
  }
  process.exit(code ?? 0);
});
