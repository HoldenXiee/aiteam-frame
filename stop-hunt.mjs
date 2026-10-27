#!/usr/bin/env node
/**
 * ★★ 停 hunt（走正常收尾，不硬杀）
 *
 * 用法：双击「停hunt.cmd」等价于 `node stop-hunt.mjs`
 *
 * 为什么逻辑在 Node 而不在 .cmd：**.cmd 文件里的中文会被 cmd.exe 按 cp936 读坏**
 * （实测：`停hunt.cmd` 的 `if exist` 行被啃成 `'luster.lock" …` ⇒ 整段失效）。
 * ⇒ .cmd 只当**纯 ASCII 启动器**，中文与判断都放在这里。
 *
 * 顺序（与纪律㊷ 同源：先让它自己收尾，再动硬的）：
 *   1. 没有锁 / PID 已死 ⇒ 只清理，不杀
 *   2. 有锁且 PID 活着 ⇒ `taskkill /PID n`（不带 /F：请求它正常退出）
 *   3. 最多等 120 秒让它自己落账、回流、删锁
 *   4. 还不行 ⇒ `taskkill /PID n /T /F` **并明确告诉你做了强杀**（这一轮的账可能截断）
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB = join(HERE, process.env.HUNT_LAB || "research/labfirst/hunt");
const LOCK = join(LAB, "work", "_cluster.lock");
const TOPO = join(LAB, "work", "_topology.log");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const taskkill = (pid, force, tree) => {
  const args = ["/PID", String(pid)];
  if (tree) args.push("/T");
  if (force) args.push("/F");
  try {
    execFileSync("taskkill", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const lastDone = () => {
  try {
    return readFileSync(TOPO, "utf8")
      .split("\n")
      .filter((l) => l.includes("rule:done"))
      .pop();
  } catch {
    return undefined;
  }
};

console.log("═".repeat(66));

if (!existsSync(LOCK)) {
  console.log("★ 没有锁文件 ⇒ hunt 现在没在跑。");
  const t = lastDone();
  if (t) console.log(`  最后一次收尾账：${t.slice(0, 110)}`);
  process.exit(0);
}

const raw = readFileSync(LOCK, "utf8").trim();
const pid = Number(/pid=(\d+)/.exec(raw)?.[1] ?? NaN);

if (!Number.isFinite(pid) || !alive(pid)) {
  console.log(`★ 锁是陈旧的（pid=${Number.isFinite(pid) ? pid : "?"} 已不在）⇒ 直接清锁，不杀任何进程。`);
  try {
    unlinkSync(LOCK);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

// ★★★★★ 干净的路：写一个**信号文件**，集群下一个 tick（≤5 分钟）读到就进收尾态 ——
//   与"窗口到点"完全同一条路（先停研究员、等已 fire 的专家、落账、回流、删锁）。
//   ★ 因为 tick 可能正卡在一条规则上，所以最多等 6 分钟；超时才动硬的。
const STOP_REQ = join(LAB, "work", "_stop-request");
writeFileSync(STOP_REQ, `requested=${new Date().toISOString()}
`);
console.log(`★ hunt 在跑（PID ${pid}）⇒ 已写信号文件 \`work/_stop-request\``);
console.log("  它会在这个 tick 结束后进收尾态（先落账、回流、删锁，再退）。最多等 6 分钟…");

for (let i = 1; i <= 72; i++) {
  await sleep(5000);
  if (!existsSync(LOCK)) {
    console.log(`★ 它自己收尾了（等了 ${i * 5} 秒）。`);
    const t = lastDone();
    if (t) console.log(`  收尾账：${t.slice(0, 110)}`);
    process.exit(0);
  }
  if (i % 12 === 0) console.log(`  …还是没收尾（已等 ${i * 5} 秒）`);
}

console.log("★★ 等满 6 分钟还没收尾 ⇒ **强杀**（这一轮的账可能截断，日志里会缺 rule:done）");
try {
  if (existsSync(STOP_REQ)) unlinkSync(STOP_REQ);
} catch {
  /* ignore */
}
taskkill(pid, true, true);
await sleep(1500);
try {
  if (existsSync(LOCK)) unlinkSync(LOCK);
} catch {
  /* ignore */
}
console.log(`★ 已强杀 PID=${pid}，锁已删。`);
process.exit(0);
