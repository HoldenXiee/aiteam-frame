// grant —— ★★★★ 集群**给某位成员临时加一把工具**（不是出厂固定）
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 它和 `spawn_seat` 正好是一对
//
//   spawn_seat（已有）              grant（本文件）
//   ─────────────────────          ──────────────────────────────
//   长**一个人**                    长**一份能力**
//   新席位只读（框架约束①）          ★ 给已有成员加工具
//   本轮有效，只在内存               ★ 本轮有效，到点收回
//
//   ★★★ 两者合起来才是完整的「生长」：
//     · 有一件活没人干 ⇒ `spawn_seat`（长人）
//     · 有一个人能干，但他手上没工具 ⇒ `grant`（长能力）
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么"临时"是硬的（不是图省事）
//
//   ★ 出厂给每个人全套工具 ⇒ 它不知道该用哪个，而且**成本不可控**。
//   ★ 永久加工具 ⇒ 累积成一个没人记得为什么在那儿的工具表
//     （这正是 skill 的第四个弊端，只是换到工具层）。
//
//   ⇒ 所以：**加的时候就必须说什么时候收回**（`until`）。
//   ★★ 到期由 runner 真的 `tools.remove()` —— 不是"记得就收"。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 三条硬约束
//
//   ① **只能加"只读/无害"类工具到别人的表里**（`SAFE_TOOLS`）
//      ⇒ ★ 不许通过 grant 把「写」「删」给一个本来没有的人 ——
//        那是绕过 `spawn_seat` 的框架约束①（新席位只读）。
//      ★★ 这条是我的判断（设计者没说过），写在下面便于被推翻。
//   ② **必须给 `until`**（什么时候收回）
//      ⇒ 没收回条件的能力 = 出厂配置 = 失去"临时"的意义。
//   ③ **必须给 `evidence`**（为什么现在需要）
//      ⇒ 没有依据就加能力 = 拍脑袋（纪律②）。
//
// ══════════════════════════════════════════════════════════════════════════

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NL = String.fromCharCode(10);

/**
 * ★ 可以 grant 的工具（只读 / 无害）。
 *
 * ★★ 不含 `write` / `edit` / `bash` —— 那些会**改盘**，
 *    加给别人等于绕过"新席位只读"那条框架约束。
 * ★ 名单由研究助手定（框架），集群不能自己扩。
 */
export const SAFE_TOOLS = ["read", "grep", "find", "ls"] as const;

export type GrantInput = {
  target: string;
  /** ★ 给哪些工具（只能从 SAFE_TOOLS 里选） */
  tools: string[];
  /** ★★ 什么时候收回 */
  until: string;
  /** ★ 为什么现在需要 */
  evidence: string;
};

/** ★ 纯函数：校验（纪律⑦） */
export function checkGrantInput(input: GrantInput, members: string[]): string[] {
  const errs: string[] = [];

  if (!input.target.trim()) errs.push("target 必填");
  else if (!members.includes(input.target)) {
    errs.push(`target「${input.target}」不是现有成员（${members.join("、")}）`);
  }

  if (!input.tools?.length) errs.push("tools 必填：要加哪几把工具");

  // ① 只能加安全的
  const bad = (input.tools ?? []).filter((t) => !(SAFE_TOOLS as readonly string[]).includes(t));
  if (bad.length) {
    errs.push(
      `不许 grant：${bad.join("、")} —— 只能加只读/无害的工具（${SAFE_TOOLS.join("/")}）。` +
        `★ 要给它写/改的能力，那属于框架（spawn_seat 的只读约束不能绕）。`,
    );
  }

  // ② 必须有收回条件
  if (!input.until.trim()) {
    errs.push("until 必填：**什么时候收回** —— 没收回条件的能力会变成出厂配置");
  }

  // ③ 必须有依据
  if (input.evidence.trim().length < 8) errs.push("evidence 太短：为什么现在需要它");

  return errs;
}

export type GrantDeps = {
  members: () => string[];
  closing: () => boolean;
  /** ★ 真加（runner 提供：拿得到那个 agent 的 tools 面） */
  apply: (rec: GrantInput) => Promise<{ ok: boolean; note: string }>;
  ledger: string;
  log: (m: string) => void;
};

export function makeGrantTool(deps: GrantDeps) {
  return defineTool({
    name: "grant",
    label: "临时给某位成员加一把工具",
    // ★★★ 纪律㉘：说清它和 spawn_seat 是一对
    description: [
      "**临时**给某一位成员加几把工具（本轮有效，到期收回）。",
      "",
      "★★ 它和 `spawn_seat` 是一对：",
      "  · `spawn_seat`：有一件活**没人**干 ⇒ 长**一个人**",
      "  · `grant`：有人能干，但他**手上没工具** ⇒ 长**一份能力**",
      "",
      "★ 只能加只读/无害的工具：`read` / `grep` / `find` / `ls`。",
      "  ★★ 不能加 `write` / `edit` / `bash` —— 那会绕过「新席位只读」的框架约束。",
      "",
      "★ 必填：target · tools · until（★ 什么时候收回）· evidence（为什么现在需要）",
      "",
      "★★★ 为什么必须给 until：没有收回条件的能力 = 出厂配置 = 永久累积成没人记得为什么在那儿的工具表。",
    ].join(NL),
    parameters: Type.Object({
      target: Type.String({ description: "成员 key" }),
      tools: Type.Array(Type.String(), { description: `只读工具（${SAFE_TOOLS.join("/")}）` }),
      until: Type.String({ description: "★ 什么时候收回" }),
      evidence: Type.String({ description: "为什么现在需要" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (deps.closing()) {
        return {
          content: [{ type: "text" as const, text: "⛔ 已进收尾态，不再加能力。" }],
          details: { ok: false } as { ok: boolean },
          isError: true,
        };
      }

      const input = params as GrantInput;
      const errs = checkGrantInput(input, deps.members());
      if (errs.length) {
        return {
          content: [{ type: "text" as const, text: ["⛔ 这次 grant 不收：", ...errs.map((e) => `  · ${e}`)].join(NL) }],
          details: { ok: false, errors: errs } as { ok: boolean; errors?: string[] },
          isError: true,
        };
      }

      const r = await deps.apply(input);
      if (!r.ok) {
        return {
          content: [{ type: "text" as const, text: `⛔ 没加成：${r.note}` }],
          details: { ok: false } as { ok: boolean },
          isError: true,
        };
      }

      try {
        mkdirSync(dirname(deps.ledger), { recursive: true });
        appendFileSync(
          deps.ledger,
          JSON.stringify({ op: "grant", ...input, at: new Date().toISOString() }) + NL,
          "utf8",
        );
      } catch (e) {
        deps.log(`★ 已加，但记账失败：${(e as Error).message}`);
      }

      deps.log(`★★ 给「${input.target}」临时加了 ${input.tools.join("/")}（收回条件：${input.until}）`);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `✔ 「${input.target}」现在多了：${input.tools.join("、")}`,
              `★★ 到「${input.until}」就收回 —— 记得在够用之后让它别再依赖。`,
            ].join(NL),
          },
        ],
        details: { ok: true } as { ok: boolean },
      };
    },
  });
}
