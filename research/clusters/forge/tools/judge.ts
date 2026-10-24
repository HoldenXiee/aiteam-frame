// judge —— ★★★ 观众表态：谁最说服了我
//
// ══════════════════════════════════════════════════════════════════
// ★★★ 设计者裁定（2026-10-19，逐字）：
//
//   「害怕『辩论会不会永远吵不完』可以尝试加一个『**观众**』，
//     最后『观众』**最被说服哪个观点就写哪个观点**。」
//
//   「如果**所有『观众』都支持某个观点（或达到 9 成支持）就结束争辩写入 book**。」
//
//   「建议**每个观众的定义也不同，各自都有想法**。」
// ══════════════════════════════════════════════════════════════════
//
// ★★★ 为什么这个机制能解决"吵不完"（不是拍脑袋）：
//
//   三个团队立场对立 ⇒ 它们之间两两投票会**循环**：
//     A 比 B 更"根本"、B 比 C 更"实在"、C 比 A 更"可用" ⇒ A>B>C>A。
//   ★ 这就是投票悖论 —— **用团队自己投票，永远收敛不了**。
//
//   ★★ 但**观众各有独立的评价函数** ⇒ 每个观众对三个立场有**自己的排序** ⇒
//      "谁最被说服"= argmax ⇒ **不循环，有唯一解**。
//
//   ★★★ 而且"观众"是**从使用者那一侧长出来的判据** ——
//     这正是 DESIGN 的「把意图落地」：书的验收者不是作者，是**要用它的人**。
//
// ★★ 为什么要 4 个观众（不是一个裁判）：
//   · 一个裁判 = 又一个"谁说了算"的问题
//   · ★ 4 个各有偏好的观众 ⇒ 偏向不同 ⇒ **能区分**"只有理论派觉得好"和"所有人都觉得好"

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIENCES, BOOK_THRESHOLD, type TeamKey } from "../prompts/lines.ts";

export type Choice = TeamKey | "都不够";

/**
 * ★★★ 把「题目」归一化后再比（2026-10-20）。
 *
 * ★ 为什么必须有：规则里写的题目**带反引号**，而观众存下来的**没有**：
 *   ```
 *   规则：`x.md` 这份东西该不该进书，哪一方的说法最站得住？
 *   落盘：x.md 这份东西该不该进书，哪一方的说法最站得住？
 *   ```
 * ⇒ 精确比较**永远不匹配** ⇒ 实测后果：
 *   `voteCoverage` 一直算出 0 ⇒ 同一批产物被**无限重推**。
 *
 * ★★ 纪律⑪：**判据与指令必须同源**。这里是同源的具体做法 ——
 *   不信任任何一边的书写格式，**两边都归一化**。
 */
export function normQuestion(t: string): string {
  return t.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

export interface Vote {
  at: string;
  /** 观众 key（operator / skeptic / newcomer / builder）*/
  by: string;
  /** ★ 被评的那个问题（一句话，可判死）*/
  question: string;
  /** ★ 最被谁说服 */
  choice: Choice;
  /** ★ 按他自己的标准说的理由 */
  reason: string;
  /** ★ 若"都不够"：缺什么才能说服他 */
  missing?: string;
}

/** ★★★ 观众投票的**纯函数**判定（可离线重判 —— 纪律⑦）*/
export function resolveVotes(
  votes: Vote[],
  question: string,
  threshold = BOOK_THRESHOLD,
): {
  decided: boolean;
  winner?: Choice;
  /** 各选择拿到的支持率 */
  support: Record<string, number>;
  /** ★ 反对的人（没投赢家的）*/
  dissenters: string[];
  /** ★ 没表态的观众 */
  silent: string[];
} {
  const want = normQuestion(question);
  const q = votes.filter((v) => normQuestion(v.question) === want);
  const voted = new Map(q.map((v) => [v.by, v]));
  const silent = AUDIENCES.map((a) => a.key).filter((k) => !voted.has(k));
  const total = AUDIENCES.length;
  const support: Record<string, number> = {};
  for (const v of voted.values()) {
    support[v.choice] = (support[v.choice] ?? 0) + 1;
  }
  for (const k of Object.keys(support)) support[k] = support[k]! / total;

  let winner: Choice | undefined;
  let best = 0;
  for (const [k, r] of Object.entries(support)) {
    if (r > best) {
      best = r;
      winner = k as Choice;
    }
  }
  // ★★★ 设计者：「所有观众都支持某个观点（或达到 9 成支持）」⇒ 结束争辩
  //   ★ "都不够" 也算一个观点 —— 若观众压倒性认为都不够，那说明**还写不成书**
  const decided = winner !== undefined && best >= threshold && silent.length === 0;
  return {
    decided,
    winner,
    support,
    dissenters: [...voted.values()].filter((v) => v.choice !== winner).map((v) => v.by),
    silent,
  };
}

export function makeJudge(deps: {
  /** ★ 本观众是谁 */
  selfKey: string;
  /** ★ 落盘路径 */
  recordPath: string;
  /** ★ 已投的票（共享）*/
  votes: Vote[];
}) {
  return defineTool({
    name: "judge",
    label: "Judge",
    description:
      "★★★ 你是**观众** —— 你的唯一职责是回答：**谁最说服了我？**\n" +
      "★ 你不生产观点，也不写产物。你只表态。\n" +
      "★ 选项：`theory` / `practice` / `landing` / **`都不够`**。\n" +
      "★★ **`都不够` 是完全有效的判断** —— 全体观众支持某一方时争辩才会结束，\n" +
      "   所以你的不同意见比附和重要得多。\n" +
      "★ 理由要**按你自己的标准**说（你就是按你的身份在看这件事的）。",
    parameters: Type.Object({
      question: Type.String({
        description: "★ 你在评哪个问题（必须与团队争的那个问题一致 —— 一句话）",
      }),
      choice: Type.Union(
        [Type.Literal("theory"), Type.Literal("practice"), Type.Literal("landing"), Type.Literal("都不够")],
        { description: "最被谁说服（都不够 = 没人说服你，这也算表态）" },
      ),
      reason: Type.String({
        description: "★ 按你自己的标准说理由（你的身份决定你看重什么）。至少 20 字。",
      }),
      missing: Type.Optional(
        Type.String({ description: "★ 若选「都不够」：缺什么才能说服你（这一条最有价值）" }),
      ),
    }),
    execute: async (_id, p) => {
      if (p.reason.trim().length < 20) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⛔ 理由太短（${p.reason.trim().length} 字）。\n` +
                `★ 你是观众，你的**理由**就是这本书的验收标准之一 —— 写清你按什么标准看的（至少 20 字）。`,
            },
          ],
          details: {},
        };
      }
      if (p.choice === "都不够" && !p.missing?.trim()) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⛔ 你选了「都不够」，但没说**缺什么**。\n` +
                `★★ 这一条恰恰是最有价值的反馈 —— 请填 ` + "missing" + `。`,
            },
          ],
          details: {},
        };
      }
      const v: Vote = {
        at: new Date().toISOString(),
        by: deps.selfKey,
        question: p.question.trim(),
        choice: p.choice,
        reason: p.reason.trim(),
        ...(p.missing ? { missing: p.missing.trim() } : {}),
      };
      // ★ 同一观众对同一问题改主意 ⇒ 覆盖（后一次为准）
      const i = deps.votes.findIndex((x) => x.by === deps.selfKey && x.question === v.question);
      if (i >= 0) deps.votes[i] = v;
      else deps.votes.push(v);
      try {
        mkdirSync(join(deps.recordPath, ".."), { recursive: true });
        appendFileSync(deps.recordPath, JSON.stringify(v) + "\n");
      } catch {
        /* 落盘失败不影响内存 */
      }

      const r = resolveVotes(deps.votes, v.question);
      const pct = (k: string) => `${Math.round((r.support[k] ?? 0) * 100)}%`;
      const lines = [
        `✔ **${deps.selfKey}** 已表态：**${v.choice}**`,
        ``,
        `当前票况（${AUDIENCES.length} 位观众）：` +
          AUDIENCES.map((a) => {
            const own = deps.votes.find((x) => x.by === a.key && x.question === v.question);
            return `${a.key}=${own?.choice ?? "★未表态"}`;
          }).join(" · "),
      ];
      if (r.silent.length) lines.push(`⏳ 还差 ${r.silent.length} 位观众表态：${r.silent.join("、")}`);
      if (r.decided) {
        lines.push(
          ``,
          `★★★ **争辩结束** —— 「${r.winner}」拿到 ${pct(r.winner!)} 的支持（门槛 ${Math.round(BOOK_THRESHOLD * 100)}%）。`,
          `★ 按设计者的规则：**就写这一方的观点**，可以写入 book。`,
        );
        if (r.dissenters.length) lines.push(`⚠ 反对者：${r.dissenters.join("、")}（他们的理由应作为保留意见附上）`);
      } else if (r.winner) {
        lines.push(``, `★ 目前最被说服的是「${r.winner}」（${pct(r.winner)}），**还没到门槛** —— 争辩继续。`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
    },
  });
}

/** ★ 读回历史票（进程重启不丢）*/
export function loadVotes(recordPath: string): Vote[] {
  if (!existsSync(recordPath)) return [];
  const byKey = new Map<string, Vote>();
  for (const line of readFileSync(recordPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Vote;
      byKey.set(`${v.by}\u0000${v.question}`, v);
    } catch {
      /* 坏行跳过 */
    }
  }
  return [...byKey.values()];
}

/** ★ 收尾时把裁决落成一份表（人一眼看得出哪些问题辩完了、哪些卡住）*/
export function writeVerdicts(path: string, votes: Vote[]): { decided: number; open: number } {
  const questions = [...new Set(votes.map((v) => v.question))];
  const lines = [`# 观众裁决（${new Date().toISOString()}）`, ``, `★ 观众：${AUDIENCES.map((a) => a.key).join(" / ")}`, `★ 门槛：${Math.round(BOOK_THRESHOLD * 100)}%`, ``];
  let decided = 0;
  for (const q of questions) {
    const r = resolveVotes(votes, q);
    if (r.decided) decided++;
    lines.push(`## ${q}`, ``, `- 裁决：${r.decided ? `✔ **${r.winner}**（${Math.round((r.support[r.winner!] ?? 0) * 100)}%）` : "⛔ 未达门槛"}`, `- 票：${AUDIENCES.map((a) => `${a.key}=${votes.find((v) => v.by === a.key && v.question === q)?.choice ?? "未表态"}`).join(" · ")}`);
    const ms = votes.filter((v) => v.question === q && v.missing);
    if (ms.length) lines.push(`- ⚠ 观众说还缺：${ms.map((v) => `${v.by}：${v.missing}`).join("；")}`);
    lines.push(``);
  }
  writeFileSync(path, lines.join("\n") + "\n");
  return { decided, open: questions.length - decided };
}

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 「能不能照做」的**硬门槛**（2026-10-20）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么要它（实测出来的病）
//
//   设计者对第二集群的裁定：
//     「追求写的东西**描述的准确、有深度**，可以**用作「工具」**」
//
//   ★★★ 而实测（2026-10-20，34 份书稿）：
//     · 含 ≥20 处 `work/` 实验路径的份：**27/34 = 79%**
//     · 观众达成 90% 共识：**0/24**
//     · newcomer 没投票：**15/24 = 62%**
//     · 投「都不够」：**21 票**
//   ⇒ newcomer 自己的诊断（逐字）：
//     「『说服我它是对的』和『说服我能照做』是**两件事**，我卡在后者」
//     「它现在是一份给同行看的**实验报告**，不是给新人的**说明书**」
//
// ★★★ 根因：`missions.ts` 写着「**没长出新概念的内容，不算这本教科书的内容**」，
//   但 `grep "概念|定义|模型" rules.ts` ⇒ **12 条规则里 0 条提到**。
//   ⇒ 这条最重的禁令**零出口** ⇒ 纪律㉕：「写在文档里的规则 = 没有规则」。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 我为什么不动 `BOOK_THRESHOLD = 0.9`，而是**另加一条**
//
//   90% 门槛是设计者原话：「所有观众支持（或 9 成）就结束争辩写入 book」——
//   它回答的是「**该写哪一方的说法**」（三个团队里选一个）。
//
//   ★★ 但它回答不了「**这份东西能不能用**」—— 那是**另一类问题**：
//     · 三个团队都写得很"对"，读者照样看不懂（这是实测的常态）
//     · 44 票选 landing / 24 practice / 21 theory / **21 都不够**
//       ⇒ 四观点并存时 90% **结构上永远达不到** ⇒ 观众机制 0/24 触发
//
//   ⇒ 所以这里是**并列的两个门**，不是替换：
//     `resolveVotes`  —— 选谁的口径（0.9 门槛，不动）
//     `usabilityGate` —— 这份能不能进书（★ 新，见下）
// ══════════════════════════════════════════════════════════════════════════

/** ★ 可用性判据的输入（全部来自已落盘的 votes.jsonl，可离线重判）*/
export interface UsabilityInput {
  /** 题目（= 被评的那份产物）*/
  question: string;
  /** 该题目的所有票 */
  votes: Vote[];
}

export interface UsabilityVerdict {
  /** ★ 能不能进书 */
  usable: boolean;
  /** ★ 谁说了「不够用」（点名，可追）*/
  blockers: { by: string; missing: string }[];
  /** ★ 谁没被问过（沉默）*/
  silent: string[];
  /** ★ 一句话理由（进日志）*/
  why: string;
}

/**
 * ★★★ 「能不能照做」的硬门槛。
 *
 * ★ 为什么这样定（而不是拍一个阈值）：
 *
 *   ① **newcomer 说「不够」⇒ 直接卡**
 *      ★ 理由：`newcomer` 的定义就是「没有这本书背后的全部上下文的人」。
 *        他不能照做 ⇒ 读者也不能。（这是**定义推出来的**，不是我拍的数）
 *
 *   ② **其他观众说「不够」⇒ 要有人替他说话才算**（不必单独卡）
 *      ★ 理由：skeptic 可能是「证据不够」，那是另一道门的事（`sign_off`）；
 *        但如果**两个以上**观众都说不够 ⇒ 不能当作偶然。
 *
 *   ③ **newcomer 沉默 ⇒ 不算通过**
 *      ★★ 理由：实测 62% 的份 newcomer **根本没被叫去投**。
 *        "没表态"不能当成"没问题"—— 那是**沉默即认同**的老病。
 *
 *   ★★★ 三条都不含"我觉得"，全是结构量。
 *
 * @param input  题目 + 该题目的票
 * @param opts   ★ 可选调整（默认：newcomer 必须表态且说够用）
 */
export function usabilityGate(
  input: UsabilityInput,
  opts?: {
    /** ★ 关键的观众（默认 newcomer）*/
    keyViewer?: string;
    /** ★ 其他观众里，几个说不够就算数（默认 2）*/
    othersNeeded?: number;
  },
): UsabilityVerdict {
  const keyViewer = opts?.keyViewer ?? "newcomer";
  const othersNeeded = opts?.othersNeeded ?? 2;
  const want = normQuestion(input.question);
  const q = input.votes.filter((v) => normQuestion(v.question) === want);
  const voted = new Map(q.map((v) => [v.by, v]));

  const silent = AUDIENCES.map((a) => a.key).filter((k) => !voted.has(k));

  // ① newcomer 必须表态，且必须说"够用"
  const nc = voted.get(keyViewer);
  const blockers: { by: string; missing: string }[] = [];
  if (!nc) {
    return {
      usable: false,
      blockers: [],
      silent,
      why: `★ ${keyViewer} 从没被问过 ⇒ 不能当"没问题"（沉默 ≠ 认同）`,
    };
  }
  if (nc.choice === "都不够") {
    blockers.push({ by: nc.by, missing: nc.missing ?? "（没说缺什么）" });
  }

  // ② 其他观众：>= othersNeeded 人说不够 ⇒ 也算
  const othersNo = q.filter((v) => v.by !== keyViewer && v.choice === "都不够");
  if (othersNo.length >= othersNeeded) {
    for (const v of othersNo) blockers.push({ by: v.by, missing: v.missing ?? "（没说缺什么）" });
  }

  if (blockers.length) {
    return {
      usable: false,
      blockers,
      silent,
      why: `${blockers.map((b) => b.by).join("、")} 说「都不够」⇒ 读者照不了做`,
    };
  }
  return {
    usable: true,
    blockers: [],
    silent,
    why: `${keyViewer} 认可（选了 ${nc.choice}）`,
  };
}

/** ★ 把一批题目的可用性汇总成读数（收尾打日志用）*/
export function usabilitySummary(
  votes: Vote[],
): { total: number; usable: number; blocked: number; neverAsked: number; blockers: Record<string, number> } {
  const byQ = new Map<string, Vote[]>();
  for (const v of votes) byQ.set(v.question, [...(byQ.get(v.question) ?? []), v]);
  let usable = 0;
  let blocked = 0;
  let neverAsked = 0;
  const blockers: Record<string, number> = {};
  for (const [question] of byQ) {
    const r = usabilityGate({ question, votes });
    if (r.usable) usable++;
    else {
      blocked++;
      if (!r.blockers.length) neverAsked++;
      for (const b of r.blockers) blockers[b.by] = (blockers[b.by] ?? 0) + 1;
    }
  }
  return { total: byQ.size, usable, blocked, neverAsked, blockers };
}
