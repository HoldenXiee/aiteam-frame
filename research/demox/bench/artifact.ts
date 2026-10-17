// ★ 产物质量度量（DESIGN 说「有效且**高质量**」—— 我只测了"有效"）
//
// ★ 为什么要单独做（见 `research/demox/重读DESIGN-新触发.md` 触发 3）
//   DESIGN 原文：「**有效且高质量地**使用这成本几乎为零的智力」——**两个要求**。
//   而 demox 十几轮实验，判据全是「对不对」（`quality.ts` 的 recall×precision×honesty）。
//   ★ **「这份产物拿去做事够不够」一次没量过** —— 这是 C4 缺口。
//
// ★ 而且 DESIGN 自己给了方向（`DESIGN-解读.md` Q12 的 (a)）：
//   > 产物要能带「证据链」（引用了哪份材料的哪一行），人只抽查证据链；
//   > 这样「人花了多少时间」就变成可测的。
//   ⇒ ★ **有证据链 → 人可抽查 → 人的劳动可测**。这是「人的位置」的入口。
//
// ★ 五个维度（都能纯函数离线重判，不看模型说了什么）
//   usable      产物**存在且能被程序读**（不是让人再解析一段自然语言）
//   complete    要求的字段都在（缺一项就得人来补）
//   traceable   ★ **每条结论带得出依据**（引用了哪份材料）
//   verifiable  ★ **依据是真的**（引用的编号确实存在于语料）
//   reviewable  ★ **人能快速抽查**（证据链够短、能定位）
//
// ★ 判据纪律：**不泄露 ground truth**，只问「产物本身够不够用」。
import type { Task } from "./tasks.ts";

export interface ArtifactQuality {
  /** 能不能被程序直接读（JSON 可解析 / 结构化） */
  usable: boolean;
  /** 要求的信息在不在 */
  complete: number; // 0..1
  /** ★ 结论有没有带依据 */
  traceable: number; // 0..1
  /** ★ 依据是不是真的（引用的编号存在） */
  verifiable: number; // 0..1
  /** ★ 人能不能快速抽查 */
  reviewable: number; // 0..1
  /** 综合（几何平均 —— 任一项为 0 则整体为 0，与 quality.ts 同口径） */
  score: number;
  /** 人话诊断：哪些维度塌了 */
  wounds: string[];
}

/** 从产物文本里抽出结构化内容，抽不出来就返回 null（used by usable） */
export function parseArtifact(text: string | null): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();
  // 直接是 JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续 */
  }
  // 包在代码块里 —— ★ 这算「不可程序直接读」吗？**算可用**（剥壳即可），但要记一笔
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 继续 */
    }
  }
  // 最外层大括号
  const i = trimmed.indexOf("{");
  const j = trimmed.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(trimmed.slice(i, j + 1));
    } catch {
      /* 继续 */
    }
  }
  return null;
}

/** 从一条结论里抽出它引用的材料编号 */
function citedIds(entry: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      // M12 / m12 / 材料12 —— 只认同一种规范写法（"M" + 数字）
      for (const m of v.matchAll(/\b[mM](\d{1,3})\b/g)) out.push(`M${Number(m[1])}`);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(entry);
  return out;
}

/**
 * 判产物质量。
 *
 * @param text      产物原文（读不到就给 null）
 * @param task      任务（用它的 corpus 编号判断"依据真不真"—— **不用 hidden/ground truth**）
 * @param opts.expect  这套产物**应该**包含哪些条目（不泄露真值：只数数量，不比对内容）
 */
export function artifactQuality(
  text: string | null,
  task: Task,
  opts: { expect?: number } = {},
): ArtifactQuality {
  const wounds: string[] = [];
  const parsed = parseArtifact(text);

  // ── usable ──
  const usable = parsed !== null && typeof parsed === "object";
  if (!usable) wounds.push("产物读不出来（不是合法 JSON）—— 人得先手工解析");

  // ── complete ──
  let complete = 0;
  const expect = opts.expect ?? task.corpus.length;
  let groups: unknown[] | null = null;
  if (usable) {
    const o = parsed as Record<string, unknown>;
    // 找"分组"字段：duplicates / groups / pairs 都认
    const key = ["duplicates", "groups", "pairs", "result"].find((k) => Array.isArray(o[k]));
    if (key) groups = o[key] as unknown[];
  }
  if (groups) {
    complete = 1;
    // 每个分组至少要有 2 个编号 —— 只有 1 个的组没有意义
    const degenerate = groups.filter((g) => citedIds(g).length < 2).length;
    if (degenerate > 0) {
      complete *= 1 - degenerate / groups.length;
      wounds.push(`${degenerate} 个分组少于两个编号 —— 不成一组`);
    }
  } else if (usable) {
    wounds.push("产物里找不到分组字段（duplicates/groups/pairs）");
  }

  // ── traceable + verifiable ── ★ 这两条是 DESIGN Q12 要的「证据链」
  const valid = new Set(task.corpus.map((d) => d.id));
  let traceable = 0;
  let verifiable = 0;
  if (groups && groups.length) {
    const withCite = groups.filter((g) => citedIds(g).length >= 2).length;
    traceable = withCite / groups.length;
    const allCited = groups.flatMap((g) => citedIds(g));
    const realCited = allCited.filter((id) => valid.has(id)).length;
    verifiable = allCited.length ? realCited / allCited.length : 0;
    if (traceable < 1) wounds.push(`${groups.length - withCite} 条结论**没带得出依据**`);
    if (verifiable < 1) wounds.push(`${allCited.length - realCited} 处引用了**语料里不存在的编号**`);
  } else if (usable) {
    wounds.push("没有分组 → 无从查证依据");
  }

  // ── reviewable ── ★ 人抽查的成本：结论条数别太多、编号别太长
  let reviewable = 0;
  if (groups) {
    const n = groups.length;
    // 人抽查的成本 ≈ 条数；期望规模 = 语料量的一半（正常的重复组数）
    const expected = Math.max(1, Math.round(expect / 2));
    const ratio = n <= expected * 2 ? 1 : expected * 2 / n;
    const maxLen = Math.max(...groups.map((g) => citedIds(g).length));
    const lenPenalty = maxLen <= 4 ? 1 : 4 / maxLen; // 一个组塞太多编号 → 人得自己再拆
    reviewable = ratio * lenPenalty;
    if (ratio < 1) wounds.push(`${n} 条结论，人要逐条核 —— 偏多`);
    if (lenPenalty < 1) wounds.push(`有的组塞了 ${maxLen} 个编号 —— 人得自己再判断`);
  }

  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const parts = [complete, traceable, verifiable, reviewable].map(clamp);
  const score = usable && parts.every((p) => p > 0) ? Math.pow(parts.reduce((a, b) => a * b, 1), 1 / parts.length) : 0;

  return { usable, complete, traceable, verifiable, reviewable, score, wounds };
}
