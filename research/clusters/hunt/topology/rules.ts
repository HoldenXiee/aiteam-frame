// ★★★ 拓扑 v2 —— 按微实验的实测值改写（单因素，逐条有据）
//
// ══════════════════════════════════════════════════════════════
// v1 的病（微实验 A/B/C 实测，不是猜的）
// ══════════════════════════════════════════════════════════════
//
//   ★★★ **A · 触发粒度**（根因）
//     v1 只在 `agent_settled` 看。而研究员**一头扎进长实验**（实测：112 轮 0 次 settle）
//     ⇒ 规则**连被调用的机会都没有**。
//     微实验 A：同一个事件序列，只拨观察点密度 ⇒ **0 → 2 个专家**。
//     ★ 附带发现：主集群 600s 实跑里 `rule:` trace **一条都没有** —— 实证了这一点。
//
//   ★★ **B · 节流阈值**（A 的参数）
//     微实验 B（180 次工具调用、6 段长实验）：
//       阈值   规则调用  fire   隔多久一次   发现卡住
//         5     111      2      90 次        15 次
//        10      57      2      90 次        30 次
//        15      39      2      90 次        45 次   ← ★ 选它
//        30      21      2      90 次        90 次   ✗ 太晚
//       120       6      0      —           ★ 看不见
//     ⇒ **取 15**：`detectedAfter=45`（≤60 合格）且 `perFire=90`（≥30 合格）。
//     ★ 5/10 也合格，但**规则调用次数高一倍多**（111/57 vs 39）——
//       在真集群里每次调用都要读盘、可能 fire，所以**在合格区内取最省的**。
//
//   ★★ **C · 观察窗口**（误报源）
//     v1 只看 `outbox`。而研究员**大部分时间在 `work/` 里干活**
//     ⇒ 「在努力干活」与「真卡住」在 v1 眼里**长得一样**（都是 outbox 不动）。
//     微实验 C：
//       outbox-only：1/2 判对（★ 把"在干活"误判成"卡住" → 起了 inspirer+archivist）
//       work-too   ：2/2 判对
//     ⇒ **把 `work/` 也算活动**。
//
// ══════════════════════════════════════════════════════════════
// ★★ 这三条都是**单因素**拨动，各自有独立的微实验证据（不是一次改三个然后说不清）。
// ★★★ 而且它们**不是干涉**：规则仍挂在集群自己的事件上，只是（A）看的时间点更密、
//     （C）看的窗口更全、（B）密度取实测值。**没有"我在外面盯"的循环。**
// ══════════════════════════════════════════════════════════════

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LAB } from "../paths.ts";
import { convergedMtime, countFreshFiles, hasProgress, workLatestMtime } from "./progress.ts";
import type { ExpertName } from "../prompts/index.ts";

// ─────────────── 参数（★ 全部来自微实验实测，不是拍的）───────────────

/** ★ 微实验 B：每 15 次工具调用看一次（合格区内最省的） */
export const THROTTLE_N = 15;
/**
 * ★★★ 微实验 E（长跑实测发现）：**时间那一路的节流**。
 *
 * ★ 为什么必需 —— 「工具调用次数」是**错的单位**：
 *   实测它跑实验的方式是 `bash` 里执行 `npx tsx exp-cross.ts`，
 *   **一次调用内部跑 20+ 轮，平均每轮 273 秒、最长 602 秒**（`work/runs/orch.jsonl` 的 secs）。
 *   ⇒ **一次工具调用可以是 1~3 小时**。
 *   ⇒ 实测：长跑 25 分钟，`rule:tick` 只跑了 **1 次**，而 `work/` 里改了 **1589 个文件**。
 *   ★★ 所以"每 15 次工具调用"在实验形态下 **= 几小时** ⇒ 规则**仍然被饿死**。
 *
 * ★★★ 教训：**节流必须用"会流走的东西"做单位**。
 *   工具调用次数**不会因为等待而增加**；**时间会流走**。
 *   （同族：`P11`「用什么当判据，就等于让它服从什么」）
 */
export const THROTTLE_MS = 5 * 60_000;
/** 平台期阈值：连续几"看"没有进展。★ 取值理由：一审一换视角的节奏 */
export const PLATEAU_ROUNDS = 3;
/**
 * ★★★ v3（2026-10-19）：一个 tick 周期内 `work/` 里**新出多少文件**才算"在干活"。
 *
 * ★ 为什么要有这个数（两次被推翻的教训，见 `topology/progress.ts` 的头注释）：
 *   · 光看"有没有动" ⇒ 跑同一条线的第 20 轮永远判为健康（v1 的病）
 *   · 光看"outbox 份数" ⇒ **跑实验的 15 分钟被判为卡住**（v2 的病，研究员自己抓到的）
 * ★★ 用**体量**区分：跑实验会产出**大批量**文件（corpus/runs/每轮产物）；
 *   原地打转（反复改同一个脚本）只产出**零星几个**。
 *
 * ★ 取值依据：它一轮实验落盘 `corpus/` 就有几十上百个文件；
 *   而"改脚本"一轮通常 <5 个。⇒ 取 **10** 作为分界（留足余量）。
 * ★★ 这个数**要在长跑里回看 `rule:tick` 的 fresh 分布再调**。
 */
export const FRESH_FILES_THRESHOLD = 10;
/** 同一专家的冷却时间（防刷屏） */
export const COOLDOWN_MS = 20 * 60_000;

// ─────────────── 状态读取（★ 读磁盘，不读它的自述）───────────────

export function listOutbox(): string[] {
  const d = join(LAB, "outbox");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : [];
}

/**
 * ★★ 微实验 C 的落地：`work/` 里最近有没有动过。
 *
 * ★ 为什么要它：研究员**大部分时间在 work/ 里干活**，
 *   只看 outbox 会把"在努力干活"误判成"卡住了"（微实验 C：误报 1/2）。
 */
/**
 * ★★★ 集群自己写的文件 —— 它们**不算研究员的活”。
 *
 * ★ 为什么必须排除（2026-10-18 实测到的**观察者效应**）：
 *   规则每跑一次就写 `work/_topology.log`。而 `workLatestMtime()` 又去看 `work/`。
 *   ⇒ **规则写日志 → work/ mtime 变新 → 下一轮判为"有活动"** —— 自触发死循环。
 *   真实运行日志的原话：`rule:tick ... 活动=true roundsSinceNew=0`（**永远**为 0）
 *   ⇒ `onPlateau` 永远不触发，**微实验 C 的修复被这个效应抵消掉了**。
 *
 * ★★ 教训（值得单独记一条）：**量具自己会污染测量** ——
 *   这条路本项目走过多次（`O8` 的成本观测、`P11` 的账本挂错位置）。
 *   凡是"读磁盘判活动"的地方，都必须先问：**这个磁盘上有没有我自己写的东西？**
 */
// ─────────────── 规则表 ───────────────

export type TriggerCtx = {
  fire: (role: ExpertName, why: string, focus?: string) => Promise<string>;
  state: State;
  /**
   * ★★★ 规则级日志 —— 填的是归因分析里那个**测不了**的洞：
   *   原来 `_topology.log` 只在 `fire` 里写 ⇒ **分不清「规则没跑」与「跑了但没触发」**。
   *   ★ 有了它，微实验 A 的结论才在真集群里得到实证（600s 实跑：一条都没有）。
   */
  trace: (rule: string, detail: string) => void;
  /**
   * ★★★ 辩证（2026-10-19）：把“去挑战同事产物”的**处境**送到某位员工面前。
   *
   * ★ 为什么不是给它一个工具（实测教训）：
   *   第一版给了 `challenge` 工具 —— **一次都没用过**（`P13`：“允许它做 X” 它不做）。
   *   ⇒ 辩论不能是**能力**，必须是**处境**（由代码主动送到它面前）。
   *
   * ★ 未接（单员工跑）时为 `undefined` ⇒ `onNewFinding` 直接不触发。
   */
  challenge?: (toKey: string, text: string) => void;
  /** ★ 当前活着的员工 key（用于“新产物该交给谁挑战”） */
  peerKeys?: () => string[];
  /**
   * ★★★ 收尾态（2026-10-19）：窗口到点后为 `true`。
   *
   * ★ 为什么必需（实测）：多员工时“窗口到点 → 等收尾”会**自激** ——
   *   员工还在产出 ⇒ 新产物触发 `onSettled` ⇒ fire 专家（要跑 6 分钟）
   *   ⇒ 期间又有新产物 ⇒ 又触发 ⇒ **永不收敛**（实测超窗口 44 分钟仍在跑）。
   * ★ `N=1` 时不存在这个问题（一个员工收尾就是收尾）。
   * ★★ 这不是“运行时干涉” —— 它是**集群的收尾形态**（配置的一部分）。
   */
  closing?: () => boolean;
};

export type State = {
  auditedOutputs: number;
  /**
   * ★★★ 连续几次检查**没有进展**（2026-10-19 微实验 G 换过定义）。
   * ★ 进展 = 交了新成果 **或** 更新了 `CONVERGED.md` —— ★ 不是"有没有动作"。
   */
  roundsSinceProgress: number;
  /** ★ 上次看到的 `CONVERGED.md` mtime（进展信号②的基准） */
  lastConvergedMtime: number;
  /** ★★★ 上一次 tick 的时刻 —— v3 判据用它算"这段时间新出了多少文件" */
  lastTickAt: number;
  firedAt: Partial<Record<ExpertName, number>>;
  verdict?: "STOP" | "CONTINUE";
  /**
   * ★★ 微实验 C：上一次「看见活动」的时刻。
   * ★ 活动的定义 = **outbox 有新产物** 或 **work/ 有改动**。
   */
  lastActiveAt: number;
  /**
   * ★★★ v2 修正（微实验 D 实测）：`work/` 里**最大的 mtime**。
   *
   * ★ 为什么不能用 `Date.now()` 当基准（这是 D 实验查出的真 bug）：
   *   实测 `statSync(f).mtimeMs - Date.now()` 会在 **-17ms ~ +4ms** 之间跳 ——
   *   **文件系统时间戳可以走在挂钟前面**。
   *   ⇒ 拿 `mtime > Date.now()` 判"刚动过"，会把**早就存在的文件**也判成新活动。
   *
   * ★★ 正确做法：**自己跟自己比** —— 只用"这次读到的最大 mtime > 上次读到的最大 mtime"
   *   作为"动过"的判据。两个值同源（都是 mtime），不跨时钟域。
   */
  lastWorkMtime: number;
  /**
   * ★★★ tick 专用的"上次看到的 outbox 份数" —— **与 `auditedOutputs` 分开**。
   *
   * ★ 为什么不能共用一个（2026-10-19 长跑实测抓到）：
   *   `tick()` 先把它推成最新值，而 `onSettled` 的判据正是
   *   `outs.length > state.auditedOutputs` ⇒ **永远是 false** ⇒ **审查从不触发**。
   *   实测：outbox 16→19，fire 一次都没有。
   * ★★ 两个判据必须各有各的变量：
   *   · `seenOutboxCount` —— tick 用（有活动吗）
   *   · `auditedOutputs`  —— onSettled 用（该审查吗）
   */
  seenOutboxCount: number;
  /**
   * ★★★ 辩证专用：已经被“交给同事挑战过”的产物文件名。
   *
   * ★ 与 `auditedOutputs`（审查）、`seenOutboxCount`（活动）**又是三个不同的账** ——
   *   这是本项目反复踩过的坑（一个状态两个写者 ⇒ 判据恒 false）。
   *   ★ 三条规则三个账：审的、看的、辩的。
   */
  challengedOutputs: string[];
};

export function newState(): State {
  // ★ 初始化时先把当前的 work/ mtime 记下来 —— 否则第一轮会把"开工前就有的文件"判成活动。
  return {
    auditedOutputs: 0,
    seenOutboxCount: 0,
    roundsSinceProgress: 0,
    firedAt: {},
    lastActiveAt: Date.now(),
    lastWorkMtime: 0,
    lastConvergedMtime: convergedMtime(),
    challengedOutputs: [],
    lastTickAt: Date.now(),
  };
}

/**
 * ★ 结算点 —— v1 的 `agent_settled` 回调体**原样搬到这里**，让两个观察点共用一个动作序列。
 *
 * ★★★ 为什么必须共用（`P11`：判据与指令必须同源）：
 *   v1 是把这段逻辑**内联在 runner 的事件回调里**的。加了第二个观察点之后，
 *   如果两处各写一遍，就会出现"settle 走一套、工具调用走另一套"的静默分叉。
 */
export async function tick(
  ctx: TriggerCtx & {
    rules: {
      onSettled: () => Promise<void>;
      onCapabilityGap: () => Promise<void>;
      onPlateau: () => Promise<void>;
      onNewFinding: () => Promise<void>;
    };
  },
): Promise<void> {
  const { state, rules, trace } = ctx;
  const n = listOutbox().length;

  // ★ 微实验 C：活动 = outbox 变了 **或** work/ 动了
  // ★★★ 微实验 D：work/ 的"动了"必须是 **mtime 自己跟自己比**（见 State.lastWorkMtime 的注释）
  const workAt = workLatestMtime();
  const outboxChanged = n > state.seenOutboxCount;
  const workChanged = workAt > state.lastWorkMtime && state.lastWorkMtime !== 0;

  // ★★★★ 这里曾经有一个**双重记账** bug（2026-10-19 长跑实测抓到）：
  //   tick() 先 `state.auditedOutputs = n`，再调 `onSettled()` ——
  //   而 `onSettled` 自己的判据正是 `outs.length > state.auditedOutputs`
  //   ⇒ **永远是 false** ⇒ **审查从不触发**。
  //   实测：outbox 从 16 跳到 19，tick 把 auditedOutputs 推成 19，**fire 一次都没有**。
  //
  // ★★ 根因：**同一个状态（auditedOutputs）被两处写** ——
  //   一处用来判"有没有活动"（tick），一处用来判"要不要审查"（onSettled）。
  //   两处共用一个变量，先跑的就把后跑的判据废了。
  //
  // ★★★ 修法：**tick 不再碰 `auditedOutputs`** —— 它只负责"活动/平台期"，
  //   审查的书由 `onSettled` 自己记（单一写者）。
  //   两个判据分开：
  //     · `activityAt` —— tick 用（是不是有活动）
  //     · `auditedOutputs` —— onSettled 用（有没有审过）
  //   （同族：`P11`「用什么当判据，就等于让它服从什么」；
  //     以及本项目反复吃过的「一个状态两个写者」）
  if (workAt > state.lastWorkMtime) state.lastWorkMtime = workAt;
  // ★ 活动账用 seenOutboxCount，**不碰 `auditedOutputs`**（那是 onSettled 的）
  if (outboxChanged) state.seenOutboxCount = n;
  // ★ 活动账（供 trace 看"它到底在不在动"）—— ★ 判据已换到 roundsSinceProgress
  if (outboxChanged || workChanged) {
    state.lastActiveAt = Date.now();
  }

  trace("tick", `outbox=${n} audited=${state.auditedOutputs} 活动=${outboxChanged || workChanged} roundsSinceProgress=${state.roundsSinceProgress}`);
  // ★ 顺序重要：onSettled 先跑（它自己记 auditedOutputs），其余两个不许碰它
  await rules.onSettled();
  // ★★★ 辩证（2026-10-19）：新产物落盘 → **结构性地**要求同事去挑战
  //   ★ 为什么放在这里（`onSettled` 之后、`onPlateau` 之前）：
  //     · 先审（`onSettled`）—— 审查是底线
  //     · 再辩 —— 辩论是**多员工才有的**机制
  //     · 最后看平台期
  //   ★★ 为什么必须有这条规则（实测教训）：
  //     给 `challenge` **工具** = 「允许它辩」⇒ **一次都没用过**（P13）。
  //     ⇒ 辩论不能是能力，必须是**处境**（由代码送到它面前）。
  await rules.onNewFinding();
  await rules.onCapabilityGap();
  await rules.onPlateau();
}

export function makeRules(ctx: TriggerCtx) {
  const { state, fire } = ctx;

  /** 情况 A：有新产物 → 审查（★ 收敛时就顺便要它判停，C7） */
  async function onSettled(): Promise<void> {
    // ★ 收尾态：不再 fire 新专家（已 fire 的会跑完）
    if (ctx.closing?.()) return;
    const outs = listOutbox();
    ctx.trace("onSettled", `outbox=${outs.length} auditedOutputs=${state.auditedOutputs}`);
    if (outs.length > state.auditedOutputs) {
      state.auditedOutputs = outs.length;
      const converged = outs.some((f) => /CONVERGED/i.test(f));
      const why = converged
        ? `研究员写了收敛声明（\`outbox/CONVERGED.md\`），且 outbox 现有 ${outs.length} 份成果。`
        : `研究员刚产出新东西（outbox 现有 ${outs.length} 份）。`;
      const focus = converged ? (await import("../prompts/inspector.ts")).CONVERGED_FOCUS : "";
      const out = await fire("inspector", why, focus);
      const v = out.match(/VERDICT:\s*(STOP|CONTINUE)/i);
      if (v) state.verdict = v[1]!.toUpperCase() as "STOP" | "CONTINUE";
    }
  }

  /** 情况 B：它写了"能力缺口"类产物 → 起改库者（★ C1） */
  async function onCapabilityGap(): Promise<void> {
    const gaps = listOutbox().filter((f) => /缺口|提案|撞墙|做不到|capability/i.test(f));
    const since = Date.now() - (state.firedAt["libsmith"] ?? 0);
    ctx.trace("onCapabilityGap", `gaps=${gaps.length} sinceLastMs=${state.firedAt["libsmith"] ? since : "never"}`);
    if (!gaps.length) return;
    if (Date.now() - (state.firedAt["libsmith"] ?? 0) < COOLDOWN_MS) return;
    state.firedAt["libsmith"] = Date.now();
    await fire("libsmith", `研究员报告了底层能力缺口：${gaps.map((g) => `\`outbox/${g}\``).join("、")}`);
  }

  /**
   * 情况 C：连续多次"看"都没有活动 → 换视角 + 重审目标。
   *
   * ★★ 注意这里的判据现在是 `roundsSinceNew` —— 而它由 `tick()` 用
   *   **"outbox 或 work/ 有没有动"** 计算（微实验 C 的落地）。
   *   ⇒ 「在干活」不会累加，「真卡住」才会。
   */
  /**
   * 情况 C：连续多次检查没有**进展** → 换视角 + 重审目标。
   *
   * ══════════════════════════════════════════════════════════════
   * ★★★ 判据换过（2026-10-19 长跑实测，微实验 G）
   * ══════════════════════════════════════════════════════════════
   *
   * ★ 旧定义："有没有动作"（outbox 或 work/ 动没动）
   *   实测：`roundsSinceNew` 到过 2 **但从未到 3** ⇒ `inspirer` 从未触发。
   *   ★★ 不是判据坏了（微实验验证过），是**它太勤快** ——
   *     `work/` 里几乎一直在动（跑实验、写分析脚本）
   *     ⇒ "连续 15 分钟什么都没动"**几乎不可能发生**。
   *
   * ★★★ 更根本的问题："有没有动作"**漏了一整类真实的卡住** ——
   *   · 在跑同一个实验的第 20 轮（原地打转）⇒ `work/` 在动 ⇒ **判为健康**（错）
   *   · 在反复改分析脚本（没结论）      ⇒ `work/` 在动 ⇒ **判为健康**（错）
   *   ★ 证据：它一晚跑了同一条线的 **8 个实验**（cross-pilot/2/3/hard/k/grep/off-small/off-kdose）
   *     —— 这在旧定义下**永远不是卡住**。
   *
   * ★★ ⇒ 新定义：**"有没有进展"**（不是"有没有动作"）。
   *   进展 = · 交了新成果（`outbox` 变多） **或** · 更新了 `CONVERGED.md`
   *   ★ 两者都是**它自己写的、语义明确的"我推进了"信号**（不是我们替它判）。
   */
  async function onPlateau(): Promise<void> {
    // ★ 收尾态：不再 fire inspirer/archivist（它们是长跑专家，会让收尾永不结束）
    if (ctx.closing?.()) return;
    // ══════════════════════════════════════════════════════════════
    // ★★★ v3 判据（第三次定义，前两次都被实测推翻，详见 topology/progress.ts）
    //
    //   ★ 两个信号都要看，各治一半的病：
    //     ① **产出**：outbox 变多 或 CONVERGED 更新
    //        ⇒ 治 v1 的病（跑同一条线第 20 轮 = "健康的动"）
    //     ② **体量**：`work/` 里这段时间新出的**文件数**
    //        ⇒ 治 v2 的病（跑实验时被判"卡住"，★ 这是研究员自己抓到的）
    //
    //   ★★ 为什么用"体量"而不是"有没有动"：
    //     跑实验 → 大批量文件（corpus/runs/每轮产物，几十上百个）
    //     原地打转 → 零星几个（反复改同一个脚本）
    // ══════════════════════════════════════════════════════════════
    const outs = listOutbox().length;
    const convM = convergedMtime();
    const since = state.lastTickAt;
    const { ok: busy, fresh } = hasProgress(since, FRESH_FILES_THRESHOLD);

    const produced = outs > state.seenOutboxCount || convM > state.lastConvergedMtime;
    const progressed = produced || busy;

    if (produced) {
      if (outs > state.seenOutboxCount) state.seenOutboxCount = outs;
      if (convM > state.lastConvergedMtime) state.lastConvergedMtime = convM;
    }
    state.lastTickAt = Date.now();

    if (progressed) state.roundsSinceProgress = 0;
    else state.roundsSinceProgress++;

    const mins = Math.round((state.roundsSinceProgress * THROTTLE_MS) / 60_000);
    ctx.trace(
      "onPlateau",
      `outbox=${outs} 新文件=${fresh} 产出=${produced} 在干活=${busy} ` +
        `roundsSinceProgress=${state.roundsSinceProgress}/${PLATEAU_ROUNDS} 约${mins}分钟`,
    );

    if (state.roundsSinceProgress < PLATEAU_ROUNDS) return;
    if (Date.now() - (state.firedAt["inspirer"] ?? 0) < COOLDOWN_MS) return;
    state.firedAt["inspirer"] = Date.now();

    // ★★★ 触发理由里**给出可核对的数**（P12：拦的同时给路）——
    //   它看得见"这段时间只出了 N 个文件、也没交新成果"，能自己判断该不该换路。
    await fire(
      "inspirer",
      `研究员已经约 ${mins} 分钟**既没交新成果、也没在批量干活**` +
        `（这段窗口内 \`work/\` 里新出 ${fresh} 个文件，阈值 ${FRESH_FILES_THRESHOLD}）。` +
        `★ 注意：这不等于"它懒"—— 更可能是**在原地打转**（反复改同一个脚本、同一条线的第 N 个实验）。` +
        `★ 请给它一个**别的学科**能借的框架。`,
    );
    await fire(
      "archivist",
      `研究员已经约 ${mins} 分钟没有实质推进（新文件 ${fresh} 个 / 无新成果）。` +
        `★ 请做一次**阶段性复审**：看它是不是在同一条线上重复。`,
    );
    state.roundsSinceProgress = 0;
  }

  // ══════════════════════════════════════════════════════════════
  // ★★★ 情况 D：辩证 —— 有新产物 ⇒ **结构性地**要同事去挑战它
  //
  //   ★★★ 为什么必须有这条（实测教训，2026-10-19）：
  //     第一版只给了 `challenge` **工具**，结果 **一次都没用过**。
  //     ⇒ **「允许它辩」＝它不辩**（`P13` 第 N 次）。
  //   ★ 所以辩论不能是**能力**（工具），必须是**处境**（由代码送到它面前）。
  //     —— 这与本集群其它触发同构：不是“让模型自己决定要不要分工”（`P3`）。
  //
  //   ★★ 与 `onSettled` 的分工：
  //     · `onSettled`    → 叫**外部专家**（inspector）审
  //     · `onNewFinding` → 叫**内部同事**（另两个角度的研究员）辩
  //     两者**不能互相替代**：专家上下文干净（看不到推导），同事**全程在场**（能追到细节）。
  //
  //   ★ 单员工时 `ctx.challenge` 未接 ⇒ 直接不触发（与旧行为完全一致）。
  // ══════════════════════════════════════════════════════════════
  async function onNewFinding(): Promise<void> {
    if (!ctx.challenge || !ctx.peerKeys) return;
    // ★ 收尾态：不再送新挑战
    if (ctx.closing?.()) return;
    const outs = listOutbox();
    const fresh = outs.filter((f) => !state.challengedOutputs.includes(f));
    if (fresh.length === 0) return;
    // ★ 一次最多送一份 —— 否则一批十几份产物会同时向同事发问，把它们的上下文淹了
    const target = fresh[0]!;
    state.challengedOutputs.push(target);
    const peers = ctx.peerKeys();
    const n = Math.min(peers.length, 2);
    ctx.trace(
      "onNewFinding",
      `新产物=${target} · 要 ${n} 位同事去挑战（已辩 ${state.challengedOutputs.length}/${outs.length}）`,
    );
    const text =
      `## ⚔️ 辩证：有一份新同事产物需要你挑战\n\n` +
      `**产物**：\`outbox/${target}\`\n\n` +
      `---\n\n` +
      `★ 读完它，然后**必须表一个态**：\n` +
      `  · **给出反例**（指到文件/数字/实验）\n` +
      `  · **指出缺陷**（装置、判据、归因哪一处错）\n` +
      `  · **我同意**（★ 并写清你**核对过什么**才同意的）\n\n` +
      `★★ 不要写“看起来还行” —— 那既没推进也没纠正。\n` +
      `★ 用你的角度去看：**别人会信什么，你就去找什么的反面**。\n` +
      `★ 若它站得住，说出来也是贡献 —— 那意味着三个人从三个方向都没找到问题。`;
    for (const k of peers.slice(0, n)) ctx.challenge(k, text);
  }

  return { onSettled, onCapabilityGap, onPlateau, onNewFinding };
}
