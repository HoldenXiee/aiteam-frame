// converged-gate —— ★★★★★ 把「我收敛了」挡在**结构化实验**这道门上
//
// ══════════════════════════════════════════════════════════════════
// ★ 为什么需要它（2026-10-25，本轮最深的一次结构发现）
//
//   这个 lab 的「我收敛了没有」由 `outbox/CONVERGED.md` 的**状态表**回答：
//     | claim（一句话） | 证据 id | 状态 |      ← 236 行
//   而那张表的证据 id **全是 `P*`（旧的自由文本产物）**；
//   新的结构化实验 `E1…E20`（可跑装置 + 现象 + 模型 + 同侪审查）**一条都没进那张表**。
//
//   ⇒ 后果：我这一整轮做的质量门（现象要被同侪认过、判"补的"不算发现型）
//     对「这个 lab 说自己收敛了没有」**零影响**。
//   ★ 这和 forge 栽过的坑同族：**举证 ≠ 可用**；这里是 **有账 ≠ 入门**。
//   ★★ 也更像我自己那次「写好了没接上」—— 只是这次不是代码没接上，
//     是**判断没接上出口**。
//
// ★★★ 所以这里的判据是**纯形式**的（我能做）：
//     · 状态表引用了几条 `E*`
//     · 其中**没被独立审**的几条
//     · 其中**被判「补的」**的几条
//   不判断结论对不对（那是内容判断，不是我的活）。
// ══════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExperimentRow } from "../tools/record-experiment.ts";

export interface GateResult {
  /** 状态表里出现的 E 编号（去重）*/
  cited: string[];
  /** 未审的 */
  unreviewed: string[];
  /** 被判「补的」的 */
  fabricated: string[];
  /** 状态表里出现的 P 编号（旧账）的条数 —— 用来说明"还在靠旧账" */
  legacyRefs: number;
  /** 状态表行数 */
  rows: number;
  /** ★ 门是否通过：引用了 ≥1 条 E*，且没有未审/补的 */
  pass: boolean;
  /**
   * ★★ 覆盖率 = 引用了几条 E* / 账上共几条。
   * ★ 单独报、**不进门**：门只判"引的都对"，覆盖率是另一件事。
   *   实测（r22）：门通过了，但它只引了 **1 条**（账上 7 条）——
   *   **薄通过**是可能的（引一条审过的、其余不引）。这正是"形式判据可被最省力满足"的老问题。
   */
  coverage: number | null;
  /** 一句话结论 */
  verdict: string;
}

const ROW = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;

/** 从状态表里取「证据 id」列（只取含 `E\d` 的 token）*/
export function parseConverged(text: string): { cited: string[]; legacyRefs: number; rows: number } {
  const cited = new Set<string>();
  let legacyRefs = 0;
  let rows = 0;
  let tableFound = false;
  for (const line of text.split(String.fromCharCode(10))) {
    const m = ROW.exec(line.trim());
    if (!m) continue;
    const ev = m[2]!;
    // ★ 只认数据行：证据列里必须有反引号或数字 id 形状
    if (!/[`A-Za-z0-9]/.test(ev)) continue;
    if (/^-+$/.test(ev.replace(/[-: ]/g, ""))) continue;
    rows++;
    if (/证据\s*id/i.test(ev)) {
      tableFound = true;
      rows--; // 表头不算
      continue;
    }
    for (const e of ev.match(/\bE[0-9]+\b/g) ?? []) cited.add(e);
    // ★ 旧账引用：P25 / P29-… / 裸脚本名也算（只用来对比，不判错）
    if (/\bP[0-9]+\b/.test(ev)) legacyRefs++;
  }
  void tableFound;
  return { cited: [...cited].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), legacyRefs, rows };
}

export function convergedGate(lab: string, rows: readonly ExperimentRow[]): GateResult {
  const p = join(lab, "outbox", "CONVERGED.md");
  if (!existsSync(p)) {
    return {
      cited: [],
      unreviewed: [],
      fabricated: [],
      legacyRefs: 0,
      rows: 0,
      pass: false,
      coverage: null,
      verdict: "没有 `outbox/CONVERGED.md` ⇒ **未声明**（不当作已通过，也不当作失败）",
    };
  }
  const { cited, legacyRefs, rows: trows } = parseConverged(readFileSync(p, "utf8"));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const unreviewed: string[] = [];
  const fabricated: string[] = [];
  for (const id of cited) {
    const r = byId.get(id);
    if (!r) {
      unreviewed.push(id); // ★ 引用了一条账上没有的实验 ⇒ 同"未审"处理
      continue;
    }
    if (!r.reviewedBy || r.reviewedBy === r.by) unreviewed.push(id);
    else if (r.phenomenonVerdict === "补的") fabricated.push(id);
  }
  const pass = cited.length > 0 && unreviewed.length === 0 && fabricated.length === 0;
  const verdict = pass
    ? `✔ 状态表引用了 ${cited.length} 条结构化实验，全部经独立审查且无"补的"`
    : cited.length === 0
      ? `⛔ 状态表的证据 id **一条结构化实验都没有**（旧账引用 ${legacyRefs} 处、表 ${trows} 行）` +
        ` —— 也就是说"我收敛了"**没有经过新门**`
      : `⛔ 状态表引用了 ${cited.length} 条 E*，但 ${unreviewed.length} 条未审、${fabricated.length} 条被判"补的"`;
  const coverage = rows.length > 0 ? cited.length / rows.length : null;
  return { cited, unreviewed, fabricated, legacyRefs, rows: trows, pass, coverage, verdict };
}

export function renderGate(g: GateResult): string {
  const list = (xs: string[]) => (xs.length ? xs.join("·") : "—");
  const cov =
    g.coverage !== null && g.cited.length > 0
      ? ` · 覆盖率 ${g.cited.length}/${Math.round(g.cited.length / g.coverage)}（★ 薄通过也算通过：门只判「引的对不对」）`
      : "";
  return (
    `★★★★★ 收敛门（CONVERGED 的证据 id 必须指到 E* 且经独立审）：**${g.pass ? "通过" : "未通过"}**` +
    `
    ${g.verdict}` +
    (g.cited.length > 0
      ? `
    引用：${list(g.cited)} · 未审：${list(g.unreviewed)} · 补的：${list(g.fabricated)}` + cov
      : "")
  );
}



// ══════════════════════════════════════════════════════════════════
// ★★★★ 收敛欠账（2026-10-25 · 照 `closure.ts` 在缺陷账上验证过的手法）
//
//   ★ 实测：r22 收敛门**通过了，但只引了 1 条**（账上 7 条）—— 薄通过。
//     门只判"引的对不对"，不判"引够了没有"；而"引几条才够"是内容判断，不是我的活。
//   ★★ 所以我不用门槛卡覆盖率，改成**列清单递上去**：
//     账上有、状态表没引的，全列出来，下一轮自己处置。
//     （closure.ts 就是这么把结账率从 2% 拉到 21% 的：
//       「开环系统里，限产无效 —— 要清欠账(WIP)，不是限开工」纪律㊵）
//   ★★★ 而且必须**落盘**：不落盘就没法量"上一轮列的欠账这一轮清了几条"。
// ══════════════════════════════════════════════════════════════════

export const DEBT_FILE = "_收敛欠账.md";

export interface ConvergenceDebt {
  /** 账上有、状态表没引的实验 */
  uncited: { id: string; claim: string; reviewed: boolean }[];
  /** 引用了几条 / 账上共几条 */
  cited: number;
  total: number;
  /** ★ 上一轮落盘的欠账里，这一轮清掉了几条（结账率的同族读数）*/
  clearedFromLast: number | null;
  /** 上一轮列了几条 */
  lastListed: number | null;
}

export function convergenceDebt(lab: string, rows: readonly ExperimentRow[]): ConvergenceDebt {
  const gate = convergedGate(lab, rows);
  const cited = new Set(gate.cited);
  const uncited = rows
    .filter((r) => !cited.has(r.id))
    .map((r) => ({
      id: r.id,
      claim: r.claim.slice(0, 80),
      reviewed: !!r.reviewedBy && r.reviewedBy !== r.by,
    }));

  // ★ 读上一轮落盘的清单，算"这一轮清了几条"
  let lastListed: number | null = null;
  let clearedFromLast: number | null = null;
  const p = join(lab, "work", DEBT_FILE);
  if (existsSync(p)) {
    const txt = readFileSync(p, "utf8");
    const ids = [...new Set(txt.match(/E[0-9]+/g) ?? [])];
    if (ids.length > 0) {
      lastListed = ids.length;
      const nowCited = new Set(gate.cited);
      clearedFromLast = ids.filter((i) => nowCited.has(i)).length;
    }
  }
  return { uncited, cited: gate.cited.length, total: rows.length, clearedFromLast, lastListed };
}

/** ★ 落盘（每轮覆盖；内容只是 id + 一句话，供下一轮与自己对照）*/
export function writeDebtFile(lab: string, d: ConvergenceDebt, round: string): void {
  const lines = [
    `# 收敛欠账 · ${round}`,
    "",
    `> 账上有 **${d.total}** 条结构化实验，状态表引用了 **${d.cited}** 条 ⇒ 欠 **${d.uncited.length}** 条。`,
    "> ★ 每条自行处置（**引它进状态表** / **说明为什么它不算证据** / **说明还缺什么**）。",
    "> ★ 这张表只列 id 与一句话，判断由你自己做。",
    "",
    ...d.uncited.map((u) => `- \`${u.id}\` ${u.reviewed ? "（已审）" : "（**未审**）"} — ${u.claim}`),
    "",
  ];
  mkdirSync(join(lab, "work"), { recursive: true });
  writeFileSync(join(lab, "work", DEBT_FILE), lines.join(String.fromCharCode(10)), "utf8");
}

export function renderDebt(d: ConvergenceDebt): string {
  if (d.total === 0) return "★ 收敛欠账：账上还没有结构化实验 ⇒ 未声明";
  const cleared =
    d.lastListed === null
      ? "（上一轮没有欠账清单，无从对照）"
      : ` · ★ 上一轮列了 ${d.lastListed} 条，这一轮清掉 **${d.clearedFromLast ?? 0}**`;
  return (
    `★★ 收敛欠账：账上 ${d.total} 条 · 状态表引了 ${d.cited} 条 ⇒ **欠 ${d.uncited.length} 条**` +
    (d.uncited.length ? `（${d.uncited.slice(0, 6).map((u) => u.id).join("·")}${d.uncited.length > 6 ? "…" : ""}）` : "") +
    cleared
  );
}


/**
 * ★★★★★ 被判「补的」证据仍被引用 ⇒ 哪几条 claim 只靠它们撑着
 *
 * ★ 实测（2026-10-25 主空间）：判"补的" **8 条**，**8 条全都被状态表引用**。
 *   门只报"未通过"，但没人去撤回 —— 这就是"门有判决、没有后果"。
 * ★★ 这里只做**可数**：按 claim 行看，它引的 E 里有没有一条站得住的。
 *   判"这条 claim 对不对"是内容判断，不是我的活。
 */
export interface UnsupportedClaim {
  /** 状态表上那句 claim（截断）*/
  claim: string;
  /** 它引的 E 编号 */
  cited: string[];
  /** 其中被判"补的"的 */
  fake: string[];
}

export function unsupportedClaims(convergedText: string, rows: readonly ExperimentRow[]): UnsupportedClaim[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: UnsupportedClaim[] = [];
  const lines = convergedText.split(String.fromCharCode(10));

  // ★★★★★ 2026-10-26 · **这一次是集群纠正我**（第 18 次量具错）
  //
  //   ★ 我原来把**任何**提到 `E2` 的表格行都算「用 E2 撑这条 claim」。
  //     而 `CONVERGED.md` 有 2264 行、39 张表、`E2` 出现 65 次，其中
  //     · 「判「补的」= 8：E2 E4 E5…」—— **名单**
  //     · 「承重行里的不合格 = 12 处 / 6 个 id（E2×2 …）」—— **计数**
  //     · 五行**存在目的就是论证 E2 不是承重引用** —— **元讨论**
  //     这三种行和真正的承重引用**长得一样** ⇒ 我报的 18 条里大部分是元讨论。
  //   ★★ 它(P238)给的两条可核排除，我原样实现：
  //     ① 该行的**处置列**以 `⛔` 开头（那一行本身就是在说「不算证据」）
  //     ② 该行位于标题含「为什么不是」「不是承重」「元讨论」的小节下
  //   ★★★ 判死（它写的，也是我该守的）：按这两条排除后，
  //     若仍有**一条**行在正文里声称「这条 claim 有跑前冻结的证据」而只引补的 E ⇒ 排除规则不成立。
  let metaSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    // 小节标题会改变"这一段的表格是不是元讨论"
    if (line.startsWith("#")) {
      metaSection = /为什么不是|不是承重|元讨论|口径|统计|名单/.test(line);
      continue;
    }
    if (metaSection) continue;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 2) continue;
    const claimCell = cells[0]!;
    const evCell = cells[1]!;
    // ★ 排除 ①：处置/判决列以 ⛔ 开头（那一行自己已经撤了）
    if (cells.some((c) => c.startsWith("⛔"))) continue;
    // ★ 排除：表头/分隔行
    if (/^-+$/.test(evCell) || /^证据|evidence/.test(evCell) || /^claim/i.test(claimCell)) continue;
    const ids = [...new Set(evCell.match(/E[0-9]+/g) ?? [])];
    if (ids.length === 0) continue;
    // ★ 排除 ③：名单行 / 计数行 —— claim 格里是"判「补的」""共 N 条""x 处"这类
    if (/^(判|共|计|合计|名单|统计)/.test(claimCell) && !/[。？?]/.test(claimCell)) continue;
    const fake = ids.filter((i) => byId.get(i)?.phenomenonVerdict === "补的");
    if (fake.length === ids.length) {
      out.push({ claim: claimCell.slice(0, 70), cited: ids, fake });
    }
  }
  return out;
}

export function renderUnsupported(u: readonly UnsupportedClaim[]): string {
  if (u.length === 0) return "★ 被判「补的」的证据没有单独撑着任何 claim（或状态表里没有 E 引用）";
  return (
    // ★★★ 2026-10-26 · **这个数只当指针，不当结论**（第 18 次量具错之后）
    //   我修掉了元讨论行，但剩下 7 条里人工核过仍有 4 条是「行号 / 正则片段 / 单个 id」这类非 claim 行。
    //   ⇒ claim 粒度我**判不准**（那是内容判断，纪律①）。它的价值在于**逼集群去处置**，
    //     而它确实逼出了 `P238`（一份可核的逐行核对 + 一条判死断言）。
    `★★★★ 粗口径候选：${u.length} 条行**看起来**只引了被判"补的"证据` +
    `（★ 这个数会混进行号/正则/名单行，**别当结论用**——它是给集群的指针）` +
    `（${u.slice(0, 4).map((x) => x.fake.join("·")).join(" / ")}）` +
    `　← ★ 门给了判决但**没人撤回**：要么撤回引用、要么重做一次带真 PREREG 的实验、要么说明它其实成立`
  );
}
