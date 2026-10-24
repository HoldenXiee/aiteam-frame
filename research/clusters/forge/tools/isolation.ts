// ══════════════════════════════════════════════════════════════════════════
// ★★★ 「散记」的可算代理量（2026-10-20）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么需要它
//
//   `missions.ts` 的 `forge.antiValue` 最后一句是最重的禁令：
//     「★★ 一句话：**没长出新概念的内容，不算这本教科书的内容。**」
//   ★★ 而实测：`grep "概念|定义|模型" rules.ts` ⇒ **12 条规则里 0 条提到**。
//   ⇒ 这条禁令**零出口**（纪律㉕：写在文档里的规则 = 没有规则）。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 但我**不能**判"有没有新概念"——那是内容判断（硬规则①）
//
//   ⇒ 所以这里只算**一个可数的代理量**：**这份产物引用了多少份别的产物**。
//
//   ★ 判据依据：`antiValue` 自己列的两种病都有共同形状 ——
//     · 「分散的散记：再写一条 P 号成果，写得比原来长一点」
//     · 「只做摘要 / 只做汇总」
//     ⇒ 它们的共同点是 **跟已有的东西没有连接**：
//       散记各说各的；摘要至少要说"我摘的是哪份"。
//
//   ★★★ 所以「零引用」= **既没说自己在回答谁，也没说自己在修正谁** ——
//     这是"散"的一个**必要**症状（不是充分条件：零引用也可能是真的新方向）。
//   ⇒ 因此它**只报数、不拦截**，由集群自己判断该怎么处理。
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 实测基线（2026-10-20，62 份非下划线产物）
//
//     引用 0 份：**24 份（39%）**   ← ★★★ 完全孤立
//     引用 1 份：20 份
//     引用 2 份： 7 份
//     引用 3-4 份：7 份
//     引用 7 份：  3 份
//     引用 22 份： 1 份（`_决策表.md` 那种总表）
//
//   ★★ 注意：**分布没有自然断层**（0→1→2 是连续的），
//     所以我**不设阈值** —— 设了就是我拍的数。
//     只把"零引用"这一档（有明确定义：一份都没提）拎出来。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** ★ 一份产物的引用情况 */
export type Isolation = {
  artifact: string;
  /** ★ 它提到了多少份**别的**产物（出度） */
  cites: number;
  /**
   * ★★★★★ 有多少份**别的**产物提到了它（入度）
   *
   * ★★★ 为什么必须记这一半（2026-10-21，**第三次修我的量具**）：
   *
   *   我原来只数"出度"（它引用了谁），把 19 份判成"散记"。
   *   ★ 实测：这 19 份里 **8 份是被别人大量引用的**（例：`实践-冗余买不到数` 被引 5 次）。
   *   ⇒ 那 8 份不是散记，是**别的章的根据** —— 源头本来就不需要引用别人。
   *
   *   ★★ 真散记的判据是**两边都为零**：既不引用别人，**也没人引用它**。
   *   ★★★ 真孤岛实测只有 **3 份**，不是 19 —— 我的旧判据夸大了 **6 倍**。
   *
   *   ★ 与集群推翻我「前置倒挂」那次是同一个道理：
   *     「**提及是依赖的必要条件，不是充分条件**」——
   *     这里反过来：**没提及不等于没被依赖**。
   */
  citedBy: number;
  /** ★ 它的字数（只用于排序，不判好坏）*/
  chars: number;
  /**
   * ★ 四种角色（★ 只有 `island` 是病）
   * · `island`     出 0 入 0 ⇒ **真散记**
   * · `source`     出 0 入 >0 ⇒ 被依赖的源头（★ 正常，别当成病）
   * · `sink`       出 >0 入 0 ⇒ 只引用别人的综述（★ 正常）
   * · `connected`  两边都 >0
   */
  role: "island" | "source" | "sink" | "connected";
};

/**
 * ★★★ 算「哪些产物是孤立的小岛」。
 *
 * @param outboxDir forge 的 outbox
 * @param opts.stripUnderscore ★ 跳过 `_` 开头的汇总文件（默认 true）
 *        ★ 理由：`_决策表.md` 这类**本来就是索引**，引用 40 份是它的职责，
 *          把它算进来会污染分布。
 */
export function findIsolated(
  outboxDir: string,
  opts?: { stripUnderscore?: boolean },
): { all: Isolation[]; isolated: Isolation[] } {
  const strip = opts?.stripUnderscore ?? true;
  let files: string[] = [];
  try {
    files = readdirSync(outboxDir).filter((f) => f.endsWith(".md"));
  } catch {
    return { all: [], isolated: [] };
  }
  if (strip) files = files.filter((f) => !f.startsWith("_"));

  const texts = new Map<string, string>();
  for (const f of files) {
    try {
      texts.set(f, readFileSync(join(outboxDir, f), "utf8"));
    } catch {
      /* 读不到就跳过（不静默：下面 all 里就没有它）*/
    }
  }

  // ★ 用文件名前 12 字当"指称标记"。
  //   ★ 为什么不用全文相似度：实测平均重复句只有 1.3% —— **复述不是这个集群的病**。
  //     （这条我先验证过才换的方向，见 `research/docs/实验/`）
  const stems = [...texts.keys()].map((f) => ({ f, stem: f.replace(/\.md$/, "").slice(0, 12) }));

  const all: Isolation[] = [];
  for (const [f, t] of texts) {
    let cites = 0;
    for (const { f: g, stem } of stems) {
      if (g === f) continue;
      if (stem.length < 8) continue; // ★ 太短的标记会误命中
      if (t.includes(stem)) cites++;
    }
    // ★★★ 入度：**别人**有没有提到我（★ 2026-10-21 补，旧版只有出度）
    const myStem = f.replace(/\.md$/, "").slice(0, 12);
    let citedBy = 0;
    if (myStem.length >= 8) {
      for (const [g, gt] of texts) {
        if (g === f) continue;
        if (gt.includes(myStem)) citedBy++;
      }
    }
    const role: Isolation["role"] =
      cites === 0 && citedBy === 0
        ? "island"
        : cites === 0
          ? "source"
          : citedBy === 0
            ? "sink"
            : "connected";
    all.push({ artifact: f, cites, citedBy, chars: t.length, role });
  }
  all.sort((a, b) => a.cites - b.cites || b.chars - a.chars);
  // ★★★ 只有「两边都为零」才是真散记（2026-10-21 修：旧判据只看出度，夸大了 6 倍）
  return { all, isolated: all.filter((x) => x.role === "island") };
}

/** ★ 渲染成给人看的一段读数 */
export function renderIsolation(r: ReturnType<typeof findIsolated>): string {
  const n = r.all.length;
  const z = r.isolated.length;
  const avg = n ? r.all.reduce((s, x) => s + x.cites, 0) / n : 0;
  const pct = n ? ((z / n) * 100).toFixed(0) : "0";
  const src = r.all.filter((x) => x.role === "source").length;
  const sink = r.all.filter((x) => x.role === "sink").length;
  // ★★★ 2026-10-21：把「真孤岛」和「只出零（被依赖的源头）」分开报
  //   ★ 旧版只报"零引用 19 份" ⇒ 集群会当成 19 份散记去救，
  //     实际其中 8 份是**别人引用它、它不引用别人**（源头本来如此，不用救）。
  return (
    `${n} 份 · 平均引用 ${avg.toFixed(1)} 份 · ` +
    `★★ 真孤岛 ${z} 份（${pct}%，★ 出 0 且入 0）` +
    (src ? ` · 只出零 ${src} 份（★ 被依赖的源头，正常）` : "") +
    (sink ? ` · 只入零 ${sink} 份（★ 综述型，正常）` : "")
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 防「刷指标」（2026-10-20）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么需要
//
//   ★ 我上一节刚把「零引用」变成可见的坏指标，这就等于告诉集群
//     **"塞一句文件名就能过关"**。
//
//   ★★★ 这是我自己写在文档里的话（纪律㉕的原话）：
//     「写在提示词里的规则 = 没有规则」——
//     而"不许硬塞引用"当时**只写在提示词里**。
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 可算的区分：**「提到」和「说了什么关于它」**
//
//   刷指标的样子：文件名出现在一句没有内容的句子里
//     · 「参见 `xxx.md`」   ← 光秃秃的引用
//     · 「另见 xxx」        ← 同上
//     · 文末列一堆文件名    ← 参考文献式刷
//
//   真整合的样子：文件名出现在**有主张**的句子里
//     · 「`xxx.md` 的 κ2<1 只证明了形状是前提，不是它落地的原因」
//     · 「我按 `xxx.md` 的 32 行复算，S1Q1 是 565,958 token」
//
//   ★★ 判据（可算、不判内容对错）：
//     这个文件名所在的**那一句**，扣掉文件名后还剩多少字？
//     剩下 < 12 字 ⇒ 极可能是光秃秃的引用。
// ══════════════════════════════════════════════════════════════════════════

/** ★ 一次提及的质量 */
export type Citation = {
  /** ★ 提到了哪一份 */
  target: string;
  /** ★ 那一句（扣掉文件名后）还剩多少字 */
  contextChars: number;
  /** ★ 是不是"光秃秃"的引用（contextChars < 12）*/
  bare: boolean;
};

/**
 * ★★★ 逐次检查"提到"的质量（防止为了不孤立而硬塞文件名）。
 *
 * @param text 产物正文
 * @param self 这份自己的文件名（不算自己的引用）
 * @param others 其它所有产物文件名
 */
export function auditCitations(
  text: string,
  self: string,
  others: readonly string[],
): { total: number; bare: number; real: number; citations: Citation[] } {
  // ★ 按句切（中英文标点都算）—— 判"同一句里有没有别的内容"
  const sents = text.split(/[。；\n]+/);
  const out: Citation[] = [];
  for (const other of others) {
    if (other === self) continue;
    const stem = other.replace(/\.md$/, "").slice(0, 12);
    if (stem.length < 8) continue;
    for (const s of sents) {
      if (!s.includes(stem)) continue;
      // ★ 扣掉文件名和常见标记（反引号、连接词）后还剩多少
      const rest = s
        .split(stem)
        .join("")
        .replace(/[`「」【】、，,：:（）()《》\s]/g, "")
        .replace(/参见|另见|详见|如上|下述|同上|参考/g, "");
      const contextChars = rest.length;
      out.push({ target: other, contextChars, bare: contextChars < 12 });
    }
  }
  const bare = out.filter((c) => c.bare).length;
  return { total: out.length, bare, real: out.length - bare, citations: out };
}

/** ★ 全库的引用质量读数（一行，进日志用）*/
export function citationQuality(
  outboxDir: string,
): { total: number; bare: number; barePct: number } {
  let files: string[] = [];
  try {
    files = readdirSync(outboxDir).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  } catch {
    return { total: 0, bare: 0, barePct: 0 };
  }
  let total = 0;
  let bare = 0;
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(join(outboxDir, f), "utf8");
    } catch {
      continue;
    }
    const r = auditCitations(text, f, files);
    total += r.total;
    bare += r.bare;
  }
  return { total, bare, barePct: total ? (bare / total) * 100 : 0 };
}
