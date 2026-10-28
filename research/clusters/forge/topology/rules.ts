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
//
// ★★★ 2026-10-20 拓扑探针抓到的**第三个真 bug**（`micro/topology-probe.ts` 发现）：
//   这里原来**没有导入 `readFileSync`** —— 而 `readArtifactSafe` 里用它。
//   ⇒ 调用时抛 `ReferenceError`，被 `catch { return "" }` **静默吞掉**。
//   ⇒ 后果：五条猜想里凡是要读产物正文的（C/D/E）**全部判据恒 false**，
//     而且日志里**一声不响** —— 与 AGENTS「二、机制写了不等于接上了」同型。
//   ★★ 教训：`try/catch` 里包住的代码，**拼写/导入错误也会被当成"读不到"**。
//     ⇒ 以后凡 `catch { return "" }`，都必须先问：这里会不会藏着一个真错误？
import { join } from "node:path";
import { LAB, REPO } from "../paths.ts";
import { chapterDrift, syncSummary } from "../tools/summary.ts";
import { convergedMtime, countFreshFiles, hasProgress, workLatestMtime } from "./progress.ts";
import { makeDrainer } from "./dispatch.ts";
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
 * ★★★ outbox 的**内容指纹**（2026-10-20）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（实测踩到的第二个判据缺陷）
 *
 *   平台期 v4 的 `produced` 原来只比**文件个数**：
 *     `produced = outs > state.seenOutboxCount || ...`
 *
 *   ★★ 实测（一轮 20 分钟）：
 *     · outbox 份数 64 → 65（只多 1 份）
 *     · 但 `git diff --stat` 显示 **15 files changed, 592 insertions(+), 195 deletions(-)**
 *   ⇒ **集群在改 15 份产物，判据却说"没有产出"**。
 *
 *   ★ 这和 v3 的病是**同一类错误的两个方向**：
 *     v3 把 `work/` 的动静当进展（太松）
 *     v4 把「改已有产物」当没进展（太严）
 *
 *   ★★★ 正解：**"产出"= 文件集合有变化 或 内容有变化**。
 *     内容用 `名字+字节数+mtime` 当指纹 —— 纯本地、0 API、可离线比对。
 * ══════════════════════════════════════════════════════════════════════════
 */
export function outboxFingerprint(): { count: number; hash: string } {
  const d = join(LAB, "outbox");
  if (!existsSync(d)) return { count: 0, hash: "" };
  const files = readdirSync(d).filter((f) => f.endsWith(".md")).sort();
  const parts: string[] = [];
  let bytes = 0;
  for (const f of files) {
    try {
      const st = statSync(join(d, f));
      bytes += st.size;
      // ★ 用 mtime 秒级 + 字节数（避免每 tick 读到毫秒抖动）
      parts.push(`${f}:${st.size}:${Math.floor(st.mtimeMs / 1000)}`);
    } catch {
      /* 读不到就跳过（下一 tick 会再看到）*/
    }
  }
  void bytes;
  return { count: files.length, hash: parts.join("|") };
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
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 五条猜想的辅助件（2026-10-20）
//
//   ★ 全在这里，不放别处 —— 便于审查时一眼看完"这五条到底依赖什么"。
//   ★★ 每个都是**纯函数或纯读盘**：不调模型、不改状态，可离线重判（纪律⑦）。
// ══════════════════════════════════════════════════════════════════════════

/** ★ 猜想 A：决策表的文件名（冻结）*/
export const TABLE_NAME = "_决策表.md";
/** ★ 猜想 D：章节登记表的文件名（冻结）*/
export const INDEX_NAME = "_章节登记.md";

/**
 * ★ 猜想 C 的判据：**正文里有没有「这条被推翻了」的记录**。
 *
 * ★★ 为什么用这些词而不是"修订"（跑前冻结，不许事后放宽）：
 *   「修订」太宽 —— 措辞收紧也叫修订，那不是推翻。
 *   这五类词各自意味着**原来的结论不再成立**。
 */
export const REVERSAL_RE =
  /推翻|被[^\n]{0,20}取代|降级|不再成立|判死|原判据[^\n]{0,12}(错|漏)|原来[^\n]{0,10}(信|以为)[^\n]{0,20}(不对|错)/;
//
// ★★★ 2026-10-20 探针抓到的一个真 bug（`micro/topology-probe.ts` 发现）：
//   原来写 `被取代` —— 要求两个字**紧挨着**。
//   而真实文本是「**被 `P26` 取代**」（中间夹着证据编号）⇒ **永远不命中**。
//   ★★ 这与 `onDispute` 判据写窄（只认 `verdict === "反对"`）是**同一个病**：
//     "我想的是那个词，数据里是另一种写法"。
//   ⇒ 修法：允许中间夹最多 20 字（编号、加粗符号、空格）。

/**
 * ★ 猜想 E 的判据：**产物自己声明没有新读数**。
 */
export const UNTESTED_RE =
  /0\s*次新\s*API|0\s*API|全部是.{0,12}重新解释|不含新读数|没有新读数/;

/** ★ 安全读产物正文（读不到就返回空串 —— ★ 不许因此让 tick 崩）*/
export function readArtifactSafe(name: string, outboxDir = join(LAB, "outbox")): string {
  try {
    return readFileSync(join(outboxDir, name), "utf8");
  } catch {
    return "";
  }
}

/** ★ 猜想 A：数决策表现有多少行（`| ` 开头的表格行，扣掉表头与分隔行）*/
export function countTableRows(outboxDir?: string): number {
  const body = readArtifactSafe(TABLE_NAME, outboxDir);
  if (!body) return 0;
  return body
    .split("\n")
    .filter((l) => /^\s*\|/.test(l))
    // 表头（含「情况」「判据」）与 |---| 分隔行不算
    .filter((l) => !/^\s*\|[\s-:|]+\|\s*$/.test(l))
    .filter((l) => !/情况/.test(l))
    .length;
}

/**
 * ★★★ 猜想 D：把正文里的章号引用抽出来。
 *
 * ★★ **与 `micro/checkChapterIndex.ts` 的 `extractChapterRefs` 同一条判据**
 *   （纪律⑪：判据与指令必须同源）。
 *   ★ 这里放宽了一处：**不去掉标题行** —— 因为要检查的是"这份产物声称自己是第几章"，
 *     那也算一种需要登记的引用。★ 但**去掉代码块**（里面是引用别人的文本）。
 */
export function extractChapterNumbers(text: string): number[] {
  const CN: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12,
  };
  const noCode = text.replace(/```[\s\S]*?```/g, "");
  const out = new Set<number>();
  for (const m of noCode.matchAll(/第([一二三四五六七八九十0-9]{1,3})章/g)) {
    const raw = m[1]!;
    const n = /^\d+$/.test(raw) ? Number(raw) : CN[raw];
    if (n !== undefined) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * ★ 猜想 D：登记表里已经登记了哪些章号。
 *
 * ★ 登记表的形状（冻结）：
 *   `| 章号 | 标题 | 一句话主张 | 来源产物 |`
 *   第一列是「第N章」或纯数字。
 */
export function readChapterIndexRows(outboxDir?: string): Set<number> {
  const body = readArtifactSafe(INDEX_NAME, outboxDir);
  const out = new Set<number>();
  if (!body) return out;
  const CN: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12,
  };
  for (const line of body.split("\n")) {
    // ★★★ 2026-10-20 探针抓到的第二个真 bug：
    //   原来正则要求「第一格就是章号」⇒ 只要表里多一列序号（`| 1 | 第4章 | … |`）
    //   或第一格是「章号」表头，就**整张表都解析不出来**（返回空集 ⇒ 全部误报悬空）。
    //   ★★ 修法：**扫描整行的所有格子**，任一格形如「第N章」或纯数字即认。
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    const hasChapterWord = /章/.test(line);
    for (const cell of cells) {
      const m = cell.match(/^第?([一二三四五六七八九十0-9]{1,3})章?$/);
      if (!m) continue;
      const raw = m[1]!;
      // ★ 纯数字且本行没有"章"字 ⇒ 可能是别的列（如序号），跳过
      if (/^\d+$/.test(raw) && !hasChapterWord) continue;
      const n = /^\d+$/.test(raw) ? Number(raw) : CN[raw];
      if (n !== undefined) out.add(n);
    }
  }
  return out;
}


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
   * ★★★ 观众（设计者 2026-10-19）：「加一个『观众』，最后观众最被说服哪个观点就写哪个观点」
   *
   * ★ 未接（hunt / 无观众的 forge）时为 `undefined` ⇒ `onAudience` 直接不触发。
   */
  audience?: () => string[];
  /**
   * ★★★ 每份产物**已收到几张观众票**（2026-10-20）。
   *
   * 为什么需要：`onAudience` 原来只判"推过没有"（`audienceAsked`），
   * ★★ 而"推过"≠"投了"——实测 46 份里只有 **15 份 4 票齐全**，
   *    25 份只拿到 **1 票**。`usabilityGate` 因此把它们判成「没人问过」。
   *
   * ⇒ 改成按**覆盖度**挑：先补票数最少的那几份。
   */
  voteCoverage?: (artifact: string) => number;
  /** ★ 把话送到某位观众 */
  tellAudience?: (key: string, text: string) => void;
  /** ★★ 查某份产物的签字表（共识门的状态）*/
  /**
   * ★ 某份产物当前的签字表（团队 → 记录）。
   *
   * ★★ 类型从 `Map<string, unknown>` 收窄成带 `verdict`/`reason` 的形状 ——
   *   2026-10-20 加「认可保留」时需要读 `verdict` 判断谁有保留、谁已背书，
   *   `unknown` 逼得每处都要 cast（那正是漏判的来源）。
   */
  signoffState?: (artifact: string) =>
    | Map<string, { verdict: string; reason: string; dislodge?: string }>
    | undefined;
  /** ★ 全体团队（门的判据）*/
  allTeams?: () => string[];
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
   * ★★★ 上一位 inspector 是否还在跑（**改成异步之后才需要**）。
   *
   * ★ 为什么必须有：以前 `await fire(...)` 天然串行 —— 一个 tick 里只可能有一位。
   *   现在 tick 每 30s 就问一次，而专家要跑 3–6 分钟 ⇒ **会堆十几个 inspector**
   *   ⇒ 每份产物被审十几遍，成本翻十几倍，还互相矛盾。
   *
   * ★★ 它不是"新增机制"，是把 `await` 原来提供的那条**隐含保证**显式写出来。
   *   换成异步就必须自己保证 —— 否则就是拿"不阻塞"换"失控"。
   */
  inspectorInFlight?: boolean;
  /** ★ 这一位是什么时候开始跑的（只为日志里说清"已跑了多久"） */
  inspectorSince?: number;
  /**
   * ★★★ 连续几次检查**没有进展**（2026-10-19 微实验 G 换过定义）。
   * ★ 进展 = 交了新成果 **或** 更新了 `CONVERGED.md` —— ★ 不是"有没有动作"。
   */
  roundsSinceProgress: number;
  /** ★ outbox 的内容指纹（v5：判「有没有改内容」，不只数个） */
  outboxHash?: string;
  /** ★ 连续「在干活但没产出」的轮数（v4 判据用它做延缓） */
  busyStreak?: number;
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
  /** ★★★ 已请观众评过的产物（设计者 2026-10-19）*/
  audienceAsked: string[];
  /** ★★★ 已请过签字的产物 */
  signedAsked: string[];
  /** ★ 请过谁给「有保留」背书的产物（★ 只请一次，否则每 tick 轰炸）*/
  endorseAsked: string[];
  /** ★★★ 已送过"联合实验"处境的产物 */
  disputeAsked: string[];

  // ══════════════════════════════════════════════════════════════
  // ★★★ 2026-10-20 · 五条猜想各自一本账（★ 第五本、第六本…）
  //
  //   为什么**又是新账**（不是复用上面那些）：
  //     上面五本各自答一个不同的问题（审了吗/有产出吗/辩了吗/评了吗/签了吗）。
  //     下面五个答的是**另外五个问题**（进表了吗/写了吗/推翻写了吗/查过章号吗/查过可跑吗）。
  //   ★★ 教训（本项目反复踩）：一个状态两个写者 ⇒ 判据恒 false。
  //     所以规矩不变：**一条规则一本账，只增不共用**。
  // ══════════════════════════════════════════════════════════════
  /** ★ 猜想 A：已并入决策表的产物 */
  tabledOutputs: string[];
  /** ★ 猜想 B：已催过"你自己写一份"的席位 */
  silentAsked: string[];
  /** ★ 猜想 C：已因"含推翻记录"而要求写故事的产物 */
  falsifyAsked: string[];
  /** ★ 猜想 D：已检查过章引用的产物 */
  indexChecked: string[];
  /** ★ 猜想 E：已问过"能不能变成可执行判定"的产物 */
  untestedAsked: string[];
};

/**
 * ★★★ 五条猜想的**开关**（2026-10-20）。
 *
 * ★ 为什么要有开关（不是直接改死）：
 *   纪律⑱ 单变量 —— 一次只能开一条，否则"哪条起了作用"说不清。
 *   ★★ 默认**全关** ⇒ 不开开关时行为与拆分后完全一致（可回退、可对照）。
 *
 * 开法：`CLUSTER_RULES=table,silent,falsify,index,untested`
 *      或 `CLUSTER_RULES=all`
 */
export const RULE_SWITCHES = ["table", "silent", "falsify", "index", "untested"] as const;
export type RuleSwitch = (typeof RULE_SWITCHES)[number];

export function enabledRules(): Set<RuleSwitch> {
  const raw = (process.env.CLUSTER_RULES ?? "").trim();
  if (!raw) return new Set();
  if (raw === "all") return new Set(RULE_SWITCHES);
  const want = new Set(raw.split(",").map((x) => x.trim()) as RuleSwitch[]);
  // ★ 拼错的开关**必须响亮**（否则"我开了但它没跑"会被当成"没效果"）
  for (const w of want) {
    if (!RULE_SWITCHES.includes(w)) {
      throw new Error(`未知规则开关：\`${w}\`（可用：${RULE_SWITCHES.join(" / ")} 或 all）`);
    }
  }
  return want;
}

export function newState(): State {
  // ★ 初始化时先把当前的 work/ mtime 记下来 —— 否则第一轮会把"开工前就有的文件"判成活动。
  return {
    auditedOutputs: 0,
    seenOutboxCount: 0,
    roundsSinceProgress: 0,
    busyStreak: 0,
    firedAt: {},
    lastActiveAt: Date.now(),
    lastWorkMtime: 0,
    lastConvergedMtime: convergedMtime(),
    challengedOutputs: [],
    audienceAsked: [],
    signedAsked: [],
    endorseAsked: [],
    disputeAsked: [],
    tabledOutputs: [],
    silentAsked: [],
    falsifyAsked: [],
    indexChecked: [],
    untestedAsked: [],
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
      // ★★★ 2026-10-20 五条猜想（全部可选 —— 不开开关时行为与原来完全一致）
      onTable?: () => Promise<void>;
      onSilentSeat?: () => Promise<void>;
      onFalsify?: () => Promise<void>;
      onChapterIndex?: () => Promise<void>;
      onUntested?: () => Promise<void>;
      onCapabilityGap: () => Promise<void>;
      onPlateau: () => Promise<void>;
      onNewFinding: () => Promise<void>;
      onAudience: () => Promise<void>;
      onConsensus: () => Promise<void>;
      onDispute: () => Promise<void>;
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
  // ★★★ 顺序很重要（2026-10-19 夜间实测踩到两次）：
  //   ① `onAudience` / `onConsensus` **必须排在 `onSettled` 之前**。
  //      ★ 因为 `onSettled` 里 `await fire("inspector")` 会**等专家跑完（几分钟）**，
  //        整个 tick 被卡住 ⇒ 排在它后面的规则**一个都轮不到**。
  //      ★★ 实测症状：日志里 `fire inspector` 之后全是「tick 被跳过（上一次还在跑）」，
  //        观众的 `onAudience` 一次都没出现 ⇒ 4 位观众零表态。
  //   ② 这两条规则**不 fire 专家**（只给别人发消息），所以放在前面不会卡。
  await rules.onAudience();
  await rules.onConsensus();
  await rules.onDispute();
  await rules.onNewFinding();
  await rules.onCapabilityGap();
  await rules.onPlateau();
  // ★★★ 2026-10-20 五条猜想：**都放在 onSettled 之前、onPlateau 之后**。
  //
  //   ★★ 为什么不能放前面：onTable / onFalsify / onChapterIndex / onUntested
  //     都会 `await fire("archivist")` —— archivist 要跑**几分钟**。
  //     若排在 onAudience/onConsensus 前面 ⇒ 那两条又会被饿死（这正是 2026-10-19 的教训）。
  //   ★ onSilentSeat 也 fire 席位，同理。
  //   ★★★ 所以顺序是：**不 fire 的规则在前，fire 的规则全部在尾部**。
  await rules.onTable?.();
  await rules.onSilentSeat?.();
  await rules.onFalsify?.();
  await rules.onChapterIndex?.();
  await rules.onUntested?.();
  // ★★★ `onSettled` **必须放最后**：它会 `await fire("inspector")`（等专家几分钟），
  //   是唯一会长时间阻塞 tick 的规则 ⇒ 放在前面会把后面的规则全部饿死。
  //   ★ 副作用提醒：`onSettled` 自己记 `auditedOutputs`，所以它之后不要再读那个字段。
  await rules.onSettled();
}

export function makeRules(ctx: TriggerCtx) {
  const { state, fire: fireNow } = ctx;

  /**
   * ★★★ 2026-10-20 · 观察与派活分开（第三版，前两版都错）
   *
   * ★★★ 谁有权改这里（设计者澄清，我以前理解错过）：
   *   「**你（研究助手）是可以改框架的**，只是**研究员集群不能自己改自己的框架**」
   *   ⇒ 规则表属于框架。改它是研究助手的活（这正是"研究怎么设计集群"）。
   *   ★ 我一度把「框架不能变」读成「我也不能动框架」——
   *     那是把**对集群的约束**错当成**对我的约束**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 病（实测）
   *
   *   规则表里有 9 处 `await fire(...)`，专家每次跑 3–6 分钟，
   *   而 `tick()` 串行 `await` 每条规则 ⇒ **整个 tick 停在那里**。
   *   实测：180s 窗口 tick 只跑 1 次（该 ~6）· 600s 只跑 3 次（该 ~20）
   *   ⇒ 后面规则全被饿死 ⇒ `onChapterIndex` 从上线起 **0 次触发**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 我走过的两条错路
   *
   *   ① `await fire(...)` 原状：tick 被专家卡住 3–6 分钟
   *   ② `void fire(...)`   只让 tick 不等：★ **一个 tick 里能同时 fire 好几个**
   *      实测：一个 tick 里 archivist + inspector 同时开工。
   *      ⇒ 成本不可控、日志交错、且 9 处返回值全变成 `""`（语义被悄悄改掉）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 现在这条（③）：**观察快、派活慢，两件事分开**
   *
   *   规则里 `await fire(...)` = 「**记下**该派谁」（几微秒，立刻返回）
   *   真正的派活由 drainer 做：**同一时刻只跑一位专家**，跑完取下一个。
   *
   *   ★ 于是：tick 永不被卡 / 一次只有一位专家（成本可控、日志不交错）/
   *     规则照旧按顺序写 / `onSettled` 通过 `onDone` 拿到 `VERDICT`。
   *
   *   ★★★ 为什么不并发派所有专家：成本。一轮 6 席位约 2–3× 单员工（≈$3–5/小时），
   *     同时起 3 个专家直接翻数倍，且它们会**互相矛盾地改同一批东西**。
   *     AGENTS §三：forge 的病是「还在散记，只是写得更长」——
   *     派更多专家只会让它写得更长，不会让它更收敛。
   */
  const drainer = makeDrainer({
    doFire: (role, why, focus) => fireNow(role as ExpertName, why, focus),
    trace: (what, detail) => ctx.trace(what, detail),
    closing: () => !!ctx.closing?.(),
  });

  /**
   * ★ 规则里用的 `fire` —— **记下**该派谁，立刻返回。
   *
   * ★★ 返回值恒为 `""`：这层语义是"排队成功"，不是"专家说完了"。
   *   需要专家原话的（目前只有 `onSettled`）用 `fireNow(...).then(...)`。
   */
  const fire = ((role: ExpertName, why: string, focus?: string): Promise<string> => {
    drainer.enqueue({ role, why, focus });
    return Promise.resolve("");
  }) as TriggerCtx["fire"];

  /** 情况 A：有新产物 → 审查（★ 收敛时就顺便要它判停，C7） */
  async function onSettled(): Promise<void> {
    // ★ 收尾态：不再 fire 新专家（已 fire 的会跑完）
    if (ctx.closing?.()) return;
    const outs = listOutbox();
    ctx.trace("onSettled", `outbox=${outs.length} auditedOutputs=${state.auditedOutputs}`);
    if (outs.length > state.auditedOutputs) {
      // ★★★ 先推进再排队：drainer 是**排队**的，这一批可能几分钟后才被审
      //   ⇒ 不先推进的话，每个 tick 都会因为"还有未审的"再排一位
      state.auditedOutputs = outs.length;
      const converged = outs.some((f) => /CONVERGED/i.test(f));
      const why = converged
        ? `研究员写了收敛声明（\`outbox/CONVERGED.md\`），且 outbox 现有 ${outs.length} 份成果。`
        : `研究员刚产出新东西（outbox 现有 ${outs.length} 份）。`;
      const focus = converged ? (await import("../prompts/inspector.ts")).CONVERGED_FOCUS : "";

      // ★★★ 2026-10-20 · 不阻塞 tick（设计者选 (b)）
      //
      //   改前：`const out = await fire("inspector", ...)` —— 专家跑 3–6 分钟，
      //        tick 就停 3–6 分钟 ⇒ **后面所有规则饿死**。
      //        实测：180s 窗口 tick 只跑 1 次（该 ~6 次）· 600s 只跑 3 次（该 ~20 次）
      //        ⇒ 实际频率只有设计值的 1/6~1/7。
      //        后果：排在后面的规则判据命中了却 **0 次触发**（不是不工作，是被饿死）。
      //
      //   ★★ 为什么不用 `void fire(...)`：`onSettled` 要读 `VERDICT: STOP|CONTINUE`
      //      来更新 `state.verdict`。`void` 掉就永远拿不到那行 ⇒ 依赖它的
      //      `onPlateau` 等规则跟着坏 —— **修一个坏两个**。
      //
      //   ★ 所以：**tick 立刻返回，结果照样回到该去的地方**。
      //     语义与 `await` 完全一致，只是不占住 tick。
      //   ★★★ 失败也要走回调（`.catch`）—— 否则 `state.verdict` 会停在旧值，
      //      而调用方以为自己“等过了”（本项目栽过“静默不响”三次）。
      // ★★★ 走 drainer（**同一时刻只有一位专家在跑**）
      //
      //   ★ 为什么不直接调 `fireNow`：那会绕过派活器 ⇒ 一个 tick 里
      //     archivist 和 inspector 同时开工（实测发生过）。
      //   ★★ 为什么要 `inspectorInFlight`：drainer 一次只跑一位，但
      //     **排队的** inspector 可能攒好几个 ⇒ 这一位还没回来就不要再排。
      if (state.inspectorInFlight) {
        const waited = Math.round((Date.now() - (state.inspectorSince ?? Date.now())) / 1000);
        // ★★★ 2026-10-20 · 超时兜底（实测：inspector 跑了 900s+ 没回来，
        //   期间 `onSettled` 反复打"还在跑，不重复叫"，**审查停摆 15 分钟**）。
        //
        //   ★ 为什么需要它：`inspectorInFlight` 只在 `onDone` 里清零。
        //   ★★ 如果那次 run **永不回调**（崩了 / 被 dispose 截断 / 网络挂住），
        //     标志就**永久为 true** ⇒ `onSettled` **永久失效**（静默停摆）。
        //   ★ 这和"一次失败就永远不再审查"是同一类病 —— 已有注释提醒过一半。
        //
        //   ★ 阈值怎么定（不是我拍的）：实测一次正常 inspector 产出 5047 字，
        //     耗时约 **300–900s**。取 **1800s（30 分钟）** = 实测最长的 2 倍，
        //     只用来兜「永不回来」，不会误杀正常的长任务。
        const STALE_MS = 1800_000;
        if (Date.now() - (state.inspectorSince ?? Date.now()) > STALE_MS) {
          ctx.trace(
            "onSettled",
            `⚠ inspector 已 ${waited}s 没回来 ⇒ **判定失联，强制清零**（否则审查永久停摆）`,
          );
          state.inspectorInFlight = false;
        } else {
          ctx.trace("onSettled", `上一位 inspector 还在跑（已 ${waited}s），不重复叫`);
          return; // ★ 不推进 auditedOutputs —— 等它回来再判这一批
        }
      }
      state.inspectorInFlight = true;
      state.inspectorSince = Date.now();
      drainer.enqueue({
        role: "inspector",
        why,
        focus,
        onDone: (out) => {
          // ★ 无论成败都要清 —— 否则一次失败就永远不再审查（静默停摆）
          state.inspectorInFlight = false;
          if (!out) {
            ctx.trace("onSettled", `⛔ inspector 没说话（verdict 保持 ${state.verdict ?? "未定"}）`);
            return;
          }
          const v = out.match(/VERDICT:\s*(STOP|CONTINUE)/i);
          if (v) state.verdict = v[1]!.toUpperCase() as "STOP" | "CONTINUE";
        },
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

    // ★★★ v5（2026-10-20）：产出 = **文件集合变了 或 内容变了**，不只是个数变了。
    //
    //   实测：一轮里 `git diff --stat` 是 **15 files changed, +592/-195**，
    //   而判据说 `产出=false`（因为份数只从 64 变 65）⇒ 平台期被误判。
    //   ★ 见 `outboxFingerprint()` 的注释。
    const fp = outboxFingerprint();
    const contentChanged = state.outboxHash !== undefined && state.outboxHash !== fp.hash;
    const produced =
      outs > state.seenOutboxCount || contentChanged || convM > state.lastConvergedMtime;
    // ★ 首次（outboxHash 未定）不算变化 —— 否则第一 tick 就误报一次
    if (state.outboxHash === undefined || contentChanged) state.outboxHash = fp.hash;

    // ══════════════════════════════════════════════════════════════
    // ★★★ v4 判据（第四次定义，2026-10-20 实测推翻 v3 的一半）
    //
    //   病（实测，forge 63 份产物的一轮）：
    //     ```
    //     onPlateau outbox=63 新文件=373 产出=false 在干活=true roundsSinceProgress=0/3
    //     onPlateau outbox=63 新文件=211 产出=false 在干活=true roundsSinceProgress=0/3
    //     ```
    //   ★★★ **`work/` 里新出 373 / 211 个文件，而 outbox 一份没出**，
    //     判据却说"健康" ⇒ 平台期计数**永远被清零** ⇒ 整轮只算到过 1/3 ⇒ **从未触发**。
    //
    //   ★ 后果：集群在 `work/` 里忙 5 小时（写脚本、跑数据），
    //     **书一份没增加**，而"换视角 + 重审目标"这条规则一次没响。
    //
    //   ★★ 为什么 v3 会写成这样：它是为了治 v2 的病
    //     （"跑实验时被判卡住"——研究员自己抓到的）。
    //     但治过头了：**写实验可以无限持续，产出可以为零**。
    //
    //   ★★★ v4：`busy` 保留，但**只用来"延缓"，不用来"清零"**。
    //     · 有产出                ⇒ 清零（真进展）
    //     · 没产出但在干活        ⇒ **也递增**，只是每两轮才 +1（延缓一倍）
    //     · 没产出也没在干活      ⇒ 正常递增
    //   ★ 这样"长期只写实验不出东西"**会被判成平台期**（正是病的样子），
    //     而"跑一轮大实验后马上交产出"仍然不算卡住（v2 的病没回来）。
    const progressed = produced;
    void busy;

    if (produced) {
      if (outs > state.seenOutboxCount) state.seenOutboxCount = outs;
      if (convM > state.lastConvergedMtime) state.lastConvergedMtime = convM;
    }
    state.lastTickAt = Date.now();

    if (progressed) {
      state.roundsSinceProgress = 0;
      state.busyStreak = 0;
    } else if (busy) {
      // ★ 在干活但没产出 ⇒ **延缓**（每 2 轮才 +1），不是清零
      state.busyStreak = (state.busyStreak ?? 0) + 1;
      if (state.busyStreak % 2 === 0) state.roundsSinceProgress++;
    } else {
      state.busyStreak = 0;
      state.roundsSinceProgress++;
    }

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
    for (const k of peers.slice(0, n)) {
      const r = (ctx.challenge as unknown as (k: string, t: string) => { ok: boolean; reason?: string })(k, text);
      if (r && !r.ok) ctx.trace("onNewFinding", `⛔ 投递失败 ${k}：${r.reason ?? "未知"}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // onAudience —— ★★★ 请观众表态（设计者 2026-10-19）
  // ══════════════════════════════════════════════════════════════
  //   设计者：「加一个『观众』，最后观众最被说服哪个观点就写哪个观点」
  //          「所有观众都支持某个观点（或达到 9 成支持）就结束争辩写入 book」
  //
  // ★★ 这个规则**只负责把话送到观众那儿**；判"是否结束争辩"在 `judge` 工具里
  //    （纯函数 `resolveVotes`，可离线重判）。
  // ★ 未接观众时（hunt / 单员工 forge）直接不触发。
  async function onAudience(): Promise<void> {
    if (!ctx.audience) return;
    if (ctx.closing?.()) return;
    const outs = listOutbox();
    // ★ 至少要有产物可评
    if (outs.length === 0) return;
    // ★★ 一份产物只请一次（避免每 tick 都轰炸观众 —— 它们会被淹）
    //
    // ★★★ 2026-10-20 改：从「每 tick 1 份」改成「每 tick 最多 3 份」。
    //
    //   病（实测）：24 份产物，`onAudience` 每 tick 只推 1 份 ⇒ 要 24 个 tick。
    //   ★★★ 后果：**newcomer 在 62%（15/24）的产物上根本没被问过**。
    //     而 `usabilityGate` 一算：卡住的 16 份里 **15 份是"没人问过"**，不是"问了说不行"。
    //   ⇒ **不是内容不可用，是机制没问。**
    //
    //   ★ 为什么原来写 1：注释说"避免每 tick 都轰炸观众，它们会被淹"。
    //   ★★ 但观众**本来就不做别的事**（只评产物），而专家那边有派活器限并发。
    //     所以"淹"的担心不成立 —— 真正被淹的是 tick 节奏，不是观众。
    //
    //   ★ 为什么是 3 而不是全部：一次推 24 份等于没有排序，观众会挑好读的评。
    //     3 份是**一屏能看完**的量，且 24 份只需 8 个 tick（实测 420s 跑 5 tick，
    //     长窗口足够；短窗口也比 24 个 tick 快 3 倍）。
    // ★★★ 2026-10-20（第三次改这条规则）· 按**覆盖度**挑，不按"推过没有"。
    //
    //   病：原来 `audienceAsked` 记的是"推过"，而**推过 ≠ 投了**。
    //   ★★ 实测（46 份 / 98 票，去重后）：
    //     4 票齐全 **15 份** · 3 票 1 份 · 2 票 5 份 · **1 票 25 份**
    //   ⇒ 25 份只被一个观众看过 ⇒ `usabilityGate` 判「没人问过」。
    //
    //   ★ 为什么不是"再推一遍全部"：那会重复轰炸已评满的（14 票/份的怪象就是这么来的）。
    //   ★★ 正解：按**当前票数**排序，先补最少的。
    const need = (f: string) => (ctx.voteCoverage ? ctx.voteCoverage(f) : 0);
    // ★ 只在「还没评满」的里面挑；评满（= 观众人数）的不再打扰
    const maxTickets = ctx.audience!().length;
    const pending = outs
      .filter((f) => need(f) < maxTickets)
      .sort((a, b) => need(a) - need(b))
      // ★★★ 2026-10-20（第四次改）· 从 3 份降到 **1 份**。
      //
      //   病（实测 120 票 / 49 题，去重后）：
      //     4 票齐全 **16 题（33%）** · 2-3 票 4 题 · **1 票 29 题（59%）**
      //   ★ 各观众的覆盖率却都差不多（24–27/49）—— 说明**不是某个人偷懒**，
      //     而是"每份产物只有一个人评过"。
      //
      //   ★★★ 根因：一次推 3 份 ⇒ 观众收到 3 个题目 ⇒ 它**评 1–2 个就结束这一轮**。
      //     "推了 3 份"和"评了 3 份"不是一回事 —— 我又栽在同一个坑（推过 ≠ 做了）。
      //
      //   ★ 修法：**一次只推 1 份**。这样"收到 1 题"≈"评 1 题"，
      //     4 个观众各自开工时都会看到同一份 ⇒ 4 票齐的概率最大化。
      .slice(0, 1);
    if (pending.length === 0) return;
    for (const target of pending) {
      if (!state.audienceAsked.includes(target)) state.audienceAsked.push(target);
    }
    ctx.trace(
      "onAudience",
      `请观众评 ${pending.map((f) => `\`${f}\`(${need(f)}/${maxTickets}票)`).join("、")}` +
        `（推过 ${state.audienceAsked.length}/${outs.length}）`,
    );
    for (const target of pending) {
      const text = [
        "## 🎬 请你们评判：" + target,
        "",
        "★ 三个团队（theory / practice / landing）在争同一件事。",
        "★★★ 你的活只有一个：**谁最说服了你？**",
        "  · 用 `judge` 工具表态（theory / practice / landing / **都不够**）",
        "  · ★ 理由按**你自己的标准**说 —— 你就是按你的身份在看这件事的",
        "  · ★★ 若选「都不够」，**一定**填 missing 字段：缺什么才能说服你",
        "",
        "★★ 不要客气。全体观众支持某一方时争辩才结束 —— **你的不同意见很重要**。",
        "★ 问题（judge 的 question 参数请原样用这句）：**" +
          target +
          " 这份东西该不该进书，哪一方的说法最站得住？**",
      ].join(String.fromCharCode(10));
      for (const k of ctx.audience()) {
        const r = (ctx.tellAudience as unknown as (k: string, t: string) => { ok?: boolean; reason?: string })(k, text);
        if (r && r.ok === false) ctx.trace("onAudience", `⛔ 投递失败 ${k}：${r.reason ?? "未知"}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // onConsensus —— ★★★ 把「去签字」变成处境（不是能力）
  // ══════════════════════════════════════════════════════════════
  //   ★★★ 为什么必须有这条规则（我自己的实测规律 `P13`）：
  //     上一版把 `sign_off` 只当**工具**给下去 ⇒ 与 `challenge` 工具版一模一样的坑
  //     ⇒ **一次都不会用**。而共识门没签字 ⇒ 什么都进不了书。
  //   ★★ 所以：产物一出现，就由**代码**把「请你团队去签字」送到其他团队面前。
  //
  //   ★ 只送一次（`signedAsked`），否则每 tick 都轰炸。
  async function onConsensus(): Promise<void> {
    if (!ctx.challenge || !ctx.peerKeys) return;
    if (ctx.closing?.()) return;
    if (!ctx.signoffState) return;
    const outs = listOutbox();
    if (outs.length === 0) return;
    const teams = ctx.allTeams?.() ?? [];
    // ★ 找一份「还没被全体团队表态」**且还没请过**的产物
    //
    // ★★★ 2026-10-20 修 bug（离线实验：`micro/experiment-consensus.ts`）：
    //   原来是
    //     const target = outs.find((f) => 有团队没签);
    //     if (!target || state.signedAsked.includes(target)) return;   ← ★ 卡死点
    //   ★★ 症结：`find` 每次都返回**同一份**（第一份没签全的），
    //     而它一旦进了 `signedAsked`，`return` 就把它**永久挡住** ⇒ 后面的永远轮不到。
    //
    //   ★★★ 实测后果（真实 24 份 outbox + 真实签字表，0 API）：
    //     改前：被请签字 1/24 份 · **landing 0/9 份**
    //     改后：被请签字 12/24 份 · **landing 9/9 份**
    //   ⇒ `landing-reader` 写了 7 份、`landing-edge` 1 份，**全部因这个 bug 没被请过签字**，
    //     而它们的「第六章/七/八/十一章」正是书里缺的读者侧骨架。
    //
    // ★ 修法：把「已请过」放进 `find` 的条件里（继续往后找），
    //   而不是找到之后才判。
    // ★★★ 2026-10-20 第二个 bug（承兑机制上线后实测出来的）
    //
    //   病：`onConsensus` 只给「**还没签过的**团队」发消息。
    //   ★★ 而「认可保留」需要**已经签过的**团队再表一次态 —— 他们**收不到任何消息**。
    //
    //   ★★★ 实测（真实签字表，0 API）：
    //     有保留的产物 **29 份**，其中 **28 份（97%）** 的其他团队**全都已签过**
    //     ⇒ 背书通道**根本不存在** ⇒ 背书率只有 3%（1/29）。
    //
    //   ★ 这不是"团队不愿背书"，是**机制没给机会**。
    //   ⇒ 修法：先找「有保留但没人承兑」的，给它一个**专门请背书**的消息。
    const resvTarget = outs.find((f) => {
      const sig = ctx.signoffState!(f);
      if (!sig) return false;
      if (state.endorseAsked.includes(f)) return false;
      const resv = teams.filter((t) => sig.get(t)?.verdict === "有保留");
      if (!resv.length) return false;
      // ★ 有没有人承兑（除保留者自己）
      const endo = teams.filter((t) => t !== resv[0] && sig.get(t)?.verdict === "认可保留");
      return endo.length === 0;
    });

    if (resvTarget) {
      const sig = ctx.signoffState(resvTarget)!;
      const resvTeams = teams.filter((t) => sig.get(t)?.verdict === "有保留");
      state.endorseAsked.push(resvTarget);
      // ★ 找**已经签过但不是保留者**的团队 —— 他们有资格背书
      const candidates = teams.filter((t) => t !== resvTeams[0] && sig.has(t));
      ctx.trace(
        "onConsensus",
        `请 ${candidates.join("、") || "（无人）"} 给 \`${resvTarget}\` 的保留背书（有保留：${resvTeams.join("、")}）`,
      );
      const detail = resvTeams
        .map((t) => {
          const r = sig.get(t)!;
          return [`· **${t}** 的保留：${r.reason}`, `  ★解除条件：${r.dislodge ?? "（没给）"}`].join(" ");
        })
        .join(String.fromCharCode(10));
      const ask = [
        `## ✍️ 有人提了保留，需要**你判断这条保留站不站得住**`,
        ``,
        `产物：` + resvTarget,
        ``,
        detail,
        ``,
        `---`,
        ``,
        `★★★ 机制说明（这是新加的一步）：`,
        `「有保留」现在**只是提议** —— 必须有**另一个团队说「认可保留」**才生效。`,
        `**没人认可的保留不算表态** ⇒ 这份产物进不了书。`,
        ``,
        "★ 所以请你二选一（用 sign_off）：",
        `· **认可保留** —— 你核过它的解除条件，认为**它站得住**（给同事背书）`,
        `· **认同**（改判为认同）—— 你认为这条保留**根本不必要**`,
        ``,
        `★★ 不要因为「不想卡住发布」就随便认可 —— 背书意味着**那条解除条件真的成立**。`,
        `★ 但也不要因为「已经签过了」就不回 —— 你这一次的态度决定它能不能进书。`,
      ].join(String.fromCharCode(10));
      for (const k of candidates) {
        const r = (ctx.challenge as unknown as (k: string, t: string) => { ok: boolean; reason?: string })(k, ask);
        if (r && !r.ok) ctx.trace("onConsensus", `⛔ 背书请求投递失败 ${k}：${r.reason ?? "未知"}`);
      }
      return; // ★ 一次只推一份
    }

    // ★★★★★ 2026-10-28 · 从「一次只推一份」改成**按批推**
    //
    // ★★★ 改前读数（离线复核，`signoffs.jsonl` + git 出生时间，0 API）：
    //   按产物**出生日**算「拿到首签的比例」是一条**单调下降**曲线：
    //     10-19 14/15 93% · 10-20 21/22 95% · 10-21 4/6 67%
    //     10-22 7/20 35% · 10-23 3/16 19% · **10-24 0/25 0%**
    //   ⇒ 存量 55 份产物**0 张签字**（`publish.md` 里 68 份被拒，其中 55 份拒因正是
    //     「未表态：theory、practice、landing」—— 不是被反对，是**从没被请过**）。
    //
    // ★★ 根因：`onConsensus` 每个 tick **只推进一份**（`find` + `return`），
    //   而 tick 节流 `THROTTLE_MS = 5 分钟` ⇒ 理论上限 **12 份/小时**。
    //   单看这个数似乎够 —— 但真实 tick 还要被 `closing`、`await fire` 阻塞、
    //   专家跑 3–6 分钟（一个 tick 就吃掉 1–3 个节流窗口）⇒ 实测远低于上限。
    //   10-24 那天进 25 份、签 6 张（比值 **0.2**，前几日是 5.3）：供给远超门的吞吐。
    //
    // ★★★ 这不是「它不愿意签」，是**机制没给机会** —— 与 2026-10-20 那次
    //   「背书通道根本不存在」是同一个病（纪律④：区分「它不听劝」和「它做不到」）。
    //
    // ★ 改法：每 tick 推进一批 `ASK_BATCH` 份，**每份各自成一条消息**（不合并 ——
    //   合并会让它一份都不细看，等于把门变宽。判据没松，只是**送得更多**）。
    // ★ 为什么必须有上限：不设上限 = 一 tick 给一位研究员塞几十份 ⇒ 它只会草率点头，
    //   那是把「沉默不算认同」偷换成「批量盖章算认同」。
    const ASK_BATCH = 4;
    const targets = outs
      .filter((f) => {
        const signs = ctx.signoffState!(f);
        return teams.some((t) => !signs?.has(t)) && !state.signedAsked.includes(f);
      })
      .slice(0, ASK_BATCH);
    if (!targets.length) return;

    for (const target of targets) {
    state.signedAsked.push(target);
    const signs = ctx.signoffState(target);
    const missing = teams.filter((t) => !signs?.has(t));
    ctx.trace("onConsensus", `请 ${missing.join("、")} 对 \`${target}\` 签字（已请 ${state.signedAsked.length} 份）`);
    const text =
      `## ✍️ 共识门：请你们团队对 \`outbox/${target}\` 签字

` +
      `★★★ 这个集群的规则是：**一份东西要进书，必须全体团队都签字**（沉默不算认同）。
` +
      `★ 目前还没表态的团队：**${missing.join("、")}**

` +
      `---

` +
      `★ 读完后用 \`sign_off\` 表一个态：
` +
      `  · **认同** —— ★ 并写清你**核对了什么**才同意的（不能凭空点头）
` +
      `  · **有保留** —— 可以进书，但你的保留意见会**附在产物里**随它走
` +
      `  · **反对** —— ⛔ 它进不了书，★ 你必须写出**反证或替代解释**

` +
      `★★ 反对不是终点：之后用 \`joint_experiment\` 和对手**一起设计实验**来判定谁对。
` +
      `★ 按你团队的立场看 —— **你看不到的问题，正是别的团队存在的原因**。`;
    // ★★★ 投递失败**必须响亮**（2026-10-19 夜间实测：静默失败导致三条规则空转 15 分钟）
    for (const k of missing) {
      const r = (ctx.challenge as unknown as (k: string, t: string) => { ok: boolean; reason?: string })(k, text);
      if (r && !r.ok) ctx.trace("onConsensus", `⛔ 投递失败 ${k}：${r.reason ?? "未知"}`);
    }
    } // ← targets 循环
  }

  // ══════════════════════════════════════════════════════════════
  // onDispute —— ★★★ 「有人反对」⇒ 请两方**共同设计一个实验**来判定
  // ══════════════════════════════════════════════════════════════
  //   ★★★ 为什么必须有这条（2026-10-19 夜间实测，判据跑前定死）：
  //     实测：**20 次签字、4 张反对票，而 `joint.jsonl` 仍然是 0**。
  //     ★ `joint_experiment` 和 `sign_off` 一样只作为**工具**给下去 ⇒ 与 `P13` 同型。
  //   ★★ 逻辑：反对票 = 双方对事实判断不同 ⇒ **只有实验能判** ⇒ 这不是"建议"，是处境。
  async function onDispute(): Promise<void> {
    if (!ctx.challenge || !ctx.peerKeys) return;
    if (ctx.closing?.()) return;
    if (!ctx.signoffState) return;
    const teams = ctx.allTeams?.() ?? [];
    for (const f of listOutbox()) {
      const signs = ctx.signoffState(f);
      if (!signs) continue;
      const id = `${f}`;
      if (state.disputeAsked.includes(id)) continue;
      // ★★★ 什么算"僵局"（2026-10-19 夜间 R9 实测修正）：
      //   原来只认 `verdict === "反对"` ⇒ 但门收紧后，真实的僵局形态是
      //   **「有保留但没给解除条件」**（那只算没表态）和 **「没表态」**。
      //   ★ 若不认这两种 ⇒ **门关了，却没有任何机制推动它往前走** ⇒ 死锁。
      //   ★★ 判据：一份产物**门没开**，且有团队**不是简单认同** ⇒ 就是僵局。
      const against = teams.filter((t) => {
        const rec = signs.get(t) as { verdict?: string; dislodge?: string } | undefined;
        if (!rec) return true; // 没表态
        if (rec.verdict === "反对") return true;
        if (rec.verdict === "有保留") return !rec.dislodge || rec.dislodge.trim().length < 10;
        return false; // 认同
      });
      if (against.length === 0) continue;
      state.disputeAsked.push(id);
      ctx.trace("onDispute", `\`${f}\` 有 ${against.length} 方反对（${against.join("、")}）⇒ 送去联合实验`);
      const text =
        `## 🔬 分歧已登记：\`outbox/${f}\`\n\n` +
        `★★★ **这份东西现在过不了门** —— 这些团队还没给结论：**${against.join("、")}**。\n` +
        `  （★ 反对票 / 有保留但没说解除条件 / 干脆没表态 —— 三种都算）\n` +
        `★ 按这个集群的规则：**门没开 ⇒ 它进不了书**，必须先辩清楚。\n\n` +
        `---\n\n` +
        `★★ 而「谁对」**辩是辩不出来的** —— 只有实验能判。\n` +
        `★ 所以请你们**用 \`joint_experiment\` 和对方一起设计一个判定实验**：\n` +
        `  1. \`action="propose"\` —— 写清：要判什么（可判死的一句话）、几个臂、**判据（纯函数源码）**\n` +
        `  2. 对方 \`action="sign"\` —— 认同 / **要求加臂** / 反对\n` +
        `  3. 全体签好之后 \`action="run"\` 取回装置骨架，真跑\n\n` +
        `★★ 为什么必须**共同**设计：单方设计的实验，对方**天然不信它的判据**。\n` +
        `★ 若你只是「有保留」—— 要么给出**可执行的解除条件**（如「再加一个对照臂 N=8」），\n` +
        `  要么直说你其实同意或反对。**没有结论的保留不算表态**，门会一直关着。`;
      for (const k of [...new Set([...against, ...teams])]) {
        const r = (ctx.challenge as unknown as (k: string, t: string) => { ok: boolean; reason?: string })(k, text);
        if (r && !r.ok) ctx.trace("onDispute", `⛔ 投递失败 ${k}：${r.reason ?? "未知"}`);
      }
      break; // ★ 一次只推一份，别把他们的上下文淹了
    }
  }


  // ══════════════════════════════════════════════════════════════════════════
  // ★★★ 2026-10-20 · 五条猜想（见 `research/docs/集群设计/forge/五猜想-详细拓扑设计-2026-10-20.md`）
  //
  //   ★ 全部默认**关闭**（`CLUSTER_RULES` 不开 ⇒ 与拆分后行为完全一致）。
  //   ★★ 纪律⑱：一次只开一条，否则分不清哪条起了作用。
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * ★ 猜想 A · 决策表 —— 新产物并入 `情况→判据→动作→代价→边界` 那张表。
   *
   * ★★★ 为什么是「表」不是「章」：书自己的前言写着「如果你在踩坑：按『什么情况 → 怎么做』组织」，
   *   而实际进书的 10 份是散文。⇒ forge 在做「重述」，不是「体系化」。
   *
   * ★ 判据：≥2 份未并入表的产物（1 份不成表，只会加一列）。
   */
  async function onTable(): Promise<void> {
    if (ctx.closing?.()) return;
    const outs = listOutbox().filter((f) => f !== TABLE_NAME);
    const pending = outs.filter((f) => !state.tabledOutputs.includes(f));
    if (pending.length < 2) return;
    if (Date.now() - (state.firedAt["archivist"] ?? 0) < COOLDOWN_MS) return;

    state.firedAt["archivist"] = Date.now();
    state.tabledOutputs.push(...pending);
    const rows = countTableRows();
    ctx.trace("onTable", `${pending.length} 份待并入表 · 表现有 ${rows} 行`);

    await fire(
      "archivist",
      `有 ${pending.length} 份新产物还没进决策表：${pending.map((p) => `\`${p}\``).join("、")}。\n` +
        `★ 表在 \`outbox/${TABLE_NAME}\`（现有 ${rows} 行，没建就建）。\n` +
        `★★ 你**只做三件事，不要写新章**：\n` +
        `  1. **加行**：每份产物给一行「什么情况 → 判据 → 该做什么 → 代价 → 边界」五格\n` +
        `  2. **改行**：若它推翻了某行，把那行标 🔁 并指向新行（★ 不要删 —— 读者要知道它错过）\n` +
        `  3. **报冲突**：若两行的「该做什么」在这种情况下矛盾，写进表末「未裁决」栏\n` +
        `★★★ 判死条件：某份产物**填不满五格**（尤其说不出边界）⇒ 不要硬填，\n` +
        `   把它列进「还进不了表」栏，并写清缺哪一格。`,
    );
  }

  /**
   * ★ 猜想 B · landing 真的写产物。
   *
   * ★★★ 实测（2026-10-20）：`landing/reader` 与 `landing/edge` **各 0 份产物**，
   *   而 `theory-mapper` 一人写了 6 份。
   *   ⇒ 设计者裁定「观众最被说服哪个观点就写哪个观点」**失效** ——
   *     landing 没有观点，观众只能在 theory 造好的选项里挑。
   *
   * ★ 判据：某 landing 席位 0 份产物，且 outbox 已有 ≥5 份（有事可评了）。
   */
  async function onSilentSeat(): Promise<void> {
    if (ctx.closing?.()) return;
    const outs = listOutbox();
    if (outs.length < 5) return;
    if (!ctx.peerKeys) return;

    for (const seat of ctx.peerKeys()) {
      if (!seat.startsWith("landing/")) continue;
      if (state.silentAsked.includes(seat)) continue;
      if (outs.some((f) => f.includes(seat.replace("/", "-")))) continue; // 它写过
      if (Date.now() - (state.firedAt[seat as ExpertName] ?? 0) < COOLDOWN_MS) continue;

      state.silentAsked.push(seat);
      state.firedAt[seat as ExpertName] = Date.now();
      ctx.trace("onSilentSeat", `${seat} 至今 0 份产物（outbox ${outs.length} 份）`);
      await fire(
        seat as ExpertName,
        `★ 你已经评了 ${outs.length} 份别人的产物，但**你自己一份都没写**。\n` +
          `★★ 这个集群不是审稿会 —— 你这一队的职责是**产出读者侧的东西**。\n` +
          `★★★ 现在请你交一份产物（不是意见、不是评审）：\n` +
          `  · \`reader\`：写**读者会在哪里卡住**的具体现场 —— 拿一章真去照做，卡在哪一步、缺哪句话\n` +
          `  · \`edge\`：给「这条在什么条件下不成立」一个反例或一次实测\n` +
          `★ 判据：你交的必须是**一种新的产物**，不是对现有章末的补充。`,
      );
    }
  }

  /**
   * ★ 猜想 C · 推翻故事。
   *
   * ★★★ 依据：hunt 的 `CONVERGED` 有 7 条被推翻/降级（🔁4 + 📉3），而书里 **0 条**。
   *   读者最该学的不是「这些结论都对」，是**怎么发现自己错了**。
   *
   * ★ 判据：产物正文含推翻/降级字样，且还没有对应的独立故事。
   */
  async function onFalsify(): Promise<void> {
    if (ctx.closing?.()) return;
    for (const f of listOutbox()) {
      if (state.falsifyAsked.includes(f)) continue;
      const body = readArtifactSafe(f);
      if (!body || !REVERSAL_RE.test(body)) continue;

      state.falsifyAsked.push(f);
      if (Date.now() - (state.firedAt["archivist"] ?? 0) < COOLDOWN_MS) continue;
      state.firedAt["archivist"] = Date.now();
      ctx.trace("onFalsify", `\`${f}\` 含推翻记录`);
      await fire(
        "archivist",
        `\`outbox/${f}\` 里写了某条原来成立、后来被推翻/降级。\n` +
          `★★★ 请把它写成**一份独立的产物**（不是章内小节），四段，缺一段不算完成：\n` +
          `  1. **原来的说法**（当时的判据是什么，日期）\n` +
          `  2. **什么让它漏了**（判据？装置？语料？给出具体那一处）\n` +
          `  3. **新判据**（与旧的差在哪一句话上）\n` +
          `  4. **边界**（新判据在什么条件下也会漏）\n` +
          `★★ 为什么值得单独写：读者最该学的是**怎么发现自己错了**。\n` +
          `★ 若你判断这条不构成推翻（只是措辞收紧），明说，并把它降级为「收窄」。`,
      );
      return; // ★ 一次只推一份
    }
  }

  /**
   * ★ 猜想 D · 章号必须有唯一登记处。
   *
   * ★★★ 已用**真实书数据确定性证实**（`micro/checkChapterIndex.ts`，0 API）：
   *   书里引用 11 个章号共 41 次，而**实际只有 3 章**（5/9/10）
   *   ⇒ **8 个章号悬空**。第九章明文「替换第四章」，而第四章在归档区、从未进书。
   *
   * ★ 判据：产物引用了登记表里没有的章号。
   */
  async function onChapterIndex(): Promise<void> {
    if (ctx.closing?.()) return;
    const index = readChapterIndexRows();
    for (const f of listOutbox()) {
      if (state.indexChecked.includes(f)) continue;
      const body = readArtifactSafe(f);
      if (!body) continue;
      state.indexChecked.push(f);

      const refs = extractChapterNumbers(body);
      const bad = refs.filter((n) => !index.has(n));
      if (!bad.length) continue;
      if (Date.now() - (state.firedAt["archivist"] ?? 0) < COOLDOWN_MS) continue;
      state.firedAt["archivist"] = Date.now();
      ctx.trace("onChapterIndex", `\`${f}\` 引用不存在的章：${bad.join("、")}`);

      await fire(
        "archivist",
        `\`outbox/${f}\` 引用了**不在登记表里**的章：${bad.map((n) => `第${n}章`).join("、")}。\n` +
          `★★ 读者会去找它，但找不到（它可能在归档区，从没进书）。\n` +
          `第 1 步：更新 \`outbox/${INDEX_NAME}\` —— 每章一行：章号 · 标题 · 一句话主张 · 来源产物\n` +
          `第 2 步：对每个无法解析的引用，二选一：\n` +
          `  · 把它**收进登记表**（若那份产物确实在 outbox 里且过了门）\n` +
          `  · 把它改成**自足的说法**（不要让读者去查一个不存在的东西）\n` +
          `★★★ 不许做的：把归档区的产物当成章来引用 —— 归档 = 没进书 = 读者看不到。`,
      );
      return; // ★ 一次只推一份
    }
  }

  /**
   * ★ 猜想 E · 可执行判据。
   *
   * ★★ 「工具」= 能拿来跑，不是能拿来读。
   *   设计者原话：「可以**用作「工具」**」。而 10 份里只有 1 份真跑了新实验。
   *
   * ★ 判据：产物自称「0 次新 API / 没有新读数」。
   */
  async function onUntested(): Promise<void> {
    if (ctx.closing?.()) return;
    for (const f of listOutbox()) {
      if (state.untestedAsked.includes(f)) continue;
      const body = readArtifactSafe(f);
      if (!body || !UNTESTED_RE.test(body)) continue;

      state.untestedAsked.push(f);
      if (Date.now() - (state.firedAt["archivist"] ?? 0) < COOLDOWN_MS) continue;
      state.firedAt["archivist"] = Date.now();
      ctx.trace("onUntested", `\`${f}\` 自称无新读数`);
      await fire(
        "archivist",
        `\`outbox/${f}\` 里写着「没有新读数」。\n` +
          `★★ 这不一定是缺点 —— 有些结论确实只能靠重新解释。\n` +
          `★ 但读者要拿它当**工具**用，就得能**跑一遍判断自己属不属于这个情况**。\n` +
          `第 1 步：问一句 —— **这一条能不能写成一个 20 行的判定脚本？**\n` +
          `  · 能 → 写出来，放进 \`work/checks/\`，并在章末给出跑法（一行命令）\n` +
          `  · 不能 → ★ 明写**为什么不能**（缺数据？还是它不是断言而是定义？）\n` +
          `★★★ 不许做的：假装能跑（写一个永远返回 true 的脚本，比没有更坏）。`,
      );
      return; // ★ 一次只推一份
    }
  }


  return {
    onSettled, onCapabilityGap, onPlateau, onNewFinding, onAudience, onConsensus, onDispute,
    onTable, onSilentSeat, onFalsify, onChapterIndex, onUntested,
    /**
     * ★★★ 派活器（给 runner 用）。
     *
     * ★ 为什么要暴露：**收尾时必须等它跑完**。
     *   `fire` 现在只是"排进队列"，专家还在后台跑 ⇒
     *   runner 若直接 `dispose()` 所有 agent，**会把正跑着的专家截断**。
     *   ⇒ 收尾要 `await waitIdle()`（见 runner）。
     */
    dispatcher: drainer,
  };
}
