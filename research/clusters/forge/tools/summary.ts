// ★★★ 书的目录（SUMMARY.md）—— 唯一写入口的**配套**（不是新的门）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么需要这个文件（2026-10-20 实测）
//
//   症状：`research/book/src/05-集群产出/` 有 **27 份**，但 `SUMMARY.md` 只列 **10 份**
//   ⇒ ★★ **读者打开书只能看到 10 份，其余 17 份等于不存在**。
//
//   根因：`publish.ts` 只做 `copyFileSync` —— **从不更新 SUMMARY.md**，
//        整个仓库**没有任何代码写 SUMMARY**。
//
//   ★★★ 这就是 AGENTS.md 里 forge 的**失败形状**：「**还在散记，只是写得更长**」。
//     我以前把"进了书"当成目标，于是把散记从 10 份放进书变成 27 份 ——
//     **让病更重了**：书的目录跟不上，读者反而更迷失。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 设计：只做两件事，都不改门
//
//   ① `syncSummary` —— 把已进书的产物**补进目录**（幂等，只追加不删）
//   ② `chapterDrift` —— 统计「被引用但不存在的章」（★ 这是**读数**，不是拦）
//
// ★ 为什么不在这里**拦**（不通过就不许进书）：
//   设计者说"框架不能变"，而门是框架。**改门的判据 = 改框架**。
//   ⇒ 这里只做**目录同步 + 读数**；要不要拦，是集群自己的事（它能读这个读数）。
//
// ★★ 纪律㉕：规则必须落在结构上 —— "记得更新目录"写在文档里=没有规则。
//   这里把它做成**发布路径上的一个必经步骤**，不靠谁记得。
// ══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * ★★★ 目录一致性：**报缺，不改结构**（2026-10-20 第二版）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★★ 第一版我做的事是错的，这是它造成的后果
 *
 *   第一版：书里有但目录没列的 ⇒ **自动追加到 `SUMMARY.md`**。
 *   实测结果（29 份产物）：
 *     · 原有那一节（手写、有分组）11 条
 *     · ★ 我自动新建的 `## 05-集群产出` 一节平铺 19 条
 *   ⇒ **同一批内容出现在两个地方，目录分裂了。**
 *
 *   ★★ 这正好撞在 AGENTS §三 说的 forge 的病上：
 *     「forge 失败时看起来像 —— **还在散记，只是写得更长**」。
 *     我把散记从 10 份装成 29 份，**让病更重**：读者看到两份目录。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★★ 为什么"自动补目录"这件事本身是错的
 *
 *   **目录的结构就是书的组织方式。** 它体现"先读什么、哪些是一组、
 *   哪些是附录"——那是**内容判断**，不是格式填充。
 *
 *   ★ 按 AGENTS 硬规则①：**研究内容**的决定交给集群，
 *     我立的只能是**要求**（"每一份都要能被读者找到"），
 *     不能替它决定**放在哪一节、和谁一组**。
 *
 *   ⇒ 所以现在它只做两件事：
 *     ① **报出**哪些产物读者点不到（读数，给集群看）
 *     ② **报出**目录里有哪些条目指向不存在的文件（悬空）
 *
 *   ★★★ 真正的修（把 19 条组织进有意义的节、合并同类）**是集群的活**。
 */
export function syncSummary(opts: {
  /** `research/book/src/` */
  bookSrc: string;
  /** 章节子目录名（默认 `05-集群产出`）*/
  subdir?: string;
  /**
   * ★★★ 保留参数名，但**已不写盘**（第二版只报数）。
   *
   * ★ 不删参数：调用方（runner / onTocDrift）还在传 `dryRun`，
   *   删了会编译不过；而且"它曾经会写盘"这件事要在类型上留痕。
   *   ★★ 若将来真想写盘，必须先回答"这一条该放哪一节" —— 那是内容判断。
   */
  dryRun?: boolean;
}): {
  /** ★ 书里有、但目录里找不到的（读者点不到） */
  added: string[];
  /** ★ 目录里已经有几条指向本书 */
  alreadyListed: number;
  /** ★ 书里一共几份 */
  total: number;
  /** ★ 目录里指向 `subdir/` 但**文件不存在**的条目（悬空条目）*/
  danglingEntries: string[];
} {
  const sub = opts.subdir ?? "05-集群产出";
  const destDir = join(opts.bookSrc, sub);
  const summaryPath = join(opts.bookSrc, "SUMMARY.md");

  if (!existsSync(summaryPath) || !existsSync(destDir)) {
    return { added: [], alreadyListed: 0, total: 0, danglingEntries: [] };
  }

  const files = readdirSync(destDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const summary = readFileSync(summaryPath, "utf8");
  const onDisk = new Set(files);

  // ① 目录里列了哪些（按完整路径）
  const listed = new Set<string>();
  const danglingEntries: string[] = [];
  // ★ 按行解析目录条目（比正则可靠 —— 我第一版正则漏了反斜杠，"目录列出 0"）
  for (const line of summary.split(String.fromCharCode(10))) {
    const path = linkPathOf(line, sub);
    if (!path) continue;
    listed.add(path);
    // ★ 目录里写了但文件不在 ⇒ 读者点了会 404
    if (!onDisk.has(path)) danglingEntries.push(path);
  }

  // ② 书里有、目录没列 ⇒ 读者点不到
  const missing = files.filter((f) => !listed.has(f));

  // ★★★ 注意：**不写盘**。见上面注释（目录结构是内容判断）
  return { added: missing, alreadyListed: listed.size, total: files.length, danglingEntries };
}

/**
 * ★ 中文数字归一。
 *
 * ★★★ 这里踩过三个坑（值得写下来）：
 *   ① 第一版只认阿拉伯数字 ⇒ 漏掉 240/241 次引用（书里几乎全是中文数字）
 *   ② `十` 单独作捕获组时 toNum 返回 NaN ⇒ 漏掉「第十章」
 *   ③ ★★「一」这个键里混进了一个**不可见字符 U+3164**（韩文填充符）
 *      ⇒ CN_DIGITS["一"] 是 undefined ⇒ 10 + 0 = 10
 *      ⇒ **「第十一章」被算成「第十章」**，两个章号合成一个
 *      ⇒ 症状极难查：11 既不在 existing 也不在 dangling（它变成了 10）
 *   ★ 教训：**用不可见的字符当键，错误不会报，只会算错**。
 */
const CN_DIGITS: Record<string, number> = {
  "一": 1,
  "二": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
};

// ★★★ 防复发：键必须是裸中文字（宁可起不来，也不要静默算错）
for (const k of Object.keys(CN_DIGITS)) {
  const cp = k.codePointAt(0)!;
  if (cp < 0x4e00 || cp > 0x9fff) {
    throw new Error(`CN_DIGITS 的键 [${k}] 不是裸中文字（码位 U+${cp.toString(16)}）`);
  }
}
function toNum(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  // ★★★ `十` 单独出现 = 10（★ 实测漏了：“第十章”的捕获组就是 `十`）
  if (s === "十") return 10;
  if (s.length === 1) return CN_DIGITS[s] ?? Number.NaN;
  if (s[0] === "十") return 10 + (CN_DIGITS[s[1]!] ?? 0);
  if (s[1] === "十") return (CN_DIGITS[s[0]!] ?? 0) * 10 + (CN_DIGITS[s[2]!] ?? 0);
  return Number.NaN;
}

/**
 * ★ 章号模式。
 *
 * ★★★ 不要写成模块级的带 `g` 正则 —— `matchAll` 会把 `lastIndex` 留在上面，
 *   下一次调用**从上次结束的位置继续** ⇒ 直接跳过文件开头。
 *   实测：第 11 章被 6 份引用，却一次都没被算到（我查了两轮才定位）。
 *   ⇒ 改成**函数**，每次返回一个新正则。
 */
const chRe = () => /第([一二三四五六七八九十0-9]{1,3})章/g;

/**
 * ★★★ 章号漂移：**被引用但不存在**的章有几处。
 *
 * ★ 这是**读数**，不是拦截。
 *   设计者问的就是「书能不能被读者真的用起来」——
 *   而"读者会去找第 11 章，书里只有 5/9/10"正是它用不起来的最硬证据。
 */
export function chapterDrift(opts: {
  bookSrc: string;
  subdir?: string;
}): {
  /** 书里真实存在的章号 */
  existing: number[];
  /** 被引用但不存在的章号 → 被引次数 */
  dangling: Map<number, number>;
  /** 引用总数（分母）*/
  totalRefs: number;
} {
  const sub = opts.subdir ?? "05-集群产出";
  const destDir = join(opts.bookSrc, sub);
  if (!existsSync(destDir)) return { existing: [], dangling: new Map(), totalRefs: 0 };

  const files = readdirSync(destDir).filter((f) => f.endsWith(".md"));
  const bodies = files.map((f) => ({ name: f, text: readFileSync(join(destDir, f), "utf8") }));

  // ★ ① 真实存在的章：看**标题**（`# 第 N 章`）和**文件名**（`第N章`）
  const existing = new Set<number>();
  for (const b of bodies) {
    const head = b.text.slice(0, 400);
    for (const m of head.matchAll(/^#+\s*第\s*([一二三四五六七八九十0-9]{1,3})\s*章/gm)) {
      const n = toNum(m[1]!);
      if (!Number.isNaN(n)) existing.add(n);
    }
    for (const m of b.name.matchAll(/第([一二三四五六七八九十0-9]{1,3})章/g)) {
      const n = toNum(m[1]!);
      if (!Number.isNaN(n)) existing.add(n);
    }
  }

  // ★ ② 被引用的章：全文里的 `第 N 章`（★ 去掉第一行标题 —— 那是它的自称，不是引用）
  const dangling = new Map<number, number>();
  let totalRefs = 0;
  for (const b of bodies) {
    const body = b.text.replace(/^#.*$/m, "");
    for (const m of body.matchAll(chRe())) {
      const n = toNum(m[1]!);
      if (Number.isNaN(n)) continue;
      totalRefs++;
      if (!existing.has(n)) dangling.set(n, (dangling.get(n) ?? 0) + 1);
    }
  }

  return { existing: [...existing].sort((a, b) => a - b), dangling, totalRefs };
}

/**
 * ★ 从一行 markdown 目录条目里取出「属于 subdir 的相对路径」。
 *
 * 形如：`  - [标题](05-集群产出/文件.md)` → `文件.md`
 *
 * ★★ 为什么单独写一个函数：第一版用 `new RegExp` 拼模板串，
 *   反斜杠被吃了 ⇒ 一条都没匹配上 ⇒ 报「目录列出 0 份」。
 *   ★ 那种错**不报错，只是算错**（本会话已经栽过 4 次）。
 *   改成逐字符找，谁都吃不掉。
 */
function linkPathOf(line: string, sub: string): string | null {
  const open = line.indexOf("](");
  if (open < 0) return null;
  const close = line.indexOf(")", open);
  if (close < 0) return null;
  const target = line.slice(open + 2, close).trim();
  const prefix = `${sub}/`;
  if (!target.startsWith(prefix)) return null;
  const name = target.slice(prefix.length);
  return name.length ? name : null;
}
