// 铺现场：把语料写进 work/corpus/、清掉上一轮的产物、按需预估花费。
//
// 两边实验**都不自己造材料** —— 都从这里拿（两份 README 的公平性自查表都列了这一条）。
// 跑法：
//   node demom/bench/prep.ts              铺语料 + 清产物
//   node demom/bench/prep.ts --check      只检查现场，不动任何文件
//
// 为什么要有「清产物」：上一轮的 report.md 留着，下一轮就算一个字没写，judge() 也可能判它 ok。
// 这是最容易让实验静默失效的一个点，所以做成显式步骤。

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "../env.ts";
import { CORPUS, CONTRADICTION_GROUPS, DISTRACTORS, DUPLICATE_GROUPS } from "./corpus.ts";
import { DRAFT_DIR, REPORT_FILE, TOPICS } from "./task.ts";

const CORPUS_DIR = join(cwd, "corpus");

/** 单轮的大致成本上限（免费档下是 0，但换档位时这个闸立刻有用） */
export const EST_ROUND_USD = 0.0002;

function writeCorpus(): void {
  // ⚠️ 先清空：语料 id 会跨版本复用（旧 M4 与新 M4 是不同材料、标题不同 → 两个文件都在），
  //    不清就会留下陈旧材料，而 agent 会把它当成真的语料读进去。
  if (existsSync(CORPUS_DIR)) rmSync(CORPUS_DIR, { recursive: true, force: true });
  mkdirSync(CORPUS_DIR, { recursive: true });
  for (const doc of CORPUS) {
    // 文件名带 id，方便人翻；**不带 topics** —— 那是判据的 ground truth，不该白送给 agent
    writeFileSync(join(CORPUS_DIR, `${doc.id}-${doc.title.replace(/[\\/:*?"<>|]/g, "_")}.md`), `${doc.title}\n\n${doc.text}\n`);
  }
}

/**
 * 数据集完整性自检：研究数据必须先过这一关，否则判据会在一个坏掉的底座上跑。
 *
 * 检查：id 唯一 / 埋点引用的 id 都真实存在 / 重复组与矛盾组不重叠 / 干扰材料真的没有主题。
 */
export function validateDataset(): string[] {
  const errs: string[] = [];
  const ids = CORPUS.map((d) => d.id);
  const all = new Set(ids);

  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupIds.length) errs.push(`材料 id 重复：${[...new Set(dupIds)].join("、")}`);

  for (const g of DUPLICATE_GROUPS)
    for (const id of g) if (!all.has(id)) errs.push(`重复组引用了不存在的 id：${id}`);
  for (const g of CONTRADICTION_GROUPS)
    for (const id of g) if (!all.has(id)) errs.push(`矛盾组引用了不存在的 id：${id}`);
  for (const id of DISTRACTORS) if (!all.has(id)) errs.push(`干扰材料引用了不存在的 id：${id}`);

  // 同一份材料不能既是重复组又是矛盾组（不然判据自相矛盾）
  const dupSet = new Set(DUPLICATE_GROUPS.flat());
  for (const id of CONTRADICTION_GROUPS.flat())
    if (dupSet.has(id)) errs.push(`材料 ${id} 同时出现在重复组和矛盾组里（判据会自相矛盾）`);

  // 干扰材料真的不该带主题
  for (const id of DISTRACTORS) {
    const d = CORPUS.find((x) => x.id === id);
    if (d && d.topics.length) errs.push(`干扰材料 ${id} 却带了主题：${d.topics.join(",")}`);
  }

  // 每个主题至少要有足够材料（不然「自由 vs 流程」的分辨力不足）
  for (const t of TOPICS) {
    const n = CORPUS.filter((d) => d.topics.includes(t.id)).length;
    if (n < 5) errs.push(`主题 ${t.id} 只有 ${n} 份材料，太少（建议 ≥5）`);
  }

  return errs;
}

function cleanArtifacts(): void {
  const reportPath = join(cwd, REPORT_FILE);
  if (existsSync(reportPath)) rmSync(reportPath);
  const draftPath = join(cwd, DRAFT_DIR);
  if (existsSync(draftPath)) rmSync(draftPath, { recursive: true, force: true });
}

/**
 * 跑一轮之前的现场重置。
 *
 * ★ 必须在**每一轮**之前调（不只是整批之前）★
 * 否则 `--repeat 5` 的第 2 轮会看到第 1 轮的 draft/ 与 report.md ——
 * 那意味着后几轮的数据被前几轮污染，而污染是静默的（产物看起来很正常）。
 */
export function resetScene(): void {
  cleanArtifacts();
  const dir = join(cwd, DRAFT_DIR);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** 现场检查：语料在不在、产物清没清 */
export function checkScene(): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;

  const files = existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR) : [];
  const missing = CORPUS.filter((d) => !files.some((f) => f.startsWith(d.id + "-"))).map((d) => d.id);
  // 多出来的文件也算不合格：陈旧语料会被 agent 当真材料读进去（实测撞过：清空前的 45 份）
  const extra = files.filter((f) => !CORPUS.some((d) => f.startsWith(d.id + "-")));
  lines.push(`    语料 ${files.length} 份（期望 ${CORPUS.length}）${missing.length ? ` ← 缺 ${missing.join(", ")}` : ""}${extra.length ? ` ← 多出 ${extra.join(", ")}` : ""}${!missing.length && !extra.length ? " ✓" : ""}`);
  if (missing.length || extra.length) ok = false;

  const reportThere = existsSync(join(cwd, REPORT_FILE));
  lines.push(`    产物 ${REPORT_FILE}：${reportThere ? "还在（上一轮的！必须清）" : "已清 ✓"}`);
  if (reportThere) ok = false;

  return { ok, lines };
}

// ─────────────────────────────────────────────────────────────
// 直接跑：铺现场。
//
// ⚠️ 必须用 `import.meta.main` 守住 —— 这个文件同时被当作**模块**（run.ts 要 import 它的
//    checkScene）。不守的话，import 它就会把下面整段跑一遍、还 process.exit 掉。
// ─────────────────────────────────────────────────────────────
if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");

  console.log("[prep] 实验室现场");
  console.log(`    cwd = ${cwd}`);

  if (checkOnly) {
    const s = checkScene();
    for (const l of s.lines) console.log(l);
    console.log(`    → ${s.ok ? "✓ 现场就绪" : "✗ 现场没就绪"}`);
    process.exit(s.ok ? 0 : 1);
  }

  console.log("[prep] 数据集完整性自检");
  const errs = validateDataset();
  if (errs.length) {
    for (const e of errs) console.log(`    ✗ ${e}`);
    console.log(`    → ✗ 数据集不完整，先改 bench/corpus.ts`);
    process.exit(1);
  }
  console.log(`    ✓ id 唯一、埋点都能解析、主题分布均匀（${CORPUS.length} 份）`);

  writeCorpus();
  cleanArtifacts();

  const s = checkScene();
  for (const l of s.lines) console.log(l);

  console.log(`\n[prep] 任务 T 的埋点（改 bench/corpus.ts 就是改难度）`);
  console.log(`    主题 ${TOPICS.length} 个：${TOPICS.map((t) => t.id).join(", ")}`);
  console.log(`    重复组 ${DUPLICATE_GROUPS.length} 组：${DUPLICATE_GROUPS.map((g) => g.join("≡")).join(" " )}`);
  console.log(`    矛盾组 ${CONTRADICTION_GROUPS.length} 组：${CONTRADICTION_GROUPS.map((g) => g.join(" vs ")).join(" ; ")}`);
  console.log(`    干扰材料 ${DISTRACTORS.length} 份：${DISTRACTORS.join("、")}`);

  console.log(`\n[prep] 成本闸（两边共用这个预估）`);
  console.log(`    一次完整对比 ≈ A 若干 agent + B 5 个阶段，各跑 N 次`);
  console.log(`    按 ${CORPUS.length} 份语料估：单次运行约 ${(EST_ROUND_USD * 8).toFixed(4)} USD 量级`);
  console.log(`    默认 N=5 → 单次对比约 ${(EST_ROUND_USD * 8 * 2 * 5).toFixed(4)} USD`);
  console.log(`    ⚠️ 当前档 longcat-2.5-preview-free 实测 cost=0；换档位前先看这段再跑`);
  console.log(`\n    → ✓ 现场就绪，可以跑：node demom/labA-cluster/run.ts / node demom/labB-workflow/run.ts`);
}
