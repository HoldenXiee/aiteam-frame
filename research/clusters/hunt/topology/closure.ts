// ★★★★★ 「缺陷结账」—— hunt 的自审为什么停不下来（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// 真读数（实测，`outbox/CONVERGED.md`）
//
//   O 行 53 条（它自己登记的自己装置的缺陷）：
//     ⚠ 新增（只登记，无处置）  23  (43%)
//     未做/未修              22  (41%)
//     ★ 已修                    4  (7%)
//     部分                    2  (3%)
//
//   ⇒ **结账率 7.5%（4/53）**。53 开 / 4 关 —— 这是一个**开环系统**。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★★ 这解释了全部现象，包括我的修法为什么失败
//
//   现象（最近 24h）：产物 57 份里 36 份是自审、**P* 研究结论 0 份**。
//
//   ★ 我原来的诊断：「`onInstrumentReview` 正反馈」 —— 只对了一半。
//   ★★ 我原来的修法：「自审占比 ≥ 50% 就停规则」 —— **治错了地方**。
//      实测：规则停了，产出仍然 63% 自审。
//   ★★★ 真因：**每审一条，开 2–3 条，关 0–1 条**。
//      停掉"开工"没用，因为**存量本身就是工作来源** ——
//      45 条未结缺陷摆在那里，它只能继续干这个。
//
// ★★★★ 正确的判据不是「产出占比」，是「**未结账存量**」（WIP）：
//     · 占比：管不住，因为它选什么活我不知道
//     · 存量：明确分母（已登记的 O 行）、可数、可离线重判、**喂得进它的决策**
//   这和 Kanban 的 WIP limit 同源：**开工上限管不住，存量上限才管得住**。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 防"假结账"（这是最大的风险）
//
//   如果我要求"必须有处置"，它可以把 45 条全标成 `已修` —— 一行不改。
//   （同族：`P13`「允许它做 X 它不做」；「有保留太廉价」；`O` 行刷指标）
//
//   ⇒ 所以「修了」必须带**可核证据**：
//     · `修了` ⇒ 引用了至少一个**存在的**路径（文件 / 读数 / commit 号）
//     · `不修` ⇒ 必须说清"这是边界不是缺陷"（★ 我自己也常犯这个：把装置边界当缺陷）
//     · `修不了` ⇒ 必须说清卡在哪
//   ★ 判据是**形式**的：有没有引用路径、路径在不在。**不判理由对不对**（那是内容判断）。
// ══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 一条缺陷的处置状态 */
export type Disposition = "closed" | "boundary" | "blocked" | "open" | "unsaid";

export type DefectRow = {
  id: string;
  /** 处置原文（★ 原样留着，因为我判不了它说得对不对） */
  text: string;
  kind: Disposition;
  /** ★ `closed` 时必须非空：它引用的路径 */
  cites: string[];
  /** ★ 引用的路径里，**盘上真的存在**的 */
  citesExist: string[];
};

export type Closure = {
  rows: DefectRow[];
  /** ★ 已结账 = closed（且证据存在）+ boundary + blocked */
  closed: number;
  /** ★ 未结账 = open + unsaid + **证据落空的 closed** */
  open: number;
  total: number;
  /** ★ 结账率 */
  rate: number;
  /**
   * ★★★ 说"修了"但**我机械核不了**的（引用了产物名/读数，不是路径）
   *
   * ★ 为什么不叫"假结账"（2026-10-21 我第一版就叫错了）：
   *   它的证据可能是「42/42 一致」这种**读数**，我判不了那个数对不对（内容判断）。
   *   ⇒ 只能如实报「**已声明，但无法机械核验**」。
   * ★ 纪律㉜：缺数据 ≠ 0 —— 这里是「我核不了 ≠ 它假」。
   */
  unverifiable: string[];
};

/**
 * ★ 判一条 O 行的处置种类 —— **只看形式，不看理由**
 *
 * ★ 顺序很重要：先判 `closed`（因为"已修"里常带"部分"字样），
 *   再判 `boundary` / `blocked`，最后才是 open/unsaid。
 */
export function classifyDisposition(text: string): Disposition {
  const s = text.replace(/\*/g, "").trim();
  if (!s) return "unsaid";
  // ★ `⚠ 新增` = 只登记，没处置（实测 23 条都是这个）
  if (s.startsWith("⚠") && /新增/.test(s)) return "unsaid";
  if (/已修|已落|已补|已达成|已闭|✅/.test(s)) return "closed";
  // ★ "不修"这一类：说清它是**边界**而不是缺陷（我自己也常犯）
  if (/边界|不是缺陷|声明式|降级为|不可通用|只能声明/.test(s)) return "boundary";
  if (/修不了|卡在|阻塞|依赖/.test(s)) return "blocked";
  if (/未做|未修|未落|未接|待补|待办/.test(s)) return "open";
  return "unsaid";
}

/** ★ 从处置文本里抽它引用的路径（反引号包着的，看起来像路径的） */
export function extractCites(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const v = m[1]!.trim();
    // ★★★ 只认「看起来像本仓库路径」的（2026-10-21 修：我第一版认"含斜杠"，
    //   于是 `P92/P67/P95b` 这种「列举几个产物」被当成路径 ⇒ 报出 5 条假结账。
    //   ★ 纪律㉞：口径里混进了不属于这个问题的东西（把「顿号」当成了「路径」）。
    const isRepoPath = /^(work|outbox|lib|runs|src|dev|research)\//.test(v);
    const isFile = /\.(md|ts|mts|mjs|jsonl|json|txt|log)$/.test(v);
    if (isRepoPath || isFile) out.push(v);
  }
  return [...new Set(out)];
}

/**
 * ★ 纯函数：把 CONVERGED 的 O 行算成结账读数
 *
 * @param converged 状态表全文
 * @param exists    判某个相对路径在不在（注入以便离线测试）
 */
export function closure(
  converged: string,
  exists: (rel: string) => boolean = () => true,
): Closure {
  const rows: DefectRow[] = [];
  for (const line of converged.split(String.fromCharCode(10))) {
    // ★ O 行：`| O12 | 缺陷 | 谁 | 处置 |`
    if (!/^\|\s*\*{0,2}O\d+/.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] 是空（行首 |），cells[1] = O号，最后一个非空 = 处置
    const body = cells.slice(1, -1).filter((c) => c !== "");
    if (body.length < 2) continue;
    const id = body[0]!.replace(/\*/g, "").trim();
    const text = body[body.length - 1]!;
    const kind = classifyDisposition(text);
    const cites = extractCites(text);
    const citesExist = cites.filter((c) => {
      // ★ 只判"像相对路径"的；绝对路径 / 命令不判（那是另一类证据）
      if (/^[A-Za-z]:|^\//.test(c)) return true;
      return exists(c);
    });
    rows.push({ id, text, kind, cites, citesExist });
  }

  // ★★★ 三分类（纪律㉜）：
  //   · 可核已结  —— `修了` **且**引用的路径在盘上
  //   · 已声明无法核验 —— `修了` 但引用了产物名/读数（我判不了对不对）
  //   · 未结      —— `未做` / 只登记（`⚠ 新增`）
  //   ★ `说清是边界` / `说清卡在哪` 算已结 —— 拦的同时给路（纪律⑳）。
  const unverifiable: string[] = [];
  let closed = 0;
  for (const r of rows) {
    if (r.kind === "closed") {
      if (r.citesExist.length === 0) {
        unverifiable.push(r.id);
        continue;
      }
      closed++;
    } else if (r.kind === "boundary" || r.kind === "blocked") {
      closed++;
    }
  }
  const total = rows.length;
  return {
    rows,
    closed,
    // ★ 未结 = 总数 - 可核已结 - 无法核验（无法核验的**不算结账**，但也别冤枉它）
    open: total - closed - unverifiable.length,
    total,
    rate: total ? closed / total : 0,
    unverifiable,
  };
}

/** ★ 从盘上读 */
export function readClosure(outboxDir: string): Closure {
  const f = join(outboxDir, "CONVERGED.md");
  if (!existsSync(f)) return { rows: [], closed: 0, open: 0, total: 0, rate: 0, unverifiable: [] };
  const root = join(outboxDir, "..");
  const txt = readFileSync(f, "utf8");
  // ★ 证据路径以**集群空间**为根（产物写的是 `work/...` / `outbox/...`）
  return closure(txt, (rel) => existsSync(join(root, rel)));
}

/** ★ 渲染读数 */
export function renderClosure(c: Closure): string {
  if (!c.total) return "（状态表里没有 O 行）";
  const pct = Math.round(c.rate * 100);
  const L = [
    `★ 缺陷结账：${c.closed}/${c.total} 可核已结（${pct}%）· ★★ 未结 ${c.open} 条` +
      (c.unverifiable.length ? ` · 已声明但我核不了 ${c.unverifiable.length} 条` : ""),
  ];
  if (c.unverifiable.length) {
    L.push(
      `   ★ 我核不了的（引用了产物名/读数，不是路径 —— ★ 不判真假，只报"核不了"）：${c.unverifiable.slice(0, 8).join(" ")}`,
    );
  }
  return L.join(String.fromCharCode(10));
}

/**
 * ★★★★★ 该不该开**新的**自审 —— WIP 上限（纯函数）
 *
 * ★ 这是替代 `auditQuota` 的判据。区别：
 *   · `auditQuota` 量的是「自审**产出占比**」⇒ 管不住（它选什么活我不知道）
 *   · 这个量的是「**未结账存量**」⇒ 明确分母、可数、**喂得进它的决策**
 *
 * @param open 未结账缺陷数
 * @param limit 允许的未结上限
 */
export function canOpenNewAudit(open: number, limit = 8): { allowed: boolean; reason: string } {
  if (open <= limit) return { allowed: true, reason: `未结 ${open} ≤ 上限 ${limit} ⇒ 可以开新的` };
  return {
    allowed: false,
    reason: `未结 ${open} > 上限 ${limit} ⇒ 先把存量关掉（修了带证据 / 说清是边界 / 说清卡在哪）`,
  };
}
