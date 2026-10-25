/**
 * 实验账 —— hunt 的主判据（DESIGN-2026-10-21 §1 / §9）
 *
 * ★★★ 为什么要这个模块：
 *   DESIGN 定的核心单元是「实验」，主判据是「活跃实验数 / 新开率 / 死因质量 / 装置覆盖」。
 *   而**这些现在一个都量不出来** —— 上一轮我只剩下"产物份数"这种与探索无关的数。
 *   没有它，后面每一轮改动我都分不清「没发生」和「发生了但我没看见」（纪律㉖/㉒）。
 *
 * ★★ 两种模式，必须自报家门：
 *   · `ledger`    —— 集群自己维护的 `EXPERIMENTS.md`（★ 目标形态，DESIGN §1）
 *   · `inferred`  —— 集群还没登记时，**从文件名推断**（★ 有系统偏差，读数必须带这个标记）
 *   绝不把 inferred 的数当 ledger 的数用（纪律㉜/㉞）。
 *
 * ★ 判据全是**形式**的（文件名 / 正文里有没有可核锚 / 路径在不在盘上），
 *   不做内容判断（硬规则①）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ───────────────────────────── 类型 ─────────────────────────────

export interface Artifact {
  file: string;
  text: string;
  /** mtime（毫秒）。★ 只看"新不新"，不拿它当历史（纪律㉛） */
  mtimeMs: number;
}

/** 一条实验。★ `unsaid` = 有这一格但没写，**不是 0**（纪律㉜） */
export type Outcome = "active" | "dead" | "parked" | "handoff" | "unsaid";

export interface Row {
  id: string;
  outcome: Outcome;
  /** 结局那一栏的原文（没有就空串） */
  cause: string;
  /** ★ 死因/下一步里有没有**可核锚**：数字 / 路径 / 引号里的判据名 */
  anchored: boolean;
  /** ★ 集群自己写的「能不能一条命令跑」；账里没有这一列 ⇒ **null（未声明）**，不是 false */
  runnable?: boolean | null;
}

export interface Stats {
  mode: "ledger" | "inferred";
  total: number;
  byOutcome: Record<Outcome, number>;
  /** 死掉的实验里，死因带可核锚的比例（★ 分母 = dead+parked；0 条时返回 null，不是 0） */
  deadCauseJudgeable: number | null;
  /** 新开率：最近 24h / 7d 内新建的实验数（按 mtime，只看新不新） */
  newLast24h: number;
  newLast7d: number;
  /** 装置覆盖率：引用了**在盘上**的可跑装置的比例（分母 = total；0 条时 null） */
  deviceCoverage: number | null;
  /**
   * ★ 账里「能不能一条命令跑」= 能 的比例（分母 = 账里声明了这一格的）。
   * ★★ 账里没这一列 ⇒ null（未声明）。**这不是 `deviceCoverage` 的替代** ——
   *   覆盖率问"有没有装置"，这个问"装置跑不跑得起来"。
   */
  runnableRate: number | null;
  /** 明确写了「不能一条命令跑」的条数 */
  notRunnable: number;
  /**
   * ★★★ 账里**实际有哪些列**（2026-10-21 补）。
   *   ★ 为什么要打出来：DESIGN 第1节的实验有 7 项（假设/装置/读数/现象/模型/猜想/结局），
   *     而账现在只有 4 列 ⇒ 「现象 / 模型 / 猜想」根本没有格子。
   *     那不是"我判不了"，是**账里没这一格** —— 每轮把它打出来，缺口就一直在眼前。
   */
  columns: string[];
  /** 引用了装置但**不在盘上**的（★ 这类是"证据落空"，单独报，不许并进覆盖率） */
  deviceMissing: number;
  /**
   * ★ 宽松口径对照：正文**任一处**出现四态词（活/死/挂起/移交）的份数。
   * ★★ 这个数**不许当准绳** —— 「死」在"死循环"里、「活」在"活动"里到处都是。
   *   报它是为了让读者看见「口径一换数就变」（P102 的教训）。
   */
  looseOutcome: number;
}

export interface Attribution {
  /** 正文开头就明写「回答上级 / 回应上级」的份数 */
  deliveryDriven: number;
  total: number;
  /** 比例；total=0 时 null */
  share: number | null;
}

export interface SourceMix {
  /** 有 URL / arXiv / doi ⇒ 真的看过外面 */
  external: number;
  /** 提到学科概念（信息论/熵/控制论/…） */
  interdisciplinary: number;
  /** 明写了「出处 / 来源 / 引自」 */
  declared: number;
  total: number;
}

// ───────────────────────── 形式的判据（纯函数）─────────────────────────

/** 正文里能被别人独立核对的锚：数字 / 带扩展名的路径 / 反引号里的东西 */
export function hasAnchor(text: string): boolean {
  if (!text) return false;
  if (/\d/.test(text)) return true;
  if (/`[^`]{2,}`/.test(text)) return true;
  // ★ 只认**带扩展名**的路径 —— `lib/aiteam` 这种相对成长不算（纪律㉞）
  if (/(?:[\w.-]+\/)+[\w.-]+\.(?:md|ts|mts|mjs|js|jsonl|json|txt|log|sh)/.test(text)) return true;
  return false;
}

const OUTCOME_MAP: [Outcome, RegExp][] = [
  ["dead", /^(死|已死|推翻|被推翻|否定|不通|closed?[-\s]?dead)/i],
  ["handoff", /^(移交|转交|交给 ?forge|进书|handoff)/i],
  ["parked", /^(挂起|暂停|搁置|等|parked?)/i],
  ["active", /^(活|进行中|继续|active|open)/i],
];

/** 只看形式，不看理由：把「结局」那一栏映射成状态（★ 认不出 ⇒ unsaid，不猜） */
export function classifyOutcome(raw: string): Outcome {
  const s = (raw ?? "").trim();
  if (!s) return "unsaid";
  for (const [k, re] of OUTCOME_MAP) if (re.test(s)) return k;
  return "unsaid";
}

/** `| P58 | 谓词 | 装置 | 2026-10-19 | 活：下一步跑 X |` ⇒ Row */
/**
 * ★★★ 2026-10-21 修（★ 集群把 `EXPERIMENTS.md` 写成了**索引**，账体在 `EXPERIMENTS-<seat>.md`）：
 *   第一版把表格的**任何** `|` 行都当实验行 —— 于是索引表的「席位 | 文件 | 字节」
 *   也会被当成实验，而且主观地把最后一格当结局。那是典型的「口径混进异物」（纪律㉞）。
 * ★ 现在**认表头**：只有表头里同时出现 id 列词（编号/实验/id）与结局列词（结局/状态/结论/结果）
 *   的表格才被解析，且**按列名取值**，不靠“最后一格”。
 */
const ID_HEAD = /^(编号|实验|实验号|id|ID|＃|#)$/;
// ★★★ 2026-10-21 补「四态」：集群的裁决表用**四态**当列名，而这里原来不认它
//   ⇒ 那张表整张读不到（同「判据永远匹配不上」）。
const OUT_HEAD = /^(结局|状态|结论|结果|四态|verdict|Status)$/;
/**
 * ★★★ 「死因」必须是**它自己的列**，不能拿整行当死因。
 *   第一版 `cause = body[outCol]` ⇒ 只拿到 `死` 这个字 ⇒ 死因可判死 0%（假读数）。
 *   第二版想过「整行拼接」⇒ 也不行：整行里一定有装置路径，那样永远 100%（恒真读数）。
 *   ⇒ 只认**表头里明写**的死因列（死因/判死句/理由/为什么/原因）。没有这一列 ⇒ 未声明。
 */
const CAUSE_HEAD = /(死因|判死句|理由|为什么|原因|why|because)/i;
/**
 * ★★★ 2026-10-21 补（DESIGN §7① 的判据）：「装置能跑」不等于「路径在盘上」。
 *   集群自己在账里写了一列「能不能一条命令跑 / 不能一条命令跑」（`EXPERIMENTS.md` 57 次），
 *   而我第一版只验 `existsSync` ⇒ 把"跑不起来"也记成覆盖了（纪律㉞）。
 *   ★ 这一列是**它自己写的判定**，我只照抄，不自己跑（跑它的脚本有副作用）。
 */
const RUNNABLE_HEAD = /(能不能一条命令跑|能一条命令跑|可复跑|runnable)/i;

/** ★ 只读表头，返回列名（给「账有哪些列」用） */
export function ledgerColumns(text: string): string[] {
  const cols: string[] = [];
  for (const line of text.split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const body = t.split("|").slice(1, -1).map((c) => c.trim());
    if (body.some((c) => ID_HEAD.test(c)) && body.some((c) => OUT_HEAD.test(c))) {
      cols.push(...body);
    }
  }
  return [...new Set(cols)];
}

export function parseLedger(text: string): Row[] {
  const rows: Row[] = [];
  const lines = text.split(String.fromCharCode(10));
  let idCol = -1;
  let outCol = -1;
  let causeCol = -1;
  let runCol = -1;
  let inTable = false;

  const reset = () => {
    idCol = -1;
    outCol = -1;
    causeCol = -1;
    runCol = -1;
    inTable = false;
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      reset();
      continue;
    }
    const cells = t.split("|").map((c) => c.trim());
    // cells[0] 是空（行首 |）；跳过行首/行尾空单元
    const body = cells.slice(1, cells.length - 1);
    if (!body.length) continue;

    const isSep = body.every((c) => /^[-:\s]*$/.test(c));
    if (isSep) {
      inTable = true;
      continue;
    }

    if (!inTable) {
      // 这行是**表头**：找列名
      const i = body.findIndex((c) => ID_HEAD.test(c));
      const o = body.findIndex((c) => OUT_HEAD.test(c));
      const k = body.findIndex((c) => CAUSE_HEAD.test(c));
      const rn = body.findIndex((c) => RUNNABLE_HEAD.test(c));
      if (i >= 0 && o >= 0) {
        idCol = i;
        outCol = o;
        causeCol = k;
        runCol = rn;
      } else {
        reset();
      }
      continue;
    }

    if (idCol < 0) continue; // 不在实验表里
    const id = body[idCol] ?? "";
    if (!id || /^[-:\s]+$/.test(id)) continue;
    const state = outCol >= 0 ? (body[outCol] ?? "") : "";
    const cause = causeCol >= 0 ? (body[causeCol] ?? "") : "";
    const runCell = runCol >= 0 ? (body[runCol] ?? "") : "";
    rows.push({
      id,
      outcome: classifyOutcome(state),
      cause,
      anchored: hasAnchor(cause),
      runnable: runCol < 0 ? null : !/不能|不可|否|no/i.test(runCell),
    });
  }
  return rows;
}

/** 没有账时：从文件名推断实验（★ 只认编号前缀，其它一律不算） */
export function inferRows(arts: Artifact[], prefixes = ["P"]): Row[] {
  const re = new RegExp(`^(${prefixes.join("|")})\\d+`, "i");
  return arts
    .filter((a) => re.test(a.file))
    .map((a) => {
      // ★★★ 2026-10-21 修（★ 这是集群用**我的真源码**复现后，第 5 次纠正我的量具）：
      //   原来只扫**前 4000 字符**、只认 `结局|状态|结论` 三个词 ⇒
      //   「有结局 0/58」其实是 **词表 × 前4000字符 × 标签形状** 三个谓词的合取，
      //   真值随口径在 0…58 之间（它给了 8/8 人造答案复现，见 `outbox/P102…`）。
      //   ⇒ 改成**扫全文** + 放宽标签词。★ 但仍只认**明写的结局栏**，不从语气猜。
      const m = a.text.match(
        /(?:^|\n)\s*(?:结局|状态|结论|结果|Verdict|Status)\s*[：:]\s*([^\n]{0,120})/,
      );
      const outcome = m ? classifyOutcome(m[1]!) : "unsaid";
      return { id: a.file, outcome, cause: m?.[1] ?? "", anchored: hasAnchor(m?.[1] ?? "") };
    });
}

/** 引用到的装置路径（★ 只认带扩展名的；用于覆盖率与"证据落空"） */
export function deviceRefs(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:[\w.-]+\/)+[\w.-]+\.(?:mjs|mts|ts|js|sh|jsonl)/g;
  for (const m of text.matchAll(re)) out.add(m[0]);
  return [...out];
}

/**
 * 产物结构 —— ★★★ 这一条是 2026-10-21 实测出来的核心读数：
 *
 *   58 份编号实验（`P*`）**全部在 10-19 之前**；
 *   24 份「手段审查」+ 3 INSPIR + 12 回应 + 1 台账，**全在最近几天**。
 *   ⇒ 它不是"不会做实验"，是被**自己审自己**的那条链吃满了 —— 手段 V→XXII 逐层审上一层。
 *
 * ★ 判据纯形式：按文件名前缀归类（前缀 → 计数），不做内容判断。
 * ★ `auditChain` = 同一前缀的条数（近似链深：每一层审上一层的产物）。
 */
export interface ArtifactMix {
  byPrefix: Record<string, number>;
  total: number;
  /** 编号实验（默认 `P`）占多少 */
  experiments: number;
  /** ★ 装置/审查类的合计（手段/INSPIR/回应/台账/量具/装置/审查） */
  apparatus: number;
  /** 最长的那条自审链（前缀 → 条数） */
  longestChain: { prefix: string; n: number } | null;
}

const APPARATUS_PREFIXES = ["手段", "INSPIR", "回应", "台账", "量具", "装置", "审", "实验"];

export function artifactMix(arts: Artifact[], expPrefixes = ["P"]): ArtifactMix {
  const byPrefix: Record<string, number> = {};
  const expRe = new RegExp(`^(${expPrefixes.join("|")})[0-9]+`, "i");
  let experiments = 0;
  for (const a of arts) {
    if (expRe.test(a.file)) {
      experiments++;
      byPrefix[expPrefixes[0]!] = (byPrefix[expPrefixes[0]!] ?? 0) + 1;
      continue;
    }
    const hit = APPARATUS_PREFIXES.find((p) => a.file.startsWith(p));
    const key = hit ?? "(其它)";
    byPrefix[key] = (byPrefix[key] ?? 0) + 1;
  }
  const apparatus = Object.entries(byPrefix)
    .filter(([k]) => APPARATUS_PREFIXES.includes(k))
    .reduce((a, [, n]) => a + n, 0);
  let longestChain: { prefix: string; n: number } | null = null;
  for (const [k, n] of Object.entries(byPrefix)) {
    if (!APPARATUS_PREFIXES.includes(k)) continue;
    if (!longestChain || n > longestChain.n) longestChain = { prefix: k, n };
  }
  return { byPrefix, total: arts.length, experiments, apparatus, longestChain };
}

/**
 * ★★★ 猜想计数（DESIGN v2 §2 轮A 的第三个读数）
 *
 * ★ 实测背景（191 份）：只有 **3%** 的产物出现「猜想/推测」字样 —— 而设计要的
 *   「创新 = 猜想 → 接口 → 对照」里，**猜想那一段基本是空的**。
 * ★★ 这里只认**明写的标记**（`猜想：…` / `类型：猜想`），不靠语气词 —— 否则"可能"两个字
 *   到处都是，读数就成了恒真。
 */
const CONJ_MARK = /^\s*(?:[-*]\s*)?(?:类型\s*[：:]\s*猜想|猜想\s*[：:])/m;

export function conjectures(arts: Artifact[]): { total: number; unverified: number } {
  let total = 0;
  let unverified = 0;
  for (const a of arts) {
    if (!CONJ_MARK.test(a.text)) continue;
    total++;
    if (/未验证/.test(a.text)) unverified++;
  }
  return { total, unverified };
}

const DELIVERY_RE = /(回答上级|回应上级|上级要的|上级那|按上级|上级的指示|上级让我)/;

/**
 * 投递驱动比 —— ★★ DESIGN §9 里它是**反向指标**：越高说明我管得越多、它自己开线越少。
 * ★ 只扫**开头 30 行**：产物正文里引用一次"上级"是正常的，开头就写才是"这是给我的作业"。
 */
export function deliveryDriven(arts: Artifact[]): Attribution {
  let n = 0;
  for (const a of arts) {
    const head = a.text.split(String.fromCharCode(10)).slice(0, 30).join(String.fromCharCode(10));
    if (DELIVERY_RE.test(head)) n++;
  }
  return { deliveryDriven: n, total: arts.length, share: arts.length ? n / arts.length : null };
}

const DISCIPLINE_RE =
  /(信息论|熵|互信息|控制论|系统论|系统科学|博弈论|复杂度|网络科学|热力学|演化论|统计力学|贝叶斯|因果推断|认知科学|生态学|相变)/;
const EXTERNAL_RE = /(https?:\/\/|arxiv\.org|doi:|10\.\d{4,}\/)/i;
// ★★★ 第一版写成 /(出处|来源|引自|参考|依据[:：])/ ⇒ 154 份里 143 份"有出处" = **恒真读数**。
//   「依据」在论证里到处都是，那不是引用出处（纪律㉞：口径太宽 ⇒ 读数恒真）。
//   ★ 只认**带冒号的引用栏**与"引自"：这是形式，不是内容判断。
const CITE_RE = /(出处[：:]|引自|参考资料|参考文献|来源[：:])/;

/** 灵感通道的读数（DESIGN §3） */
export function sourceMix(arts: Artifact[]): SourceMix {
  let external = 0;
  let interdisciplinary = 0;
  let declared = 0;
  for (const a of arts) {
    if (EXTERNAL_RE.test(a.text)) external++;
    if (DISCIPLINE_RE.test(a.text)) interdisciplinary++;
    if (CITE_RE.test(a.text)) declared++;
  }
  return { external, interdisciplinary, declared, total: arts.length };
}

// ───────────────────────────── 组装 ─────────────────────────────

/**
 * @param labRoot 集群空间根（`research/labfirst/hunt`）—— ★ 不是 `outbox`
 * @param now     注入时间戳（★ 不要在函数里 `Date.now()`：否则不可离线重判）
 */
export function experimentStats(
  rows: Row[],
  /**
   * ★★★ 必须**按行**给 refs。第一版传的是"全局 refs"⇒ A 行的装置可以"覆盖" B 行，
   *   那是典型的「口径混进异物」（纪律㉞）。改成按 id 取。
   */
  devices: { refsFor: (id: string) => string[]; exists: (p: string) => boolean },
  times: { now: number; mtimeOf: (id: string) => number | undefined },
  mode: "ledger" | "inferred",
  /** ★ 宽松口径（正文任一处出现四态词）—— 由调用方数好传进来，这里不算 */
  looseOutcome = 0,
  /** ★ 账里实际有哪些列（由调用方读表头后传进来） */
  columns: string[] = [],
): Stats {
  const byOutcome: Record<Outcome, number> = { active: 0, dead: 0, parked: 0, handoff: 0, unsaid: 0 };
  for (const r of rows) byOutcome[r.outcome]++;

  const ended = rows.filter((r) => r.outcome === "dead" || r.outcome === "parked");
  const deadCauseJudgeable = ended.length ? ended.filter((r) => r.anchored).length / ended.length : null;

  const DAY = 86_400_000;
  let newLast24h = 0;
  let newLast7d = 0;
  for (const r of rows) {
    const m = times.mtimeOf(r.id);
    if (m === undefined) continue;
    const age = times.now - m;
    if (age <= DAY) newLast24h++;
    if (age <= 7 * DAY) newLast7d++;
  }

  let declared = 0;
  let ok = 0;
  for (const r of rows) {
    if (r.runnable === undefined || r.runnable === null) continue;
    declared++;
    if (r.runnable) ok++;
  }
  let covered = 0;
  let missing = 0;
  for (const r of rows) {
    const mine = devices.refsFor(r.id);
    // ★ 没有任何装置 ⇒ 不算覆盖（DESIGN §1：没有装置就不是实验）
    if (mine.some((p) => devices.exists(p))) covered++;
    else missing++;
  }

  return {
    mode,
    total: rows.length,
    byOutcome,
    deadCauseJudgeable,
    newLast24h,
    newLast7d,
    deviceCoverage: rows.length ? covered / rows.length : null,
    runnableRate: declared ? ok / declared : null,
    notRunnable: declared - ok,
    deviceMissing: missing,
    columns,
    looseOutcome,
  };
}

/** 渲染（★ 缺数据写「未声明」，绝不写 0 —— 纪律㉜） */
export function renderExperiments(
  s: Stats,
  att: Attribution,
  mix: SourceMix,
  /** ★ 账里「结局」列实际长什么样（前几个不同的值）—— 用来判"表在、但没记四态" */
  outcomeSamples: string[] = [],
  /** ★ 账之间冲突的提示（为一句话多传一个参数，比让调用方拼字符串更不容易漏） */
  ledgerConflictsNote = "",
): string {
  const pct = (v: number | null) => (v === null ? "未声明" : `${Math.round(v * 100)}%`);
  const L: string[] = [];
  L.push(
    `★ 实验账[${s.mode}]：共 ${s.total} · 活 ${s.byOutcome.active} · 死 ${s.byOutcome.dead}` +
      ` · 挂起 ${s.byOutcome.parked} · 移交 ${s.byOutcome.handoff} · **未声明 ${s.byOutcome.unsaid}**`,
  );
  L.push(`   新开：24h ${s.newLast24h} · 7d ${s.newLast7d}   ← ★ 主判据（DESIGN §9）`);
  L.push(`   死因可判死：${pct(s.deadCauseJudgeable)}   装置覆盖：${pct(s.deviceCoverage)}（证据落空 ${s.deviceMissing} 条）`);
  L.push(
    `   ★ 装置**能不能一条命令跑**：${pct(s.runnableRate)}（写明「不能」的 ${s.notRunnable} 条）` +
      `—— 覆盖率只问"在不在"，这个问"跑不跑得起来"（DESIGN §7①）`,
  );
  if (s.columns.length) {
    const need = ["现象", "模型", "猜想"];
    const missing = need.filter((n) => !s.columns.some((c) => c.includes(n)));
    L.push(
      `   ★★ 账的列：${s.columns.map((c) => c.slice(0, 10)).join(" · ")}` +
        (missing.length ? `　⇒ ★ 缺 ${missing.join("/")}（DESIGN §1 的 7 项里有 3 项**没有格子**）` : ""),
    );
  }
  L.push(
    `   ★ 口径：结局必须**明写在行首**（结局/状态/结论/结果），扫全文 · ` +
      `宽松口径（正文任一处有四态词）会有 ${s.looseOutcome} 条 —— **那个数不准，只是给你看口径一换数就变**`,
  );
  L.push(`   ★★ 投递驱动比：${pct(att.share)}（${att.deliveryDriven}/${att.total}）—— 反向指标，越低越好`);
  L.push(
    `   灵感出处：外部材料 ${mix.external} · 跨学科 ${mix.interdisciplinary} · 明写出处 ${mix.declared}` +
      `（共 ${mix.total}）`,
  );
  // ★ 只在**多数**认不出时才警告。第一版写成 `if (unsaid)` ⇒ 60 行里有 1 行认不出
  //   就报「结局列认不出四态」，是狼来了（量具必须在该响时才响）。
  if (s.mode === "ledger" && s.total > 0 && s.byOutcome.unsaid / s.total > 0.5 && outcomeSamples.length) {
    L.push(
      `   ⚠ 账读到了，但「结局」列认不出四态 —— 实际写在里面的是：${outcomeSamples
        .slice(0, 4)
        .map((v) => `\`${v.slice(0, 18)}\``)
        .join(" · ")}`,
    );
  }
  if (s.mode === "ledger" && ledgerConflictsNote) {
    L.push(`   ⚠ ${ledgerConflictsNote}`);
  }
  if (s.mode === "inferred") {
    L.push(`   ⚠ 这是**从文件名推断**的读数，不是它自己登记的账 —— 有系统偏差，别当准绳`);
  }
  return L.join(String.fromCharCode(10));
}

// ───────────────────────────── I/O ─────────────────────────────

export function readArtifacts(outboxDir: string, limit = 400): Artifact[] {
  let files: string[] = [];
  try {
    files = readdirSync(outboxDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Artifact[] = [];
  for (const f of files.slice(-limit)) {
    const p = join(outboxDir, f);
    try {
      const st = statSync(p);
      out.push({ file: f, text: readFileSync(p, "utf8"), mtimeMs: st.mtimeMs });
    } catch {
      /* 读不了就当不存在，不塞空串 */
    }
  }
  return out;
}

/**
 * 读实验账。★ `labRoot` 必须是集群空间根 —— 传错根会**报错**，不静默返回空
 *   （纪律㉞ 的教训：prereg-trace 传错根时静默回"没有数据"）。
 */
export function readExperiments(
  labRoot: string,
  now = Date.now(),
): {
  stats: Stats;
  att: Attribution;
  mix: SourceMix;
  rows: Row[];
  outcomeSamples: string[];
  /** ★ 同一编号在两份账里结局不一致的（我判不了 ⇒ 记 unsaid，不悄悄挑一个）*/
  ledgerConflicts: string[];
} {
  if (labRoot.replace(/[\\/]+$/, "").endsWith("outbox") || labRoot.endsWith("work")) {
    throw new Error(
      `readExperiments 要的是**集群空间根**（如 research/labfirst/hunt），拿到的是「${labRoot}」。` +
        `★ 传错根会静默返回空 —— 所以这里直接抛错。`,
    );
  }
  const outboxDir = join(labRoot, "outbox");
  const arts = readArtifacts(outboxDir);
  // ★★★ 2026-10-21：账可能是**分席位**的（`EXPERIMENTS-<seat>.md`），
  //   而 `EXPERIMENTS.md` 只是索引 ⇒ 全部读、按 id 去重、别把索引当账。
  let ledgerFiles: string[] = [];
  try {
    ledgerFiles = readdirSync(outboxDir)
      .filter((f) => /^EXPERIMENTS.*\.md$/i.test(f))
      .sort();
  } catch {
    ledgerFiles = [];
  }

  let rows: Row[];
  let mode: Stats["mode"];
  let ledgerConflicts: string[] = [];
  if (ledgerFiles.length) {
    // ★★★ 2026-10-21 修（集群 `P107` 的指控：**同一编号在 14/60 个 id 上冲突**）：
    //   原来"先读到 / 有结局的优先" ⇒ 悄悄挑一个，读数是**记账顺序的函数**，不是事实。
    //   ⇒ 现在：结局**一致**才采纳；**不一致就记成 unsaid 并计入 conflicts**（我判不了就说判不了）。
    const byId = new Map<string, Row>();
    const conflicts: string[] = [];
    for (const f of ledgerFiles) {
      for (const r of parseLedger(readFileSync(join(outboxDir, f), "utf8"))) {
        // ★ 已经判过冲突的 id **不再被后面的账覆盖**（否则第三份账会把 unsaid 冲掉，
        //   读数又变成"谁最后写谁算"）
        if (conflicts.includes(r.id)) continue;
        const prev = byId.get(r.id);
        if (!prev) {
          byId.set(r.id, r);
          continue;
        }
        const a = prev.outcome;
        const b = r.outcome;
        // ★ unsaid 不算冲突（一份账没写结局，另一份写了 ⇒ 用写了的那份）
        if (a === b || b === "unsaid") continue;
        if (a === "unsaid") {
          byId.set(r.id, r);
          continue;
        }
        conflicts.push(r.id);
        byId.set(r.id, { ...prev, outcome: "unsaid", cause: `两份账的结局不一致（${a} vs ${b}）`, anchored: false });
      }
    }
    rows = [...byId.values()];
    ledgerConflicts = [...new Set(conflicts)];
    mode = rows.length ? "ledger" : "inferred";
    if (!rows.length) rows = inferRows(arts);
  } else {
    rows = inferRows(arts);
    mode = "inferred";
  }

  const byFile = new Map(arts.map((a) => [a.file, a]));
  /**
   * ★★★ 2026-10-21 修：账里的 id 往往**不是文件名**（`P58` vs `P58-有结局…md`）
   *   ⇒ 第一版按 id 精确匹配 ⇒ 装置覆盖报 0%、新开率报 0（假读数）。
   *   ★ 现在按**前缀**回找文件（`exact` → `id-*` → `id*`）。
   */
  const lookup = (id: string): Artifact | undefined => {
    const exact = byFile.get(id);
    if (exact) return exact;
    const hit = arts.find((a) => a.file === id || a.file.startsWith(id + "-") || a.file.startsWith(id));
    return hit;
  };
  const refsByRow = new Map<string, string[]>();
  for (const r of rows) {
    const a = lookup(r.id);
    refsByRow.set(r.id, a ? deviceRefs(a.text) : []);
  }
  const stats = experimentStats(
    rows,
    {
      refsFor: (id) => refsByRow.get(id) ?? [],
      exists: (p) => existsSync(join(labRoot, p)) || existsSync(join(labRoot, "..", "..", "..", p)),
    },
    { now, mtimeOf: (id) => lookup(id)?.mtimeMs },
    mode,
    rows.filter((r) => {
      const a = lookup(r.id);
      return a ? /(活|死|挂起|移交)/.test(a.text) : false;
    }).length,
    [...new Set(ledgerFiles.flatMap((f) => ledgerColumns(readFileSync(join(outboxDir, f), "utf8"))))],
  );

  const outcomeSamples = [
    ...new Set(rows.filter((r) => r.cause).map((r) => r.cause.slice(0, 24))),
  ].slice(0, 6);

  return { stats, att: deliveryDriven(arts), mix: sourceMix(arts), rows, outcomeSamples, ledgerConflicts };
}
