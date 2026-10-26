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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/**
 * ★★★★★ 多久回头审视一次**自己的手段**（2026-10-21）
 *
 * ★ 为什么是 90 分钟：一轮 hunt 窗口通常 60~120 分钟 ⇒ 一轮里最多问一次。
 * ★★ 太短会把成本翻倍（这是个长跑专家）；太长就等于没有。
 */
export const REVIEW_EVERY_MS = 90 * 60_000;

/**
 * ★★★★★ 「提炼」的节拍：每新增这么多份研究结论，就必须问一次「它该变成什么」。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这条规则要治的病（实测，2026-10-21）
 *
 *   hunt 有 **58 份 P\*（研究结论）**，其中**真正像"创新"的至少 5 份**：
 *
 *     `P70` 同一条错规则：执行时 **0/24 反对**，被要求「审这条规则」时 **12/12 逮住**
 *     `P63` 池子自己长出的技能：**白名单挡得住广告，挡不住读取**
 *     `P72` 共享材料池：**广告面建 agent 时冻结，能力面当场 live**
 *     `P69` 错了但明确的核验规则**会被忠实执行** —— 勤奋不保护
 *     `P98` 先果后因 pilot：**goal-only 与给规则等价**
 *
 *   ★★★ 而 `58 份里只有 5 份（8%）`提到过「别人能不能用」。
 *
 * ★★★★ 这就是它造不出 MCP / skill 那一级创新的原因 —— 不是没有原料，
 *   是**缺"把观察变成接口"这一步**。MCP 与 skill 都不是发现，
 *   是**把"每个 agent 都在手工重做的同一件事"提成了**一个面**。
 *
 *   步是**我**替它走的（`enforce`/`correct`/`grant`/`write_skill` 都是我看着
 *   它的产物造的）。⇒ 流水线断在中间：**它观察 → 我抽象 → 我发**。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ★ 为什么用**节拍**而不是"检测哪份像创新"：
 *   判"像不像创新"是**内容判断**（硬规则①，我不能碰）。
 *   而「攒了 N 份新结论就该回头提炼一次」是**纯节拍**，不需要懂内容。
 */
export const GENERALIZE_EVERY = 3;

/** ★ 测试/短跑用：`GENERALIZE_EVERY_N=1` 把节拍压到每份（★ 不改判据本身） */
const GEN_EVERY =
  Number(process.env.GENERALIZE_EVERY_N) > 0 ? Number(process.env.GENERALIZE_EVERY_N) : GENERALIZE_EVERY;

/**
 * ★★★★★ 该不该提炼（纯函数，可离线重判 —— 纪律⑦）
 *
 * 判据：**自上次提炼以来新增的研究结论数 ≥ 节拍**
 *
 * @param products   outbox 文件名
 * @param sinceCount 上次提炼时 P* 的份数（0 = 从没提炼过）
 * @returns 该提炼吗 + 新增几份（★ 报数是为了读数能解释）
 */
export function generalizeDue(
  products: string[],
  sinceCount: number,
): { due: boolean; research: number; fresh: number; reason: string } {
  const research = products.filter((f) => /^P\d/.test(f)).length;
  const fresh = research - sinceCount;
  if (fresh < GEN_EVERY) {
    return {
      due: false,
      research,
      fresh,
      reason: `新增研究结论 ${fresh} 份 < 节拍 ${GEN_EVERY} 份 ⇒ 再攒攒`,
    };
  }
  return {
    due: true,
    research,
    fresh,
    reason: `新增研究结论 ${fresh} 份 ≥ 节拍 ${GEN_EVERY} 份 ⇒ 该提炼了`,
  };
}

/** ★ 测试/短跑用：`INSTRUMENT_REVIEW_MS=120000` 把间隔压短（★ 不改判据本身） */
const REVIEW_MS =
  Number(process.env.INSTRUMENT_REVIEW_MS) > 0 ? Number(process.env.INSTRUMENT_REVIEW_MS) : REVIEW_EVERY_MS;

/**
 * ★ 外部材料多久问一次（默认 40 分钟；`EXTERNAL_MS` 可压短给测试用）
 * ★★ 配额的另一半：`EXTERNAL_MAX_PER_WINDOW` —— 一个 window 最多问几次，
 *    否则"回头看"类规则会吃满产出（纪律㊱ 实测过：审查规则吃掉 57/60）。
 */
const EXTERNAL_MS = Number(process.env.EXTERNAL_MS) > 0 ? Number(process.env.EXTERNAL_MS) : 40 * 60_000;
/**
 * ★ 现象审查多久问一次（默认 25 分钟；`PHENOMENON_MS` 可压短）
 * ★★ 为什么它比 onExternal 更勤：现象是"新东西"的唯一入口，
 *   而一个自报的"意外"完全可以是**先看读数再编预期**。
 *   ★ 实测（r11–r14 四臂）：现象填了 30/30，**被独立审 0/30** —— 光靠投递不够。
 */
const PHENOMENON_MS =
  Number(process.env.PHENOMENON_MS) > 0 ? Number(process.env.PHENOMENON_MS) : 12 * 60_000;
const EXTERNAL_MAX_PER_WINDOW = Number(process.env.EXTERNAL_MAX) > 0 ? Number(process.env.EXTERNAL_MAX) : 6;
/** ★ 外部材料占产物的目标线：低于它才问（到了就不再催 —— 配额换成"读数驱动"）*/
const EXTERNAL_TARGET = 0.3;

// ─────────────── 状态读取（★ 读磁盘，不读它的自述）───────────────

/**
 * ★★★★★ 「哪些产物该被派挑战」—— **纯函数**（纪律⑦：判据可离线重判）
 *
 * ★ 为什么要抽出来：这条判据曾经错得最贵 ——
 *   `challengedOutputs` 在内存里，重启清零 ⇒ **整个历史账被当成新产出逐条重审**。
 *   实测：32 条挑战的产物龄全是 13.8 分钟（拷贝时刻），没有一个是真的新活。
 *
 * @param outs        outbox 里的文件名
 * @param startedAt   本轮开跑时刻（ms）
 * @param challenged  本轮已经辩过的文件名
 * @param mtimeOf     取 mtime（ms）—— 取不到的（已被删）算**不新**
 */
export function pickFresh(
  outs: readonly string[],
  startedAt: number,
  challenged: readonly string[],
  mtimeOf: (f: string) => number | undefined,
): string[] {
  const done = new Set(challenged);
  return outs.filter((f) => {
    if (done.has(f)) return false;
    const m = mtimeOf(f);
    // ★ 取不到 mtime ⇒ 不当新（静默当新就是那个 bug 的一半）
    if (typeof m !== "number") return false;
    return m >= startedAt;
  });
}

export function listOutbox(): string[] {
  const d = join(LAB, "outbox");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : [];
}

/**
 * ★★★★★ 本轮**该被辩证的产物** —— 两个落点都算（2026-10-25）
 *
 * ★ 为什么必须两个：实测 r3 一轮写了 11 份新 `.md` 到 `work/`，**outbox 0 份新增**，
 *   而 `onNewFinding` 只看 `outbox` ⇒ 一轮只辩了 2–5 份，辩证被饿住。
 *   ★★ 这是同一个盲区（第 13 次）咬到了**机制本身**，不只是我的读数。
 * ★ 排除：`_` 开头的（我的处境表/临时件）、`STATE.md`、`PROJECTS.md`、
 *   `EXPERIMENTS*.md`（账本，不是研究产物）。
 */
export function listDebatable(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const add = (dir: string, rel: string) => {
    const d = join(LAB, dir);
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".md")) continue;
      if (f.startsWith("_")) continue;
      if (/^(STATE|PROJECTS|EXPERIMENTS)/.test(f)) continue;
      out.push({ name: rel ? `${rel}/${f}` : f, path: join(d, f) });
    }
  };
  add("outbox", "");
  add("work", "work");
  return out;
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
  /**
   * ★ 真正去叫专家（会跑 3–6 分钟）。
   * ★★ 规则里**不要直接用它** —— 用 makeRules 里的 `fire`（排队）。
   *    只有派活器（dispatch.ts）该调它。
   */
  fireNow: (role: ExpertName, why: string, focus?: string) => Promise<string>;
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
  // ★★★ 2026-10-20 拆分：这里原来还有 `audience` / `tellAudience` /
  //   `signoffState` / `allTeams` 四个通道 —— 它们服务于 onAudience / onConsensus /
  //   onDispute 三条**出书机制**的规则，而 hunt 不出书。★ 现在它们在 forge 那份里。
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
  /** ★ 上次回头审视手段的时间（0 = 从没审过） */
  lastInstrumentReviewAt: number;
  /** ★★★★★ 上次提炼时 P* 的份数（-1 = 从没提炼过） */
  lastGeneralizeAt: number;
  /** ★★★★★ 辩证轮转的起点（★ 否则永远只送给排在前面的几位） */
  challengeOffset: number;
  /** ★★★★★ 已按「面」处理过的产物名（★ 避免同一份反复触发） */
  auditedNames: string[];
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
  /**
   * ★★★★★ 本轮开跑的时刻（2026-10-25 新加 ���— 治一个**最贵的结构性 bug**）。
   *
   * ★ 实测（照实写）：复制两个 arm 各跑一轮，`challenges.jsonl` 里 32 条挑战，
   *   **被挑战产物的龄全是 13.8 分钟** —— 也就是"拷贝那一刻的旧账"。
   *   根因：`challengedOutputs` 是**内存**的，每轮重启清零 ⇒
   *   `fresh = outs.filter(f => !challenged)` 把**整个 235 份历史账**当"新产物"，
   *   每 tick 挑一份（`fresh[0]`，**从最老的开始**），各发 2 位同事。
   * ★★ 后果：**每跑一轮，它先花大半时间重审一周前的旧账** ——
   *   这才是"答辩占比 78%"的真正引擎（不是"新活辩太多"）。
   * ★★★ 治法要落在**结构**上：只挑 `mtime > runStartedAt` 的产物。
   *   归档的账不该被"新"这个字欺骗（纪律㉛：别用当前状态回答历史问题）。
   */
  runStartedAt: number;
  /**
   * ★★★★★ 上一次"去外面找材料"的时刻（2026-10-25 设计者要求：**网上探索权重更大**）。
   *
   * ★ 实测现状（这是加这条规则的唯一理由）：
   *   四条灵感叹道的用量 —— ①自己的死线账 406 · ②跨学科 96 · **③外部材料 15** · ④同行反驳 13 次
   *   全部产物 691 份 ⇒ **外部材料只占 2%**。
   * ★★ 而它**不是不能用**：`P108` 借了社会选择论、`P113` 借了 Cohen κ、
   *   `P123` 借了 Kitagawa 分解 + ECB WP939 —— 每次借都真的改了它的读数口径。
   *   ⇒ 问题不是能力，是**没有触发**（工具在手，没人叫它去用）。
   * ★★★ 所以要的是**规则 + 配额**（纪律㊱：回头看类规则必须有配额，否则吃满产出）。
   */
  lastExternalAt: number;
  /** ★ 本 window 已经问过几次外部材料（配额）*/
  externalAsked: number;
  /** ★ 上一次问"审别人的现象"的时刻（2026-10-25 大改）*/
  lastPhenomenonAt: number;
  /** ★ 上一次催「收敛欠账」的时刻（2026-10-25）*/
  lastDebtAt: number;
  /** ★ 上一次催「撤回被判补的证据」的时刻（2026-10-25）*/
  lastRetractAt: number;
  // ★★★ 2026-10-20 拆分：`audienceAsked` / `signedAsked` / `disputeAsked`
  //   三本账随三条 forge 规则一起搬走了。★ hunt 只有两本账：审的（auditedOutputs）、辩的（challengedOutputs）。
};

export function newState(): State {
  // ★ 初始化时先把当前的 work/ mtime 记下来 —— 否则第一轮会把"开工前就有的文件"判成活动。
  return {
    auditedOutputs: 0,
    seenOutboxCount: 0,
    roundsSinceProgress: 0,
    firedAt: {},
    lastActiveAt: Date.now(),
    lastInstrumentReviewAt: 0,
    lastGeneralizeAt: -1,
    challengeOffset: 0,
    auditedNames: [],
    lastWorkMtime: 0,
    lastConvergedMtime: convergedMtime(),
    challengedOutputs: [],
    runStartedAt: Date.now(),
    lastExternalAt: 0,
    externalAsked: 0,
    lastPhenomenonAt: 0,
    lastDebtAt: 0,
    lastRetractAt: 0,
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
/**
 * ★★★★★ 辩证该送给哪几位 —— **轮转，不是永远取前几位**
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★★★ 这是同一类 bug 的**第二次**（2026-10-21）
 *
 *   原写法：`for (const k of peers.slice(0, n))` —— n=2，**永远取前两位**。
 *   而 `peers` 的顺序是 `ANGLES` 的顺序：
 *     [falsifier(先证伪), instrument-skeptic(先怀疑量具), hands-on(先动手做)]
 *   ⇒ **`hands-on` 永远收不到挑战**。
 *
 *   ★★ 实测（早前记在 runner.ts 的注释里，但当时归因错了）：
 *     「`hands-on` 整个窗口只收到 **5 次**挑战，另两位 **24/25** 次」
 *     —— 我当时归因成"它几乎从不空闲 ⇒ 排在自己输出后面"，
 *       还据此把 `queue` 改成了 `steer`。
 *     ★★★ 真因更简单：**它根本不在收件名单里**（`slice(0,2)` 切掉了它）。
 *
 * ★ 教训：`slice(0, n)` 这种"按序取前 n"在本项目里已经咬过两次
 *   （① `pickAnglesN` ② 这里）。**凡是集合按序截断，先问"最后那个是不是最不能少的"。**
 * ═══════════════════════════════════════════════════════════════════════
 *
 * @param peers  全部同事
 * @param n      这次要送给几位
 * @param offset 轮转起点（每次 +n，让每个人都被轮到）
 */
export function pickPeers(peers: string[], n: number, offset: number): string[] {
  if (peers.length === 0 || n <= 0) return [];
  const k = Math.min(n, peers.length);
  const start = ((offset % peers.length) + peers.length) % peers.length;
  const out: string[] = [];
  for (let i = 0; i < k; i++) out.push(peers[(start + i) % peers.length]!);
  return out;
}

/** ★ 逐规则计时（`HUNT_TRACE_RULES=1` 才打）—— 用来定位"哪条规则卡住了" */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (!process.env.HUNT_TRACE_RULES) return fn();
  const t0 = Date.now();
  process.stderr.write(`[rule-in] ${name}
`);
  try {
    await fn();
  } finally {
    process.stderr.write(`[rule-out] ${name} ${Date.now() - t0}ms
`);
  }
}

export async function tick(
  ctx: TriggerCtx & {
    rules: {
      onSettled: () => Promise<void>;
      onCapabilityGap: () => Promise<void>;
      onPlateau: () => Promise<void>;
      onNewFinding: () => Promise<void>;
      onInstrumentReview: () => Promise<void>;
      onGeneralize: () => Promise<void>;
      onExternal: () => Promise<void>;
      onPhenomenon: () => Promise<void>;
      onDebt: () => Promise<void>;
      onRetract: () => Promise<void>;
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
  // ★★★ 辩证（2026-10-19）：新产物落盘 → **结构性地**要求同事去挑战
  //   ★ 为什么放在这里（`onSettled` 之后、`onPlateau` 之前）：
  //     · 先审（`onSettled`）—— 审查是底线
  //     · 再辩 —— 辩论是**多员工才有的**机制
  //     · 最后看平台期
  //   ★★ 为什么必须有这条规则（实测教训）：
  //     给 `challenge` **工具** = 「允许它辩」⇒ **一次都没用过**（P13）。
  //     ⇒ 辩论不能是能力，必须是**处境**（由代码送到它面前）。
  // ★★★ 顺序很重要：**不 fire 专家的规则放前面，`onSettled` 放最后**。
  //   ★ 因为 `onSettled` 里 `fireNoWait("inspector")` 会**等专家跑完（几分钟）**，
  //     整个 tick 被卡住 ⇒ 排在它后面的规则**一个都轮不到**。
  //   ★★ 2026-10-20 拆分：原来这里还有 onAudience/onConsensus/onDispute
  //      （它们属于 forge，搬走了）。
  await step("onNewFinding", () => rules.onNewFinding());
  // ★★★ 2026-10-21 第 6 条：提炼（节拍判据，不靠内容判断）
  await step("onGeneralize", () => rules.onGeneralize());
  // ★ 非阻塞（steer）：排在所有会 fire 的规则之后（纪律㉚）
  await step("onExternal", () => rules.onExternal());
  await step("onPhenomenon", () => rules.onPhenomenon());
  await step("onDebt", () => rules.onDebt());
  await step("onRetract", () => rules.onRetract());
  // ★★★★★ 2026-10-21 · **顺序按"会不会阻塞 tick"排，不按重要性排**
  //
  //   ★★★ 实测（这一条规则的第一次真跑）：420 秒里 tick 只跑了 **1 次**，
  //     日志里只有 `onNewFinding` 和 `onCapabilityGap` 两行，
  //     **`onInstrumentReview` 一次都没出现**。
  //   ★ 根因：`onCapabilityGap` 里有 `fireNoWait("libsmith")` ——
  //     **它会等专家跑完（几分钟）**，把整个 tick 卡在那里 ⇒ 排在它后面的规则全饿死。
  //   ★★ 这与 AGENTS §三 `onSettled` 那个老坑**是同一个病**，
  //     只是换了一条规则。⇒ 现在改成：**不 fire 的规则全部排在 fire 之前**。
  await step("onInstrumentReview", () => rules.onInstrumentReview());   // ★ 不 fire（除到期那次）→ 先跑，饿不死
  await step("onPlateau", () => rules.onPlateau());            // ★ 同上
  await step("onCapabilityGap", () => rules.onCapabilityGap());      // ★ 会 fireNoWait(libsmith) → 往后排
  // ★★★ `onSettled` **必须放最后**：它会 `fireNoWait("inspector")`（等专家几分钟），
  //   是唯一会长时间阻塞 tick 的规则 ⇒ 放在前面会把后面的规则全部饿死。
  //   ★ 副作用提醒：`onSettled` 自己记 `auditedOutputs`，所以它之后不要再读那个字段。
  await step("onSettled", () => rules.onSettled());
}

import { makeDrainer } from "./dispatch.ts";
import { canOpenNewAudit, readClosure } from "./closure.ts";
import { readProjects } from "./projects.ts";
import { externalUsage, readArtifacts } from "./experiments.ts";
import { readStructured } from "../tools/record-experiment.ts";
import type { ExperimentRow } from "../tools/record-experiment.ts";
import { convergenceDebt, unsupportedClaims } from "./converged-gate.ts";

export function makeRules(ctx: TriggerCtx) {
  const { state } = ctx;

  // ══════════════════════════════════════════════════════════════
  // ★★★★ 2026-10-21 · 派活器（从 forge 搬来，治同一个病）
  //
  //   ★★★ 实测（这一轮的 hunt）：600 秒窗口里 **tick 只跑了 1 次**，
  //     日志里刷着 `rule:skip 工具节流 被跳过（上一次 tick 还在跑——它在等专家）`。
  //   ★ 根因：规则里 `fireNoWait(...)` 会等专家跑完（3–6 分钟）⇒ 整个 tick 停在那里。
  //
  //   ★★ 修法与 forge 完全一致：**观察快、派活慢，两件事分开**
  //     · 规则里 `fire(...)` = 「**记下**该派谁」，几微秒返回
  //     · `drainer` 按「同一时刻只跑一位」的节奏真派
  //
  //   ★ 需要专家原话的（只有 `onSettled` 要读 `VERDICT`）用 `onDone` 回调。
  // ══════════════════════════════════════════════════════════════
  const drainer = makeDrainer({
    doFire: (role, why, focus) => ctx.fireNow(role as ExpertName, why, focus),
    trace: (what, detail) => ctx.trace(what, detail),
    closing: () => !!ctx.closing?.(),
  });

  /** ★ 规则里用的 `fire` —— **记下**该派谁，立刻返回（返回值恒为 ""） */
  const fire = ((role: ExpertName, why: string, focus?: string): Promise<string> => {
    drainer.enqueue({ role, why, focus });
    return Promise.resolve("");
  }) as (role: ExpertName, why: string, focus?: string) => Promise<string>;

  /** ★ 需要专家原话时用这个（★ 走派活器，不绕过"一次只跑一位"） */
  /**
   * ★★★★★ **不占 tick 的 fire**（2026-10-25）
   *
   * ★ 实测：主空间 45 分钟只跑了 **4 次 tick** —— 因为 `onInstrumentReview` /
   *   `onPlateau` / `onGeneralize` 里各有一处 `fireNoWait(...)`，每次等专家 3–6 分钟。
   *   ⇒ 这就是纪律㉚ 那个病的第三次复发：**规则顺序按"会不会阻塞 tick"排**，
   *     但更彻底的办法是**根本没有会阻塞的 fire**。
   * ★★ 语义：入队、立刻返回。需要结果的地方用 `fireWait`（带 onDone）。
   */
  const fireNoWait = (role: ExpertName, msg: string): void => {
    drainer.enqueue({ role, why: msg.slice(0, 90), message: msg });
  };

  const fireWait = (role: ExpertName, why: string, focus: string, onDone: (t: string) => void): void => {
    drainer.enqueue({
      role,
      why,
      focus,
      onDone: (out) => {
        try {
          onDone(out);
        } catch (e) {
          ctx.trace("fire", `⛔ onDone 回调抛了：${(e as Error).message}`);
        }
      },
    });
  };

  /** 情况 A：有新产物 → 审查（★ 收敛时就顺便要它判停，C7） */
  async function onSettled(): Promise<void> {
    // ★ 收尾态：不再 fire 新专家（已 fire 的会跑完）
    if (ctx.closing?.()) return;
    // ★★★★ 两个落点都看（outbox + work/*.md）—— 否则新成果落在 work/ 就没人辩
    const outs = listDebatable().map((x) => x.name);
    ctx.trace("onSettled", `outbox=${outs.length} auditedOutputs=${state.auditedOutputs}`);
    if (outs.length > state.auditedOutputs) {
      state.auditedOutputs = outs.length;
      const converged = outs.some((f) => /CONVERGED/i.test(f));
      const why = converged
        ? `研究员写了收敛声明（\`outbox/CONVERGED.md\`），且 outbox 现有 ${outs.length} 份成果。`
        : `研究员刚产出新东西（outbox 现有 ${outs.length} 份）。`;
      // ★★★★★ 2026-10-21：focus 按**新产物的形式**选（不是内容判断）
      //
      //   · 宣布收敛   ⇒ CONVERGED_FOCUS（判"真探索完了还是想收工"）
      //   · 新的是「面」⇒ INTERFACE_FOCUS（**去跑它**，不是读它）
      //   · 其余       ⇒ 常规审查
      //   ★ 判据是文件名前缀 `面-`（形式），与 `classifyForward` 同族。
      const insp = await import("../prompts/inspector.ts");
      const fresh = outs.filter((f) => !state.auditedNames.includes(f));
      const hasInterface = fresh.some((f) => /^面[-_]/.test(f));
      const focus = converged ? insp.CONVERGED_FOCUS : hasInterface ? insp.INTERFACE_FOCUS : "";
      if (hasInterface) {
        ctx.trace("onSettled", `新产物是「面」⇒ 要 inspector **去跑它**（不是读它）：${fresh.filter((f) => /^面[-_]/.test(f)).join("/")}`);
        state.auditedNames.push(...fresh);
      }
      // ★★★ 走派活器 + onDone（★ 不 await：await 会卡住整个 tick）
      //   ★ 语义与原来的 `fireNoWait(...)` 完全一致，只是**不占住 tick**。
      fireWait("inspector", why, focus, (out) => {
        if (!out) {
          ctx.trace("onSettled", `⛔ inspector 没说话（verdict 保持 ${state.verdict ?? "未定"}）`);
          return;
        }
        const v = out.match(/VERDICT:\s*(STOP|CONTINUE)/i);
        if (v) state.verdict = v[1]!.toUpperCase() as "STOP" | "CONTINUE";
      });
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
    fireNoWait("libsmith", `研究员报告了底层能力缺口：${gaps.map((g) => `\`outbox/${g}\``).join("、")}`);
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
  // ══════════════════════════════════════════════════════════════
  // ★★★★★ 情况 E：回头看**自己用的手段**（2026-10-21，设计者提问驱动）
  //
  //   ★★★ 设计者原话（这一条规则的唯一来源）：
  //     「按照道理来说，hunt 集群应该可以自己发现没用 skill，或重审目标，获取灵感时，
  //       **应该能发现比 skill 更适合 agent 集群的东西**。
  //       因为 hunt 集群本身就是探索，而且还有**修改底层库的权限**，
  //       但是**为什么运行这么多次 hunt 后，非要到我提醒，才做这件事**」
  //
  //   ★★★ 我查到的根因（不是"它懒"，是**结构上没人问过它**）：
  //     · 它的 4 条规则分别治：新产物要审 / 能力缺口要报 / 平台期要换路 / 产物要辩
  //     · ★ **没有一条问"你手上反复用的那件东西，还好用吗"**
  //     · 它每次都在**用**手段（跑实验、写脚本、改库），
  //       但**从来没有一个时刻**被要求**退一步看这些手段本身**
  //
  //   ★★ 而且项目里早就写下过这条结论（`missions.ts` 里引用的 `C7`）：
  //     「**它判不了自己的盲区** —— 所以「体系化」这件事不能在第一集群里做」
  //     ⇒ 那条结论只被用来**分工**，**没被变成一条规则**。
  //     ★★★ 这正是 AGENTS.md §二说的病：**结论写了，但没接上**。
  //
  //   ★★★ 所以这条规则不加"能力"，加的是**处境**（`P13` 的第 N+1 次）：
  //     给它一个**周期**，到期就必须回答"我反复用的东西里，有没有该换掉的"。
  //
  //   ★ 判据（★ 可判死，不靠感觉）：
  //     ① 距上次审视 ≥ REVIEW_EVERY_MS
  //     ② 而且这段时间**确实在干活**（有过新产物或新文件）
  //        —— ★ 没干活的时候不该问"手段好不好"，那时该问"该不该退休"
  //   ★★ 冷却与 inspirer 共用同一套，避免同时派两个长跑专家把成本翻倍。
  async function onInstrumentReview(): Promise<void> {
    if (ctx.closing?.()) return;

    const now = Date.now();
    const last = state.lastInstrumentReviewAt ?? 0;
    const elapsed = now - last;

    ctx.trace(
      "onInstrumentReview",
      `距上次 ${Math.round(elapsed / 60_000)} 分钟 / 阈值 ${Math.round(REVIEW_MS / 60_000)} 分钟`,
    );

    // ① 周期没到
    if (elapsed < REVIEW_MS) return;
    // ② 这段时间没干活 ⇒ 该问的是别的（onPlateau 管）
    if (state.lastActiveAt === 0 || now - state.lastActiveAt > REVIEW_MS) {
      ctx.trace("onInstrumentReview", "这段时间没干活 ⇒ 跳过（那是 onPlateau 的事）");
      return;
    }
    // ③ 冷却（与 inspirer 共用，避免同时起两个长跑专家）
    if (now - (state.firedAt["inspirer"] ?? 0) < COOLDOWN_MS) return;

    // ★★★ 2026-10-21 · ④ 存量闸**已撤**（DESIGN §4.1「撤掉我加的保守东西」）
    //
    //   ★ 它当初治的是「自审吃满产出」（63%）。撤的理由两条：
    //     ① 手段换了：真正让产出转向的是**递读数 + 逼回答**（实测 4 次都灵，
    //        最近一次它答 (b)「转到量具自己」并当场开了 3 个新实验）；
    //     ② 这个闸只挡**规则触发**，挡不住它自己选的活 —— 实测规则停了产出仍 63% 自审。
    //   ★★ 自审的正确定位改为「必须挂到某个实验的阻塞上」（DESIGN §6），那是结构，
    //     不是配额。配额留着只会让我误以为问题解决了。
    void canOpenNewAudit;
    void readClosure;

    // ★★★★★ 2026-10-21 · ④ 新闸：**自审必须挂在项目上**（DESIGN §6）
    //
    //   ★★★ 这是打断"自喂环"的机制。实测：`手段 I → XXII` 24 层，每层审上一层 ——
    //     审装置 → 发现缺陷 → 又需要审装置，**没有终点**，而它把产出吃成了 63% 自审。
    //   ★ 而"自审"本身是合法的活（`先怀疑量具` 是这个集群的角度之一），不能删。
    //     ⇒ 正确做法：**每条自审必须为某个项目服务**。没有项目 ⇒ 不许开自审。
    //   ★★ 与"对象必须是外部"合起来才是完整的治：
    //     项目有外部对象 ⇒ 自审服务于项目 ⇒ 自审被项目限住，而项目朝外。
    const pj = readProjects(LAB);
    if (pj.mode === "none" || pj.stats.total === 0) {
      ctx.trace(
        "onInstrumentReview",
        "⛔ 跳过：项目账里**一个项目都没有** —— 自审必须挂在项目上（没有项目 ⇒ 自审自己没有目的）",
      );
      return;
    }
    const projectList = pj.rows.map((r) => `${r.id}（对象：${r.object || "未声明"}）`).join(" · ");

    state.lastInstrumentReviewAt = now;
    state.firedAt["inspirer"] = now;
    ctx.trace("onInstrumentReview", `项目 ${pj.stats.total} 个 ⇒ 放行（${projectList.slice(0, 80)}）`);

    // ★★★ 派给 inspirer，但**换一个完全不同的问题**。
    //   ★ 它平时的任务是"从别的学科借框架"；
    //   ★ 这次的任务是"**审视我们自己在用的手段**"。
    fireNoWait(
      "inspirer",
      [
        "★★★ 这一轮**不问研究内容**，问**你自己在用的手段**。",
        "",
        "★ 你不是「来提一条新想法」的 —— 是来回答一个具体问题：",
        "",
        "   **你（和你的同事）反复在用的那件东西，还好用吗？有没有更好的？**",
        "",
        "★★ 什么叫「手段」（不是研究内容）：",
        "   · 你每次都要做的那个动作（写产物、跑实验、改库、发挑战）",
        "   · 你反复套用的那个格式 / 那个清单 / 那个判据",
        "   · 你手上那套工具本身（★ 包括库给你的那些面）",
        "",
        "★★★ 具体怎么问（照着做，别泛泛而谈）：",
        "   ① 挑一件你**这轮至少用过 3 次**的东西",
        "   ② 说出它**为什么是这样**（当初为了治什么病）",
        "   ③ 问：那个病**现在还在吗**？不在了 / 变了 ⇒ 它可能该换",
        "   ④ 再问：**有没有一件东西，你一直在手工做，而它本该是结构？**",
        "      （★ 判据：这件事如果写成一条规则 / 一个工具 / 一道门，",
        "        是不是就不用每次都靠「记得」了）",
        "",
        "★★ 特别注意一个盲区（项目里早就写下过，但从没被当成规则）：",
        "   「**它判不了自己的盲区**」（`C7`）",
        "   ⇒ 所以别问「我有什么没想到」（答不出来），",
        "     要问「**我反复做的哪件事，其实可以交给结构**」。",
        "",
        "★ 产出要求：写进 `outbox/`，一条就够，但必须带",
        "  · 你挑的是哪件东西、用过几次（**给数**）",
        "  · 它当初治什么病、那个病现在还成不成立（**给证据**）",
        "  · 更好的做法是什么，**为什么它更好（可判死的判据）**",
        "",
        "★★ 不许写的：",
        "  · 泛泛的「应该多反思」—— 那不是发现",
        "  · 直接改框架（规则表/门/席位）—— 那是研究助手的活，你只能**提议**",
      ].join(String.fromCharCode(10)),
    );
  }

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
    fireNoWait(
      "inspirer",
      `研究员已经约 ${mins} 分钟**既没交新成果、也没在批量干活**` +
        `（这段窗口内 \`work/\` 里新出 ${fresh} 个文件，阈值 ${FRESH_FILES_THRESHOLD}）。` +
        `★ 注意：这不等于"它懒"—— 更可能是**在原地打转**（反复改同一个脚本、同一条线的第 N 个实验）。` +
        `★ 请给它一个**别的学科**能借的框架。`,
    );
    fireNoWait(
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
    // ★★★★ 两个落点都看（outbox + work/*.md）—— 否则新成果落在 work/ 就没人辩
    const outs = listDebatable().map((x) => x.name);
    // ★★★★★ 2026-10-25 · **只挑战本轮新产出**（治"每轮重审整个历史账"）
    //
    //   ★ 实测：32 条挑战全部指向龄 13.8 分钟的旧账 —— 因为 `challengedOutputs`
    //     是内存的，重启即清零 ⇒ 235 份历史全被当成"新产物"逐条重审。
    //   ★★ 判据：`mtime > runStartedAt`。归档的账不该被"新"这个字骗（纪律㉛）。
    const fresh = pickFresh(outs, state.runStartedAt, state.challengedOutputs, (f) => {
      try {
        return statSync(f.startsWith("work/") ? join(LAB, f) : join(LAB, "outbox", f)).mtimeMs;
      } catch {
        return undefined;
      }
    });
    // ★ 老账不派挑战，但要**报出来**（否则"历史账一直没人审"会静默）
    const archived = outs.length - fresh.length - state.challengedOutputs.length;
    if (archived > 0 && state.challengedOutputs.length === 0) {
      ctx.trace(
        "onNewFinding",
        `本轮只辩新产出：历史账 ${archived} 份**不派挑战**（它们上一轮已经被辩过 —— 内存集合重启清零是旧 bug，2026-10-25 修）`,
      );
    }
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
      `**产物**：\`${target.startsWith("work/") ? "" : "outbox/"}${target}\`\n\n` +
      `---\n\n` +
      `★ 读完它，然后**必须表一个态**：\n` +
      `  · **给出反例**（指到文件/数字/实验）\n` +
      `  · **指出缺陷**（装置、判据、归因哪一处错）\n` +
      `  · **我同意**（★ 并写清你**核对过什么**才同意的）\n\n` +
      `★★ 不要写“看起来还行” —— 那既没推进也没纠正。\n` +
      `★ 用你的角度去看：**别人会信什么，你就去找什么的反面**。\n` +
      `★ 若它站得住，说出来也是贡献 —— 那意味着三个人从三个方向都没找到问题。`;
    // ★★★ 2026-10-21：`slice(0,n)` → **轮转**。
    //   原写法永远取前两位 ⇒ 排在最后的 `hands-on` **一次都没收到过挑战**。
    const targets = pickPeers(peers, n, state.challengeOffset ?? 0);
    state.challengeOffset = (state.challengeOffset ?? 0) + n;
    ctx.trace("onNewFinding", `本轮送给：${targets.join(" + ")}（轮转 offset=${state.challengeOffset - n}）`);
    for (const k of targets) {
      const r = (ctx.challenge as unknown as (k: string, t: string) => { ok: boolean; reason?: string })(k, text);
      if (r && !r.ok) ctx.trace("onNewFinding", `⛔ 投递失败 ${k}：${r.reason ?? "未知"}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ★★★ 2026-10-20 拆分：`onAudience` / `onConsensus` / `onDispute` **不在这里了**。
  //
  //   ★ 这三条都是**出书的机制**：
  //     · onAudience  —— 请观众评"哪一方最站得住"（观众是书的验收者）
  //     · onConsensus —— 请缺席团队签共识门（门决定能不能进 book）
  //     · onDispute   —— 门没开 ⇒ 送联合实验
  //   ★★ 设计者裁定：「hunt 的产物**不进 book**（它是原料，给 forge 用），
  //      **book 只交给 forge 来管**」⇒ hunt 没有书 ⇒ 这三条**一个都不该在 hunt 里**。
  //
  //   ★ 它们现在只活在 `research/clusters/forge/topology/rules.ts`。
  // ══════════════════════════════════════════════════════════════

  // ★★★ 把派活器交给 runner：它要在每个 tick 后 `drain()`，收尾时要「等队列跑空」
  /**
   * ★★★★★ 提炼：把「观察」推一步到「接口」（2026-10-21 新增，第 6 条规则）
   *
   * ★★ 为什么必须有这一条 —— 实测：
   *   · hunt 有 58 份 P\*，其中至少 5 份是**治理机制级**的发现
   *   · ★★★ 但 58 份里只有 **5 份（8%）**提到过「别人能不能用」
   *   · 而 `enforce`/`correct`/`grant`/`write_skill` 这些**面**，
   *     是**我**看着它的产物造的，不是它提炼的
   *
   * ⇒ 流水线断在中间：**它观察 → 我抽象 → 我发**。
   *   MCP 和 skill 都不是这样的：它们是**从观察里长出来的接口**。
   *
   * ★ 判据是**节拍**（每新增 N 份研究结论问一次），
   *   不是"检测哪份像创新" —— 后者是内容判断（硬规则①）。
   */
  // ══════════════════════════════════════════════════════════════
  // ★★★★★ onRetract —— 被判「补的」证据必须有人处置（门有判决就得有后果）
  //
  //   ★ 实测（主空间）：判"补的" **8 条**，**8 条全都被状态表引用**，一条都没撤。
  //     门只报"未通过"，**没人被要求撤回** ⇒ 判决没有后果。
  //   ★★ 三选一（有路才拦得住，纪律⑳）：
  //     撤回引用 / 重做一次带真 PREREG 的实验 / 说明它其实成立
  // ══════════════════════════════════════════════════════════════
  async function onRetract(): Promise<void> {
    if (ctx.closing?.()) return;
    if (!ctx.challenge) return;
    const now = Date.now();
    if (now - state.lastRetractAt < 20 * 60_000) return;
    const rows = readStructured(LAB);
    const p = join(LAB, "outbox", "CONVERGED.md");
    if (!existsSync(p) || rows.length === 0) return;
    const bad = unsupportedClaims(readFileSync(p, "utf8"), rows);
    if (bad.length === 0) return;
    state.lastRetractAt = now;

    const target = bad[0]!;
    // ★ 派给**这条证据的作者**（别人改不了它），没有就派第一个座位
    const author = rows.find((r) => target.fake.includes(r.id))?.by;
    const peers = ctx.peerKeys?.() ?? [];
    const who = (author && peers.includes(author)) ? author : peers[0];
    if (!who) return;
    ctx.trace("onRetract", `只有"补的"证据撑着的 claim ${bad.length} 条 ⇒ 派 ${who} 处置 ${target.fake.join("·")}`);
    ctx.challenge(
      who,
      [
        "## ★★★★★ 你引的证据被判「补的」，但状态表还在用它",
        "",
        `**那条 claim**：${target.claim}`,
        `**它只靠**：${target.fake.map((f) => "`" + f + "`").join(" · ")}（都被同侪判为"先看读数再补预期"）`,
        "",
        "### 三选一（有后果，别放着）",
        "1. **撤回引用** —— 从 `outbox/CONVERGED.md` 的状态表里去掉这几个 `E*`，claim 相应降级",
        "2. **重做一次** —— 这次先写 PREREG（写死预期）、再跑、再记 `record_experiment`",
        "3. **说明它其实成立** —— 指到跑前就存在的证据（不是事后叙述）",
        "",
        "★ 判据（我机械可查）：处置后 `只有补的证据撑着的 claim` 应少一条。",
      ].join(String.fromCharCode(10)),
    );
  }

  // ══════════════════════════════════════════════════════════════
  // ★★★★ onDebt —— 催「收敛欠账」（2026-10-25）
  //
  //   ★ 为什么必须做成规则、不能写在投递里：
  //     投递一轮只发一次，而主目标轮换是**按 run** 的（一个 run 55 分钟只有一个主目标）
  //     ⇒ "清欠账"平均 4 轮才轮到一次。实测：上一轮列了 3 条，**清 0**。
  //   ★★ 规则可以反复触发（每 15 分钟），而且**带具体行号**派给具体的人 ——
  //     这和历史上有过效果的两次同形（onPhenomenon、onExternal）。
  // ══════════════════════════════════════════════════════════════
  async function onDebt(): Promise<void> {
    if (ctx.closing?.()) return;
    if (!ctx.challenge) return;
    const now = Date.now();
    if (now - state.lastDebtAt < 15 * 60_000) return;
    const rows = readStructured(LAB);
    if (rows.length === 0) return;
    // 只催**已审过的**欠账：未审的引不进状态表，催它等于白催
    const debt = convergenceDebt(LAB, rows).uncited.filter((u) => u.reviewed);
    if (debt.length === 0) return;
    state.lastDebtAt = now;

    const peers = ctx.peerKeys?.() ?? [];
    const who = peers[(state.externalAsked ?? 0) % Math.max(peers.length, 1)];
    if (!who) return;
    // ★ 一次派**多条**（与 onPhenomenon 同形）：欠账 13 条而一次只催 1 条 ⇒ 永远追不上
    const k = Math.max(1, Math.min(3, Math.ceil(debt.length / 4)));
    ctx.trace("onDebt", `欠账 ${debt.length} 条（已审的）⇒ 本轮派 ${k} 条`);
    const item = debt[0]!;
    ctx.challenge(
      who,
      [
        `## ★★★★ 收敛欠账：处置 \`${item.id}\`（一条已审过的实验）`,
        "",
        "**它的 claim**：" + item.claim,
        "",
        "### 三选一，必须落到 `outbox/CONVERGED.md` 的状态表里",
        "",
        "1. **引它进状态表** —— 在「证据 id」列写 `" + item.id + "`，并写清它支持哪一条 claim",
        "2. **说明它不算证据** —— 写进状态表或产物：为什么它不能承重（边界？样本？载体？）",
        "3. **说明还缺什么** —— 缺对照臂 / 缺第二个载体 / 缺审查",
        "",
        "★ 允许处置为「不算」，但**不许不处置**：不处置，下一轮这张清单还是它。",
        "★★ 判据（我机械可查）：处置后 `收敛欠账` 里应该少一条。",
      ].join(String.fromCharCode(10)),
    );
    // ★ 剩下的 k-1 条：派给别人（同一人一次只处理一条，避免他挑顺手的）
    for (let i = 1; i < k; i++) {
      const it = debt[i];
      const w = peers[(i + (state.externalAsked ?? 0)) % Math.max(peers.length, 1)];
      if (!it || !w || w === who) continue;
      ctx.challenge(
        w,
        [
          `## ★★★★ 收敛欠账：处置 \`${it.id}\`（一条已审过的实验）`,
          "",
          "**它的 claim**：" + it.claim,
          "",
          "### 三选一，必须落到 `outbox/CONVERGED.md` 的状态表里",
          "1. **引它进状态表**（证据 id 列写 `" + it.id + "`，并写清支持哪条 claim）",
          "2. **说明它不算证据**（为什么不能承重：边界？样本？载体？）",
          "3. **说明还缺什么**（缺对照臂 / 缺第二个载体 / 缺审查）",
          "",
          "★ 允许处置为「不算」，但不许不处置。",
        ].join(String.fromCharCode(10)),
      );
      ctx.trace("onDebt", `→ ${w} 处置 ${it.id}`);
    }
  }


/** ★ 审现象的投递文本（抽成纯函数：一次可以派多条，内容必须一致）*/
function phenomenonPrompt(target: ExperimentRow): string {
  return [
    `## ★★★★★ 审一格「现象」：\`${target.id}\`（作者 **${target.by}**，不是你写的）`,
    "",
    "**它自报的现象**：",
    "> " + target.phenomenon.replace(String.fromCharCode(10), " ").slice(0, 500),
    "",
    "**它的机制（model）**：",
    "> " + (target.model || "(空)").replace(String.fromCharCode(10), " ").slice(0, 300),
    "",
    "### 你要判的只有一件事",
    "**这是「真意外」还是「先看读数再补的预期」？**",
    "",
    "★ 判「补的」的证据只有三类（别用语气判断）：",
    "  ① `PREREG` / 跑前写死的东西里**没有**这条预期（事后才出现）",
    "  ② 预期写得**比读数还笼统**（例如「可能不一样」，而读数是 3/8 vs 0/8）",
    "  ③ 现象与 `outcome` 自相矛盾（说意外，但结局写「活」且没解释为什么能活）",
    "",
    `用 \`review_experiment({ id: "${target.id}", verdict: "真意外"|"补的", note: "<凭什么>" })\`。`,
    "★★ 自签会被拒 —— 你不是作者，所以你能审。",
    "★★★ 这个判定直接决定它算不算「发现型」：**没被人认过的现象只算填了**。",
  ].join(String.fromCharCode(10));
}

  // ══════════════════════════════════════════════════════════════
  // ★★★★★ onPhenomenon —— 让**另一位**去审「这格现象是真意外还是补的」
  //
  //   ★ 为什么必须是规则、不能只写在投递里（实测）：
  //     r11–r14 四个臂，结构化实验 30 条，**现象填了 30/30，被独立审 0/30**。
  //     投递里明明列了"还没审的行号"，就是没人审 —— 与 `onExternal` 当初一样：
  //     **工具在手 ≠ 有人叫它用**。
  //   ★★ 派给**作者以外**的人（自己审自己工具会拒），并且**带行号**（指着说）。
  // ══════════════════════════════════════════════════════════════
  async function onPhenomenon(): Promise<void> {
    if (ctx.closing?.()) return;
    if (!ctx.challenge) return;
    const now = Date.now();
    // ★★★ 按**积压**调速（2026-10-25）：审查必须跑赢生产，否则账上永远是"未审"。
    //   实测 r23：实验 28 条、独立审 11 条（39%）—— 定时 12 分钟一次追不上。
    const backlogAll = readStructured(LAB).filter((r) => !r.reviewedBy && r.phenomenon.trim()).length;
    const gap = backlogAll >= 5 ? Math.min(PHENOMENON_MS, 150_000) : backlogAll >= 2 ? Math.min(PHENOMENON_MS, 360_000) : PHENOMENON_MS;
    if (now - state.lastPhenomenonAt < gap) return;

    const rows = readStructured(LAB).filter((r) => !r.reviewedBy && r.phenomenon.trim());
    if (rows.length === 0) return;
    state.lastPhenomenonAt = now;

    const peers = ctx.peerKeys?.() ?? [];
    // ★ 找一个**不是这些行的作者**的人
    const authors = new Set(rows.map((r) => r.by));
    const reviewer = peers.find((k) => !authors.has(k)) ?? peers[0];
    if (!reviewer) return;

    // ★★★★★ 一次派**多条**（2026-10-25）：审查速率曾经被 tick 频率卡住
    //
    //   ★ 实测：既然一次只派 1 条、tick 5 分钟一次，审查上限就是 ~12 条/小时，
    //     而生产是它的两倍 ⇒ 未审积压从 2 涨到 **10**（越攒越多）。
    //   ★★ 派活器本来就支持并发（默认 3），所以卡点不在机器，在"我一次只给一条"。
    //   ★★★ 派几条：按积压算（欠得多就多派），封顶 3（= 并发上限），至少 1。
    //     这正是纪律㊵：开环系统里要**清欠账**，不是限开工。
    const k = Math.max(1, Math.min(3, Math.ceil(rows.length / 2)));
    const authors2 = new Set(rows.map((r) => r.by));
    const pool = peers.filter((p) => !authors2.has(p));
    const reviewerPool = pool.length > 0 ? pool : peers;

    const targets = rows.slice(0, k);
    let sent = 0;
    targets.forEach((target, i) => {
      const reviewer = reviewerPool[i % Math.max(reviewerPool.length, 1)];
      if (!reviewer) return;
      // ★ 不让一个人审自己刚写的那条（作者已排除；这里再防一次多目标时的重合）
      if (reviewer === target.by) return;
      ctx.challenge!(reviewer, phenomenonPrompt(target));
      sent++;
      ctx.trace("onPhenomenon", `→ ${reviewer} 审 ${target.id}（作者 ${target.by}）`);
    });
    if (sent === 0) return;
    ctx.trace("onPhenomenon", `未审 ${rows.length} 条 ⇒ 本轮派 ${sent} 条（k=${k}）`);
  }

  // ══════════════════════════════════════════════════════════════
  // ★★★★★ onExternal —— **外部材料通道**（2026-10-25 设计者：网上探索权重更大）
  //
  //   ★ 为什么需要规则，而不是写在投递里：
  //     实测四条通道用量 ①死线账 406 · ②跨学科 96 · **③外部材料 15（2%）** · ④反驳 13。
  //     工具全在手上（`web_search`/`fetch_content`/`source_check` 已进白名单），
  //     `P108/P113/P123` 每次借外部框架都真改了读数 —— **问题是没有触发**。
  //   ★★ 纪律㊱：这条属于"回头看"类，**必须有配额** —— 所以
  //     ① 间隔 ≥ 40 分钟；② 一个 window 最多 6 次；③ 占比够了就不再催。
  //   ★★★ 走 `ctx.challenge`（steer）而不是 `fire`：角度座位不在 ExpertName 里。
  // ══════════════════════════════════════════════════════════════
  async function onExternal(): Promise<void> {
    if (ctx.closing?.()) return;
    if (!ctx.challenge) return;
    const now = Date.now();
    if (now - state.lastExternalAt < EXTERNAL_MS) return;
    if ((state.externalAsked ?? 0) >= EXTERNAL_MAX_PER_WINDOW) return;

    // ★ 读数：外部材料占比（只数**研究产物**，不数我自己的账）
    const ratio = externalUsage(readArtifacts(join(LAB, "outbox")));
    if (ratio.share !== null && ratio.share >= EXTERNAL_TARGET) {
      ctx.trace("onExternal", `外部材料已占 ${Math.round(ratio.share * 100)}% ≥ 目标 ${Math.round(EXTERNAL_TARGET * 100)}% ⇒ 本轮不再催`);
      return;
    }

    state.lastExternalAt = now;
    state.externalAsked = (state.externalAsked ?? 0) + 1;
    ctx.trace(
      "onExternal",
      `外部材料 ${ratio.n}/${ratio.total}（${ratio.share === null ? "未声明" : Math.round(ratio.share * 100) + "%"}）< 目标 ⇒ 问第 ${state.externalAsked}/${EXTERNAL_MAX_PER_WINDOW} 次`,
    );

    // ★★★★ 2026-10-25：**轮转所有座位**，不是永远问 falsifier。
    //   实测：外部材料只有 3%，而一轮产出 15–20 份 —— 一个座位一次问只能到 ~25% 上限。
    //   每个座位都该有外部材料配额（"谁搜"不该固定成一个人）。
    const peers = ctx.peerKeys?.() ?? [];
    const idx = state.externalAsked ?? 0;
    const who = peers.length > 0 ? peers[idx % peers.length] : undefined;

    const prompt = [
      "## ★★★★★ 这一轮只做一件事：**去外面找一条能判死（或支持）你自己结论的材料**",
      "",
      "★ 事实（我量的，你随时可以复核）：",
      `  · 四条灵感叹道的用量：①自己的死线账 **406 份** · ②跨学科 **96 份** · ③**外部材料只有 15 份（2%）** · ④同行反驳 13 次`,
      "  · 你不是不会用 —— `P108` 借社会选择论、`P113` 借 Cohen κ、`P123` 借 Kitagawa 分解 + ECB WP939，",
      "    **每次借都真的改了你的读数口径**。缺的不是能力，是**没人叫你去借**。",
      "",
      "### 你要交的（四件事，缺一算没答）",
      "",
      "1. **挑一条你自己的具体结论**（带数，能指回 `outbox/P*.md`）",
      "2. **去外面找一条材料** —— 论文 / 标准 / 别人的实现 / 官方文档。**优先网上搜**。",
      "   必须给：**出处 URL** + **原文里的一句话（逐字）**",
      "3. **它是支持还是判死你那条结论** —— 说清在哪一点上一致/冲突",
      "4. **它改了你什么** —— 口径、判据、还是结论本身（改不了就写「没改，因为…」）",
      "",
      "★ 不许做的：",
      "  · 引一条**跟你结论无关**的材料（那只是装饰）",
      "  · 编一个 URL（★ 我会去核；编一次，这条通道以后就废了）",
      "  · 说「我搜了没找到」却**不给搜过的词**（★ 要给 query 列表）",
      "",
      "★★ 判据：这条材料必须挂在**一条具体的 claim** 上，不是挂在「这个方向」上。",
    ].join(String.fromCharCode(10));

    if (who && ctx.challenge) {
      ctx.challenge(who, prompt);
      ctx.trace("onExternal", `→ ${who}（steer，web 优先 · 轮转 ${(state.externalAsked ?? 0) % Math.max(ctx.peerKeys?.().length ?? 1, 1)}/${ctx.peerKeys?.().length ?? 1}）`);
    }
  }

  async function onGeneralize(): Promise<void> {
    if (ctx.closing?.()) return;

    const g = generalizeDue(listOutbox(), state.lastGeneralizeAt < 0 ? 0 : state.lastGeneralizeAt);
    ctx.trace("onGeneralize", g.reason);
    if (!g.due) return;

    // ★ 冷却（与 inspirer 共用）
    if (Date.now() - (state.firedAt["inspirer"] ?? 0) < COOLDOWN_MS) {
      ctx.trace("onGeneralize", "冷却中（inspirer 刚跑过）⇒ 下一 tick");
      return;
    }

    state.lastGeneralizeAt = g.research;
    state.firedAt["inspirer"] = Date.now();

    // ★★★★★ 派给谁：**建设性的那一位**（`hands-on`），不是 `inspirer`
    //
    //   ★ 为什么改（2026-10-21）：这个问题要的产出是**一个能跑的接口**
    //     （写脚本 + 6 条人造答案 + 跨载体验证），那是 `先动手做` 的活。
    //     `inspirer` 的任务是"从别的学科借框架" —— 借来还要有人做出来。
    //   ★★ 实测：这道题第一次是被 `hands-on` 答的（`面-denom`），
    //     而那一轮 `inspirer` 只是把它转达了。
    //   ★ 没有 `hands-on`（单角度跑）时退回 `inspirer`。
    // ★★★ 走哪条信道：**角度座位只能用 `challenge`（steer）**，
    //   不能 `fire` —— `fire` 的 `ExpertName` 只含专家（inspector/archivist/
    //   inspirer/watchdog/libsmith），角度座位不在其中。
    //   ★ 这是实测踩出来的：`fire("hands-on")` 直接是类型错误 —— 好事，
    //     它把"派给了不存在的座位"这种事挡在编译期（同族：`spawn_seat` 长出的
    //     座位路由到空气那次）。
    const hasHandsOn = (ctx.peerKeys?.() ?? []).includes("hands-on");
    const prompt = [
        "## ★★★★★ 这一轮的问题是：**你的发现，有没有变成别人能用的东西**",
        "",
        `★ 自上次问过之后，你新增了 **${g.fresh} 份研究结论**（P*）。`,
        "",
        "★★★ 先看清一件事：",
        "  `MCP` 与 `skill` 都不是「发现」，是**把『每个 agent 都在手工重做的同一件事』提成了一个面**。",
        "  ★ 而本项目里那些「面」（`enforce`/`correct`/`grant`/`write_skill`）",
        "    **不是你提炼出来的** —— 是上级看着你的产物造的。",
        "  ⇒ 流水线断在中间：**你观察 → 上级抽象 → 上级发**。",
        "",
        "★ 你现在要做的，是把中间那一步自己走一遍。",
        "",
        "### 必须回答（三选一都算，**不许不答**）",
        "",
        "**(a) 指出一条可以变成「面」的发现** —— 说清四件事：",
        "    ① 它是什么（一句能判死的话，带数）",
        "    ② **谁在重复做同一件手工事**（★ 说不出具体谁 ⇒ 它还不是面）",
        "    ③ 如果做成接口，那个接口**长什么样**（输入/输出/谁能调）",
        "    ④ **换一个载体还成立吗**（★ 这是 MCP 与普通观察的分界线）",
        "",
        "**(b) 说清现在为什么**还不能**变成面 —— 缺什么、要等什么",
        "",
        "**(c) 说清「这件事本质上不能变成面」** —— 为什么它只能是一次性判断",
        "",
        "★★ 允许答 (b)/(c) —— **但必须给出理由**。",
        "★ 不许做的：",
        "  · 把已有的某份 P* 改个标题说「它可以做成工具」（那是刷指标）",
        "  · 提出一个**只有你能用**的接口（那还是 N=1）",
        "",
        "★★★ 判据：你答 (a) 的那一条，必须能让**另一个集群照着做**。",
        "  做不到就老实答 (b)/(c)。",
        "",
        "依据可以查：`outbox/P*.md`（58 份研究结论）、`outbox/CONVERGED.md`。",
    ].join(String.fromCharCode(10));

    // ★ 优先给**建设性的那一位**（它要的是一个能跑的接口：写脚本 + 人造答案 + 跨载体）
    //   ★ 没有它（单角度跑）⇒ 退回 `inspirer`
    if (hasHandsOn && ctx.challenge) {
      ctx.challenge("hands-on", prompt);
      ctx.trace("onGeneralize", "→ hands-on（steer，问题当场注入）");
      return;
    }
    fireNoWait("inspirer", prompt);
    ctx.trace("onGeneralize", "→ inspirer（没有 hands-on 座位）");
  }

  return { onSettled, onCapabilityGap, onPlateau, onNewFinding, onInstrumentReview, onGeneralize, onExternal, onPhenomenon, onDebt, onRetract, drainer };
}
