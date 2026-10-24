// spawn_seat —— ★★★ agent 触发：长出一个**常驻席位**（本轮有效）
//
// ══════════════════════════════════════════════════════════════════════════
// 设计者 2026-10-20（逐字）：
//   「框架不能变（规则就属于框架的一部分），变的只能是**在框架里面长东西**，
//     比如启动 agent 等等（生长出符合框架的、**看似复杂但逻辑清晰的拓扑结构**）」
//   「长出来的席位**只在内存里，本轮有效**」
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 它和 `spawn_line` 的区别（★ 别混淆，两者不是同一件事）
//
//   spawn_line（已有）               spawn_seat（本文件）
//   ─────────────────────           ──────────────────────────────
//   一次性的子研究员                  **常驻**，本轮一直活着
//   await 完就 dispose               不收工，等别人找它
//   产物：返回一段结论               产物：它在 outbox/ 里写自己的东西
//   拓扑：不变                       拓扑：★ **多了一个节点**
//
//   ★ 所以「长出拓扑」这件事，只有 spawn_seat 能做到。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么必须「只在内存里」（这是设计者裁定的，不是我图省事）
//
//   若写盘（`topology/seats.json`）并下轮读回 —— 盘上的结构会变成
//   **事实上的框架**，只是没写在代码里。那正是「框架渐变」，比写死更难管。
//
//   ★ 本轮有效 ⇒ 每轮从**同一个固定框架**出发 ⇒ 不同轮的拓扑可以比较
//     ⇒ 「它长出了什么」这件事本身成为**可观测的现象**（而不是累积的既成事实）。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 框架在这里的体现（★ 这三条是硬的，工具不给商量余地）
//
//   ① 新席位**只能只读**（`READONLY_TOOLS`）—— 它不能写代码、不能改库
//      ⇒ 长出来的东西**不能反过来改变框架**
//   ② 新席位**不能自己再长**（它的工具表里没有 spawn_seat）
//      ⇒ 防止递归长出一棵树，把成本烧光
//   ③ 团队名**必须是现有的**（theory / practice / landing）
//      ⇒ 它长的是**这个团队里的一个座位**，不是新开一个团队
// ══════════════════════════════════════════════════════════════════════════

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Agent } from "../../../../src/index.ts";
import { attachGate } from "../guard.ts";
import { MODEL, READONLY_TOOLS } from "../paths.ts";

/** ★ 一个"被长出来的"座位 */
export type GrownSeat = {
  /** `theory/units` 这种 key（★ 团队名/职责名） */
  key: string;
  team: string;
  /** 它自己说的职责（★ 会进它的 role，也会进日志） */
  duty: string;
  /** ★ 为什么需要它 —— 这是判"该不该长"的唯一依据 */
  why: string;
  agent: Agent;
  at: number;
};

export type SpawnSeatDeps = {
  /** ★ 现有的团队名（★ 只能用其中的 —— 不许新开团队） */
  teams: () => string[];
  /** ★ 现有的席位 key（★ 用来查重名） */
  takenKeys: () => string[];
  /** ★ 真正建 agent 并接入路由（由 runner 提供 —— 它知道 researcherByKey / deliveries 等） */
  create: (seat: { key: string; team: string; duty: string; why: string }) => Promise<Agent>;
  /** ★ 长成之后回调（runner 用来记日志 / 记账 / 挂路由） */
  onGrown: (seat: GrownSeat) => void;
  /** ★ 收尾态不允许再长（与其它规则同一条纪律） */
  closing: () => boolean;
  /** ★ 本轮上限（默认 4）*/
  maxSeats?: number;
};

/**
 * ★★★ 本轮的"生长账" —— **只在内存里**（设计者裁定）。
 *
 * ★ 为什么由这个模块自己管而不是放 runner 的状态里：
 *   它是**这个工具自己的状态**。放进 `State` 会诱使别人去读它，
 *   而"本轮有效"这个约束正是靠"它不在任何持久化路径上"来保证的。
 */
export function makeSpawnSeat(deps: SpawnSeatDeps) {
  const grown: GrownSeat[] = [];
  const max = deps.maxSeats ?? 4;

  return defineTool({
    name: "spawn_seat",
    label: "SpawnSeat",
    description:
      "在这个集群里**长出一个常驻座位**（本轮有效）。" +
      "★ 适合：你发现某件活**没人负责**、且它会反复出现 —— 那就该有个专门的座位。" +
      "★★ 不适合：一次性的问题（用 `spawn_line`）、或你本来就该自己干的活。" +
      "★ 新座位**只读**（不能写文件、不能改库），也**不能再长座位**。" +
      `★ 本轮最多长 ${max} 个。`,
    parameters: Type.Object({
      team: Type.String({ description: "哪个团队下的座位（必须是现有的团队名）" }),
      duty: Type.String({
        description: "它的职责（★ 一句话，说清**它专门看什么** —— 会写进它的角色定义）",
      }),
      why: Type.String({
        description:
          "★★ 为什么需要它（必须回答：现在**没人**在做这件事，而且它**会反复出现**）",
      }),
    }),
    execute: async (_id, p) => {
      // ★ 框架约束①：收尾态不许长
      if (deps.closing()) {
        return {
          content: [{ type: "text" as const, text: "⛔ 已进入收尾态，不再长新座位。" }],
          details: { ok: false } as { ok: boolean; key?: string },
        };
      }

      // ★ 框架约束②：团队名必须是现有的
      const teams = deps.teams();
      if (!teams.includes(p.team)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `⛔ 没有这个团队：\`${p.team}\`。现有：${teams.join("、")}。\n` +
                `★ 你长的是**这个团队里的一个座位**，不是新开团队。`,
            },
          ],
          details: { ok: false } as { ok: boolean; key?: string },
        };
      }

      // ★ 框架约束③：查重（★ 已经在做的活不该再长一个座位）
      const key = `${p.team}/${p.duty.trim().split(/[\s，,。]/)[0]!.slice(0, 12)}`;
      if (deps.takenKeys().includes(key) || grown.some((g) => g.key === key)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `⛔ 已经有 \`${key}\` 这个座位了。★ 有话直接送去，别重复长。`,
            },
          ],
          details: { ok: false } as { ok: boolean; key?: string },
        };
      }

      // ★ 框架约束④：上限
      if (grown.length >= max) {
        return {
          content: [
            {
              type: "text" as const,
              text: `⛔ 本轮已经长了 ${grown.length} 个座位（上限 ${max}）。\n` +
                `★ 座位多了就变成"大家都在说、没人真的看" —— 先看看现有这些在干嘛。`,
            },
          ],
          details: { ok: false } as { ok: boolean; key?: string },
        };
      }

      const agent = await deps.create({ key, team: p.team, duty: p.duty, why: p.why });
      const seat: GrownSeat = { key, team: p.team, duty: p.duty, why: p.why, agent, at: Date.now() };
      grown.push(seat);
      deps.onGrown(seat);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `✔ 长出了座位 \`${key}\`（本轮有效）。\n` +
              `★ 它是**只读**的，会一直在。你可以用 \`challenge\` 找它。\n` +
              `★★ 它**不能写文件** —— 它的结论要靠你或同事落到 outbox（这是刻意的：\n` +
              `   长得越多，越需要有人负责收束）。`,
          },
        ],
        details: { ok: true, key } as { ok: boolean; key?: string },
      };
    },
  });
}

/** ★ 给 runner 用：长出座位时的角色定义（★ 形状与其它席位一致，只是职责是它自己说的） */
export function grownSeatRole(seat: { key: string; team: string; duty: string; why: string }): string {
  return (
    `你是研究集群里 \`${seat.team}\` 团队下的座位 \`${seat.key}\`。\n\n` +
    `## 你为什么存在\n` +
    `★ 这个座位不是一开始就有的 —— **是你的同事发现有一件活没人负责，才把你长出来的**。\n` +
    `他给的理由：${seat.why}\n\n` +
    `## 你专门看什么\n` +
    `${seat.duty}\n\n` +
    `## 你的处境（★ 别越界）\n` +
    `· 你**只读** —— 能看 \`outbox/\`、\`work/\`、源码，但**写不了任何文件**。\n` +
    `  ★ 这是刻意的：座位只负责**看住一件事**，写由原来的研究员负责。\n` +
    `· 你**不能再长座位** —— 长出你的那位负责收束。\n` +
    `· 你看的是**同一批产物**，但要盯住你那一条（别人很可能不盯）。\n\n` +
    `## 你要做什么\n` +
    `· 发现**你这条上的问题**时，用 \`challenge\` 直接找作者说，指到文件/数字。\n` +
    `· 没有问题时**明说"这条我看过了，没问题"** —— ★ 沉默和"没看"分不开。\n`
  );
}

/** ★ 默认工具表（★ 只读 —— 框架约束①） */
export const GROWN_SEAT_TOOLS: readonly string[] = READONLY_TOOLS;

export const GROWN_SEAT_MODEL = MODEL;
export { attachGate };
