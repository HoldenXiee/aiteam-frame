// publish —— ★★★ 写进 `research/book/` 的**唯一入口**（共识门真的挡住它）
//
// ══════════════════════════════════════════════════════════════════
// ★★★ 为什么必须有一个"唯一的写入口"
//
//   ★ 前几轮的缺口：共识门会**判定**、会**报账**（`work/consensus.md`），
//     但 `research/book/` 的写入路径**完全没接门** ⇒
//     "没签字的东西不能进书"只是一句话，**代码上一处都没挡**。
//
//   ★★★ 这是 `P13` 的第四次：**写在文档里的规则 = 没有规则**。
//     ⇒ 规则必须落在**唯一的执行点**上（和"红线钉在 createLab"同一个思路）。
//
// ★★ 判据（跑前冻结，可离线重判）：
//     · 全体团队 `认同`                    → ✔ 可发布
//     · 有 `有保留` **且给了解除条件**      → ✔ 可发布（保留意见附在文末）
//     · 有 `反对` / 没表态 / 保留没给解除条件 → ⛔ 拒绝发布
// ══════════════════════════════════════════════════════════════════

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gateVerdict, renderSignOff, loadSignOffs, agreedArtifacts, type SignOffTable } from "./signoff.ts";

export interface PublishResult {
  published: string[];
  rejected: { artifact: string; why: string[] }[];
  /** ★ 已发布但带着保留意见的（人要看到）*/
  withReservations: { artifact: string; note: string }[];
}

/**
 * ★★★ 把**开了门**的产物发布进 `research/book/src/`。
 *
 * ★ 幂等：已发布过的再跑一次只是覆盖（内容来自 outbox，不重复累加）。
 * ★★ 拒绝清单**不静默** —— 每一份被拒都要说出为什么。
 */
export function publishToBook(opts: {
  /** forge 空间的 outbox 目录 */
  outboxDir: string;
  /** 签字台账 */
  signoffsPath: string;
  /** 全体团队 */
  allTeams: readonly string[];
  /** `research/book/src/` 目录 */
  bookSrc: string;
  /** ★ 写进 book 的章节子目录（默认 `05-从集群产出/`）*/
  subdir?: string;
  /** ★ true = 只算不写（干跑）*/
  dryRun?: boolean;
}): PublishResult {
  const table: SignOffTable = loadSignOffs(opts.signoffsPath);
  const sub = opts.subdir ?? "05-集群产出";
  const destDir = join(opts.bookSrc, sub);

  const published: string[] = [];
  const rejected: { artifact: string; why: string[] }[] = [];
  const withReservations: { artifact: string; note: string }[] = [];

  const all = existsSync(opts.outboxDir)
    ? readdirSync(opts.outboxDir).filter((f) => f.endsWith(".md"))
    : [];

  for (const f of all) {
    const signs = table.get(f);
    const m = gateVerdict(signs, opts.allTeams);
    if (!m.ok) {
      const why: string[] = [];
      if (m.blocked.length) why.push(`反对：${m.blocked.join("；")}`);
      if (m.missing.length) why.push(`未表态：${m.missing.join("、")}`);
      rejected.push({ artifact: f, why });
      continue;
    }
    // ★ 保留意见随产物走（不能"开了门就当没说过"）
    const note = renderSignOff(f, signs);
    if (m.reservations.length) withReservations.push({ artifact: f, note: m.reservations.join("\n") });
    if (opts.dryRun) {
      published.push(f);
      continue;
    }
    mkdirSync(destDir, { recursive: true });
    const src = join(opts.outboxDir, f);
    const body = readFileSync(src, "utf8");
    // ★★ 保留意见附在文末 —— 读者要知道"有人反对过但被解除了"
    const tail = note ? `\n\n${note}` : "";
    writeFileSync(join(destDir, f), body + tail);
    published.push(f);
  }

  return { published, rejected, withReservations };
}

/** ★ 把发布结果渲染成人能读的一份账 */
export function renderPublishReport(r: PublishResult, allTeams: readonly string[]): string {
  const L: string[] = [
    `# 发布账（${new Date().toISOString()}）`,
    ``,
    `★ 全体团队：${allTeams.join("、")}`,
    `★ 门规则：全体认同 → 可发；有保留+解除条件 → 可发（意见附文末）；反对/没表态/保留无解除 → ⛔`,
    ``,
    `## ✔ 已发布 ${r.published.length} 份`,
    ...r.published.map((f) => `- ${f}`),
    ``,
  ];
  if (r.withReservations.length) {
    L.push(`## ⚠ 带保留发布的 ${r.withReservations.length} 份（★ 人要看一眼）`, ``);
    for (const w of r.withReservations) {
      L.push(`### ${w.artifact}`, ``, w.note, ``);
    }
  }
  L.push(`## ⛔ 被拒 ${r.rejected.length} 份`, ``);
  if (r.rejected.length === 0) L.push(`（无）`);
  for (const x of r.rejected) {
    L.push(`### ${x.artifact}`, ...x.why.map((w) => `- ${w}`), ``);
  }
  return L.join("\n") + "\n";
}

/** ★ 供 CLI / runner 使用：一次发布 + 落账 */
export function publishAndReport(opts: Parameters<typeof publishToBook>[0] & { reportPath: string }): PublishResult {
  const r = publishToBook(opts);
  if (!opts.dryRun) writeFileSync(opts.reportPath, renderPublishReport(r, opts.allTeams));
  return r;
}

/** ★ 只算"哪些能发"，不写盘（给收尾汇报用）*/
export function agreedForPublish(signoffsPath: string, allTeams: readonly string[]): string[] {
  return agreedArtifacts(loadSignOffs(signoffsPath), allTeams);
}

export { copyFileSync };
