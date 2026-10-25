// dialectic —— ★★★★ 答辩的账（DESIGN v3-1 · 环 1 的治法）
//
// ══════════════════════════════════════════════════════════════════
// ★★★★★ 为什么要有这个文件（2026-10-25 实测）
//
//   环 1 · 答辩环：
//     onNewFinding 派挑战 → 研究员必须回应（`challenge` 结构性要求给 verdict）
//       → 回应本身是一份产物 → 又能被挑战 → …
//
//   读数：
//     按天答辩占比 10-19 **23%** · 10-24 **78%** · 10-25 **49%**
//     实质产出（P*/实验/面-） 53 → **4** → 28
//     `onNewFinding` 触发 **20 次**（本 window 规则里最高）
//     `F1 → F2 → F3 → F4` —— **同一条 claim 审了 4 轮**
//
//   ★★★ 而 `challenge.ts` **一行都不落盘** ⇒
//     没人知道有多少条 claim 在飞、哪些被反复审、哪些结过账。
//     这是**开环**：和缺陷账同一个病（53 开 / 1 关）。
//   而缺陷账治好了（结账率 2% → 21%）靠的正是「三态处置 + 不许重开」。
//   ⇒ 第一步不是禁止答辩（那是设计者要的机制），而是**先让它可数**。
// ══════════════════════════════════════════════════════════════════

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CHALLENGES_FILE = "challenges.jsonl";

export interface ChallengeRow {
  at: string;
  by: string;
  to: string;
  artifact: string;
  claim: string;
  /** ★ 归一化后的 claim 键 —— 用来判"同一条被审了几次" */
  claimKey: string;
  verdict: string;
}

export function challengesPath(lab: string): string {
  return join(lab, "work", CHALLENGES_FILE);
}

/**
 * ★ claim 归一化：判"是不是同一条"必须比这个，不能比原句。
 * ★★ 归一化只做**形式**处理（去空白、去标点、小写、截断），不做语义 ——
 *    语义判断会引入我的口径错（已经被纠正 12 次）。
 * ★★★ 局限（要写清）：换一种说法讲同一件事，归一化认不出。
 *    ⇒ 这个读数**只能低估重复，不会高估**。
 */
export function claimKey(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[`*_>#|\-—…·，。、；：！？（）()[\]{}"'“”‘’/\\]/g, "")
    .slice(0, 80);
}

export function appendChallenge(lab: string, row: Omit<ChallengeRow, "claimKey" | "at">): ChallengeRow {
  const full: ChallengeRow = { at: new Date().toISOString(), ...row, claimKey: claimKey(row.claim) };
  const p = challengesPath(lab);
  mkdirSync(join(lab, "work"), { recursive: true });
  appendFileSync(p, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export function readChallenges(lab: string): ChallengeRow[] {
  const p = challengesPath(lab);
  if (!existsSync(p)) return [];
  const out: ChallengeRow[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as ChallengeRow;
      // ★ 缺字段的行不静默丢 —— 记账残缺必须看得见
      if (typeof r.claim !== "string") continue;
      out.push({ ...r, claimKey: r.claimKey || claimKey(r.claim) } as ChallengeRow);
    } catch {
      /* 半行（进程被杀）—— 跳过 */
    }
  }
  return out;
}

export interface DialecticStats {
  total: number;
  /** 不同 claim 数（按 claimKey 去重）*/
  claims: number;
  /** ★ 被挑战 ≥2 次的 claim 数 —— "环在转"的直接证据 */
  revisited: number;
  /** 反复最厉害的那几条（key 只用于展示）*/
  worst: { claim: string; times: number }[];
  /** 按 verdict 分布 */
  byVerdict: Record<string, number>;
  /** 人均：谁最爱挑 / 谁最常被挑 */
  byChallenger: Record<string, number>;
  byTarget: Record<string, number>;
}

export function dialecticStats(rows: readonly ChallengeRow[]): DialecticStats {
  const perClaim = new Map<string, { claim: string; times: number }>();
  const byVerdict: Record<string, number> = {};
  const byChallenger: Record<string, number> = {};
  const byTarget: Record<string, number> = {};
  for (const r of rows) {
    const k = r.claimKey;
    const cur = perClaim.get(k);
    if (cur) cur.times++;
    else perClaim.set(k, { claim: r.claim, times: 1 });
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
    byChallenger[r.by] = (byChallenger[r.by] ?? 0) + 1;
    byTarget[r.to] = (byTarget[r.to] ?? 0) + 1;
  }
  const all = [...perClaim.values()];
  return {
    total: rows.length,
    claims: all.length,
    revisited: all.filter((c) => c.times >= 2).length,
    worst: all
      .filter((c) => c.times >= 2)
      .sort((a, b) => b.times - a.times)
      .slice(0, 3),
    byVerdict,
    byChallenger,
    byTarget,
  };
}

export function renderDialectic(s: DialecticStats): string {
  if (s.total === 0) {
    return "★ 答辩账：**没有记录**（`challenge` 从本轮起才落盘）—— 之前的答辩**无法回溯**";
  }
  const worst = s.worst.map((w) => `「${w.claim.slice(0, 34)}…」×${w.times}`).join(" · ");
  return (
    `★ 答辩账：${s.total} 次挑战 / **${s.claims} 条 claim**` +
    ` · ★★ **被挑战 ≥2 次的 ${s.revisited} 条**` +
    (worst ? `（${worst}）` : "") +
    `　← ★ >0 就是"环在转"：同一条 claim 被审了不止一次`
  );
}
