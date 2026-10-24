// correct —— ★★★★ 集群**改掉别人脑子里的错**（不是发文档让它自己改）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者 2026-10-21（逐字，这是这一族工具的共同起点）：
//   「这个底层库开放了很多 api（甚至有需求可以自己改底层库造 api），
//    完全可以去**实验创新**，创新出更符合我们目标的东西。」
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么"改写记忆"是集群真正需要的东西（而不是又一份文档）
//
//   集群跑久了会出现一种病，**skill 完全治不了**：
//
//     一位成员在 30 分钟前得出一个**错的**结论，然后**基于它**又推了 5 步。
//     你现在告诉它"那条错了"——它会：
//       · 承认错（嘴上），但**那 5 步的上下文还在** ⇒ 后续推理继续受污染
//       · 或者干脆不承认（死守错误结论），因为"我前面已经论证过了"
//
//   ★★★ skill 是"再加一条进来"，它**不改已有的**。
//   而 `context.replace` / `context.erase` 能**直接改掉那一条**。
//
//   ⇒ 这是"治理"和"规劝"的区别：
//     · skill（规劝）：往上下文里**加**一句话，希望它自己改
//     · correct（治理）：**直接改**它上下文里的那条，连同污染一起
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 三条硬约束（★ 不给商量 —— 因为这是"动别人的脑子"）
//
//   ① **必须指明是哪一条 entry**（`entryId`，来自 `context.entries()`）
//      ⇒ 不许"清空它的记忆"这种模糊操作 —— 那是暴力，不是纠正。
//   ② **必须给出"为什么错"的证据**（`evidence`）
//      ⇒ 没有依据就改别人的结论 = 集群内的霸凌。
//   ③ **必须说明"改成什么"**（`replacement`），或显式声明"抹掉"（`erase: true`）
//      ⇒ ★★★ 只抹不给替代 = 它会用同样的推理再得出同一个错。
//         「抹掉 + 给对的」才是纠正；「只抹掉」是让它重新踩坑。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 一条我自己加的约束（不是设计者说的，是我的判断，写在这里便于被推翻）
//
//   ④ **保留原文**（`originalPreview` 落盘）
//      ⇒ 改别人的记忆是可逆的吗？**不是**（pi 的 context edit 是 append-only，
//        但 `erase` 之后模型看不见原文了）。
//      ⇒ 所以我至少要在**账**里留下：改之前那句话是什么。
//      ★★ 否则事后无法回答"它当初为什么那么想" —— 而那往往才是真问题。
//
// ══════════════════════════════════════════════════════════════════════════

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NL = String.fromCharCode(10);

export type CorrectInput = {
  /** ★ 对谁 */
  target: string;
  /** ★ 哪一条（来自 `context.entries()` 的 id） */
  entryId: string;
  /** ★ 那句话现在是什么（★ runner 用它核对 entryId 没填错） */
  originalPreview: string;
  /** ★★ 为什么错（必须有证据） */
  evidence: string;
  /** ★ 改成什么（`erase: true` 时可以空） */
  replacement?: string;
  /** ★ 完全抹掉（★ 但要求同时给 replacement 的替代品，见校验） */
  erase?: boolean;
};

/** ★ 纯函数：校验（纪律⑦） */
export function checkCorrectInput(input: CorrectInput, members: string[]): string[] {
  const errs: string[] = [];

  if (!input.target.trim()) errs.push("target 必填");
  else if (!members.includes(input.target)) {
    errs.push(`target「${input.target}」不是现有成员（${members.join("、")}）`);
  }

  if (!input.entryId.trim()) {
    errs.push(
      "entryId 必填 —— 必须先 `context.entries()` 看它到底说过什么，" +
        "★ 不许使用「清空它的记忆」这种模糊操作（那是暴力，不是纠正）",
    );
  }

  // ② 必须有证据
  if (input.evidence.trim().length < 8) {
    errs.push("evidence 太短：**为什么错**必须有依据（读数 / 反例 / 复算），否则就是集群内的霸凌");
  }

  // ③ ★★★ 关键：抹掉必须给替代
  const hasRepl = (input.replacement ?? "").trim().length > 0;
  if (input.erase && !hasRepl) {
    errs.push(
      "只看 erase 不收：★ 只抹不给对的 ⇒ 它会用同样的推理**再得出同一个错**。" +
        "请在 replacement 里写「正确的是什么」，或把 erase 去掉改成 replace。",
    );
  }
  if (!input.erase && !hasRepl) {
    errs.push("replacement 必填（或 erase:true + replacement 给对的说法）");
  }

  // ④ 必须留下原文
  if (input.originalPreview.trim().length === 0) {
    errs.push("originalPreview 必填 —— 要在账里留「改之前它说的是什么」，否则事后无法回答它当初为什么那么想");
  }

  return errs;
}

export type CorrectDeps = {
  members: () => string[];
  closing: () => boolean;
  /** ★ 真正去改（runner 提供：它拿得到那个 agent 的 context 面） */
  apply: (rec: {
    target: string;
    entryId: string;
    originalPreview: string;
    evidence: string;
    replacement?: string;
    erase?: boolean;
  }) => Promise<{ ok: boolean; note: string }>;
  ledger: string;
  log: (m: string) => void;
};

export function makeCorrectTool(deps: CorrectDeps) {
  return defineTool({
    name: "correct",
    label: "改掉某位成员的一个错误结论",
    // ★★★ 纪律㉘：描述必须说清它和 skill / enforce 的区别
    description: [
      "**直接改掉**某位成员上下文里的一个错误结论（不是发一份文档让它自己改）。",
      "",
      "★★ 三个工具的分工（选错就白做）：",
      "  · `write_skill`：全体都要知道的**做法** ⇒ 加一条进来",
      "  · `enforce`：某一位**反复做错**同一件事 ⇒ 装一道门，不合格过不去",
      "  · `correct`：某一位**已经得出了一个错结论，还在基于它往下推** ⇒ **直接改掉那一条**",
      "",
      "★★★ 什么时候该用 correct：`skill` 加了、`enforce` 装了，但它**脑子里那条错的还在**",
      "  （它已经论证过、已经写进产物、后续 5 步都基于它）。",
      "",
      "★ 必填：",
      "  · target：成员 key",
      "  · entryId：哪一条（先用 `context.entries()` 看它说过什么 —— 不许模糊清空）",
      "  · originalPreview：那句话现在是什么（★ 会记进账，事后能查它当初为什么那么想）",
      "  · evidence：为什么错（读数 / 反例 / 复算）",
      "  · replacement：正确的是什么",
      "  · erase：是否连原文一起抹掉（★ 抹掉也必须给 replacement）",
      "",
      "★★★ 不许做的：只说「抹掉」不给对的说法 —— 它会用同样的推理再得出同一个错。",
    ].join(NL),
    parameters: Type.Object({
      target: Type.String({ description: "成员 key" }),
      entryId: Type.String({ description: "来自 context.entries() 的 id" }),
      originalPreview: Type.String({ description: "原文是什么（记进账）" }),
      evidence: Type.String({ description: "为什么错" }),
      replacement: Type.Optional(Type.String({ description: "正确的是什么" })),
      erase: Type.Optional(Type.Boolean({ description: "连原文一起抹掉（仍须给 replacement）" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (deps.closing()) {
        return {
          content: [{ type: "text" as const, text: "⛔ 已进收尾态，不再改别人的记忆。" }],
          details: { ok: false } as { ok: boolean },
          isError: true,
        };
      }

      const input = params as CorrectInput;
      const errs = checkCorrectInput(input, deps.members());
      if (errs.length) {
        return {
          content: [{ type: "text" as const, text: ["⛔ 这条纠正不收：", ...errs.map((e) => `  · ${e}`)].join(NL) }],
          details: { ok: false, errors: errs } as { ok: boolean; errors?: string[] },
          isError: true,
        };
      }

      const r = await deps.apply(input);
      if (!r.ok) {
        return {
          content: [{ type: "text" as const, text: `⛔ 没改成：${r.note}` }],
          details: { ok: false } as { ok: boolean },
          isError: true,
        };
      }

      // ★ 记账（★ 含原文，事后能回答"它当初为什么那么想"）
      try {
        mkdirSync(dirname(deps.ledger), { recursive: true });
        appendFileSync(
          deps.ledger,
          JSON.stringify({ op: "correct", ...input, at: new Date().toISOString() }) + NL,
          "utf8",
        );
      } catch (e) {
        deps.log(`★ 已改，但记账失败：${(e as Error).message}`);
      }

      deps.log(`★★ 改掉了「${input.target}」的一条：${input.originalPreview.slice(0, 40)}`);
      deps.log(`   理由：${input.evidence.slice(0, 80)}`);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `✔ 已改掉「${input.target}」的那一条（${r.note}）`,
              `★ 原文：${input.originalPreview.slice(0, 80)}`,
              `★★ 改成：${(input.replacement ?? "(抹掉)").slice(0, 80)}`,
              `★★★ 它会**在下一轮**读到新的版本 —— 这不是提醒，是它上下文里那条真的变了。`,
            ].join(NL),
          },
        ],
        details: { ok: true } as { ok: boolean },
      };
    },
  });
}
