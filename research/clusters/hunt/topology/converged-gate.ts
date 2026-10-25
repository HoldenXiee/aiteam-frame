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

import { existsSync, readFileSync } from "node:fs";
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

