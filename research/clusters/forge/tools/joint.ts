// joint_experiment —— ★★ 争辩中「共同设计实验来验证」
//
// ══════════════════════════════════════════════════════════════════
// ★★★ 设计者裁定（2026-10-19，逐字）：
//   「在争辩中，各个团队**可以设计实验，或共同设计实验**来验证。」
// ══════════════════════════════════════════════════════════════════
//
// ★★ 为什么"共同"比"各自"重要（不是礼貌问题，是证据问题）：
//   · **单方设计的实验** ⇒ 另一方天然不信它的判据
//     实测教训（`P44` 撤回事件）：缺安慰剂臂 ⇒ headline 与机制归因双双撤回。
//     ★ 而缺臂，往往正是**设计者自己没想到**——同一方再想一遍也想不出来。
//   · **联合设计** ⇒ 判据是**吵出来的** ⇒ 结论才会被双方接受。
//
// ★★ 机制形状：
//   ① 一方发起 `joint_experiment.propose`（问题 / 臂 / 判据 / 谁该参与）
//   ② 其他团队 `joint_experiment.sign`（认同 / 要求加臂 / 反对）
//   ③ ★ 全体签好 ⇒ 发起方可以真跑（`joint_experiment.run` 给出装置骨架）
//
// ★★★ 判据必须**跑前冻结**（纪律⑦）：`run` 会把 judge 的源码哈希记下来，
//   跑完改判据 ⇒ 哈希对不上 ⇒ 这次实验作废。

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface JointProposal {
  id: string;
  at: string;
  by: string;
  question: string;
  arms: string[];
  /** ★ 判据（纯函数的源码，跑前冻结） */
  judge: string;
  /** ★ 判据源码的哈希（跑完对不上 = 改过判据 = 作废） */
  judgeHash: string;
  signs: Map<string, { verdict: "认同" | "要求加臂" | "反对"; reason: string }>;
}

export function makeJointExperiment(deps: {
  selfKey: string;
  allTeams: () => readonly string[];
  /** 提案与签字的落盘路径 */
  recordPath: string;
  table: Map<string, JointProposal>;
  /** ★ 联合实验的装置目录（跑的原件放这里） */
  workDir: string;
}) {
  return defineTool({
    name: "joint_experiment",
    label: "JointExperiment",
    description:
      "★★ 争辩里判不出谁对时，用这个**和其他团队一起设计一个实验**来判定。\n" +
      "用法一步步来：\n" +
      "  1. `action=propose` —— 提出：要判什么、几个臂、判据（★ 判据是**纯函数源码**，跑前冻结）\n" +
      "  2. `action=sign` —— 其他团队表态：认同 / **要求加臂**（★ 缺安慰剂臂是最常见的坑）/ 反对\n" +
      "  3. `action=run` —— 全体签好之后，取回装置骨架并真跑\n" +
      "★★ 为什么必须共同设计：单方设计的实验，另一方**天然不信它的判据**。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("propose"), Type.Literal("sign"), Type.Literal("run")], {
        description: "propose / sign / run",
      }),
      id: Type.Optional(Type.String({ description: "提案 id（sign/run 时要）" })),
      question: Type.Optional(Type.String({ description: "propose：要判定什么（一句话，可判死）" })),
      arms: Type.Optional(
        Type.Array(Type.String(), { description: "propose：实验臂（★ 想想对手会要求加哪一臂）" }),
      ),
      judge: Type.Optional(
        Type.String({ description: "propose：判据的**纯函数源码**（输入读数，输出判定；跑前冻结）" }),
      ),
      verdict: Type.Optional(
        Type.Union([Type.Literal("认同"), Type.Literal("要求加臂"), Type.Literal("反对")], {
          description: "sign：你的表态",
        }),
      ),
      reason: Type.Optional(Type.String({ description: "sign：理由（要求加臂就写要加哪一臂、为什么）" })),
    }),
    execute: async (_id, p) => {
      const all = deps.allTeams();
      const save = (obj: unknown) => {
        try {
          mkdirSync(deps.workDir, { recursive: true });
          appendFileSync(deps.recordPath, JSON.stringify(obj) + "\n");
        } catch {
          /* 落盘失败不影响内存 */
        }
      };

      if (p.action === "propose") {
        if (!p.question || !p.arms?.length || !p.judge) {
          return {
            content: [{ type: "text" as const, text: "⛔ propose 需要 question + arms + judge 三样。" }],
            details: {},
          };
        }
        if (p.arms.length < 2) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `⛔ 只有 ${p.arms.length} 个臂 —— 那不是实验，是观察。\n` +
                  `★ 至少要有一个**对照臂**（纪律②：没有对照的观察不是证据）。`,
              },
            ],
            details: {},
          };
        }
        const id = `J${deps.table.size + 1}`;
        const judgeHash = createHash("sha256").update(p.judge).digest("hex").slice(0, 12);
        const prop: JointProposal = {
          id,
          at: new Date().toISOString(),
          by: deps.selfKey,
          question: p.question,
          arms: p.arms,
          judge: p.judge,
          judgeHash,
          signs: new Map(),
        };
        deps.table.set(id, prop);
        save({ kind: "propose", ...prop, signs: [] });
        const others = all.filter((t) => t !== deps.selfKey);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `✔ 提案 **${id}** 已登记。\n` +
                `  问题：${p.question}\n` +
                `  臂：${p.arms.join(" / ")}\n` +
                `  ★ 判据哈希：\`${judgeHash}\`（跑完对不上 = 判据被改过 = 作废）\n\n` +
                `★★ 现在必须让 ${others.join("、")} 来 \`sign\`（★ 用 challenge 通知他们）。\n` +
                `★ 他们大概率会**要求加臂** —— 那正是联合设计的价值。`,
            },
          ],
          details: {},
        };
      }

      const prop = p.id ? deps.table.get(p.id) : undefined;
      if (!prop) {
        return {
          content: [
            {
              type: "text" as const,
              text: `⛔ 没有这个提案：${p.id ?? "（没给 id）"}。现有：${[...deps.table.keys()].join("、") || "（无）"}`,
            },
          ],
          details: {},
        };
      }

      if (p.action === "sign") {
        if (!p.verdict || !p.reason) {
          return {
            content: [{ type: "text" as const, text: "⛔ sign 需要 verdict + reason。" }],
            details: {},
          };
        }
        prop.signs.set(deps.selfKey, { verdict: p.verdict, reason: p.reason });
        save({ kind: "sign", id: prop.id, by: deps.selfKey, verdict: p.verdict, reason: p.reason });
        const need = all.filter((t) => !prop.signs.has(t));
        const blocked = [...prop.signs].filter(([, s]) => s.verdict !== "认同");
        return {
          content: [
            {
              type: "text" as const,
              text:
                `✔ 已签：**${deps.selfKey}** → ${p.verdict}\n` +
                (p.verdict === "要求加臂"
                  ? `★★ 你要求加臂 ⇒ 提案方**必须改臂**再重签（这会让实验更强）。\n`
                  : "") +
                (need.length ? `⏳ 还差：${need.join("、")}\n` : `★★★ 全体签好！可以 \`run\` 了。\n`) +
                (blocked.length ? `⚠ 非认同：${blocked.map(([k, s]) => `${k}(${s.verdict})`).join("、")}` : ""),
            },
          ],
          details: {},
        };
      }

      // run
      const need = all.filter((t) => !prop.signs.has(t));
      const bad = [...prop.signs].filter(([, s]) => s.verdict !== "认同");
      if (need.length || bad.length) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⛔ 还不能跑。\n` +
                (need.length ? `  尚未表态：${need.join("、")}\n` : "") +
                (bad.length ? `  非认同：${bad.map(([k, s]) => `${k}（${s.verdict}：${s.reason}）`).join("；")}\n` : "") +
                `★★ 联合实验的价值就在这一步 —— **判据必须是吵出来的**。`,
            },
          ],
          details: {},
        };
      }
      const skeleton =
        `// ★ 联合实验 ${prop.id}（全体已签：${[...prop.signs.keys()].join("、")}）\n` +
        `// 问题：${prop.question}\n` +
        `// 臂：${prop.arms.join(" | ")}\n` +
        `// ★★ 判据哈希 ${prop.judgeHash} —— 跑完请用同一个判据；改过即作废\n\n` +
        `${prop.judge}\n`;
      return {
        content: [
          {
            type: "text" as const,
            text:
              `★★★ **${prop.id} 可以跑了**（全体认同）。\n\n` +
              `★ 装置骨架（写进 \`work/\` 下再跑）：\n\`\`\`ts\n${skeleton}\n\`\`\`\n` +
              `★★ 跑完把读数写进 \`work/runs/\`，判据用上面这份（哈希 \`${prop.judgeHash}\`）。`,
          },
        ],
        details: {},
      };
    },
  });
}
