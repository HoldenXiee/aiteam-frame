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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Verdict = "认同" | "有保留" | "反对";

export interface SignOffRecord {
  at: string;
  artifact: string;
  by: string;
  verdict: Verdict;
  reason: string;
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
): { ok: boolean; blocked: string[]; reservations: string[]; missing: string[] } {
  const blocked: string[] = [];
  const reservations: string[] = [];
  const missing: string[] = [];
  for (const t of allTeams) {
    const rec = signs?.get(t);
    // ★★★ 没表态 = 不许进（沉默不是认同）
    if (!rec) missing.push(t);
    else if (rec.verdict === "反对") blocked.push(`${t}：${rec.reason}`);
    else if (rec.verdict === "有保留") reservations.push(`${t}：${rec.reason}`);
  }
  // ★★ 只要有反对 或 有人没表态 ⇒ 不许进 book
  return { ok: blocked.length === 0 && missing.length === 0, blocked, reservations, missing };
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
      "为一份产物签字 —— ★★★ 这是**共识门**。\n" +
      "★ 一份东西要进教科书，必须**全体团队都表态**（沉默不算认同）。\n" +
      "★ 三选一：**认同** / **有保留**（可进，但你的保留意见会附在产物里）/ **反对**（不许进，先辩清楚）。\n" +
      "★★ 反对不是终点 —— 反对之后应当**设计实验来判定谁对**（可以用 joint_experiment）。",
    parameters: Type.Object({
      artifact: Type.String({ description: "对哪份产物签字（outbox 里的文件名）" }),
      verdict: Type.Union([Type.Literal("认同"), Type.Literal("有保留"), Type.Literal("反对")], {
        description: "★ 三选一，不许含糊",
      }),
      reason: Type.String({
        description:
          "★ 理由。选「认同」也要写**你核对过什么**才同意的（不能凭空点头）；" +
          "选「反对」必须写清**你的反证或替代解释**。",
      }),
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
