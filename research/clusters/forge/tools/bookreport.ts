// ══════════════════════════════════════════════════════════════════════════
// ★★★ 书本身的可读性判据（2026-10-20）
//
//   设计者问的：「读者能不能**真的用起来**」。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么需要它（我自己的缺口）
//
//   之前所有判据都是**门视角**：
//     · 已发 9 份 / 被拒 36 份
//     · 带保留 2 份
//     · 悬空章号 7 个
//
//   ★★ 但这些都回答不了最要紧的那个问题：
//     **门砍掉 86% 之后，剩下的是"精华"还是"侥幸过关的少数"？**
//
//   实测证据（2026-10-20，34 份）：
//     13 份「理论-*」讲的是**同一个主题家族**（数/判据/落点/断言面/观测单元…）
//     7 份「实践-*」、5 份「读者-*」同构
//   ⇒ 读者要回答"一个数什么时候算数"，得读几份？**没人知道。**
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 这个判据只用**可数的东西**，不判内容对错
//
//   ★ 我必须小心：**判"内容好不好"是我的禁区**（硬规则①：那是集群的事）。
//   所以这里只算**结构量**：
//     ① 读者找得到吗（目录可达）
//     ② 跳转会不会断（引用完整）
//     ③ 一个主题散在几份（主题聚类）
//     ④ 一份里有多少是"研究痕迹"（修订记录 / work 路径）而不是结论
//
//   ★★ 四个都是**纯函数、0 API、可离线重判**（纪律⑦）。
// ══════════════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type BookReport = {
  /** 书里几份 */
  files: number;
  /** 目录列出了几份 */
  listed: number;
  /** ★ 读者点不到的份数（有文件、目录没列）*/
  unreachable: number;
  /** ★ 目录里指向不存在文件的条目 */
  danglingEntries: number;
  /** ★ 章号：存在的 / 悬空的 / 引用总数 / 落空次数 */
  chapters: { existing: number[]; dangling: number[]; refs: number; lost: number };
  /**
   * ★★★ 主题聚类：同一前缀下有几份。
   *
   * ★ 这不是"内容判断" —— 它只看**文件名前缀**（`理论-` / `实践-` / `读者-`）。
   * ★★ 它回答的是："读者要看'理论'这一块，得读几份？"
   *   而这个数**越小越可读**（但小到 1 份又意味着没有覆盖）。
   */
  clusters: { prefix: string; count: number; names: string[] }[];
  /**
   * ★ 研究痕迹占比：`修订记录` / `work/.../runs/` / `.jsonl` / `token 中位` 这类行。
   *
   * ★ 为什么关心它：**书是给读者用的，不是研究日志**。
   *   这些行对作者有用（可复查），对读者是噪音。
   *   ★★ 但它不是"坏" —— 只是**位置问题**（也许该进附录）。
   */
  traces: { lines: number; totalLines: number; ratio: number };
};

/** ★ 从文件名取主题前缀（`理论-数的落点-…` → `理论`）*/
function prefixOf(name: string): string {
  const i = name.indexOf("-");
  return i > 0 ? name.slice(0, i) : "（无前缀）";
}

/** ★ 一行是不是"研究痕迹"（给作者看的，不是给读者看的）*/
function isTrace(line: string): boolean {
  return (
    /修订记录/.test(line) ||
    /^\|\s*\d+\s*\|.*\|/.test(line) || // 修订表格行
    /work\/\S*(runs|work)\//.test(line) ||
    /\.jsonl/.test(line) ||
    /token 中位/.test(line) ||
    /复算/.test(line) ||
    /^> /.test(line) // ★ 引用块里的路径/数据说明
  );
}

/**
 * ★★★ 算一本书的可读性。
 *
 * @param bookSrc `research/book/src/`
 * @param subdir  章节子目录（默认 `05-集群产出`）
 */
export function bookReport(opts: { bookSrc: string; subdir?: string }): BookReport {
  const sub = opts.subdir ?? "05-集群产出";
  const dir = join(opts.bookSrc, sub);
  const summaryPath = join(opts.bookSrc, "SUMMARY.md");

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return {
      files: 0,
      listed: 0,
      unreachable: 0,
      danglingEntries: 0,
      chapters: { existing: [], dangling: [], refs: 0, lost: 0 },
      clusters: [],
      traces: { lines: 0, totalLines: 0, ratio: 0 },
    };
  }

  // ① 目录可达性
  const summary = (() => {
    try {
      return readFileSync(summaryPath, "utf8");
    } catch {
      return "";
    }
  })();
  const onDisk = new Set(files);
  const listed = new Set<string>();
  let danglingEntries = 0;
  for (const line of summary.split("\n")) {
    const open = line.indexOf("](");
    if (open < 0) continue;
    const close = line.indexOf(")", open);
    if (close < 0) continue;
    const target = line.slice(open + 2, close).trim();
    const pre = `${sub}/`;
    if (!target.startsWith(pre)) continue;
    const name = target.slice(pre.length);
    listed.add(name);
    if (!onDisk.has(name)) danglingEntries++;
  }
  const unreachable = files.filter((f) => !listed.has(f)).length;

  // ② 章号 + ③ 聚类 + ④ 痕迹
  const CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const toNum = (s: string): number => {
    if (/^\d+$/.test(s)) return Number(s);
    if (s === "十") return 10;
    if (s.length === 1) return CN[s] ?? NaN;
    if (s[0] === "十") return 10 + (CN[s[1]!] ?? 0);
    if (s[1] === "十") return (CN[s[0]!] ?? 0) * 10 + (CN[s[2]!] ?? 0);
    return NaN;
  };

  const existing = new Set<number>();
  const dangling = new Map<number, number>();
  let refs = 0;
  let lost = 0;
  let totalLines = 0;
  let traceLines = 0;
  const byPrefix = new Map<string, string[]>();

  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    const lines = text.split(/\r?\n/);
    totalLines += lines.length;
    traceLines += lines.filter(isTrace).length;

    const p = prefixOf(f);
    byPrefix.set(p, [...(byPrefix.get(p) ?? []), f]);

    // ★ 存在的章：看标题和文件名
    const head = text.slice(0, 400);
    for (const m of head.matchAll(/^#+\s*第\s*([一二三四五六七八九十0-9]{1,3})\s*章/gm)) {
      const n = toNum(m[1]!);
      if (!Number.isNaN(n)) existing.add(n);
    }
    for (const m of f.matchAll(/第([一二三四五六七八九十0-9]{1,3})章/g)) {
      const n = toNum(m[1]!);
      if (!Number.isNaN(n)) existing.add(n);
    }
  }

  // ★ 引用：全文（去掉第一行标题）
  for (const f of files) {
    const body = readFileSync(join(dir, f), "utf8").replace(/^#.*$/m, "");
    for (const m of body.matchAll(/第([一二三四五六七八九十0-9]{1,3})章/g)) {
      const n = toNum(m[1]!);
      if (Number.isNaN(n)) continue;
      refs++;
      if (!existing.has(n)) {
        dangling.set(n, (dangling.get(n) ?? 0) + 1);
        lost++;
      }
    }
  }

  const clusters = [...byPrefix.entries()]
    .map(([prefix, names]) => ({ prefix, count: names.length, names }))
    .sort((a, b) => b.count - a.count);

  return {
    files: files.length,
    listed: listed.size,
    unreachable,
    danglingEntries,
    chapters: {
      existing: [...existing].sort((a, b) => a - b),
      dangling: [...dangling.keys()].sort((a, b) => a - b),
      refs,
      lost,
    },
    clusters,
    traces: { lines: traceLines, totalLines, ratio: totalLines ? traceLines / totalLines : 0 },
  };
}

/** ★ 渲染成人能读的一行（跑完直接打日志用）*/
export function renderBookReport(r: BookReport): string {
  const parts = [
    `书 ${r.files} 份`,
    `目录 ${r.listed}`,
    `点不到 ${r.unreachable}`,
    `悬空条目 ${r.danglingEntries}`,
    `章号 ${r.chapters.existing.length} 个（悬空 ${r.chapters.dangling.length}）`,
    `引用落空 ${r.chapters.lost}/${r.chapters.refs}`,
    `痕迹 ${(r.traces.ratio * 100).toFixed(1)}%`,
  ];
  return parts.join(" · ");
}
