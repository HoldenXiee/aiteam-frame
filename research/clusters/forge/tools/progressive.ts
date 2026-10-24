// ══════════════════════════════════════════════════════════════════════════
// ★★★ 「渐进的书」审查基准（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者裁定（逐字）
//
//   「因为这个 book 是**渐进式**的，是**随着 hunt 集群的推进来不断完善的**，
//    我害怕强制要求：从目录第一份出发，每份指向的"下一站"能不能接上，
//    形成不断裂的链路，**会导致后续的不断完善会有问题**，
//    建议 forge 的**审查板块要设计成这种情景下运行**」
//
//   三条具体裁定：
//   · 基准：**按「当前这本」判，不按「理想那本」**
//   · 未完成：**显式标记「待补」就不算缺陷**
//   · 过时：**过时就算缺陷，必须更新**（审查就是让产出符合目标）
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 这个文件要防的两种反向错误
//
//   ① **拿"理想的书"当尺子** —— 判"链路不闭合"、"缺 1-4 章"，
//      而这本书**本来就在长**。⇒ 集群会被迫先补骨架、而不是补内容。
//
//   ② **拿"随便怎样都行"当尺子** —— 半成品不标、过时不改，
//      书越长越烂，而审查说"没事"。⇒ 这等于没有审查。
//
//   ★ 分界线只有一条：**有没有诚实地标出来**。
//     · 标了「待补」⇒ 半成品合法（它知道、读者也知道）
//     · 没标 ⇒ 就是缺陷（读者以为这是定论）
// ══════════════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────────────────────────────────────
// ① 待补标记
// ──────────────────────────────────────────────────────────────────────────

/**
 * ★ 「待补」的标准写法（★ 少数几种，太多种等于没有约定）
 *
 * ★★ 为什么限定写法：如果每份用不同的词（"待补充/TODO/后面会讲/未写完"），
 *    那就**查不全**，等于没有标记。
 */
const PENDING_PATTERNS: RegExp[] = [
  /待补[:：]/g,
  /本节待补/g,
  /本章待补/g,
  /待写[:：]/g,
  /TODO\(渐进\)/g,
  /【待补】/g,
];

export type PendingMark = {
  /** ★ 在第几行 */
  line: number;
  /** ★ 那一行原文（截断） */
  text: string;
};

/** ★ 找出产物里的「待补」标记 */
export function pendingMarks(text: string): PendingMark[] {
  const out: PendingMark[] = [];
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    for (const re of PENDING_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) {
        out.push({ line: i + 1, text: line.trim().slice(0, 140) });
        break;
      }
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// ② 按「当前这本」判：只查书内部自洽，不要求完整
// ──────────────────────────────────────────────────────────────────────────

/**
 * ★★★ 「当前自洽」检查（★ 不判"该有的有没有"，只判"有的对不对"）
 *
 * ★ 检四项，**全部是"这本书内部"的性质**：
 *   1. **指向 404**：正文提到了某份产物，而它不在书里 ⇒ 读者点过去是空的
 *      ★ 例外：如果那处标了「待补」，就不算缺陷（因为作者知道它还没写）
 *   2. **悬空章号**：引用「第 N 章」而书里没有第 N 章
 *      ★ 例外：同上，标了「待补」就不算
 *   3. **术语无定义**：正文用了黑话，定义页里没有（这条与"渐进"无关，必须修）
 *   4. **自相矛盾**：同一份里出现两个不同的「本轮落地 x/y」而没说明
 *      ★ 这条太容易误判，**不实现**（会变成我判内容）
 */
export type SelfConsistency = {
  /** ★ 书里有几份 */
  files: number;
  /** ★ 指向不存在产物的引用（未标待补的）*/
  danglingRefs: { artifact: string; target: string; line: number; text: string }[];
  /** ★ 标了待补、所以不算缺陷的 404 */
  excusedDangling: number;
  /** ★ 悬空章号（未标待补的）*/
  danglingChapters: { artifact: string; chapter: number }[];
  /** ★ 未定义的术语种类 */
  undefinedTerms: string[];
};

/**
 * ★★★ 按「当前这本」判自洽。
 *
 * ★★★ 关键设计：**不检查"书完整吗"**。
 *   不查"第 1-4 章有没有"、不查"链路闭合不闭合" ——
 *   因为这本书**在长**，今天只有 5 章是正常的。
 */
export function selfConsistency(opts: { bookSrc: string; subdir?: string }): SelfConsistency {
  const sub = opts.subdir ?? "05-集群产出";
  const dir = join(opts.bookSrc, sub);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return { files: 0, danglingRefs: [], excusedDangling: 0, danglingChapters: [], undefinedTerms: [] };
  }

  const stemOf = (f: string) => f.replace(/\.md$/, "").slice(0, 12);
  const stems = files.map((f) => ({ f, stem: stemOf(f), stemLen: stemOf(f).length }));

  // 全书所有「待补」行（★ 用来豁免）
  const pendingLines: { artifact: string; line: number; text: string }[] = [];
  const texts = new Map<string, string>();
  for (const f of files) {
    try {
      const t = readFileSync(join(dir, f), "utf8");
      texts.set(f, t);
      for (const m of pendingMarks(t)) pendingLines.push({ artifact: f, line: m.line, text: m.text });
    } catch {
      /* 读不到跳过 */
    }
  }

  // ★ 现有章号
  const CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const toNum = (s: string): number => {
    if (/^\d+$/.test(s)) return Number(s);
    if (s === "十") return 10;
    if (s.length === 1) return CN[s] ?? NaN;
    if (s[0] === "十") return 10 + (CN[s[1]!] ?? 0);
    if (s[1] === "十") return (CN[s[0]!] ?? 0) * 10 + (CN[s[2]!] ?? 0);
    return NaN;
  };
  const haveChapter = new Set<number>();
  for (const [f, t] of texts) {
    for (const m of t.slice(0, 400).matchAll(/^#+\s*第\s*([一二三四五六七八九十0-9]{1,3})\s*章/gm)) {
      const n = toNum(m[1]!);
      if (!Number.isNaN(n)) haveChapter.add(n);
    }
    for (const m of f.matchAll(/第([一二三四五六七八九十0-9]{1,3})章/g)) {
      const n = toNum(m[1]!);
      if (!Number.isNaN(n)) haveChapter.add(n);
    }
  }

  const danglingRefs: SelfConsistency["danglingRefs"] = [];
  const danglingChapters: SelfConsistency["danglingChapters"] = [];
  let excused = 0;

  for (const [f, t] of texts) {
    const lines = t.split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      const lineNo = i + 1;
      // ★ 这一行标了待补吗（同一行，或前后 1 行）？
      const excusedHere = pendingLines.some(
        (p) => p.artifact === f && Math.abs(p.line - lineNo) <= 1,
      );

      // ① 指向不存在的产物
      for (const { f: g, stem, stemLen } of stems) {
        if (g === f || stemLen < 8) continue;
        if (!line.includes(stem)) continue;
        // ★ 目标不在书里吗？stem 匹配不到任何现有文件
        const exists = files.some((x) => x !== f && stemOf(x) === stem);
        if (exists) continue;
        if (excusedHere) {
          excused++;
          continue;
        }
        danglingRefs.push({ artifact: f, target: stem, line: lineNo, text: line.trim().slice(0, 100) });
      }

      // ② 悬空章号
      for (const m of line.matchAll(/第([一二三四五六七八九十0-9]{1,3})章/g)) {
        const n = toNum(m[1]!);
        if (Number.isNaN(n) || haveChapter.has(n)) continue;
        if (excusedHere) {
          excused++;
          continue;
        }
        danglingChapters.push({ artifact: f, chapter: n });
      }
    }
  }

  return {
    files: files.length,
    danglingRefs,
    excusedDangling: excused,
    danglingChapters,
    undefinedTerms: [], // ★ 由 `undefinedTerms()` 单独算（同一口径，不重复实现）
  };
}

/** ★ 渲染成一行 */
export function renderSelf(s: SelfConsistency): string {
  const d = s.danglingRefs.length;
  const c = s.danglingChapters.length;
  return (
    `书 ${s.files} 份（★ 按"当前这本"判，不要求完整）` +
    ` · 指向不存在 ${d} 处 · 悬空章号 ${c} 处` +
    (s.excusedDangling ? ` · ★ 已标「待补」豁免 ${s.excusedDangling} 处` : "")
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ③ 过时：被 hunt 新成果影响的旧章节（★ 设计者裁定：过时就算缺陷）
// ──────────────────────────────────────────────────────────────────────────

/**
 * ★★★ 找出「被新成果影响」的章节。
 *
 * ★ 判据（不判内容）：
 *   产物正文里引用了 `hunt` 空间的某份原料（文件名或关键标识），
 *   而**那份原料的 mtime 比这份产物新** ⇒ 这份产物可能过时了。
 *
 * ★★ 为什么这样判：这不是"我觉得它过时"，而是"**它引用的东西变了**"——
 *   引用关系是可数的，mtime 是可数的。
 *
 * ★ 局限（必须说）：mtime 变新 ≠ 内容变了（可能只是重新保存）。
 *   ⇒ 所以只报"**可能过时**"，由集群自己判断要不要更新。
 */
export function staleBySource(opts: {
  bookSrc: string;
  subdir?: string;
  /** ★ hunt 的原料目录（只读）*/
  sourceDir: string;
}): { artifact: string; newer: string[] }[] {
  const sub = opts.subdir ?? "05-集群产出";
  const dir = join(opts.bookSrc, sub);

  let srcFiles: { name: string; stem: string; mtime: number }[] = [];
  try {
    srcFiles = readdirSync(opts.sourceDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: f,
        stem: f.replace(/\.md$/, "").slice(0, 12),
        mtime: statSync(join(opts.sourceDir, f)).mtimeMs,
      }));
  } catch {
    return [];
  }

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const out: { artifact: string; newer: string[] }[] = [];
  for (const f of files) {
    let text = "";
    let mt = 0;
    try {
      text = readFileSync(join(dir, f), "utf8");
      mt = statSync(join(dir, f)).mtimeMs;
    } catch {
      continue;
    }
    const newer: string[] = [];
    for (const s of srcFiles) {
      if (s.stem.length < 8) continue;
      if (!text.includes(s.stem)) continue;
      if (s.mtime > mt) newer.push(s.name);
    }
    if (newer.length) out.push({ artifact: f, newer });
  }
  return out;
}
