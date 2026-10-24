/**
 * forge → hunt 的交接口（DESIGN-2026-10-21 §5）
 *
 * ★★★ 为什么需要它：两个集群**不是没有交流**，而是**只有单向**（`snapshot`：hunt → forge）。
 *   forge 已经写了 36 章书，而 hunt 一点都看不到 ⇒ 它只能自己审自己，越审越窄。
 *
 * ★★★ 关键设计：**递处境，不递题目**。
 *   我给的不是「你去做 X」，而是「另一个集群现在是这个状态」。
 *   ⇒ 题目由它自己选（硬规则①：不替集群拍板）。
 *
 * ★ 判据全是**形式**的：
 *   · 「没装置」= 正文里没有任何 `*.mjs/.ts/.jsonl` 形式的路径（不是"我觉得没验证"）
 *   · 「未兑现解除条件」= forge 自己抽出来的 `PENDING-<N>.md` 的 N
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface BookFile {
  name: string;
  text: string;
}

export interface BookState {
  /** 已发布的章数（读 forge 的 `work/publish.md` 里「已发布 N 份」；读不到 ⇒ null） */
  published: number | null;
  /** forge 自己抽出来的未兑现解除条件条数（`PENDING-<N>.md`；没有 ⇒ null） */
  pendingConditions: number | null;
  /** 章文件总数 */
  chapters: number;
  /** ★ 正文里**一个可跑装置都没引用**的章（这类是 hunt 能接手的缺口） */
  deviceFree: number;
  /** 其中最短的几份（短的更容易先补） */
  deviceFreeSample: { name: string; chars: number }[];
}

const DEVICE_RE = /(?:[\w.-]+\/)+[\w.-]+\.(?:mjs|mts|ts|js|sh|jsonl)/;

export function hasDevice(text: string): boolean {
  return DEVICE_RE.test(text);
}

/** 纯函数：给一组书的文件，算状态 */
export function analyzeBook(
  files: BookFile[],
  published: number | null,
  pendingConditions: number | null,
): BookState {
  const deviceFree = files.filter((f) => !hasDevice(f.text));
  const sample = [...deviceFree]
    .sort((a, b) => a.text.length - b.text.length)
    .slice(0, 5)
    .map((f) => ({ name: f.name, chars: f.text.length }));
  return {
    published,
    pendingConditions,
    chapters: files.length,
    deviceFree: deviceFree.length,
    deviceFreeSample: sample,
  };
}

/** 从 publish.md 里读「已发布 N 份」（★ 读不到给 null，不猜 0） */
export function parsePublished(md: string): number | null {
  const m = md.match(/已发布\s*(\d+)\s*份/);
  return m ? Number(m[1]) : null;
}

/** 从 `PENDING-<N>.md` 的文件名里读 N（取最大值；没有给 null） */
export function parsePending(names: string[]): number | null {
  let best: number | null = null;
  for (const n of names) {
    const m = n.match(/^PENDING-(\d+)\.md$/);
    if (!m) continue;
    const v = Number(m[1]);
    if (best === null || v > best) best = v;
  }
  return best;
}

/** 渲染成投给 hunt 的「处境」（★ 不是任务清单） */
export function renderBookState(s: BookState): string {
  const L: string[] = [];
  L.push(`· 另一边的书：**${s.chapters} 章**` + (s.published === null ? "（发布账未声明）" : `（已发布 ${s.published} 份）`));
  if (s.pendingConditions !== null) {
    L.push(`· 它自己记着的**未兑现解除条件 ${s.pendingConditions} 条** —— 也就是"我说了但还没做到"的话`);
  }
  L.push(`· ★ **${s.deviceFree} 章正文里一个可跑装置都没引用**（不是我的判断：是正文本里没有任何 \`.mjs/.ts/.jsonl\` 路径）`);
  if (s.deviceFreeSample.length) {
    L.push(
      `  短的几份：` +
        s.deviceFreeSample.map((x) => `\`${x.name}\`（${x.chars} 字）`).join(" · "),
    );
  }
  return L.join(String.fromCharCode(10));
}

/** I/O：读另一边的落盘。★ 全部只读（纪律㉓：被分析对象只读） */
export function readBookState(opts: {
  bookDir: string;
  publishPath: string;
  forgeWorkDir: string;
}): BookState {
  let files: BookFile[] = [];
  try {
    files = readdirSync(opts.bookDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f, text: readFileSync(join(opts.bookDir, f), "utf8") }));
  } catch {
    /* 读不到就是 0 章 —— 由调用方看 chapters 判断 */
  }
  let published: number | null = null;
  try {
    published = parsePublished(readFileSync(opts.publishPath, "utf8"));
  } catch {
    published = null;
  }
  let pending: number | null = null;
  try {
    pending = parsePending(readdirSync(opts.forgeWorkDir));
  } catch {
    pending = null;
  }
  return analyzeBook(files, published, pending);
}

/** 书的目录在哪（相对仓库根） */
export const BOOK_DIR = "research/book/src/05-集群产出";
