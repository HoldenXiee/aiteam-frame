// ★★★ 单实例锁 —— **同一个集群空间，同一时刻只允许一个研究员在跑**
//
// ══════════════════════════════════════════════════════════════════
// ★★★★ 为什么必需（2026-10-19 实测事故，代价很大）
// ══════════════════════════════════════════════════════════════════
//
// ★ 事故：长跑期间我又启动了多次（`longrun2` / `longrun3`），
//   而**旧进程没真正死掉** ⇒ **3 个 researcher 会话并发写同一个 `work/`**。
//
// ★★ 研究员**自己发现**的（它的原话）：
//   「★ 重要环境事实：本 lab 同时有**两个 researcher 会话**在写，
//    outbox 里出现了**两份不同标题的 P29**，
//    **cross-hard 也因此有两批样本**」
//
// ★★★ 后果（比"数据脏"更重）：
//   ① `outbox` 里出现**同名不同内容的产出** ⇒ 成果清单不可信
//   ② 同一个实验**两批样本混在一起** ⇒ 统计口径被污染
//   ③ **它自己要花精力去辨别"哪个是我写的"** —— 白耗研究预算
//   ④ 两个会话可能**同时改 `work/` 里同一个文件**（`lab-1` 提过：`wc -l` 15→2）
//
// ★★★ 同族证据：`lab-1` 的提案「**并发集群共用工作区会互相删数据**」——
//   **同一个病，本项目已经犯过至少三次**（lab-1 / 微实验删 work / 这次）。
//
// ══════════════════════════════════════════════════════════════════
// ★ 做法：**锁文件 + PID 存活检查**（不引新依赖）
//
//   · 启动时写 `<LAB>/work/_cluster.lock`（含 PID 与启动时间）
//   · 已在跑（PID 还活着）⇒ **拒绝启动**，并在文案里说清怎么办
//   · 陈旧锁（PID 死了）⇒ 自动接管（否则崩溃一次就再也起不来）
//   · 退出时（含异常）删锁
// ══════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAB } from "./paths.ts";

const LOCK = join(LAB, "work", "_cluster.lock");

/** PID 还活着吗（`process.kill(pid, 0)` 不发信号，只探活） */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type LockResult = { ok: true; release: () => void } | { ok: false; reason: string };

/**
 * 抢锁。★ 拿不到就**别跑** —— 并发的研究员会互相毁数据。
 */
export function acquireLock(): LockResult {
  mkdirSync(join(LAB, "work"), { recursive: true });

  if (existsSync(LOCK)) {
    const raw = readFileSync(LOCK, "utf8").trim();
    const m = raw.match(/pid=(\d+)/);
    const pid = m ? Number(m[1]) : NaN;
    if (Number.isFinite(pid) && pid !== process.pid && alive(pid)) {
      return {
        ok: false,
        reason:
          `★ 已经有一个研究员在跑（PID ${pid}，锁文件 ${LOCK}）。\n` +
          `  ★★★ 不许并发 —— 两个会话会写同一个 work/ 与 outbox：\n` +
          `    · outbox 会出现**同名不同内容**的产出（成果清单不可信）\n` +
          `    · 同一个实验会**混进两批样本**（统计口径被污染）\n` +
          `    · 它会花精力辨别"哪个是我写的"（白耗研究预算）\n` +
          `  ⇒ 要么等它跑完，要么先 ` +
          `\`Stop-Process -Id ${pid} -Force\`（★ 确认那是你要停的那个）。\n` +
          `  ★ 注：本项目已在这个病上栽过三次（lab-1 提案 / 微实验删 work / 2026-10-19 并发会话）。`,
      };
    }
    // 陈旧锁（PID 已死或不是数字）⇒ 接管，并在日志里说一声
    console.log(`  lock        陈旧锁（pid=${m?.[1] ?? "?"} 已不在）→ 接管`);
  }

  writeFileSync(LOCK, `pid=${process.pid}\nstarted=${new Date().toISOString()}\n`);
  return {
    ok: true,
    release: () => {
      try {
        // ★ 只删自己的锁 —— 防止"接管者"把后来者的锁删掉
        if (existsSync(LOCK) && readFileSync(LOCK, "utf8").includes(`pid=${process.pid}`)) unlinkSync(LOCK);
      } catch {
        /* 退出路径，尽力而为 */
      }
    },
  };
}
