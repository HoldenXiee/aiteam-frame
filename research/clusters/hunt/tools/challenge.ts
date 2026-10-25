// challenge —— ★ agent 触发：一个员工**挑战另一个员工的产物**
//
// ══════════════════════════════════════════════════════════════════
// ★★★ 设计者提示（2026-10-19）：「多员工是不是可以让他们探讨，
//     通过辩论把研究辩证清楚」
// ══════════════════════════════════════════════════════════════════
//
// ★ 我原来的做法（被推翻）：3 个员工 ∥ 并行干活，**不要求交流** ——
//   3 份产物并列躺在 outbox 里，**无人合并**。那是**回避设计**。
//
// ★★ 这个工具承载的机制：**挑战 → 回应 → 收敛**
//   ① 员工 A 交出产物
//   ② 员工 B（不同角度）**必须要么给反例，要么明确说"我同意"**   ← ★ 逼它表态
//   ③ A 拿到挑战 → 回应（接受→修订 / 反驳→给证据）
//   ④ 产出一份「辩证记录」（★ 独立产物，不是把三份合并）
//
// ★★★ 为什么"必须表态"（`P7`）：
//   若只问"你觉得有问题吗"，它多半会说"看起来没问题"（`B8`：把"做完了"当"做对了"）。
//   取交集治不了系统性错误 —— 所以要有**专门找反例**的一方，且**逼它表态**。
//
// ★★ 为什么"辩证记录"是独立产物而不是合并产物：
//   `P46/P47` 实测过「并集会被霰弹成员毒化」——
//   把三份堆起来会更差；而记录**辩论本身**才是多员工的真产出。

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function makeChallenge(deps: {
  /** ★ 把挑战投给指定员工的 id（由 runner 提供；找不到就报错，不静默） */
  deliver: (toKey: string, text: string) => { ok: boolean; reason?: string };
  /** ★ 本员工自己的 key（不许挑战自己） */
  selfKey: string;
  /** ★ 可挑战的同事（key → 一句话说明它的角度） */
  peers: () => { key: string; stance: string }[];
}) {
  return defineTool({
    name: "challenge",
    label: "Challenge",
    description:
      "挑战一位同事的产物 —— 这是这个集群的**辩证机制**。\n" +
      "★ 你要么给出**具体的反例/缺陷**（指到文件、指到数字），要么**明确说「我同意」**。\n" +
      "★ 模糊表态（「看起来还行」「可以考虑」）不算 —— 那既没推进也没纠正。\n" +
      "★ 你的挑战会作为消息送到那位同事那里，它必须回应（接受→修订 / 反驳→给证据）。",
    parameters: Type.Object({
      to: Type.String({ description: "挑战谁（同事的 key，见 peers 返回）" }),
      artifact: Type.String({ description: "挑战的是哪份产物（路径）" }),
      claim: Type.String({ description: "★ 你挑战的那条 claim（一句话，要能指回原文）" }),
      verdict: Type.Union(
        [
          Type.Literal("反例"),
          Type.Literal("缺陷"),
          Type.Literal("我同意"),
          // ★★★ 2026-10-21 新增两项：**猜想的免罚区**（DESIGN v2 §2 轮B）
          Type.Literal("猜想值得做"),
          Type.Literal("猜想的判死条件写错了"),
        ],
        {
          description:
            "你的结论：反例 / 缺陷 / 我同意 / 猜想值得做 / 猜想的判死条件写错了（★ 五选一，不许含糊）" +
            "★★ 对**已标「未验证」的猜想**：**不许**用『缺陷』。只能用后两项 —— " +
            "『猜想值得做』（并给一个**能判死它的实验**）或『猜想的判死条件写错了』。" +
            "★ 因为猜想天生没有证据；用『缺陷：没有读数』去判它，等于禁掉猜想本身。",
        },
      ),
      evidence: Type.String({
        description: "★ 证据：指到文件/数字/实验。若选「我同意」，写你**核对过什么**才同意的。",
      }),
    }),
    execute: async (_id, p) => {
      if (p.to === deps.selfKey) {
        return {
          content: [{ type: "text" as const, text: `★ 不能挑战自己（${deps.selfKey}）。可挑战：${deps.peers().map((x) => x.key).join("、")}` }],
          details: {},
        };
      }
      const text =
        `## ⚔️ 同事「${deps.selfKey}」挑战了你的产物\n\n` +
        `**产物**：${p.artifact}\n` +
        `**它挑战的 claim**：${p.claim}\n` +
        `**它的结论**：★ **${p.verdict}**\n` +
        `**它的证据**：${p.evidence}\n\n` +
        `---\n\n` +
        `★ 你必须**回应**，三选一并写清理由：\n` +
        `  · **接受** ⇒ 修订产物（写清新版本，注明取代了哪一条）\n` +
        `  · **反驳** ⇒ 给出你的证据（★ 不是"我觉得"，要指到文件/数字/实验）\n` +
        `  · **悬而未决** ⇒ 说清**缺什么证据**才能判（这也是有效结论）\n` +
        `★★ 不要因为对方是同事就附和 —— 若它的证据不足，直接说。`;
      const r = deps.deliver(p.to, text);
      return {
        content: [
          {
            type: "text" as const,
            text: r.ok
              ? `✔ 已送达「${p.to}」。★ 你的挑战（${p.verdict}）已进入辩证记录。`
              : `⚠ 没送到「${p.to}」：${r.reason ?? "未知原因"}`,
          },
        ],
        details: {},
      };
    },
  });
}
