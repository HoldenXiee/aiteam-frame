// ★ 书的读数（离线，可随时跑）
//
//   npx tsx research/clusters/forge/micro/readout-book.ts
//
// ★ 与 runner 收尾时报的是**同一个纯函数**（`tools/bookreport.ts`），
//   所以离线看到的数和不跑集群时看到的一致 —— 这是纪律⑦的用处。

import { join } from "node:path";
import { bookReport, renderBookReport } from "../tools/bookreport.ts";
import { citationQuality, findIsolated, renderIsolation } from "../tools/isolation.ts";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const r = bookReport({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });

const out: string[] = [];
out.push(renderBookReport(r));
out.push("");
out.push("## 主题聚类（★ 只数文件名前缀，不判内容）");
for (const c of r.clusters) out.push(`${c.prefix}: ${c.count} 份`);
out.push("");
if (r.unreachable > 0) out.push(`★ ${r.unreachable} 份读者点不到（目录没列）`);
if (r.chapters.dangling.length) {
  out.push(`★ 悬空章号：${r.chapters.dangling.map((n) => `第${n}章`).join(" ")}`);
}

// ★★★ 「散记」的代理量（2026-10-20）
//   ★ 为什么和 book 放一起：它们是**同一件事的两个视角** ——
//     book 量「书的结构」，isolation 量「各份之间有没有连接」。
const iso = findIsolated(join(REPO, "research/labfirst/forge/outbox"));
if (iso.all.length) {
  out.push("");
  out.push("## 连接度（散记的代理量）");
  out.push(renderIsolation(iso));
  const q = citationQuality(join(REPO, "research/labfirst/forge/outbox"));
  out.push(`引用质量：${q.total} 次 · 光秃秃 ${q.bare} 次（${q.barePct.toFixed(0)}%）★ 涨了就是被刷`);
  out.push(`★★ 最孤立的前 3 份（按字数，★ 长 = 孤立是实测的）`);
  for (const x of iso.isolated.slice(0, 3)) out.push(`  · ${x.chars} 字  ${x.artifact.slice(0, 45)}`);
}

process.stdout.write(out.join("\n") + "\n");
