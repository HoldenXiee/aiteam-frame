// lib/ 的自检与回退 —— ★ 它改了库，得能看见、也得能撤销
//
// ★★★ 为什么需要这个（设计疏漏，2026-10-18 修）：
//   打通分层之后，**它改 `lib/` 会真的影响它自己的实验**。
//   ★ 万一改坏 → 实验起不来 → 撞死在一堵墙上。
//   ★★ 按 P12：**不能只让它撞** —— 要给它一条"路"（能看见、能撤销）。
//
// ★ 做法（都用现成的 git，不新造机制）：
//   ① 开工前：把 lib/ 的改动状态记下来（改了哪些文件）→ 写进 work/_lib-state.md
//   ② 把"怎么回退"写进那段记录里（它读得到）

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LAB } from "./paths.ts";

/** git 命令的薄封装（在集群空间的仓库里跑） */
function git(...args: string[]): string {
  try {
    return execFileSync("git", ["-C", LAB, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export type LibState = {
  /** 它的 lib/ 相对上次提交改动了哪些文件 */
  dirty: string[];
  /** lib/ 里有没有未提交改动 */
  hasEdits: boolean;
};

/** 看它现在把 lib/ 改成什么样了 */
export function readLibState(): LibState {
  const out = git("status", "--porcelain", "--", "lib/");
  const dirty = out
    ? out
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean)
    : [];
  return { dirty, hasEdits: dirty.length > 0 };
}

/**
 * 开工前把 lib/ 的状态写下来 —— ★ 它的"可见性"与"出路"。
 * ★ 写在 work/ 里（它能读），并在手册里告诉过它这个文件。
 */
export function recordLibState(): LibState {
  mkdirSync(join(LAB, "work"), { recursive: true });
  const st = readLibState();
  const p = join(LAB, "work", "_lib-state.md");

  const canGit = existsSync(join(LAB, ".git"));
  const body =
    `# 你的 lib/ 现在的状态\n\n` +
    `（每次开工前自动写；你可以随时自己重跑 \`git -C . status -- lib/\` 看最新的）\n\n` +
    (st.hasEdits
      ? `★ **你对库做了 ${st.dirty.length} 处改动**：\n` +
        st.dirty.map((f) => `· \`${f}\``).join("\n") +
        `\n\n★★ 这些改动**会影响你自己的实验**（env.ts 用的就是这份 lib/）。\n` +
        `★★★ **如果实验起不来了，先怀疑这里的改动**。\n`
      : `★ lib/ 与上次提交一致 —— 你还没改过库。\n\n` +
        `★★ 改库是你的权利（见研究手册「关于改库」）：\n` +
        `   改完它**会真的生效**（你的实验就跑你改的这份），所以更要想清楚再动。\n`) +
    (canGit
      ? `\n## 万一改坏了怎么退\n\n` +
        `\`\`\`bash\n` +
        `git -C ${LAB} status -- lib/        # 看改了哪些\n` +
        `git -C ${LAB} checkout -- lib/      # ★ 把 lib/ 全部改回上次提交的样子\n` +
        `\`\`\`\n` +
        `★ 只想退某一个文件：\`git -C ${LAB} checkout -- lib/aiteam/agent/lab.ts\`\n`
      : `\n⚠ 这个空间没有 git 仓库 —— **改坏了退不回来**，动之前先备份。\n`);

  appendFileSync(p, body);
  return st;
}
