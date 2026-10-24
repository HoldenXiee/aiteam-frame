// ★★★★ 谁在反复做同一件事（供集群自己决定该不该 enforce / correct）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者 2026-10-21（这一族工具的起点）：
//   「这个底层库开放了很多 api…完全可以去**实验创新**，
//    创新出更符合我们目标的东西。」
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么需要这个文件（`P13` 的第 N 次）
//
//   我给了集群 `enforce` / `correct` / `grant` 三个工具，
//   真跑一轮：**0 次调用**。
//
//   ★ 原因不是"它不会用"，是**它没有处境**：
//     「你有三个治理工具」不等于「现在有一个人需要被治」。
//
//   ⇒ 这个文件把**可数的证据**摆到它面前：
//     「landing 在 120 次签字里 56 次带保留（47%），
//       另两个团队是 24% / 25%」
//
//   ★★★ 这就是判据：**比例失衡 ⇒ 有人在反复做同一件事**。
//     后面用不用 enforce / correct，由集群自己判（我不替它拍板）。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★ 只报数，不判"这是病"
//
//   ★ 47% 带保留**可能是好事**（landing 负责落地，本来就该最挑剔）。
//   ★★ 所以这个文件**只给读数 + 一句"如果这算异常，工具在这儿"**，
//     不下结论 —— 下结论是集群的活（硬规则①）。
// ══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from "node:fs";

/** ★ 一个团队的行为统计 */
export type TeamBehavior = {
  team: string;
  /** 总签字数 */
  total: number;
  /** 带保留数 */
  reserved: number;
  /** 带保留比例（0~1） */
  reservedRate: number;
  /** ★ 和"其他团队平均"的差（正 = 比平均更爱保留） */
  vsOthers: number;
};

export type BehaviorReport = {
  teams: TeamBehavior[];
  /** ★★ 比例最失衡的那一个（如果差距够大） */
  outlier?: TeamBehavior;
  /** 总签字数（太少的话比例不可信） */
  n: number;
};

/**
 * ★ 纯函数：从签字记录里算各团队的行为（纪律⑦：可离线重判）
 *
 * @param lines signoffs.jsonl 的每一行
 * @param minN  样本下限（★ 低于它就报"太少了，比例不可信"）
 */
export function teamBehavior(lines: string[], minN = 30): BehaviorReport {
  const total = new Map<string, number>();
  const reserved = new Map<string, number>();

  for (const ln of lines) {
    if (!ln.trim()) continue;
    let d: { by?: string; verdict?: string };
    try {
      d = JSON.parse(ln) as { by?: string; verdict?: string };
    } catch {
      continue;
    }
    const by = d.by;
    if (!by) continue;
    total.set(by, (total.get(by) ?? 0) + 1);
    if (d.verdict === "有保留") reserved.set(by, (reserved.get(by) ?? 0) + 1);
  }

  const teams: TeamBehavior[] = [...total.entries()].map(([team, t]) => {
    const r = reserved.get(team) ?? 0;
    return { team, total: t, reserved: r, reservedRate: r / t, vsOthers: 0 };
  });

  const n = teams.reduce((s, t) => s + t.total, 0);
  const allReserved = teams.reduce((s, t) => s + t.reserved, 0);

  // ★ 每个团队 vs "其他团队合起来"的比例差
  for (const t of teams) {
    const oTot = n - t.total;
    const oRes = allReserved - t.reserved;
    t.vsOthers = oTot > 0 ? t.reservedRate - oRes / oTot : 0;
  }

  // ★★ 样本够 + 差距够大（≥15 个百分点）才算 outlier
  const eligible = teams.filter((t) => t.total >= minN);
  let outlier: TeamBehavior | undefined;
  for (const t of eligible) {
    if (t.vsOthers >= 0.15) {
      if (!outlier || t.vsOthers > outlier.vsOthers) outlier = t;
    }
  }

  return { teams: teams.sort((a, b) => b.reservedRate - a.reservedRate), outlier, n };
}

/** ★ 从盘上读（runner 用） */
export function readBehavior(path: string, minN = 30): BehaviorReport {
  if (!existsSync(path)) return { teams: [], n: 0 };
  const lines = readFileSync(path, "utf8").split(String.fromCharCode(10));
  return teamBehavior(lines, minN);
}

/** ★ 渲染给人/集群看 */
export function renderBehavior(r: BehaviorReport): string {
  if (!r.teams.length) return "（还没有签字记录）";
  const parts = r.teams.map(
    (t) => `${t.team} ${t.reserved}/${t.total}=${Math.round(t.reservedRate * 100)}%`,
  );
  let s = parts.join(" · ");
  if (r.outlier) {
    s +=
      ` ★ ${r.outlier.team} 比另两队高 ${Math.round(r.outlier.vsOthers * 100)} 个百分点`;
  }
  return s;
}
