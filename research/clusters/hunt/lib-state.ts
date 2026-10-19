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

// ══════════════════════════════════════════════════════════════════
// ★★★ lib/ 修订号 —— 「这份数据是哪份代码跑的」（2026-10-19 研究员请求，我采纳）
// ══════════════════════════════════════════════════════════════════
//
// ★ 它的问题（逐字）：
//   「3 位研究员共用一个 `lib/`。我在 `observe.ts` 改订阅源时，同一文件里已经有同事的
//     `textOf`/`sections` 改动；`bridge.ts` 里也有同事对 `tools.onResult` 实参的修正。
//     **改动会静默合流**。合起来能跑（12/12），但**一次 run 的结果归因不到某个 `lib/` 修订**。」
//
// ★★ 为什么这很重要：**多员工共享一个 lib/ ⇒ 改动静默合流 ⇒ 数据与代码的对应关系断了**。
//   ★ 它给的做法是 `git hash-object`（每个源文件的 blob 哈希）—— **零成本、可查**。
//
// ★ 用法（它的原话）：
//   ```ts
//   const libRev = libRevision();       // → { 短名: hash, ... } + 一个总指纹
//   写进 run 的 meta
//   ```
// ★ 注意：**不是 git commit 号** —— 因为改动往往**没提交**。
//   用 `hash-object`（内容哈希）才能反映"此刻这一份"。
// ══════════════════════════════════════════════════════════════════

/** 纳入指纹的 lib 文件（★ 取**最常被改、且影响量具**的那几个） */
const LIB_FILES = [
  "lib/aiteam/surfaces/observe.ts",
  "lib/aiteam/surfaces/io.ts",
  "lib/aiteam/surfaces/tools.ts",
  "lib/aiteam/agent/bridge.ts",
  "lib/aiteam/agent/lab.ts",
  "lib/aiteam/agent/create-agent.ts",
];

export interface LibRevision {
  /** 文件名（短）→ 内容哈希（前 12 位）。★ 空串 = 文件不存在 */
  files: Record<string, string>;
  /** 全部文件哈希拼起来的指纹（★ 用来一眼判断"两次 run 是不是同一份代码"） */
  fingerprint: string;
}

/**
 * 算此刻 `lib/` 的内容修订号。
 *
 * ★★ 用 `git hash-object`（文件内容哈希），**不是** `git rev-parse HEAD`：
 *   研究员的改动**往往没提交** —— 而"数据是哪份代码跑的"要的是**此刻这一份**。
 */
export function libRevision(): LibRevision {
  const files: Record<string, string> = {};
  for (const f of LIB_FILES) {
    const short = f.replace(/^lib\/aiteam\//, "");
    // ★ 不存在 ⇒ 空串（不抛错：文件可能被重命名，这本身也是信息）
    const h = existsSync(join(LAB, f)) ? gitNoCwd("hash-object", f) : "";
    files[short] = h.slice(0, 12);
  }
  const fingerprint = fingerprintOf(Object.values(files));
  return { files, fingerprint };
}

/** 在集群空间的仓库里跑 git（内容哈希要相对仓库根） */
function gitNoCwd(...args: string[]): string {
  return git(...args);
}

/** 指纹：把所有哈希按固定顺序拼起来取前 12 位 */
function fingerprintOf(hashes: string[]): string {
  // ★ 用简单的多项式滚动摘要（不引 crypto：零依赖、跨平台、够用）
  let h = 2166136261;
  for (const s of hashes) {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 把修订号落进 `work/_lib-rev.jsonl` —— ★ 每次调用记一笔，**可离线对齐**。
 * ★ 研究员在自己的实验里也可以直接调 `libRevision()` 写进 run 的 meta。
 */
export function recordLibRevision(note = ""): LibRevision {
  const rev = libRevision();
  try {
    mkdirSync(join(LAB, "work"), { recursive: true });
    appendFileSync(
      join(LAB, "work", "_lib-rev.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), fp: rev.fingerprint, files: rev.files, note }) + "\n",
    );
  } catch {
    /* 记账失败不影响研究 */
  }
  return rev;
}
