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

/**
 * ★★★ 2026-10-25（libsmith）：先剥**排版噪音**，再匹配。
 *
 * ★ 为什么：`OUTCOME_MAP` 四条正则全锚 `^`，而账里的结局格常写成
 *   `**死**：判据错` · `结局：死` · `🔴 死` · `**活**` —— 一个都没对上，共 4 种写法
 *   全读成 `unsaid`。人造答案实测：**6/10 判对，污染率 4/9 = 44%**
 *   （夹具来自 `work/A-exports/judge-unit-test.ts`，falsifier D-206 独立复现同一组数）。
 *
 * ★ 后果不是"少数格式读不出"，是**分母变了**：`未声明 14` 这类的数至少等于 `未声明 ∪ 读不出`。
 *   一个读不出结局的行会被当成"没写结局" ⇒ 缺陷账虚高，且虚高的方向**系统性偏向格式好看的行**。
 *
 * ★ 边界（诚实）：它只认**行首**的排版噪音。写在中间的（`判据错 ⇒ 死`）仍然读不出 ——
 *   那是"这一格里有好几件事"，正则不该猜；要它可判就得让账把结局写成一格一值。
 */
function stripDecor(raw: string): string {
  let s = (raw ?? "").trim();
  // 两轮：`**结局：** 尚未声明` 得先剥 `**` 才能看到标签，剥完标签还剩 `**`
  for (let i = 0; i < 2; i++) {
    s = s
      // ① 行首的列名标签（`结局：` `状态:` `verdict=` `**结论**：`）
      .replace(/^(结局|状态|结论|结果|四态|verdict|status)\s*[:：=]?\s*/i, "")
      // ② 行首的标点 / emoji / markdown 强调符（★ 只剥行首，不碰正文）
      .replace(
        /^[\s*_~`>#"'•·|]+/u,
        "",
      )
      .replace(/^[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]+/u, "")
      .replace(/^[\s*_~`>#"'•·|:：\-–—]+/u, "")
      .trim();
  }
  return s;
}

/** 只看形式，不看理由：把「结局」那一栏映射成状态（★ 认不出 ⇒ unsaid，不猜） */
export function classifyOutcome(raw: string): Outcome {
  const s = stripDecor(raw);
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

/**
 * ★★★★ 七项缺口 —— DESIGN §1 说单元是实验，含
 *   **假设 / 装置 / 读数 / 现象 / 模型 / 猜想 / 结局**。
 * ★ 实测它交的是「编号·谓词·装置·结局」—— **现象/模型/猜想三格根本不存在**。
 * ★★ 这里只判**列在不在**（纯形式），不判格子里写得对不对（那是内容判断，不是我的活）。
 */
export const EXPERIMENT_ITEMS = [
  { key: "hypothesis", label: "假设", re: /(谓词|假设|claim|一句话)/i },
  { key: "device", label: "装置", re: /(装置|脚本|命令|device)/i },
  { key: "reading", label: "读数", re: /(读数|对照|值|结果数)/i },
  { key: "phenomenon", label: "现象", re: /(现象|意外|与预期不符|反常)/i },
  { key: "model", label: "模型", re: /(模型|机制|解释|model)/i },
  { key: "conjecture", label: "猜想", re: /(猜想|假设的猜想|conjecture)/i },
  { key: "outcome", label: "结局", re: OUT_HEAD },
] as const;

export interface ItemGap {
  present: string[];
  missing: string[];
  columns: string[];
}

export function itemGap(ledgerText: string): ItemGap {
  const columns = ledgerColumns(ledgerText);
  const present: string[] = [];
  const missing: string[] = [];
  for (const it of EXPERIMENT_ITEMS) {
    if (columns.some((c) => it.re.test(c))) present.push(it.label);
    else missing.push(it.label);
  }
  return { present, missing, columns };
}

/** ★ 表头声明了「未验证」⇒ 这一列的行都在声明层面算标过（与行内明写分开报）*/
export function headerDeclaresUnverified(ledgerText: string): boolean {
  const head = ledgerText.split(String.fromCharCode(10)).find((l) => CONJ_COL_HEAD.test(l)) ?? "";
  return /未验证/.test(head);
}

export function renderItemGap(g: ItemGap): string {
  if (g.columns.length === 0) {
    return "★ 七项缺口：**读不到实验账的列**（未声明）—— 没列就没格，缺什么无从说起";
  }
  return (
    `★★ 七项（假设/装置/读数/现象/模型/猜想/结局）：有 **${g.present.join("·") || "无"}**` +
    (g.missing.length ? ` · ★ **缺 ${g.missing.join("·")}**` : " · 齐") +
    `　← ★ 缺的那几格就是"新东西"唯一的入口（只判列在不在，不判写得对不对）`
  );
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

export function conjectures(arts: Artifact[]): { total: number; unverified: number; headerDeclared: boolean; sources: string[] } {
  let total = 0;
  let unverified = 0;
  let headerDeclared = false;
  const sources: string[] = [];
  for (const a of arts) {
    // ① 明文标记（`猜想：` / `类型：猜想`）
    if (CONJ_MARK.test(a.text)) {
      total++;
      if (/未验证/.test(a.text)) unverified++;
      sources.push(a.file);
      continue;
    }
    // ★★ ② 2026-10-25 补：它实际是把猜想写进 `PROJECTS.md` 的**表格列**里
    //   （`| 代号 | 一句话猜想（未验证） | 版本 | …`）。我原来只扫正文标记 ⇒
    //   报「猜想 0 条」，而表里明明有 4 行 —— **这是我的口径错，不是它没做**。
    if (/PROJECTS/i.test(a.file)) {
      const rows = a.text
        .split(String.fromCharCode(10))
        .filter((l) => /^\|\s*`?[A-Za-z][\w-]*`?\s*\|/.test(l.trim()));
      const head = a.text.split(String.fromCharCode(10)).find((l) => CONJ_COL_HEAD.test(l)) ?? "";
      if (rows.length > 0 && CONJ_COL_HEAD.test(head)) {
        total += rows.length;
        // ★ 行内明写 + 表头声明，**分开算**（纪律㉜：缺数据 ≠ 0）
        //   实测：表头写「一句话猜想（未验证）」，而行内一个字都没有 ⇒
        //   只数行内会报 0 条未验证，而列定义层面 8 条都标了。
        unverified += rows.filter((l) => /未验证/.test(l)).length;
        if (/未验证/.test(head)) headerDeclared = true;
        sources.push(`${a.file}(表)`);
      }
    }
  }
  return { total, unverified, headerDeclared, sources };
}

/**
 * ★★★★★ 可推广占比 —— 这一阶段的主判据（`真因-研究对象被驯化了-2026-10-21.md`）
 *
 * ★ 实测背景：196 份产物里，标题只含**可推广概念**的 17 份（9%）；
 *   按天看 10-19 = 16/94（17%）· 10-24 = 1/54 · 10-25 = **0/43**。
 *   ⇒ 研究对象从「集群」漂移成「本 lab 的测量装置」。这是"能不能创新"的直接读数。
 *
 * ★★ 判据是**标题级**的形式判据（不读正文，避免内容判断）：
 *   · 含本 lab 专有名词 ⇒ 地方志
 *   · 只含可推广概念 ⇒ 可推广
 *   ★ 局限要说清：正文里可能有可推广结论而标题看不出来（口径偏保守）。
 */
const LOCAL_WORDS =
  /(PREREG|seal|封口|INSPIR|O[0-9]+|账|量具|装置|分母|复算|口径|CONVERGED|EXPERIMENTS|状态表|吸收率|判据|读数|上级|面-)/;
const GEN_WORDS =
  /(集群|agent|上下文|prompt|角色|座位|权限|gate|模型|思考档|成本|范式|意图|目标|探索)/;

export interface Generalizability {
  /** 标题只含可推广概念的份数 */
  generalizable: number;
  /** 标题只含本 lab 专有名词的份数（地方志） */
  local: number;
  /** 两者都有 */
  both: number;
  neither: number;
  total: number;
  /** 严格口径：可推广 / 全部；total=0 ⇒ null */
  share: number | null;
  /**
   * ★★ 宽口径：**不含本 lab 专有名词**的比例（= 1 - 地方志 - 两者都有）。
   * ★ 为什么两个都报：严格口径靠**关键词表**，会漏掉"结论很通用但用词不同"的产物
   *   （实测 `P123-率的净变化是两项大数相消的残差` 就被漏了：它既没有我的通用词、
   *    也没有本 lab 词 ⇒ 掉进 neither）。
   * ★★ 真值在两者之间；**只报一个就会误导**（纪律㉞）。
   */
  looseShare: number | null;
}

export function generalizability(arts: Artifact[]): Generalizability {
  let generalizable = 0;
  let local = 0;
  let both = 0;
  let neither = 0;
  for (const a of arts) {
    const t = a.file.replace(/\.md$/i, "");
    const l = LOCAL_WORDS.test(t);
    const g = GEN_WORDS.test(t);
    if (l && g) both++;
    else if (l) local++;
    else if (g) generalizable++;
    else neither++;
  }
  const total = arts.length;
  return {
    generalizable,
    local,
    both,
    neither,
    total,
    share: total ? generalizable / total : null,
    // 宽：不是地方志（既不是 local，也不是 local+gen 混合）
    looseShare: total ? (total - local - both) / total : null,
  };
}

/**
 * ★★★★★ 答辩占比 —— 「注意力被自喂环吃掉」的读数（2026-10-21 新发现）
 *
 * ★ 实测（按天）：
 *   10-19 答辡 22/94 = **23%** · 实质产出（编号实验 / 实验 / 面-）**53** 份
 *   10-24 答辡 42/54 = **78%** · 实质产出 **4** 份
 *   10-25 答辡 40/68 = **59%** · 实质产出 **28** 份（我近几轮的改动把它拉回了一半）
 * ★★ 答辩是**开环自喂环**：回应 → 被挑战 → 再回应（`F1→F2→F4` · `手段 I→XXII`）。
 *    与缺陷账同一个病，而治缺陷账有效的办法是**三态处置 + 不许重开**。
 */
const REPLY_PREFIX =
  /^(回应|回执|is-|F[0-9]|审|核对|答上级|台账|本轮台账|手段|装置缺陷|CONVERGED|EXPERIMENTS|PROJECTS)/;
const SUBSTANTIVE_PREFIX = /^(P[0-9]+|实验|面-)/;

export interface AttentionMix {
  total: number;
  /** 答辩/台账类（回答同事或记账）*/
  reply: number;
  /** 实质产出（编号实验 / 实验 / 面-）*/
  substantive: number;
  /** 其它 */
  other: number;
  /** 答辩 / 全部 */
  replyShare: number | null;
}

export function attentionMix(arts: Artifact[]): AttentionMix {
  let reply = 0;
  let substantive = 0;
  let other = 0;
  for (const a of arts) {
    if (REPLY_PREFIX.test(a.file)) reply++;
    else if (SUBSTANTIVE_PREFIX.test(a.file)) substantive++;
    else other++;
  }
  const total = arts.length;
  return { total, reply, substantive, other, replyShare: total ? reply / total : null };
}

/**
 * ★★★★★ 跨载体成立 —— **可推广的可执行判据**（DESIGN v3-3）
 *
 * ★ 为什么不用"标题关键词"：那是**可措辞化**的（它只要换个说法就能涨），
 *   实测连真结论都漏（`P123-率的净变化是两项大数相消的残差`）。
 * ★★ 这一版的判据是硬的：产物里必须出现
 *   ① 一个**外部载体的绝对路径**（`src` / `book` / `clusters/forge` / `dev/demo` / `research/docs`）
 *   ② 且该产物里有一条**命令**（`npx tsx` / `node ` / `--self-test`）
 *   ⇒ 两个都满足才算「在别的载体上真的动过」。
 * ★★★ 局限（必须写清）：它证明的是"**去过**"，不是"**成立**"。
 *   「在别的载体上跑通且结论站得住」需要读内容判断 —— 那是集群的活（硬规则①）。
 */
const CARRIER_RE = /(src[\/]|research[\/]book|clusters[\/]forge|dev[\/]demo|research[\/]docs)/i;
const ABS_PATH_RE = /[A-Za-z]:[\/][^\s)`'"|]+/;
const CMD_RE = /(npx\s+tsx|node\s+[\w./$-]|--self-test)/;

export interface CrossCarrier {
  /** 引了外部载体绝对路径的份数 */
  reached: number;
  /** 其中还带命令的份数（真去跑过的最小证据）*/
  executed: number;
  total: number;
  reachedShare: number | null;
  executedShare: number | null;
}

export function crossCarrier(arts: readonly Artifact[]): CrossCarrier {
  let reached = 0;
  let executed = 0;
  for (const a of arts) {
    const t = a.text;
    const hasAbs = ABS_PATH_RE.test(t) && CARRIER_RE.test(t);
    if (!hasAbs) continue;
    reached++;
    if (CMD_RE.test(t)) executed++;
  }
  const total = arts.length;
  return {
    reached,
    executed,
    total,
    reachedShare: total ? reached / total : null,
    executedShare: total ? executed / total : null,
  };
}

export function renderCrossCarrier(c: CrossCarrier): string {
  const pct = (v: number | null) => (v === null ? "未声明" : `${Math.round(v * 100 * 10) / 10}%`);
  return (
    `★★ 跨载体：引外部绝对路径 **${c.reached}/${c.total}（${pct(c.reachedShare)}）**` +
    ` · 其中带命令的 **${c.executed}（${pct(c.executedShare)}）**` +
    `　← ★ 这是"可推广"的**硬判据**（去过别的载体），比标题关键词不可措辞化`
  );
}

/**
 * ★★★★ 产物**落在哪**（2026-10-25 r3 实测抓到的读数盲区）
 *
 * ★ 实测：修好"重审历史账"之后，r3 一轮跑了 25 次 port_run、写出 `work/P123-路径护栏…`
 *   这样一份教科书级的实验（跑前预测向量 + 12 探针 + 两份载体），
 *   而 **outbox 里 0 份新产物** ⇒ 我的读数（只读 outbox）报"0 产出"。
 * ★★ 这是第 13 次「量具读不到就报 0」（纪律㉜）。修法：**两个落点分开数**，
 *   而不是把 work 并进 outbox（并进去会让"产物数"这个历史序列断掉）。
 */
export interface Loci {
  outbox: number;
  work: number;
  /** work 里靠近 since 的（默认最近 3 小时）*/
  workFresh: number;
  sinceMs: number;
}

export function artifactLoci(lab: string, sinceMs: number): Loci {
  const count = (dir: string) => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  let workFresh = 0;
  try {
    for (const f of readdirSync(join(lab, "work"))) {
      if (!f.endsWith(".md")) continue;
      try {
        if (statSync(join(lab, "work", f)).mtimeMs >= sinceMs) workFresh++;
      } catch {
        /* 读不到不算 */
      }
    }
  } catch {
    /* 没有 work/ */
  }
  return {
    outbox: count(join(lab, "outbox")),
    work: count(join(lab, "work")),
    workFresh,
    sinceMs,
  };
}

export function renderLoci(l: Loci): string {
  return (
    `★ 产量落点：outbox **${l.outbox}** · work/ **${l.work}**（最近 3 小时新写 **${l.workFresh}**）` +
    `　← ★ 只读 outbox 会漏掉它写进 work/ 的那部分（第 13 次量具盲区）`
  );
}

/**
 * ★★★★ 外部材料用量 —— 四条灵感叹道里**最弱的一条**（2026-10-25）
 *
 * ★ 实测：①自己的死线账 406 份 · ②跨学科 96 份 · **③外部材料 15 份（2%）** · ④同行反驳 13 次。
 * ★★ 判据 = 产物里出现**真外部 URL**（排除 localhost/内网）+ 已知学术/标准站点。
 *   局限：URL 出现 ≠ 读懂了；编的 URL 也数得进（要核内容得另做，见 `onExternal` 的"我会去核"）。
 */
const EXTERNAL_URL_RE =
  /https?:\/\/(?!localhost|127\.|0\.0\.0\.0)[^\s)`'"|>]+|arxiv\.org|doi\.org|nature\.com|sciencemag|springer|acm\.org|ieee|ecb\.europa|reproducible-builds\.org/i;

/**
 * ★★★★ 设计者投放的网上文章（2026-10-25 新增通道）
 *
 * ★ 设计者原话：「我可能会时不时的给你网上的一些文章来给你或集群提供灵感」
 *   落在 `research/docs/研究员提供的网上文章/`。
 * ★★ 这是**第五类材料**：不是集群自己搜的（③），是**别人递给它的**。
 *   它的价值在于**选题不受集群自己的盲区限制** —— 集群搜的时候只会搜它已经想到的词。
 * ★★★ 但它**不是任务**：不引用不算病（设计者：「不要影响研究」）。
 *   所以我只**数**它，不催它。
 */
export const PROVIDED_DIR = "research/docs/研究员提供的网上文章";

export interface ProvidedUse {
  /** 目录里有多少篇 */
  available: number;
  /** 有多少份产物引用了其中某一篇（按文件名主干匹配）*/
  cited: number;
  total: number;
  files: string[];
}

export function providedUsage(arts: readonly Artifact[], files: readonly string[]): ProvidedUse {
  const stems = files
    .map((f) => f.replace(/\.md$/i, "").replace(/[？?：:，,、]/g, ""))
    .filter((f) => f.length >= 6)
    .map((f) => f.slice(0, 18));
  const cited = arts.filter((a) => {
    const t = a.text.replace(/[？?：:，,、]/g, "");
    return stems.some((s) => t.includes(s));
  }).length;
  return { available: files.length, cited, total: arts.length, files: [...files] };
}

export function renderProvided(u: ProvidedUse): string {
  if (u.available === 0) return "★ 设计者投放的文章：0 篇（`research/docs/研究员提供的网上文章/`）";
  return (
    `★ 设计者投放的文章：**${u.available} 篇**在 \`${PROVIDED_DIR}/\`` +
    ` · 被引用 **${u.cited}/${u.total}** 份产物　` +
    `← ★ 这不是任务（不引用不算病），但它**选题不受你自己搜词的盲区限制**`
  );
}

export interface ExternalUsage {
  n: number;
  total: number;
  share: number | null;
}

export function externalUsage(arts: readonly Artifact[]): ExternalUsage {
  const n = arts.filter((a) => EXTERNAL_URL_RE.test(a.text)).length;
  return { n, total: arts.length, share: arts.length ? n / arts.length : null };
}

export function renderExternal(e: ExternalUsage): string {
  const pct = e.share === null ? "未声明" : `${Math.round(e.share * 100)}%`;
  return (
    `★ 灵感叹道｜③外部材料：**${pct}**（${e.n}/${e.total}）` +
    `　← ★ 四条里最弱的一条（死线账 406 · 跨学科 96 · **外部 15** · 反驳 13）；` +
    `规则 \`onExternal\` 会按配额催（纪律㊱）`
  );
}

/** ★ 表头里认「猜想」这一列（`一句话猜想（未验证）` / `猜想`）*/
const CONJ_COL_HEAD = /^\s*\|.*猜想.*\|/;

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
export function renderAttention(a: AttentionMix): string {
  const pct = (v: number | null) => (v === null ? "未声明" : `${Math.round(v * 100)}%`);
  return (
    `★ 注意力：答辩/台账 **${pct(a.replyShare)}**（${a.reply}/${a.total}）· ` +
    `实质产出 ${a.substantive} · 其它 ${a.other}　` +
    `← ★ 10-19 答辩只占 23%、实质 53 份；10-24 答辩 78%、实质 4 份`
  );
}

export function renderGeneralizability(g: Generalizability): string {
  const pct = (v: number | null) => (v === null ? "未声明" : `${Math.round(v * 100)}%`);
  return (
    `★★★ 可推广：**${pct(g.share)} 严格**（只含通用概念 ${g.generalizable}/${g.total}）` +
    ` / **${pct(g.looseShare)} 宽**（不含本 lab 专有名词）` +
    ` · 地方志 ${g.local} · 两者都有 ${g.both} · 都不是 ${g.neither}` +
    `　← ★ 真值在两者之间（严格口径靠关键词，会漏"通但用词不同"的；纪律㉞）`
  );
}

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
