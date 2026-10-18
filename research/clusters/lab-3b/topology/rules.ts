// ★★★ 拓扑：**情况 → 动作** 的规则表（代码触发的那一半）
//
// ★★★ 根本约束（设计者裁定）：
//   **运行时不能干涉。要干涉只能重设计集群。**
//   ✗ 不许有"我在外面盯状态 / 我判断 / 我起 agent"的循环
//   ✓ 触发必须是**集群自身结构的一部分** —— 挂在 agent 上的事件规则（见 runner.ts）
//
// ★★★ 为什么"审查/重审/换视角/判停"由**代码**触发（而不是让它自己叫）：
//   · 审查   —— 若它自己触发，**它可以不触发**（P13），甚至只在自己觉得没事时触发
//   · 重审目标 —— B6：它沉浸在局部，**看不见"该重审了"这件事**
//   · 换视角  —— P22：它默认顺着当前的路走，"该换个角度"不是它能自知的
//   · 判停   —— C7：疲劳与沉没成本在它身上，它判不了自己
//
// ★★ 共同点：**这四件事都需要"一个不被当前处境困住的视角"** —— 而"当前处境"正是 agent 本身。

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LAB } from "../paths.ts";
import type { ExpertName } from "../prompts/index.ts";

// ─────────────── 状态读取（★ 读磁盘，不读它的自述）───────────────

export function listOutbox(): string[] {
  const d = join(LAB, "outbox");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : [];
}

// ─────────────── 规则表 ───────────────

export type TriggerCtx = {
  /** 起一个专家、等它出结论、把结论落盘并回流 */
  fire: (role: ExpertName, why: string, focus?: string) => Promise<string>;
  state: State;
};

export type State = {
  /** 上一次审到第几份产物 */
  auditedOutputs: number;
  /** 连续几轮没有新东西 */
  roundsSinceNew: number;
  /** 各专家的上次触发时间（防刷屏） */
  firedAt: Partial<Record<ExpertName, number>>;
  /** 审查员给出的判停结论 */
  verdict?: "STOP" | "CONTINUE";
};

export function newState(): State {
  return { auditedOutputs: 0, roundsSinceNew: 0, firedAt: {} };
}

/** 平台期判定阈值（★ 我拍的，要实测调） */
const PLATEAU_ROUNDS = 3;
/** 同一专家的冷却时间（防刷屏） */
const COOLDOWN_MS = 20 * 60_000;

export function makeRules(ctx: TriggerCtx) {
  const { state, fire } = ctx;

  /** 情况 A：一轮结算了 —— 看有没有新产物 */
  async function onSettled(): Promise<void> {
    const outs = listOutbox();
    if (outs.length > state.auditedOutputs) {
      state.auditedOutputs = outs.length;
      const converged = outs.some((f) => /CONVERGED/i.test(f));
      const why = converged
        ? `研究员写了收敛声明（\`outbox/CONVERGED.md\`），且 outbox 现有 ${outs.length} 份成果。`
        : `研究员刚产出新东西（outbox 现有 ${outs.length} 份）。`;
      // ★ 收敛时额外要它判停（C7）
      const focus = converged ? (await import("../prompts/inspector.ts")).CONVERGED_FOCUS : "";
      const out = await fire("inspector", why, focus);
      const v = out.match(/VERDICT:\s*(STOP|CONTINUE)/i);
      if (v) state.verdict = v[1]!.toUpperCase() as "STOP" | "CONTINUE";
    }
  }

  /** 情况 B：它写了"能力缺口"类产物 → 起改库者（★ C1） */
  async function onCapabilityGap(): Promise<void> {
    const gaps = listOutbox().filter((f) => /缺口|提案|撞墙|做不到|capability/i.test(f));
    if (!gaps.length) return;
    if (Date.now() - (state.firedAt["libsmith"] ?? 0) < COOLDOWN_MS) return;
    state.firedAt["libsmith"] = Date.now();
    await fire(
      "libsmith",
      `研究员报告了底层能力缺口：${gaps.map((g) => `\`outbox/${g}\``).join("、")}`,
    );
  }

  /** 情况 C：连续多轮没有新东西 → 换视角 + 重审目标 */
  async function onPlateau(): Promise<void> {
    if (state.roundsSinceNew < PLATEAU_ROUNDS) return;
    if (Date.now() - (state.firedAt["inspirer"] ?? 0) < COOLDOWN_MS) return;
    state.firedAt["inspirer"] = Date.now();
    await fire(
      "inspirer",
      `研究员已经连续 ${state.roundsSinceNew} 轮没有产出新东西了。` +
        `★ 可能是它陷在某条路里 —— 请给它一个**别的学科**能借的框架。`,
    );
    await fire(
      "archivist",
      `研究员连续 ${state.roundsSinceNew} 轮没有新产出。★ 请做一次**阶段性复审**。`,
    );
    state.roundsSinceNew = 0;
  }

  return { onSettled, onCapabilityGap, onPlateau };
}
