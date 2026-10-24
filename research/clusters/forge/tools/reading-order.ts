// ══════════════════════════════════════════════════════════════════════════
// ★★★ 认知顺序：这本书能不能「顺着学」（2026-10-20）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者原话（逐字，这是这一整个模块的设计依据）
//
//   「其实主要的就是违反了人的认知规律，在学习陌生知识，
//     **如果学过前置知识（或类似知识）就能轻松学会**，
//     反正要符合人的认知规律」
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 把它翻译成一个可算的量
//
//   认知规律（前置知识律）：**要懂 A，得先懂 A 所依赖的东西。**
//
//   ⇒ 一份产物如果**引用了排在它后面**的东西，读者就必须「先读后面才能懂前面」。
//     这叫 **前置倒挂（forward reference）**。
//
//   ★ 一本合格的教科书：**倒挂 = 0**（所有引用都指向已在前面讲过的内容）
//   ★★ 现在的 forge：目录是按**文件名字典序**追加的，所以倒挂几乎必然发生。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★ 为什么这个量不算「内容判断」
//
//   它只问：**A 提到了 B，而 B 排得比 A 晚吗？**
//     · 不知道 A 和 B 讲什么
//     · 不判断"该不该引用"
//     · 不判断"顺序应该怎样"
//   ⇒ 纯粹的**文本指称 + 位置比较**。
//
//   ★★★ 至于"应该怎么重排"、"哪些该合并"——那是内容判断，归集群。
//     这里只负责让「不顺」变成看得见的数。
// ══════════════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** ★ 一份产物的位置与它的引用 */
export type OrderRow = {
  /** ★ 在目录里的位置（0 = 最前）*/
  index: number;
  artifact: string;
  /** ★ 它引用的产物里，**排在它后面**的那些（= 读者得先读后面）*/
  forward: string[];
  /** ★ 它引用的总数 */
  cites: number;
};

export type OrderReport = {
  /** ★ 目录里共有几份 */
  total: number;
  /** ★ 有前置倒挂的份数 */
  withForward: number;
  /** ★ 倒挂总次数 */
  forwardCount: number;
  /** ★ 最严重的几份 */
  worst: OrderRow[];
  /** ★ 每份的明细 */
  rows: OrderRow[];
  /**
   * ★★★ 「最深倒挂」：最远的一次引用跨了多少份。
   *
   * ★ 为什么关心：跨 1 份（后一份引用前一份）通常只是"顺手提一句"；
   *   跨 10 份意味着**读者读到第 3 份就被要求懂第 13 份**。
   */
  maxJump: number;
};

/** ★ 从文件名前 12 字当指称标记（与 `isolation.ts` 同一口径）*/
const stemOf = (f: string): string => f.replace(/\.md$/, "").slice(0, 12);

/**
 * ★★★ 按**目录顺序**算前置倒挂。
 *
 * @param bookSrc `research/book/src/`
 * @param subdir  章节子目录（默认 `05-集群产出`）
 *
 * ★ 为什么按**目录顺序**而不是文件名顺序：
 *   读者是照着目录读的。目录怎么排，决定了他先看到什么。
 */
export function readingOrder(opts: { bookSrc: string; subdir?: string }): OrderReport {
  const sub = opts.subdir ?? "05-集群产出";
  const dir = join(opts.bookSrc, sub);
  const summaryPath = join(opts.bookSrc, "SUMMARY.md");

  // ① 从 SUMMARY.md 取**目录顺序**（★ 这才是读者的阅读顺序）
  let order: string[] = [];
  try {
    const summary = readFileSync(summaryPath, "utf8");
    for (const line of summary.split("\n")) {
      const open = line.indexOf("](");
      if (open < 0) continue;
      const close = line.indexOf(")", open);
      if (close < 0) continue;
      const target = line.slice(open + 2, close).trim();
      const pre = `${sub}/`;
      if (!target.startsWith(pre)) continue;
      order.push(target.slice(pre.length));
    }
  } catch {
    /* 没目录 ⇒ 退回文件名序 */
  }
  if (order.length === 0) {
    try {
      order = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      return { total: 0, withForward: 0, forwardCount: 0, worst: [], rows: [], maxJump: 0 };
    }
  }

  const pos = new Map(order.map((f, i) => [f, i]));
  const stems = order.map((f) => ({ f, stem: stemOf(f) }));

  const rows: OrderRow[] = [];
  let forwardCount = 0;
  let maxJump = 0;

  for (const [i, f] of order.entries()) {
    let text = "";
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const forward: string[] = [];
    let cites = 0;
    for (const { f: g, stem } of stems) {
      if (g === f || stem.length < 8) continue;
      if (!text.includes(stem)) continue;
      cites++;
      const gPos = pos.get(g);
      if (gPos !== undefined && gPos > i) {
        forward.push(g);
        forwardCount++;
        maxJump = Math.max(maxJump, gPos - i);
      }
    }
    rows.push({ index: i, artifact: f, forward, cites });
  }

  const withForward = rows.filter((r) => r.forward.length > 0).length;
  const worst = [...rows].filter((r) => r.forward.length).sort((a, b) => b.forward.length - a.forward.length).slice(0, 10);

  return { total: order.length, withForward, forwardCount, worst, rows, maxJump };
}

/** ★ 渲染成一行（进日志）*/
export function renderOrder(r: OrderReport): string {
  if (r.total === 0) return "（没有可算的产物）";
  const pct = ((r.withForward / r.total) * 100).toFixed(0);
  return (
    `目录 ${r.total} 份 · ★ 前置倒挂 ${r.withForward} 份（${pct}%）` +
    ` · 倒挂 ${r.forwardCount} 处 · 最远跨 ${r.maxJump} 份`
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 第二个量：「术语未定义率」
//
//   认知规律的另一半：**学新东西时，第一次出现的词必须当场定义**，
//   否则读者停在那里，后面全白读。
//
//   ★ 判据（可算）：正文里出现的**专有术语**，有多少在 `00a-定义页` 里出现过？
//   ★★ 不判断"定义得好不好"，只判断**有没有出现过**。
// ══════════════════════════════════════════════════════════════════════════

/**
 * ★ 正文里的「术语」怎么识别（★ 这是这个判据最需要谨慎的地方）
 *
 * ★ 不用"所有不认识的词"（那没法算）。
 * ★★ 用**这个集群自己的黑话清单** —— 它们是可枚举的：
 *   实验批号、臂名、判据表达式、路径。**这些都是它自己造的词。**
 */
const JARGON = [
  /\b(PREREG)\b/g,
  /\b(arm|armE?)\b/gi,
  /\b(landing|matched|fp|pin)\b/g,
  /\b(R\d+|S\dQ\d|W\d+|J\d+[a-z]?|H_\w+)\b/g,
  // ★ 2026-10-20 修：`0×4` / `12×12` 这类是**读数**（表里到处都是），不是术语。
  //   ★★ 只有 `2x2` 这种**实验设计名**才算黑话 —— 它出现在正文叙述里。
  /\b2[x×]2\b/g,
  /κ\d?/g,
];

/** ★ 一份正文里出现的黑话种类与次数 */
export function jargonIn(text: string): { total: number; kinds: string[] } {
  const kinds = new Set<string>();
  let total = 0;
  for (const re of JARGON) {
    const m = text.match(re);
    if (m) {
      total += m.length;
      for (const x of m) kinds.add(x.trim());
    }
  }
  return { total, kinds: [...kinds] };
}

/**
 * ★★★ 术语未定义率：正文用到的黑话，有多少在定义页里出现过。
 *
 * @returns `undefinedRate` = 未在定义页出现的种类 / 全部种类
 *          ★ 0 = 全定义过；1 = 一个都没定义
 */
export function undefinedTerms(opts: {
  bookSrc: string;
  subdir?: string;
  /** ★ 定义页文件名（默认 `00a-定义页-九个词与一次走完.md`）*/
  defPage?: string;
}): {
  defined: string[];
  undefined: string[];
  rate: number;
  /** ★ 全书黑话总次数（含已定义的）*/
  totalHits: number;
} {
  const sub = opts.subdir ?? "05-集群产出";
  const dir = join(opts.bookSrc, sub);
  const defName = opts.defPage ?? "00a-定义页-九个词与一次走完.md";

  let defText = "";
  try {
    defText = readFileSync(join(dir, defName), "utf8");
  } catch {
    /* 没有定义页 ⇒ 全部算未定义（这本身就是个读数）*/
  }

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== defName);
  } catch {
    return { defined: [], undefined: [], rate: 0, totalHits: 0 };
  }

  const allKinds = new Set<string>();
  let totalHits = 0;
  for (const f of files) {
    let t = "";
    try {
      t = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const j = jargonIn(t);
    totalHits += j.total;
    for (const k of j.kinds) allKinds.add(k);
  }

  const defined: string[] = [];
  const undef: string[] = [];
  for (const k of allKinds) {
    if (defText.includes(k)) defined.push(k);
    else undef.push(k);
  }
  const total = allKinds.size;
  return {
    defined,
    undefined: undef.sort(),
    rate: total ? undef.length / total : 0,
    totalHits,
  };
}


// ══════════════════════════════════════════════════════════════════════════
// ★★★★★ 按「来路」分类前向引用（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么加这一节 —— **集群推翻了上面那个判据**（`P24`：被研究对象抓装置缺陷）
//
//   集群原话（逐字）：
//     「现役量具报的 **9 处**里，**0 处**是」
//     「★★★ **「提及」是「依赖」的必要条件，不是充分条件。**」
//
//   ★ 它给出了五种来路：
//     1 **承重**  「这句要用的方法/定义在那份里」→ 读者**读不懂这一段**
//     2 **依据**  「这个数从哪跑出来的」→ 读得懂，**复查时**才需要
//     3 **上游**  「我的思想来路 / 我要推翻谁」→ 读得懂（作者欠的债，不是读者的债）
//     4 **地图**  「你在第几站，下一站去哪」→ 读得懂；没有它**找不到路**
//     5 **地址**  「这个词的定义在第几行」→ 读得懂；查词时用
//
//   ★★★ **只有第 1 种（承重）才构成"往回跳"。**
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 我为什么**不**自己判「承重」
//
//   判承重要做**删章测试**：「把被引那份删掉，这句话还成立吗？」
//   ★★ 那必须**懂内容** —— 是内容判断（硬规则①，归集群）。
//
//   ⇒ 所以我只做**形式特征可算的那几类**（依据/上游/地图/地址），
//     剩下判不了的一档叫 **`待判`**，明确标出「这一档我判不了，要集群做删章测试」。
//
//   ★ 这不是偷懒 —— 这是**承认量具的边界**。
//     把判不了的硬判成"倒挂"，正是上一版犯的错。
// ══════════════════════════════════════════════════════════════════════════

/** ★ 一条前向引用的来路（★ `待判` = 我判不了，需集群做删章测试）*/
export type CiteKind = "依据" | "上游" | "地图" | "地址" | "待判";

export type ClassifiedEdge = {
  /** ★ 谁引用 */
  from: string;
  /** ★ 引用了谁（且**排在后面**）*/
  to: string;
  kind: CiteKind;
  /** ★ 那一行的原文（截断），供人复核 */
  line: string;
};

/**
 * ★ 用**行的形式特征**判来路。
 *
 * ★ 为什么用形式特征：它们是**书写约定**，不是内容判断。
 *   ★★ 例如 `依据：xxx` 这一行的写法本身就声明了"这是复查用的出处"。
 */
function classifyLine(line: string, inRefSection: boolean): CiteKind {
  // ② 依据：行首「依据」/ 在 `## 依据` 之后 / 含「详见」
  if (/^\s*(?:\*\*)?依据/.test(line) || inRefSection || /详见/.test(line)) return "依据";
  // ③ 上游：`> 上游：`
  if (/^\s*>\s*上游/.test(line) || /^\s*上游[：:]/.test(line)) return "上游";
  // ④ 地图：「你在第几站 / 下一站 / 读法 / 怎么读」
  if (/下一步读|下一站|怎么读|读法|路线|入口图/.test(line)) return "地图";
  // ⑤ 地址：「定义页 / 词条 / 见定义」
  if (/定义页|词条|见定义/.test(line)) return "地址";
  return "待判";
}

/**
 * ★★★ 把前向引用按来路分类。
 *
 * @returns 每一类各几条 + **待判的那几条**（★ 那才是需要集群做删章测试的）
 */
export function classifyForward(opts: { bookSrc: string; subdir?: string }): {
  edges: ClassifiedEdge[];
  counts: Record<CiteKind, number>;
  /** ★ 承重候选 = `待判`（我判不了，要集群判）*/
  candidates: ClassifiedEdge[];
} {
  const sub = opts.subdir ?? "05-集群产出";
  const dir = join(opts.bookSrc, sub);
  const summaryPath = join(opts.bookSrc, "SUMMARY.md");

  // ★ 目录顺序
  let order: string[] = [];
  try {
    const summary = readFileSync(summaryPath, "utf8");
    for (const line of summary.split("\n")) {
      const open = line.indexOf("](");
      if (open < 0) continue;
      const close = line.indexOf(")", open);
      if (close < 0) continue;
      const target = line.slice(open + 2, close).trim();
      const pre = `${sub}/`;
      if (!target.startsWith(pre)) continue;
      order.push(target.slice(pre.length));
    }
  } catch {
    /* 没目录 */
  }
  if (order.length === 0) return { edges: [], counts: { 依据: 0, 上游: 0, 地图: 0, 地址: 0, 待判: 0 }, candidates: [] };

  const pos = new Map(order.map((f, i) => [f, i]));
  const stems = order.map((f) => ({ f, stem: stemOf(f) }));

  const edges: ClassifiedEdge[] = [];
  for (const [i, f] of order.entries()) {
    let text = "";
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let inRef = false;
    for (const line of lines) {
      // ★ 跟踪是否在 `## 依据` 这一节里
      if (/^#+\s*(依据|参考|引文|文献)/.test(line)) inRef = true;
      else if (/^#+\s/.test(line)) inRef = false;
      for (const { f: g, stem } of stems) {
        if (g === f || stem.length < 8) continue;
        if (!line.includes(stem)) continue;
        const at = pos.get(g);
        if (at === undefined || at <= i) continue; // ★ 只看前向
        edges.push({ from: f, to: g, kind: classifyLine(line, inRef), line: line.trim().slice(0, 100) });
      }
    }
  }

  const counts: Record<CiteKind, number> = { 依据: 0, 上游: 0, 地图: 0, 地址: 0, 待判: 0 };
  for (const e of edges) counts[e.kind]++;
  return { edges, counts, candidates: edges.filter((e) => e.kind === "待判") };
}
