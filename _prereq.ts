import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ★★★ 按「前提知识」量一本书：读者能不能「学过前提就能学会」
//
//   设计者原话：
//   「主要的就是违反了人的认知规律，在学习陌生知识，
//     如果学过前提知识就能轻松学会」
//
//   ⇒ 这就是「前置依赖」：
//     一份产物用到某个概念，读者**必须先学过它**；
//     如果那个概念只在**排得更后面**的产物里讲，读者就会被卡住。
const dir = "research/book/src/05-集群产出";
const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

// 目录里的实际顺序（= 读者读到的顺序）
const summary = readFileSync("research/book/src/SUMMARY.md", "utf8");
const order: string[] = [];
for (const line of summary.split("\n")) {
  const m = line.match(/\]\(05-集群产出\/([^)]+)\)/);
  if (m) order.push(decodeURIComponent(m[1]!));
}
const pos = new Map<string, number>();
order.forEach((f, i) => pos.set(f, i));

// ★ 每份产物的「题目里承重的概念词」——用标题里出现的实词当锚
const titleOf = (f: string) => {
  const t = readFileSync(join(dir, f), "utf8");
  const h = t.match(/^#\s+(.+)$/m)?.[1] ?? f;
  // 取标题里的实词（去掉「第X章」「·」这类）
  return h.replace(/^第[一二三四五六七八九十0-9]+章\s*[·.]?\s*/, "").trim();
};

// ★ 概念锚：标题里「：」前的那个短语（作者自己起的名字）
const conceptOf = (f: string): string => {
  const h = titleOf(f);
  const before = h.split(/[：:]/)[0]!;
  return before.replace(/^[^·]*·\s*/, "").trim();
};

type Row = {
  file: string;
  idx: number;
  concept: string;
  /** ★ 它引用了哪些「排在它后面」的产物 */
  forward: { target: string; targetIdx: number; concept: string }[];
};

const rows: Row[] = [];
for (const f of files) {
  const body = readFileSync(join(dir, f), "utf8");
  const myIdx = pos.get(f) ?? 999;
  const forward: Row["forward"] = [];
  for (const g of files) {
    if (g === f) continue;
    const gIdx = pos.get(g) ?? 999;
    if (gIdx <= myIdx) continue; // 只找「排在我后面」的
    const stem = g.replace(/\.md$/, "").slice(0, 12);
    if (stem.length < 8) continue;
    if (body.includes(stem)) {
      forward.push({ target: g, targetIdx: gIdx, concept: conceptOf(g) });
    }
  }
  rows.push({ file: f, idx: myIdx, concept: conceptOf(f), forward });
}

const out: string[] = [];
out.push(`书 ${files.length} 份 · 目录里排上 ${order.length} 份`);
out.push("");
const bad = rows.filter((r) => r.forward.length > 0);
out.push(`## ★★★ 前置依赖倒挂（用到排在后面的东西）`);
out.push(`有倒挂的：**${bad.length} / ${files.length} 份**`);
out.push("");
for (const r of bad.sort((a, b) => b.forward.length - a.forward.length).slice(0, 12)) {
  out.push(`· [第${r.idx + 1}位] ${r.concept.slice(0, 24)}`);
  out.push(
    `  ↳ 用到排在后面的：${r.forward
      .slice(0, 4)
      .map((x) => `「${x.concept.slice(0, 16)}」(第${x.targetIdx + 1}位)`)
      .join("、")}`,
  );
}
process.stdout.write(out.join("\n") + "\n");
