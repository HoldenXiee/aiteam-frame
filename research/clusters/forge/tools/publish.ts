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

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gateVerdict, renderSignOff, loadSignOffs, agreedArtifacts, type SignOffTable } from "./signoff.ts";

export interface PublishResult {
  published: string[];
  rejected: { artifact: string; why: string[] }[];
  /** ★ 已发布但带着保留意见的（人要看到）*/
  withReservations: { artifact: string; note: string }[];
  /** ★★★ 这次被拒、且已从书里**撤下**的（原来门撤不下任何东西）*/
  removed: string[];
  /** ★★★ 撤下之后，**还在引用它的产物**（读者点过去是 404）*/
  orphans: { missing: string; citedBy: string[] }[];
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
  /**
   * ★★★ 「能不能照做」的硬门槛（2026-10-20）。
   *
   * ★ 设计者裁定：「可以**用作「工具」**」—— 但实测 79% 的份成了实验报告
   *   （含 ≥20 处 `work/` 实验路径），newcomer 原话：
   *   「它现在是一份给同行看的**实验报告**，不是给新人的**说明书**」。
   *
   * ★★ 为什么放在这里（而不是加一条规则催它）：纪律㉕ ——
   *   规则必须落在**结构上**。发布路径是**唯一写入口**，
   *   放在这里 = 真的拦得住；写成提示词 = 没有规则。
   *
   * ★ 不传 ⇒ 只看签字门（与旧行为完全一致，便于对照实验）。
   */
  usableCheck?: (artifact: string) => { usable: boolean; why: string };
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
    // ★★★ 「能不能照做」的硬门槛（在共识门之后 —— 两个门是**并列**关系）
    //
    //   ★ 为什么要有第二道门：共识门回答「三个团队都说站得住吗」，
    //     而**三个团队都说对、读者照样看不懂**是实测的常态（90% 的产物观众意见分歧）。
    //   ★★ 判"能不能用"的人**必须是 newcomer**：他的定义就是"没有这本书背后的上下文"。
    if (opts.usableCheck) {
      const u = opts.usableCheck(f);
      if (!u.usable) {
        rejected.push({ artifact: f, why: [`不可用（照不了做）：${u.why}`] });
        continue;
      }
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

  // ══════════════════════════════════════════════════════════════════════
  // ★★★ 撤下「这次被拒、但书里还留着」的产物（2026-10-20）
  //
  //   病（实测）：书里 38 份，而发布账说"被拒 30 份"——
  //   ★★ 其中 **5 份同时存在于这两处**：
  //     门现在会拒绝它们（如 newcomer 说「都不够」），但它们**早就进书了**。
  //
  //   ★ `publishToBook` 原来只做 `copyFileSync` **新增，从不删** ⇒
  //     · 门只管"新东西进不进"
  //     · **已经进书的坏东西，门管不到**
  //   ⇒ 结果：书里混着"现在会被拒"的内容，而账上写着它被拒。
  //   ★★★ 这违反纪律⑩：**书的现状必须对应一次确定的门判定**。
  //
  //   ★ 修法：被拒的若已在书里 ⇒ **删掉**，并在账里单列一栏（不静默）。
  const removed: string[] = [];
  if (!opts.dryRun) {
    for (const r of rejected) {
      const p = join(destDir, r.artifact);
      if (existsSync(p)) {
        try {
          rmSync(p);
          removed.push(r.artifact);
        } catch {
          /* 删不掉不静默：留给账里的人看 removed 少了这一份 */
        }
      }
    }
  } else {
    for (const r of rejected) {
      if (existsSync(join(destDir, r.artifact))) removed.push(r.artifact);
    }
  }

  // ★★★ 撤下之后：**谁还在引用被撤下的东西**（2026-10-21）
  //
  //   病（实测）：`读者-第六章-判选算验…` 被 newcomer 判「不可用」⇒ 撤下，
  //   ★★ 但**其他 16 份产物还在引用它** ⇒ 引用落空从 30 涨到 **81**。
  //
  //   ⇒ 这比"少了一章"更糟：**读者点过去是 404**。
  //   ★ 我不替它改引用（那是内容判断），但必须**让这件事可见**。
  const orphans: { missing: string; citedBy: string[] }[] = [];
  if (!opts.dryRun && removed.length) {
    let files: string[] = [];
    try {
      files = readdirSync(destDir).filter((f) => f.endsWith(".md"));
    } catch {
      /* 目录没了 */
    }
    for (const gone of removed) {
      const stem = gone.replace(/\.md$/, "").slice(0, 12);
      if (stem.length < 8) continue;
      const citedBy: string[] = [];
      for (const f of files) {
        if (f === gone) continue;
        try {
          if (readFileSync(join(destDir, f), "utf8").includes(stem)) citedBy.push(f);
        } catch {
          /* 读不到跳过 */
        }
      }
      if (citedBy.length) orphans.push({ missing: gone, citedBy });
    }
  }

  return { published, rejected, withReservations, removed, orphans };
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
  // ★★★ 撤下的必须单列一栏（不静默）
  if (r.removed && r.removed.length) {
    L.push(
      `## 🗑 从书里撤下 ${r.removed.length} 份（★ 它们以前发过，现在过不了门）`,
      ``,
      `★★ 为什么会有这一栏：\`publishToBook\` 原来**只新增、从不删** ——`,
      `   ⇒ 门拦得住"新东西进不进"，拦不住"已经进书的坏东西"。`,
      `   ★★ 实测：书里 38 份，其中 5 份在本次被拒清单里（同时存在）`,
      `   ⇒ 书的现状不对应任何一次确定的门判定（违反纪律⑩）。`,
      ``,
      ...r.removed.map((f) => `- ${f}`),
      ``,
    );
  }
  // ★★★ 引用孤儿必须单列（这是"读者点过去 404"的直接原因）
  if (r.orphans && r.orphans.length) {
    const total = r.orphans.reduce((a, x) => a + x.citedBy.length, 0);
    L.push(
      `## ⚠ 引用孤儿：${r.orphans.length} 份被撤下的东西，还有 ${total} 处引用它`,
      ``,
      `★★ 实测后果：撤下 \`读者-第六章…\` 之后，全书引用落空从 30 涨到 **81**。`,
      `★ 读者点过去是 **404** —— 比"少了一章"更糟。`,
      ``,
    );
    for (const o of r.orphans) {
      L.push(`### ${o.missing}`, ``);
      L.push(...o.citedBy.slice(0, 8).map((f) => `- ${f} 还在引用它`));
      if (o.citedBy.length > 8) L.push(`- …还有 ${o.citedBy.length - 8} 份`);
      L.push(``);
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
