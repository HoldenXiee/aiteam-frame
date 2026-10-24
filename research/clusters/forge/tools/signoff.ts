// signOff —— ★★★ 共识门：一份东西要进教科书，必须**全体团队签字**
//
// ══════════════════════════════════════════════════════════════════
// ★★★ 设计者裁定（2026-10-19，逐字）：
//
//   「必须是多个团队、多个员工，相互争辩、各自有各自的角度，
//     ★★★ **最后争辩出一个都认同的结果才能写进 book**。」
//
// ══════════════════════════════════════════════════════════════════
//
// ★★★ 为什么要做成"门"（代码执行）而不是"提示"：
//   `P13` 实测过 —— **"允许它做 X" 它不做**。
//   上一轮我写在文档里的话是「三条线最后必须合成一本」，
//   ★ 结果：**无任何机制保证它合成** ⇒ 9 份产物各写各的，0 份有共识。
//
// ★★ 所以这里的规则是**硬的**（`P12`：拦的同时也要给路）：
//
//   ┌────────────────────────────────────────────┐
//   │ 全体 `认同`            → ✔ 可进 book       │
//   │ 有人 `有保留`          → ⚠ 可进，保留附在中 │
//   │ 有人 `反对`            → ⛔ 不许进 —— 先辩  │
//   │ 有团队 `没表态`        → ⛔ 不许进（沉默≠认同）│
//   └────────────────────────────────────────────┘
//
// ★ 最后一条治的正是模型的 `B8`（把"做完了"当"做对了"）：
//   没有明确表态 ⇒ 一律按"没认同"处理，**不给它默认放行**。

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Verdict = "认同" | "有保留" | "认可保留" | "反对";

/**
 * ★★★ 2026-10-20 · 「有保留」现在只是**提议**，要有人「认可」才生效
 *
 * ══════════════════════════════════════════════════════════════════════
 * 病（实测，第二次治同一个病）
 *
 *   第一次治（2026-10-19）：「有保留但没给解除条件 = 没表态」。
 *   ★ 结果：团队学乖了 —— 每张保留都写一条条件，照样过。
 *   实测现状：进书 29 份，签字 87 张：**认同 44 · 有保留 43 · 反对 0**
 *            ⇒ 带保留率 **86%**，反对 **0 张**。
 *
 * ★★★ 根因（结构缺陷，不是团队偷懒）：
 *   两种表态的**代价**不对等 ——
 *     · 反对：要拿反例，**且卡住发布**（要说服别人）
 *     · 有保留：写一条条件，**照样进书**
 *   ⇒ 理性做法永远是"有保留"。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 修法：把「有保留」从**结论**降级成**提议**
 *
 *   A 说「有保留 + 解除条件 X」  ⇒ 只是提议
 *   需要 B 或 C 说「认可保留」    ⇒ 才生效（否则 A 算没表态）
 *
 * ★ 为什么不设阈值（如"最多 1 张保留"）：
 *   阈值是**我拍的数**（上限 1 张挡 48%、上限 2 张挡 14% —— 都是拍的）。
 *   而"要说服一个同事"是**自然代价**，不依赖任何数。
 *   ★★ 而且和现有机制同构：`sign_off` 本来就是"表态"工具。
 */

export interface SignOffRecord {
  at: string;
  artifact: string;
  by: string;
  verdict: Verdict;
  reason: string;
  /**
   * ★★★★★ 「这份产物是不是我写的」（2026-10-21）
   *
   * ★ 为什么必须记（实测）：311 条签字里 **102 条（33%）是作者给自己签的**。
   *
   * ★★ 但这**不是门的漏洞** —— 门要求全体表态，作者必然要签自己。
   *   真正的问题是**报告骗人**：`3/3 签` 看起来比实际强（只有 2 票是独立的）。
   *
   * ★★★ 一条签字自己说的（原话）：
   *   「我是这一份的**作者**，所以这条签字是**把作者的自查交出来给门看**，
   *     不是第三方背书；若装置要求作者回避，请 `practice/runner` 覆盖我这票。」
   *   ⇒ 它自己指出了这个缺口。这里只是把它**记下来**，让门能报"独立几票"。
   *
   * ★ 不改变通过阈值（那仍然是「全体表态」）—— 只让读数诚实。
   */
  isAuthor?: boolean;
  /**
   * ★★★ 「有保留」的**解除条件**（2026-10-19 夜间实测补的设计缺口）。
   *
   * ★ 现象：26 次签字里 **23 张"有保留"、0 张"反对"** ⇒ 门形同虚设。
   * ★★ 根因（设计缺陷，不是 bug）：`有保留` 太廉价 —— 它**不需要给结论**。
   *   `sign_off` 于是变成了"我读过了，但我不想负责"。
   * ★★★ 修法：**有保留必须说出"什么能解除它"**。
   *   格式要求：可执行（"再加一个对照臂 N=8"），不是"再看看"（那是敷衍）。
   * ⇒ 这条把"有保留"从**免责声明**变成**待办清单**。
   */
  dislodge?: string;
}

/** ★ 一个团队对某份产物的签字表：`artifact → (teamKey → record)` */
export type SignOffTable = Map<string, Map<string, SignOffRecord>>;

/**
 * ★★★ 共识门的**纯函数**（★ 不碰文件、不碰 agent ⇒ 可以离线判定、可以单测）
 *
 * 工作纪律⑦：**判据是纯函数，可离线重判**。
 */
export function gateVerdict(
  signs: Map<string, SignOffRecord> | undefined,
  allTeams: readonly string[],
): {
  ok: boolean;
  blocked: string[];
  reservations: string[];
  missing: string[];
  /** ★ 「有保留」被认可的（生效） · 每条都写明谁承兑的 */
  accepted: string[];
  /**
   * ★★★★★ 门有多强（2026-10-21）
   *
   * ★ 实测：311 条签字里 **102 条（33%）是作者自签**。
   *   ⇒ 「3/3 签」这个说法**看起来比实际强**：只有 2 票是独立判断。
   *
   * ★★ 这一组字段不改变通过阈值（仍然是「全体表态」），只让读数诚实。
   */
  strength: {
    /** 表态的总票数（= 通过时的团队数） */
    signed: number;
    /** ★ 其中**不是作者**的（独立判断） */
    independent: number;
    /** ★ 作者自签的票数 */
    selfSigned: number;
    /**
     * ★★★★ **没声明**是不是作者的票数（历史数据）。
     *
     * ★ 为什么必须分开（2026-10-21 实测踩到）：
     *   `isAuthor` 是这一轮才加的字段，**历史 311 条都没有**。
     *   ⇒ 我第一版把它当 `false` 处理，读数报「作者自签 0%」——
     *     ★★★ 那是**假的**：真实是 33%，只是**没声明**。
     *
     * ★★ 这正是 AGENTS.md 那条：**缺数据 ≠ 0**。
     *   把"不知道"说成"没有"，比不报更坏 —— 它会让读数看起来比实际好。
     */
    undeclared: number;
  };
} {
  const blocked: string[] = [];
  const reservations: string[] = [];
  const missing: string[] = [];
  const accepted: string[] = [];
  let independent = 0;
  let selfSigned = 0;
  let undeclared = 0;

  /**
   * ★★★ 承兑人：**除自己以外**有谁说了「认可保留」
   *
   * ★ 为什么不要求特定某人：「保留」是对产物的判断，
   *   任何一个同事觉得这条保留站得住就够了。
   * ★★ 为什么排除自己：自己认可自己等于没升级门槛。
   */
  const endorsers = (self: string): string[] =>
    allTeams.filter((t) => t !== self && signs?.get(t)?.verdict === "认可保留");

  for (const t of allTeams) {
    const rec = signs?.get(t);
    // ★★★ 没表态 = 不许进（沉默不是认同）
    if (!rec) {
      missing.push(t);
      continue;
    }

    // ★★ 数票（★ 三分类 —— "没声明"绝不能算成"独立"）
    if (rec.isAuthor === true) selfSigned++;
    else if (rec.isAuthor === false) independent++;
    else undeclared++;

    if (rec.verdict === "反对") {
      blocked.push(`${t}：${rec.reason}`);
      continue;
    }

    // ★ 「认可保留」本身不是对产物的结论，它只是给别人的保留背书
    if (rec.verdict === "认可保留") continue;

    if (rec.verdict === "有保留") {
      // ★ 2026-10-19 的修：必须给解除条件
      if (!rec.dislodge || rec.dislodge.trim().length < 10) {
        missing.push(`${t}（有保留但没给解除条件）`);
        continue;
      }

      // ★★★ 2026-10-20 的修：**保留是提议，要有人承兑才生效**
      //
      //   实测病：87 张签字里 43 张「有保留」、**0 张反对** ⇒ 带保留率 86%。
      //   根因：反对要卡住发布（要说服别人），保留只要写条条件（照样进书）
      //        ⇒ 两种表态代价不对等 ⇒ 理性做法永远是"有保留"。
      //   ⇒ 修法：没人承兑 ⇒ 这条保留**不算表态**（= 没签）。
      const who = endorsers(t);
      if (!who.length) {
        missing.push(
          `${t}（有保留，但**没有同事「认可保留」** ⇒ 这条保留不算表态。` +
            `要么说服一个同事认可它，要么自己改判）`,
        );
        continue;
      }

      accepted.push(`${t}（由 ${who.join("、")} 承兑）：${rec.reason} —— ★解除条件：${rec.dislodge}`);
      reservations.push(`${t}：${rec.reason} —— ★解除条件：${rec.dislodge}`);
    }
  }

  // ★★ 只要有反对 或 有人没表态（含"保留没被承兑"）⇒ 不许进 book
  return {
    ok: blocked.length === 0 && missing.length === 0,
    blocked,
    reservations,
    missing,
    accepted,
    strength: { signed: independent + selfSigned + undeclared, independent, selfSigned, undeclared },
  };
}

export function makeSignOff(deps: {
  /** 本员工/本团队的名字 */
  selfKey: string;
  /** ★ 全体团队（门要求全都签） */
  allTeams: () => readonly string[];
  /** ★ 读/写签字表的落盘路径（`work/signoffs.jsonl`） */
  recordPath: string;
  /** ★ 已收集的签字（runner 持有，跨工具共享） */
  table: SignOffTable;
  /** ★ 产物目录（要检查文件确实存在） */
  outboxDir: string;
}) {
  return defineTool({
    name: "sign_off",
    label: "SignOff",
    description:
      [
        "为一份产物签字 —— ★★★ 这是**共识门**。",
        "★ 一份东西要进教科书，必须**全体团队都表态**（沉默不算认同）。",
        "",
        "★★★ 四选一：",
        "· **认同** —— 你核对过，没问题",
        "· **有保留** —— 可进，但你有条件（**必须给解除条件**）",
        "  ★★ 你的保留**只是提议** —— 必须有**别的团队说「认可保留」**才生效。",
        "     没人认可 ⇒ 你这条**不算表态**（等于没签）⇒ 产物进不了书。",
        "· **认可保留** —— 你看过同事的保留，认为**它站得住**（给他背书）",
        "· **反对** —— 不许进，先辩清楚",
        "",
        "★★ 为什么要「认可保留」：实测 87 张签字里 43 张有保留、**0 张反对**（86%）。",
        "   根因是代价不对等：反对要拿反例且卡住发布，有保留写条条件就照样进书。",
      ].join(String.fromCharCode(10)),
    parameters: Type.Object({
      artifact: Type.String({ description: "对哪份产物签字（outbox 里的文件名）" }),
      verdict: Type.Union(
        [
          Type.Literal("认同"),
          Type.Literal("有保留"),
          Type.Literal("认可保留"),
          Type.Literal("反对"),
        ],
        {
          description:
            [
              "★ 四选一，不许含糊：",
              "· **认同** —— 你核对过，没问题",
              "· **有保留** —— 可进，但你有条件（**必须给解除条件**）",
              "  ★★ 你的保留**只是提议** —— 需要**别的团队说「认可保留」**才生效。",
              "     没人认可 ⇒ 你这条**不算表态**（等于没签）⇒ 产物进不了书。",
              "· **认可保留** —— 你看过同事的保留，认为**它站得住**（给他背书）",
              "· **反对** —— 不许进，先辩清楚",
            ].join(String.fromCharCode(10)),
        },
      ),
      reason: Type.String({
        description:
          "★ 理由。选「认同」也要写**你核对过什么**才同意的（不能凭空点头）；" +
          "选「反对」必须写清**你的反证或替代解释**。",
      }),
      isAuthor: Type.Optional(
        Type.Boolean({
          description:
            "★ 这份产物是**你自己写的**吗？★ 必须诚实填 —— 作者自签不是第三方背书，" +
            "门会把它单独算（实测 33% 的签字是作者自签）",
        }),
      ),
      dislodge: Type.Optional(
        Type.String({
          description:
            "★★★ 选「有保留」时**必填**：什么能解除它？\\n" +
            "必须**可执行** —— 例：「再加一个对照臂 N=8」「在第二个任务族上复现」\\n" +
            "✘ 不算：「再看看」「希望更深入」「取决于具体情况」（那是免责声明，不是保留）",
        }),
      ),
    }),
    execute: async (_id, p) => {
      const path = join(deps.outboxDir, p.artifact);
      if (!existsSync(path)) {
        // ★ P12：拦的同时给路 —— 告诉它有哪些产物可签
        const { readdirSync } = await import("node:fs");
        const avail = existsSync(deps.outboxDir)
          ? readdirSync(deps.outboxDir).filter((f) => f.endsWith(".md")).slice(0, 20)
          : [];
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⛔ 没有这份产物：${p.artifact}\n` +
                `★ 可签的产物：\n${avail.map((f) => `  · ${f}`).join("\n") || "  （outbox 还是空的）"}`,
            },
          ],
          details: {},
        };
      }
      // ★★★★★ 2026-10-21 · 「改签」必须说清**是什么让你改口**
      //
      //   ★★★ 为什么（实测，不是推测）：
      //     `gateVerdict` 只读**每队最后一条签字**（`loadSignOffs` 后写覆盖先写）。
      //     ⇒ 一位成员先签「有保留」（带解除条件），过一会儿改签「认同」，
      //       门就**看不见那条保留**了。
      //
      //   ★★★ 实测读数（`freeFlips()` 算出来的）：
      //     「有保留 → 认同」共 **61 次**，其中 **60 次产物一个字节都没动（98%）**。
      //     ⇒ 那次改签不是"改好了"，是"改口了" —— 而门把它当成了"改好了"。
      //
      //   ★ 但**不能一律拒**：产物没变而理解变了是**合法**的
      //     （例：「我原以为 X 有问题，看了同事的数据发现没问题」）。
      //   ⇒ 所以要求的是**说清是什么让你改口**，而不是禁止改口。
      const prevRec = deps.table.get(p.artifact)?.get(deps.selfKey);
      if (prevRec?.verdict === "有保留" && p.verdict === "认同") {
        // ★ 产物在两次签字之间动过没有（★ 与 freeFlips 同一个判据）
        const mt = statSync(path).mtimeMs;
        const t0 = Date.parse(prevRec.at);
        const t1 = Date.now();
        const changed = mt > t0 && mt <= t1 + 60_000;
        if (!changed) {
          // ★★ 产物没动 ⇒ 必须说清"是什么让你改口"（不能只是"我又想了想"）
          const why = (p.reason ?? "").trim();
          const vague = why.length < 25 || /^(再想想|想通了|觉得没问题了|重新考虑(后|了)|没问题了)/.test(why);
          if (vague) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: [
                    `⛔ 你上次对这份产物签的是「**有保留**」，现在要改签「认同」，`,
                    `   而**这份产物从那时到现在一个字节都没动**。`,
                    ``,
                    `★★★ 实测：这样的改签一共发生过 61 次，**60 次产物没动（98%）**。`,
                    `   门只读**最后一条**签字 ⇒ 你这一改，那条带条件的保留就**消失了**，`,
                    `   而书里没有任何痕迹说明它被解除了。`,
                    ``,
                    `★ **改口是允许的** —— 但必须说清是什么让你改口，比如：`,
                    `  ✔ 「看了同事 P47 的对照数据，我原来那条保留的前提不成立」`,
                    `  ✔ 「我误解了 §3 的读数口径；按交付口径复算后 8/8 成立」`,
                    `✘ 不算：「再想想觉得没问题」「重新考虑后同意」（那是改口，不是解除）`,
                    ``,
                    `★★ 如果产物**该改的还没改**，就别改签 —— 留着保留，让它去改。`,
                    `★ 你上次给的解除条件是：「${prevRec.dislodge ?? "(没写)"}」`,
                    `   它满足了吗？没满足就不该改签。`,
                  ].join(String.fromCharCode(10)),
                },
              ],
              details: {},
            };
          }
        }
      }

      // ★★★ 「有保留」必须给解除条件（否则门永远开着 —— 见 SignOffRecord.dislodge 的注释）
      if (p.verdict === "有保留" && (p.dislodge ?? "").trim().length < 10) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⛔ 你说「有保留」，但**没说什么能解除它**。

` +
                `★★★ 这个集群实测过：**23 张"有保留"、0 张"反对"** ⇒ 门形同虚设。
` +
                `★ 根因：「有保留」不需要给结论，于是它变成了「我读过了，但我不想负责」。

` +
                `★ 请填 dislodge：**什么能解除你的保留**（要可执行）。
` +
                `  ✔ 「再加一个对照臂 N=8」「在第二个任务族上复现」「补一批跨模型读数」
` +
                `  ✘ 「再看看」「希望更深入」「取决于具体情况」

` +
                `★ 或者：若你其实同意 ⇒ 选「认同」；若你其实不同意 ⇒ 选「反对」（那才是有效表态）。`,
            },
          ],
          details: {},
        };
      }
      if (p.reason.trim().length < 20) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⛔ 理由太短（${p.reason.trim().length} 字）。\n` +
                `★ 签字是要留进书的 —— 写清你**核对了什么**（至少 20 字）。\n` +
                `★★ 签名式点头（"看起来没问题"）不算表态（B8）。`,
            },
          ],
          details: {},
        };
      }

      const rec: SignOffRecord = {
        at: new Date().toISOString(),
        artifact: p.artifact,
        by: deps.selfKey,
        verdict: p.verdict,
        reason: p.reason,
        isAuthor: p.isAuthor === true,
        ...(p.dislodge ? { dislodge: p.dislodge } : {}),
      };
      if (!deps.table.has(p.artifact)) deps.table.set(p.artifact, new Map());
      deps.table.get(p.artifact)!.set(deps.selfKey, rec);

      try {
        mkdirSync(join(deps.recordPath, ".."), { recursive: true });
        appendFileSync(deps.recordPath, JSON.stringify(rec) + "\n");
      } catch {
        /* 落盘失败不影响内存态，但会体现在重启后 */
      }

      const m = gateVerdict(deps.table.get(p.artifact), deps.allTeams());
      const lines = [
        `✔ 已记录：**${deps.selfKey}** 对 \`${p.artifact}\` 判 **${p.verdict}**。`,
        ``,
        m.ok
          ? `★★★ **共识门已开** —— 全体团队都表过态、且无反对 ⇒ 这份可以进书。`
          : `★ 共识门现状：${m.ok ? "开" : "**还没开**"}`,
      ];
      if (m.blocked.length) lines.push(`⛔ 反对：${m.blocked.join("；")}`);
      if (m.missing.length) lines.push(`⏳ 还没表态：${m.missing.join("、")}（★ 沉默不算认同）`);
      if (m.reservations.length) lines.push(`⚠ 保留意见（会附在产物里）：${m.reservations.join("；")}`);
      if (!m.ok) {
        lines.push(``, `★★ 下一步：去用 \`challenge\` 或 \`joint_experiment\` 把分歧辩清楚。`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
    },
  });
}

/** ★ 把共识状态渲染成一段附录（写进产物 = 保留意见随产物走） */
export function renderSignOff(artifact: string, signs: Map<string, SignOffRecord> | undefined): string {
  if (!signs || signs.size === 0) return "";
  const out = [`\n---\n\n## ★ 共识状态\n`];
  for (const [team, r] of signs) {
    out.push(`- **${team}**：${r.verdict} —— ${r.reason}`);
    // ★★★ 解除条件必须随产物走（2026-10-19 夜间：测试抓到它没被渲染出来）
    //   ★ 否则读者只看到"有保留"，看不到**要做什么才能解除** ⇒ 保留意见等于没写。
    if (r.dislodge) out.push(`  - ★ **解除条件**：${r.dislodge}`);
  }
  return out.join("\n") + "\n";
}

/** ★ 读回签字表（进程重启后接着用） */
export function loadSignOffs(recordPath: string): SignOffTable {
  const t: SignOffTable = new Map();
  if (!existsSync(recordPath)) return t;
  for (const line of readFileSync(recordPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SignOffRecord;
      if (!t.has(r.artifact)) t.set(r.artifact, new Map());
      t.get(r.artifact)!.set(r.by, r);
    } catch {
      /* 坏行跳过 */
    }
  }
  return t;
}

/**
 * ★★★★★ 「免费改口」检测（2026-10-21，集群自己提的判据，我只加数）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一条不是我发明的 —— 是集群自己在产物里写下的**改判条件**：
 *
 *   「**我在什么条件下改口**（跑前写死，见 §7）：
 *     若 landing 的『保留 → 认同但**期间产物一个字节没动**』……」
 *       —— `outbox/实践-签字46%不是病-三次对照与一个真该看的0.md`
 *
 * ★★★ 我只补一件事：**把那个「一个字节没动」算出来**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 为什么这是病（结构上的，不是道德上的）
 *
 *   `gateVerdict` 只读**每队最后一条签字**（`loadSignOffs` 后写覆盖先写）。
 *   ⇒ 一位成员先签「有保留」（带解除条件），过一会儿改签「认同」，
 *     门就**看不见那条保留**了。
 *   ★★ 如果产物真的改好了，改签是对的。
 *   ★★★ 但如果**产物一个字节没动**，那次改签不是「改好了」，是「改口了」——
 *        而门把它当成了「改好了」。
 *
 * ⇒ 这个函数就是量那一件事：**改签时，产物到底动没动。**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 判据（可判死，纪律⑦）：`mtime` 落在两次签字之间 ⇒ 算"动过"。
 * ★★ 局限（必须写在代码里）：mtime 变新 ≠ 内容变了（重存也会变）⇒
 *    所以这个数只能给"**上限**"：真实"免费改口"只会比它多，不会比它少。
 */
export type FreeFlip = {
  artifact: string;
  by: string;
  /** 改签前后的判决 */
  from: Verdict;
  to: Verdict;
  /** ★ 期间产物动过没有 */
  artifactChanged: boolean;
};

export function freeFlips(
  lines: string[],
  /**
   * ★★★★★ 判「两次签字之间产物变过没有」。
   *
   * ★★★ 这个参数为什么改成回调（2026-10-21，**集群推翻了我的第一版**）：
   *
   *   我第一版用 `mtimeOf`（当前文件 mtime），得出「60/61 = 98% 没动」。
   *   ★★★ 集群说「**这个数我复现不出来**」，并给了三条口径 —— 它是对的：
   *
   *   | 口径 | 动过 | 没动 |
   *   |---|---|---|
   *   | 我的 mtime（当前 mtime 落在 t0..t1）| 1 | 60（98%）|
   *   | **git blob（t0/t1 时刻的内容哈希）** | **44（72%）** | **13（21%）** |
   *
   *   ★ 我错在哪：**`mtime` 是"现在"，不是"当时"**。
   *     任何在那之后又被写过的文件，当前 mtime 都晚于 t1 ⇒ 被我判成"从没动过"。
   *   ⇒ 系统性偏向"没动"。
   *
   *   ★★ 教训（与纪律㉙同源、方向相反）：
   *     **用"当前状态"去回答"历史问题"，一定错。**
   *     要问"那时候是什么样"，就得读**那时候的记录**（这里是 git blob）。
   */
  changedBetween: (artifact: string, t0: string, t1: string) => boolean,
): { flips: FreeFlip[]; free: number; paid: number } {
  /** ★ 按 (产物, 队) 收全部签字，按时间排序 */
  const seq = new Map<string, SignOffRecord[]>();
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let r: SignOffRecord;
    try {
      r = JSON.parse(ln) as SignOffRecord;
    } catch {
      continue;
    }
    if (!r.artifact || !r.by) continue;
    const k = `${r.artifact}||${r.by}`;
    const arr = seq.get(k) ?? [];
    arr.push(r);
    seq.set(k, arr);
  }

  const flips: FreeFlip[] = [];
  for (const [k, arr] of seq) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const [artifact, by] = k.split("||") as [string, string];
    for (let i = 0; i < arr.length - 1; i++) {
      const prev = arr[i]!;
      const next = arr[i + 1]!;
      // ★★★ 只关心「有保留 → 认同」这一种：它**冲掉了带条件的保留**
      if (prev.verdict !== "有保留" || next.verdict !== "认同") continue;
      // ★★★ 判据：**那两次签字时刻的内容**一样不一样（★ 不是"现在"）
      const artifactChanged = changedBetween(artifact, prev.at, next.at);
      flips.push({ artifact, by, from: prev.verdict, to: next.verdict, artifactChanged });
    }
  }

  const free = flips.filter((f) => !f.artifactChanged).length;
  return { flips, free, paid: flips.length - free };
}

/** ★ 供 runner 使用：把已开门的产物登记下来（收尾时汇报） */
export function agreedArtifacts(
  table: SignOffTable,
  allTeams: readonly string[],
): string[] {
  const out: string[] = [];
  for (const [art, signs] of table) {
    if (gateVerdict(signs, allTeams).ok) out.push(art);
  }
  return out.sort();
}

/** ★ 写一份共识汇总（收尾时落盘，人一眼看得出哪些进了、哪些卡住） */
export function writeAgreedIndex(
  path: string,
  table: SignOffTable,
  allTeams: readonly string[],
): string[] {
  const agreed = agreedArtifacts(table, allTeams);
  const lines: string[] = [
    `# 共识状态（${new Date().toISOString()}）`,
    ``,
    `★ 全体团队：${allTeams.join("、")}`,
    ``,
    `| 产物 | ${allTeams.join(" | ")} | 能否进书 |`,
    `|---|---${"|".repeat(allTeams.length)}---|`,
  ];
  for (const [art, signs] of [...table].sort()) {
    const cells = allTeams.map((t) => signs.get(t)?.verdict ?? "★没表态");
    const m = gateVerdict(signs, allTeams);
    lines.push(`| \`${art}\` | ${cells.join(" | ")} | ${m.ok ? "✔ 可以" : "⛔ " + (m.blocked.length ? "有反对" : "没表全")} |`);
  }
  writeFileSync(path, lines.join("\n") + "\n");
  return agreed;
}

/**
 * ★★★ 未兑现的解除条件 —— **闭环的另一半**（2026-10-20 补）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 病（实测，AGENTS §〇之三 原话）
 *
 *   「条件写在那儿，但**没人去执行**。」
 *
 *   实测：`signoffs.jsonl` 里 **96 条带保留**，每条都写了具体的解除条件
 *   （"路线 A 改成含《观测单元》与《数与延》"、"§6 换成边际价口径三行"…）。
 *   ★★ 这些条件**写得很好**（可执行、有验收标准），
 *      但**没有任何东西在事后检查它们有没有被兑现**。
 *
 * ⇒ 于是「有保留」退化成**永久的免责声明** ——
 *   门以为自己在把关，其实只是把责任推给了未来。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 这个函数只算、不改（判定与执行分开）
 *
 *   它**不判断**某个条件是否已满足 —— 那需要读产物内容、需要理解，
 *   是**集群自己的活**（我不能替它判内容，AGENTS 硬规则①）。
 *
 *   它能做的是：**把"哪些还挂着"摆到桌面上**，让集群下一轮自己排优先级。
 *   ★ 这也是 AGENTS §〇之三 的要求：
 *     「每轮 forge 开工前，把未兑现的解除条件列出来，送进集群 —— 它们自己排优先级」
 *
 * @param table     签字表
 * @param published 已经进书的产物名（★ 只有进了书的才需要解除）
 * @returns 每份产物 → 还挂着的解除条件（去重、去掉已失效的）
 */
export function unresolvedDislodges(
  table: SignOffTable,
  published: readonly string[],
): Map<string, { by: string; reason: string; dislodge: string }[]> {
  const out = new Map<string, { by: string; reason: string; dislodge: string }[]>();
  const pubs = new Set(published);

  for (const [artifact, signs] of table) {
    if (!pubs.has(artifact)) continue; // ★ 没进书不用管
    const rows: { by: string; reason: string; dislodge: string }[] = [];
    for (const [team, rec] of signs) {
      // ★ 只收「有保留且给了够具体的解除条件」——
      //   没给条件的已经在门上被当成"没表态"（见 gateVerdict）
      if (rec.verdict !== "有保留") continue;
      const d = (rec.dislodge ?? "").trim();
      if (d.length < 10) continue;
      rows.push({ by: team, reason: rec.reason, dislodge: d });
    }
    if (rows.length) out.set(artifact, rows);
  }
  return out;
}
