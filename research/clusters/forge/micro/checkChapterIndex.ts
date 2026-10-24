// ★★★ 猜想 D 的纯函数验证器 —— 章节引用一致性
//
// ══════════════════════════════════════════════════════════════════
// ★★★ 为什么这条能零成本验（而其它四条不能）
//
//   纪律⑦：**判据纯函数、可离线重判、跑前冻结**。
//
//   · A/B/C/E 的判据都依赖**模型产出什么**（表填得满不满、写得对不对）
//     ⇒ 必须真跑才能判，有成本。
//   · ★★ D 的判据是**纯文本一致性**：某份产物引用了章号 X，
//     而书里有没有章号 X —— 这**完全不需要模型**。
//
//   ★★★ 所以 D 可以先被**确定性地判定**：跑一次就知道现状有多坏。
//     如果现状是"0 处悬空"，那 D 命题不成立，整个猜想作废（省一轮 $2）。
// ══════════════════════════════════════════════════════════════════
//
// 跑法：
//   npx tsx research/clusters/forge/micro/checkChapterIndex.ts
//   npx tsx research/clusters/forge/micro/checkChapterIndex.ts --json

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 仓库根（从 research/clusters/forge/micro/ 往上 4 层）*/
const REPO = join(import.meta.dirname, "..", "..", "..", "..");
/** ★ 只扫**已经进书**的目录 —— 归档区不算（那正是悬空引用的根源）*/
const BOOK_DIR = join(REPO, "research/book/src/05-集群产出");

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15,
};

/** ★ 把「第九章」「十一」这类写法归一成数字 */
export function chapterNum(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  return CN_NUM[raw];
}

/**
 * ★★★ 冻结的判据：从正文里抽出所有**章号引用**。
 *
 * ★ 什么算引用（跑前写死，不许事后放宽）：
 *   · `第X章`            —— 显式章引用
 *   · `第X节` / `§X`     —— 不算（那是节，不是章）
 * ★ 什么不算：
 *   · 标题行 `# 第九章 · …`  —— 那是**定义**，不是引用（下面单独收集）
 *   · 代码块里的内容        —— 屏蔽
 */
export function extractChapterRefs(text: string): number[] {
  // ★ 先剥掉代码块（```...```），里面的「第X章」不算引用
  const noCode = text.replace(/```[\s\S]*?```/g, "");
  // ★ 再剥掉标题行（# 开头）—— 标题是定义章号，不是引用它
  const body = noCode
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  const refs: number[] = [];
  for (const m of body.matchAll(/第([一二三四五六七八九十0-9]{1,3})章/g)) {
    const n = chapterNum(m[1]!);
    if (n !== undefined) refs.push(n);
  }
  return [...new Set(refs)].sort((a, b) => a - b);
}

/** ★ 这份文件**定义了**哪个章号（看第一行标题）*/
export function definedChapter(text: string): number | undefined {
  const first = text.split("\n").find((l) => /^\s*#\s/.test(l)) ?? "";
  const m = first.match(/第([一二三四五六七八九十0-9]{1,3})章/);
  return m ? chapterNum(m[1]!) : undefined;
}

export type BookScan = {
  files: { name: string; defined?: number }[];
  /** ★ 书里实际存在的章号 */
  existing: number[];
  /** ★ 悬空引用：引用了但书里没有的章号 */
  dangling: { chapter: number; citedBy: string[] }[];
  /** ★ 有章号但文件名与之无关的（另一种不一致）*/
  nameMismatch: { file: string; chapter: number }[];
  /** 引用总数（含重复）*/
  totalRefs: number;
};

export function scanBook(dir = BOOK_DIR): BookScan {
  const names = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const files: BookScan["files"] = [];
  const existing = new Set<number>();
  const cites = new Map<number, Set<string>>();
  let totalRefs = 0;

  for (const name of names) {
    const text = readFileSync(join(dir, name), "utf8");
    const def = definedChapter(text);
    files.push({ name, defined: def });
    if (def !== undefined) existing.add(def);

    for (const n of extractChapterRefs(text)) {
      totalRefs++;
      (cites.get(n) ?? cites.set(n, new Set()).get(n)!).add(name);
    }
  }

  const dangling = [...cites.entries()]
    .filter(([n]) => !existing.has(n))
    .map(([chapter, by]) => ({ chapter, citedBy: [...by].sort() }))
    .sort((a, b) => a.chapter - b.chapter);

  // ★ 有章号的文件，若文件名里不含「第X章」，算另一种不一致
  //   （读者按文件名找章时会困惑，但**不是悬空**）
  const nameMismatch = files
    .filter((f) => f.defined !== undefined && !f.name.includes("章"))
    .map((f) => ({ file: f.name, chapter: f.defined! }));

  return { files, existing: [...existing].sort((a, b) => a - b), dangling, nameMismatch, totalRefs };
}

// ─────────────── CLI ───────────────

const isMain =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("checkChapterIndex.ts");

if (isMain) {
  const r = scanBook();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`\n═══ 猜想 D · 章节引用一致性（纯函数，0 API）═══\n`);
    console.log(`扫的目录：research/book/src/05-集群产出/`);
    console.log(`文件数：${r.files.length}`);
    console.log(`章节引用总数：${r.totalRefs}\n`);

    console.log(`★ 书里**实际存在**的章号：${r.existing.length ? r.existing.join("、") : "（无）"}`);
    for (const f of r.files) {
      if (f.defined !== undefined) console.log(`   · 第${f.defined}章 ← ${f.name}`);
    }

    console.log(`\n★★★ 悬空引用：${r.dangling.length} 个章号`);
    for (const d of r.dangling) {
      console.log(`   · 第${d.chapter}章 —— 被 ${d.citedBy.length} 份文件引用`);
      for (const c of d.citedBy.slice(0, 3)) console.log(`       ${c}`);
      if (d.citedBy.length > 3) console.log(`       …还有 ${d.citedBy.length - 3} 份`);
    }

    console.log(`\n★ 文件名与章号脱钩：${r.nameMismatch.length} 份`);
    for (const m of r.nameMismatch) console.log(`   · 第${m.chapter}章 ← ${m.file}`);

    const bad = r.dangling.length > 0;
    console.log(`\n═══ 判定 ═══`);
    console.log(
      bad
        ? `✘ 猜想 D **成立**：读者会去找 ${r.dangling.length} 个不存在的章（共 ${r.totalRefs} 次引用里有一部分必然落空）。`
        : `✔ 猜想 D **不成立**：0 处悬空引用 —— 这条不用做。`,
    );
    console.log(``);
  }
}
