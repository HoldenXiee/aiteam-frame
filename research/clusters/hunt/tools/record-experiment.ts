// record_experiment —— ★★★★★ 把「实验」从**自由文本**变成**结构化对象**
//
// ══════════════════════════════════════════════════════════════════
// ★ 为什么要这一步（2026-10-25 的四个读数，全部实测）
//
//   · 七项缺口：账的列是 `编号·谓词·装置·结局` ⇒ **现象 / 模型 / 猜想 三格根本不存在**
//     ⇒ 它交的是「裁决」（我预期 X，实测 X，成立），不是「发现」
//   · 外部材料 3%（四条灵感叹道里最弱；而死线账 406 · 跨学科 96）
//   · 跨载体成立 12 条 —— 但那是**另立一张账**（`port.jsonl`），与实验账不同源
//   · 链深 ≥3 的项目 2 个 —— 但项目与实验之间**没有键关联**，链深靠人肉写
//
// ★★ 结论：这些不是"要提醒它"的事，是**账的形状**决定的。
//   自由文本账里，没写的格子永远不会出现；写了的也没人核。
//   ⇒ 治法（纪律㉕）：**落在结构上**。实验 = 一个对象，七个字段，其中
//     装置**由工具真跑**（exit code 落账）⇒ 读数不能编；
//     结局=活 却给不出模型 ⇒ **拒收**（没有模型的"活"只是巧合）；
//     外部出处是**必填字段**（外部材料从"灵感通道"变成"实验的属性"）。
//
// ★★★ 能力不是瓶颈（2026-10-25 能力探针，生产 spec，41 秒）：
//   找真论文（arXiv:2508.17536）· 逐字引文（我核过在摘要里）· 写成可判死断言
//   （带反向不死条件）· 设计两载体实验（含 6 条人造答案前置检查）。
//   ⇒ 缺的从来不是能力，是**账装不下它做出来的东西**。
// ══════════════════════════════════════════════════════════════════

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { logToolCall } from "./usage-log.ts";

/**
 * ★★★★★ 异步执行（2026-10-25 · 修一个会**冻住整个集群**的坑）
 *
 * ★ 原来的写法是 `execFileSync` —— 它在**集群自己的进程**里同步跑命令。
 *   后果：研究员一跑 3 分钟的实验，**整个事件循环停 3 分钟**：
 *   tick 不再触发、别的 agent 不再推进、日志一片空白。
 *   实测症状：主空间 45 分钟只有 **4 次 tick**，20 分钟只有 1 次。
 * ★★ 判据：凡是"工具里跑命令"，必须异步 —— 否则它同时是**观察者的阻塞源**。
 */
export function runCmd(
  cmd: string,
  cwd: string,
  timeoutMs = 240_000,
): Promise<{ exit: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", cmd],
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number }) | null;
        const exit = e ? (typeof e.code === "number" ? e.code : 1) : 0;
        resolve({ exit, out: `${stdout ?? ""}${stderr ?? ""}${e?.message ?? ""}` });
      },
    );
  });
}


export const EXPERIMENTS_FILE = "experiments.jsonl";

export type Outcome = "活" | "死" | "挂起";

export interface CarrierRun {
  dir: string;
  cmd: string;
  exit: number;
  head: string;
  /** ★ 这次执行开始的时刻（ms）—— 用来判 PREREG 是不是**真的在跑之前**写的 */
  ranAt?: number;
}

export interface ExperimentRow {
  at: string;
  /**
   * ★★★★★ **落账时刻**（2026-10-26 新增）
   *
   * ★ 为什么必须单独一格：`at` 是**实验发生**的时刻（常常是 PREREG/载体那会儿），
   *   而我要回答的问题经常是"这一轮新增了几条" —— 那要用落账时刻。
   * ★★ 我因为这个混用算错过两次（先按字符串窗口比 `at`，把**昨天 19–23 点**也算进"今天 09:29 之后"，
   *   又把 `at` 当落账时间，得出「39 条实验只记了 6 次调用」的假警报）。
   * ★★★ 纪律㉔：量具记的字段必须能回答你想问的问题 —— 一个 `at` 回答不了两个问题。
   * ★ 旧行没有这一格 ⇒ **未声明**，不是 0（纪律㉜）。
   */
  recordedAt?: string;
  /**
   * ★★★★ 行号（`E1`/`E2`…）—— 让**另一位**能指着它说"这个现象是真的/补的"。
   * ★ 没有 id 就没有可挑战的对象；`challenge` 只能挑战产物，不能挑战一格。
   */
  id: string;
  by: string;
  /** ★ 与 `PROJECTS.md` 的行号关联 —— 链深靠它算，不靠人肉写 */
  project: string;
  claim: string;
  killCondition: string;
  /** ★ 必填：URL 或 `本仓:<路径>` —— 外部材料是**实验的属性**，不是额外任务 */
  source: string;
  carriers: CarrierRun[];
  /** ★ 现象：可以为空，但空就必须回答"为什么空" */
  /**
   * ★★★★★ 跑前冻结的 PREREG（2026-10-25 大改 · 让"编一句预期"变难）
   *
   * ★ 为什么必须指到文件：`phenomenon` 是自由文本，最省力的满足方式是**编一句**。
   *   实测（r17/r18）：被独立审的现象里 **20%–80% 被判「补的」**——
   *   同侪用的是时间线证据（PREREG 里有没有先写死），而那条证据当时**不在账上**。
   * ★★ 所以把它做成字段：路径**必须存在**，并记下它的 mtime；
   *   读取时再看它是否**早于本轮开跑**（不是的话标"可疑"）。
   * ★★★ 这一步不判对错（那是内容判断），只是**把可核的东西放到账上**。
   */
  prereg: string;
  /**
   * ★★★★★ **跑之前写死的预期**（2026-10-26 新增，必填）
   *
   * ★ 为什么要单独一格：判"补的"一直靠在 PREREG 里**人眼找**那条预期有没有，
   *   37% 被判"补的"且**四段持平**（40/40/25/44%），说明这不是能力问题，是结构问题。
   * ★★ 结构解法：`expected` 必须**逐字出现在 PREREG 文件里**。
   *   配上已有的「PREREG 必须早于装置第一次执行」，"预期是不是事后补的"就**不再靠判断**：
   *     · 逐字在里面 + PREREG 早于执行  ⇒ 预期**确实**先有
   *     · 逐字不在里面（或 PREREG 晚了）⇒ 它是**事后**写的，机械可查
   * ★★★ 我不判"这条预期写得对不对"（那是内容），只判"它是不是跑前就写在那儿"。
   */
  expected: string;
  /** ★ 逐字命中 PREREG 的第几行（0 = 没命中）*/
  expectedAtLine?: number;
  preregMtime: number;
  preregBeforeRun: boolean;
  phenomenon: string;
  phenomenonAbsent: "" | "没有意外" | "有但没记";
  /** ★ 结局=活 时必填：没模型的"活"只是巧合 */
  model: string;
  /**
   * ★★★★★ 猜想的状态（2026-10-26 新增，必填三选一）
   *
   * ★ 为什么：DESIGN §1 硬要求「模型/猜想**必须标「未验证」**」，
   *   而实测**逐条标注 1/91** —— 我之前的合规只是**表头级**的（列名叫"猜想（未验证）"），
   *   那不是它标了，是我给它算了。
   * ★★ 结构解法：不做"要求它记得写"，做**字段**：每条实验必须选一个状态，
   *   选「已验证」还要给出证据（`conjectureEvidence`），否则拒收。
   */
  conjectureState: "未验证" | "已验证" | "已推翻";
  /** ★ 选「已验证 / 已推翻」时必须指到证据（实验 id / 产物名 / 读数文件）*/
  conjectureEvidence?: string;
  /**
   * ★★★★★ 对照（人造答案）（2026-10-26 新增）
   *
   * ★ 为什么：DESIGN §7③「读数必须自带**人造答案**（能证明"该失败时它失败"）」
   *   是硬要求，但**从来没有读数** —— 我粗测 52/91 有 fixture 痕迹，不可核。
   * ★★ 结构解法：跟 `phenomenon` 同形 ——
   *   · 给了 `control`（一条**应该失败**的命令）：工具真跑它，记退出码，
   *     `controlExit !== 0` 才算"该失败时它失败"
   *   · 没给：必须二选一说明（`controlAbsent`）—— 三态，不许静默跳过（纪律㉜）
   */
  control?: { dir: string; cmd: string; exit: number; at: string };
  controlAbsent?: "" | "这次没有对照" | "有但没记";
  /**
   * ★★★★★ 本仓出处的**外部对照**（2026-10-26 新增）
   *
   * ★ 现状：`source` 一半是纯 `本仓:`（49/91）⇒ "外部有没有人做过" 根本没被问过。
   * ★★ 不做"必须有外部链接"（那会逼出假引用），做**必须声明**：
   *   出处里一个外部都没有 ⇒ 写一句"我搜过什么、找到什么 / 没找到"。
   *   ★ 三态：写了 / 不需要（有外部）/ 未声明（旧行）。
   */
  externalCheck?: string;
  conjecture: string;
  outcome: Outcome;
  /**
   * ★★★★★ 现象的**独立审查**（2026-10-25 大改 · 补上"填了不等于真"这一格）
   *
   * ★ 为什么必须有：整治后 `现象` 从 1% 到 14/14 —— 但那只是"填了"。
   *   常识告诉我：**一个自报的'意外'可以是补出来的**（先看读数再编预期）。
   * ★★ 判据只能由**另一位**给（自己审自己不算 —— 与 forge 的「作者自签」是同一个病）。
   * ★★★ 于是 `discovery` 不再只看"填了没有"，而是看"**有没有人独立认过**"。
   */
  phenomenonVerdict: "真意外" | "补的" | "未审";
  reviewedBy: string;
  reviewNote: string;
}

export function experimentsPath(lab: string): string {
  return join(lab, "work", EXPERIMENTS_FILE);
}

export function readStructured(lab: string): ExperimentRow[] {
  const p = experimentsPath(lab);
  if (!existsSync(p)) return [];
  const out: ExperimentRow[] = [];
  for (const line of readFileSync(p, "utf8").split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as ExperimentRow);
    } catch {
      /* 撕裂行：由别的量具计数 */
    }
  }
  return out;
}

/** ★ 下一个行号（`E1`…）—— 幂等：只看已有条数 */
/**
 * ★★★★ 一份 PREREG 只能服务一个实验（2026-10-25）
 *
 * ★ 为什么必须堵：`prereg` 是"跑前冻结的预期"的证据。若同一份文件能给 N 条实验当
 *   "我的预期写在里面"，那这道证据就退化成一句**通用的免责声明** ——
 *   而实测（r17–r22）现象里 **50%+ 被判「补的」**，同侪抓的正是"没有跑前预期"。
 * ★★ 判据是纯形式的：**同路径被用过就拒**（不判内容）。
 *   要写第二条，就再写一份（预期本来就该逐条写死）。
 */
export function preregAlreadyUsed(lab: string, prereg: string): ExperimentRow | undefined {
  const norm = (x: string) => x.split("\\").join("/").trim().toLowerCase();
  return readStructured(lab).find((r) => norm(r.prereg) === norm(prereg));
}

export function nextId(lab: string): string {
  return `E${readStructured(lab).length + 1}`;
}

export function appendStructured(lab: string, row: ExperimentRow): void {
  mkdirSync(join(lab, "work"), { recursive: true });
  appendFileSync(experimentsPath(lab), JSON.stringify(row) + "\n", "utf8");
}

/**
 * ★★★★★ 独立审查一格「现象」—— **另一个座位**才能做（自己审自己不算）
 *
 * ★ 为什么必须有：整治后现象从 1% 到 14/14，但那只说明**填了**。
 *   自报的"意外"完全可以是**先看读数再编预期**。
 * ★★ 所以 `discovery` 不该只看"填了没有"，要看"有没有人独立认过"。
 */
export interface ReviewResult {
  ok: boolean;
  reason?: string;
  row?: ExperimentRow;
}

export function applyReview(
  lab: string,
  id: string,
  r: { by: string; verdict: "真意外" | "补的"; note: string },
): ReviewResult {
  const rows = readStructured(lab);
  const i = rows.findIndex((x) => x.id === id);
  if (i < 0) {
    return { ok: false, reason: `没有 ${id} 这一行（现有：${rows.map((x) => x.id).join(" · ") || "空账"}）` };
  }
  const row = rows[i]!;
  if (row.by === r.by) {
    return { ok: false, reason: `不能审自己写的实验（作者 ${row.by}）—— 自签不算独立审查` };
  }
  if (!r.note.trim()) {
    return { ok: false, reason: "必须写 note：凭什么判它是真意外/补的（指到 PREREG、读数或时间线）" };
  }
  rows[i] = { ...row, phenomenonVerdict: r.verdict, reviewedBy: r.by, reviewNote: r.note };
  mkdirSync(join(lab, "work"), { recursive: true });
  writeFileSync(
    experimentsPath(lab),
    rows.map((x) => JSON.stringify(x)).join(String.fromCharCode(10)) + String.fromCharCode(10),
    "utf8",
  );
  return { ok: true, row: rows[i] };
}

export function makeReviewExperiment(deps: { lab: string; selfKey: string }) {
  return defineTool({
    name: "review_experiment",
    label: "Review Experiment",
    description:
      "★ **审别人记的实验里的「现象」那一格**：是真意外，还是先看读数再补的预期？\n" +
      "★★ **不能审自己写的**（自签不算独立审查，会被拒）。\n" +
      "★ 判 `补的` 要指到证据：PREREG 里有没有先写死预期 / 读数是否只在事后出现 / 预期写得比读数还笼统。\n" +
      "★ 这个判定直接决定它算不算「发现型」—— 别客气，也别报复。",
    parameters: Type.Object({
      id: Type.String({ description: "实验行号（例如 E3）" }),
      verdict: Type.Union([Type.Literal("真意外"), Type.Literal("补的")], {
        description: "真意外 / 补的（先看读数再编预期）",
      }),
      note: Type.String({ description: "★ 凭什么（指到 PREREG/读数/时间线），不许写「看起来像」" }),
    }),
    execute: async (_id, p) => {
      logToolCall("review_experiment", String(p.id));
      const r = applyReview(deps.lab, p.id, { by: deps.selfKey, verdict: p.verdict, note: p.note });
      if (!r.ok) return { content: [{ type: "text" as const, text: `⛔ ${r.reason}` }], details: {} };
      const s = sevenStats(readStructured(deps.lab));
      return {
        content: [
          {
            type: "text" as const,
            text:
              `✔ ${p.id} 的现象判为 **${p.verdict}**（审查人 ${deps.selfKey}）\n` +
              `★ 全账：独立审查 ${s.reviewed} 条 · 判"补的" ${s.calledFake} 条 · 未审 ${s.rows - s.reviewed} 条`,
          },
        ],
        details: {},
      };
    },
  });
}

/**
 * ★★★ 七项齐不齐 —— 现在**由对象保证**，不再靠"账里有没有那一列"。
 * ★ 仍未保证的只有一项：**现象为空但声明了原因**（那也算回答了）。
 */
export interface SevenStats {
  rows: number;
  withPhenomenon: number;
  withModel: number;
  withConjecture: number;
  /** ★ 跨载体成立（≥2 个载体都 exit 0）*/
  portable: number;
  /** 现象被**另一位**审过的条数 */
  reviewed: number;
  /** 被判「补的」的条数 */
  calledFake: number;
  /** ★ prereg 是本轮内才写的（可疑：可能是先看读数再补预期）*/
  latePrereg: number;
  /** 通过 ≥2 载体 + 现象 + 模型 + **结局=活** ⇒ "发现型" */
  discovery: number;
  /**
   * ★★ 反例型：≥2 载体 + 现象 + 模型 + **结局=死**。
   * 为什么单列（集群在 r11 抓到的）：「预期 X，实测 Y ⇒ X 错」**也是**发现，
   * 但把死行算进"发现型"会让那个数**对实验失败不敏感** —— 那正是它自己写的那句：
   * 「自称装『新东西』的计数，对『实验死了』不敏感」。
   */
  refuting: number;
  sources: number;
}

/**
 * ★★★★★ 按 `project` 聚合 —— **链深终于能自动算了**（不再靠人肉写"版本 v6"）
 * ★★ 链深的定义：该 project 的**实验行数**（每条 = 推了一次）。
 *   为什么不用"版本号差"：版本号是它手写的，会撞号（`X2-IS` 撞过，它自己记了 P127）。
 */
export interface ProjectChain {
  project: string;
  rows: number;
  /** 有几条带真外部 URL */
  external: number;
  /** 有几条被独立审查过 */
  reviewed: number;
  /** 被判"补的" */
  calledFake: number;
}

export function projectChains(rows: readonly ExperimentRow[]): ProjectChain[] {
  const m = new Map<string, ProjectChain>();
  for (const r of rows) {
    const k = r.project.replace(/[`*]/g, "").trim() || "(未声明)";
    const cur = m.get(k) ?? { project: k, rows: 0, external: 0, reviewed: 0, calledFake: 0 };
    cur.rows++;
    if (EXTERNAL_URL.test(r.source)) cur.external++;
    if (r.reviewedBy && r.reviewedBy !== r.by) cur.reviewed++;
    if (r.phenomenonVerdict === "补的") cur.calledFake++;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.rows - a.rows);
}

/** ★ 链深 ≥3 的项目数（DESIGN §"跨轮累积"的直接判据）*/
export function deepProjects(rows: readonly ExperimentRow[], min = 3): number {
  return projectChains(rows).filter((c) => c.rows >= min).length;
}

/** ★★★ 「真外部 URL」一等判据（与 `本仓:` 分开数，不许混）*/
const EXTERNAL_URL = /^(https?:\/\/|arxiv:|doi:|10\.\d{4}\/)/i;

export function externalUrlShare(rows: readonly ExperimentRow[]): {
  /** ★ 出处**以外部为主**（source 开头就是 URL/arXiv/DOI）*/
  n: number;
  /** ★★ 出处里**含**外部（`本仓:… + https://…` 也算 —— 它确实引了外部）*/
  any: number;
  total: number;
  share: number | null;
} {
  // ★★★ 2026-10-26 · **这个字段原来只算"以外部为主"**，而 DESIGN §9 要的是「写了出处」
  //   实测差 17 条：`本仓:work/P213/… · https://tc39.es/…` 这种被判成"没有外部"，
  //   而它真引了 TC39 / RFC / HL7。
  //   ⇒ 两个口径**并排报**，别让一个名字骗了下一个读它的人（纪律㉔）。
  const n = rows.filter((r) => EXTERNAL_URL.test(r.source)).length;
  const any = rows.filter((r) => /https?:\/\/|arxiv:|doi:|10\.\d{4}\//i.test(r.source)).length;
  return { n, any, total: rows.length, share: rows.length ? any / rows.length : null };
}

export function sevenStats(rows: readonly ExperimentRow[]): SevenStats {
  const withPhenomenon = rows.filter((r) => r.phenomenon.trim().length > 0).length;
  const withModel = rows.filter((r) => r.model.trim().length > 0).length;
  const withConjecture = rows.filter((r) => r.conjecture.trim().length > 0).length;
  const ok = rows.filter((r) => r.carriers.length >= 2 && r.carriers.every((c) => c.exit === 0)).length;
  const withPhen = (r: ExperimentRow) =>
    r.carriers.length >= 2 && r.carriers.every((c) => c.exit === 0) && !!r.phenomenon.trim() && !!r.model.trim();
  // ★★ 独立审查过、且没被判"补的" —— 这才算现象站得住（自己审自己不算）
  // ★★★ 独立审查过、且没被判"补的" —— 这才算现象站得住（自己审自己不算）
  //   ★★★★ 2026-10-25 补接线：这个谓词我上一批**写了但没用**
  //     （`discovery` 原来只要"填了+活"）⇒ 「发现型 23」是高估的。第 18 次「写好了没接上」。
  const independent = (r: ExperimentRow) => !!r.reviewedBy && r.reviewedBy !== r.by && r.phenomenonVerdict !== "补的";
  const discovery = rows.filter((r) => withPhen(r) && r.outcome === "活" && independent(r)).length;
  const refuting = rows.filter((r) => withPhen(r) && r.outcome === "死" && independent(r)).length;
  const sources = rows.filter((r) => !!r.source.trim()).length;
  const reviewed = rows.filter((r) => !!r.reviewedBy && r.reviewedBy !== r.by).length;
  const calledFake = rows.filter((r) => r.phenomenonVerdict === "补的").length;
  const latePrereg = rows.filter((r) => r.prereg && !r.preregBeforeRun).length;
  return { rows: rows.length, withPhenomenon, withModel, withConjecture, portable: ok, reviewed, calledFake, latePrereg, discovery, refuting, sources };
}

export function renderSeven(s: SevenStats): string {
  if (s.rows === 0) {
    return (
      "★★★ 结构化实验账：**0 条**（`work/experiments.jsonl` 还没有）—— " +
      "★ 用 `record_experiment` 记：它会**真跑装置**、按七个字段落账，缺格会拒收"
    );
  }
  return (
    `★★★ 结构化实验：**${s.rows} 条** · 现象 ${s.withPhenomenon} · 模型 ${s.withModel} · 猜想 ${s.withConjecture}` +
    ` · **跨载体成立 ${s.portable}** · ★ 现象被独立审 ${s.reviewed}（判"补的"${s.calledFake}）` +
    (s.latePrereg > 0 ? ` · ⚠ PREREG 本轮内才补的 ${s.latePrereg} 条` : "") +
    ` · ★ 发现型 ${s.discovery} · ★★ 反例型 ${s.refuting}` +
    ` · 有出处 ${s.sources}` +
    `　← ★ 「预期 X，实测 Y ⇒ X 错」两种结局都算（发现型=活，反例型=死）；只有"两条都不占"的才是纯裁决`
  );
}

/** ★ cwd 必须在 lab 里面（写边界不变）*/
export function insideLabDir(lab: string, dir: string): boolean {
  const a = resolve(lab).toLowerCase();
  const b = resolve(dir).toLowerCase();
  return b === a || b.startsWith(a + sep);
}

const SOURCE_OK = /^(https?:\/\/|arxiv:|doi:|本仓[:：]|10\.\d{4}\/)/i;

export function validateExperiment(p: {
  project: string;
  claim: string;
  killCondition: string;
  source: string;
  prereg: string;
  expected: string;
  carriers: readonly { dir: string; cmd: string }[];
  phenomenon: string;
  phenomenonAbsent: string;
  model: string;
  outcome: string;
  projectIds: readonly string[];
  conjectureState?: string;
  conjectureEvidence?: string;
  control?: { dir: string; cmd: string };
  controlAbsent?: string;
  externalCheck?: string;
}): string[] {
  const errs: string[] = [];
  if (p.projectIds.length > 0 && !p.projectIds.includes(p.project)) {
    errs.push(`project「${p.project}」不在 \`PROJECTS.md\` 里（现有：${p.projectIds.join(" · ")}）—— 实验必须挂在项目上，链深才数得出来`);
  }
  if (p.claim.trim().length < 8) errs.push("claim 太短：要写成一句能指回产物的话（≥8 字）");
  if (p.killCondition.trim().length < 8) errs.push("killCondition 太短：写清「若 X 则它错」，否则不是可判死的实验");
  if (!SOURCE_OK.test(p.source.trim())) {
    errs.push("source 必须是 URL / arXiv / DOI / `本仓:<路径>` —— 外部出处是**实验的属性**，不是可选装饰");
  }
  if (!p.prereg.trim()) {
    errs.push("prereg 必填：写清**跑前冻结**的那份文件（`work/…-PREREG.md`）—— 它是「预期是否事后补」唯一可核的东西");
  }
  if (!p.expected.trim()) {
    errs.push(
      "expected 必填：**跑之前**你写死的那句预期（★ 必须**逐字**出现在 PREREG 文件里）—— " +
        "没有它，「现象」就只能靠别人凭印象判「是真的意外还是事后补的」",
    );
  }
  if (p.carriers.length === 0) errs.push("至少要一个载体（carrier），否则读数没有落点");
  for (const c of p.carriers) {
    if (!c.dir.trim()) errs.push("载体少了 dir");
    if (!c.cmd.trim()) errs.push("载体少了 cmd —— 「装置」必须是一条能跑的命令");
  }
  if (!p.phenomenon.trim() && !p.phenomenonAbsent) {
    errs.push(
      "现象为空 ⇒ 必须二选一说明：`没有意外` 或 `有但没记`（★ 这是唯一能装「你没料到的事」的格子，不许静默空着）",
    );
  }
  if (!p.conjectureState) {
    errs.push(
      "conjectureState 必填（未验证 / 已验证 / 已推翻）—— DESIGN 要求猜想**必须标状态**，" +
        "以前只有表头写着「未验证」，等于没标",
    );
  } else if (p.conjectureState !== "未验证" && !(p.conjectureEvidence ?? "").trim()) {
    errs.push(
      `conjectureState=${p.conjectureState} ⇒ 必须给 conjectureEvidence（指到实验 id / 产物 / 读数文件）` +
        " —— 说「已验证」却指不出证据，等于把猜想当结论",
    );
  }
  // ★ 出处里一个外部都没有 ⇒ 必须声明"外面的世界怎么说"
  const hasExternal = /https?:\/\/|arxiv:|doi:|10\.\d{4}\//i.test(p.source);
  if (!hasExternal && !(p.externalCheck ?? "").trim()) {
    errs.push(
      "source 里没有一条外部（URL/arXiv/DOI）⇒ 必须填 `externalCheck`：" +
        "你搜过什么、找到什么；**没找到也要写**（★ 不逼你编引用，但逼你问过外面）",
    );
  }
  if (!p.control && !p.controlAbsent) {
    errs.push(
      "★ 没有对照（`control`）⇒ 必须二选一说明：`这次没有对照` 或 `有但没记`。" +
        "对照 = 一条**应该失败**的命令（人造答案）；没有它，" +
        "读数通过只能说明「跑起来了」，不能说明「判得对」",
    );
  }
  if (p.outcome === "活" && !p.model.trim()) {
    errs.push("结局=活 但没写 model ⇒ **拒收**：没有机制的「活」只是一次巧合，不是结论");
  }
  return errs;
}

export function makeRecordExperiment(deps: {
  lab: string;
  selfKey: string;
  projectIds: () => string[];
}) {
  return defineTool({
    name: "record_experiment",
    label: "Record Experiment",
    description:
      "★ **记一条实验**（这是这个集群的知识单位）。\n" +
      "★★ 它会**真跑你给的装置**（每个载体一条命令），把退出码与输出头落账 —— **读数不能编**。\n" +
      "★ 七个字段：假设 claim / 判死条件 / 装置（carriers 里的 cmd）/ 读数（工具自己抓）/ " +
      "现象 / 模型 / 猜想 / 结局。\n" +
      "★ **缺格会拒收**：`结局=活` 却没写 `model` 会被拒（没有机制的活只是巧合）；" +
      "现象空着必须二选一说明理由。\n" +
      "★ `source` 是必填：URL / arXiv / DOI / `本仓:<路径>` —— 外部出处是**实验的属性**。\n" +
      "★ `project` 必须是 `PROJECTS.md` 里已有的行号 —— 链深靠这个键算，不靠人肉写。",
    parameters: Type.Object({
      project: Type.String({ description: "★ 挂在哪个项目上（`PROJECTS.md` 的行代号，例如 X2）" }),
      claim: Type.String({ description: "假设（一句话，能指回产物/结论）" }),
      killCondition: Type.String({ description: "★ 判死条件：若观察到 X，则这条假设错" }),
      source: Type.String({ description: "★ 出处：URL / arXiv:xxxx / DOI / `本仓:<路径>`" }),
      prereg: Type.String({
        description:
          "★ **跑前冻结**的 PREREG 文件路径（例如 `work/xxx-PREREG.md`）。必须已存在；工具会记 mtime 并判它是不是本轮开跑前就写好的",
      }),
      expected: Type.String({
        description:
          "★★★★ **跑之前写死的那句预期** —— 必须**逐字**出现在 `prereg` 文件里（工具会核对行号）。" +
          "★ 这一格存在的原因：以前「现象是不是真意外」只能靠另一位凭印象判，37% 被判\"补的\"且四段持平；" +
          "有了它，「预期是不是事后补的」变成**机械核对**（逐字在不在 + PREREG 早不早于执行）。",
      }),
      carriers: Type.Array(
        Type.Object({
          dir: Type.String({ description: "★ 载体目录（相对本 lab，例如 work/lab-A）" }),
          cmd: Type.String({ description: "★ 在这个载体里跑的命令（这就是「装置」）" }),
        }),
        { description: "1–3 个载体。★ 两个以上载体都 exit 0 才算「跨载体成立」" },
      ),
      phenomenon: Type.String({ description: "★ 现象：实测**与你预期不一样**的地方（写不出就留空并在下面说明）" }),
      phenomenonAbsent: Type.Union([Type.Literal(""), Type.Literal("没有意外"), Type.Literal("有但没记")], {
        description: "★ phenomenon 为空时必填：这次真没有意外，还是有但你没记？",
      }),
      model: Type.String({ description: "★ 模型/机制：为什么会得到这个读数（结局=活 时必填）" }),
      conjecture: Type.String({ description: "猜想：这条读数指向的下一个可验证问题（可空）" }),
      conjectureState: Type.Union(
        [Type.Literal("未验证"), Type.Literal("已验证"), Type.Literal("已推翻")],
        {
          description:
            "★★★★ **猜想的状态**（必填）。默认「未验证」—— DESIGN 要求猜想必须标状态；" +
            "选「已验证/已推翻」必须同时给 `conjectureEvidence`（指到实验 id / 产物 / 读数文件）。" +
            "★ 这一格是 2026-10-26 加的：之前只有表头写着「未验证」，逐条标注 1/91，等于没标。",
        },
      ),
      conjectureEvidence: Type.Optional(
        Type.String({ description: "★ 选「已验证/已推翻」时必填：证据指到哪（实验 id / 产物名 / 读数文件）" }),
      ),
      control: Type.Optional(
        Type.Object({
          dir: Type.String({ description: "★ 对照跑的目录（相对本 lab）" }),
          cmd: Type.String({ description: "★ **应该失败**的命令（人造答案：它必须 exit ≠ 0）" }),
        }, { description: "★★★★ 对照（人造答案）：一条**应该失败**的命令。工具会真跑它并记退出码；`exit ≠ 0` 才算「该失败时它失败」" }),
      ),
      externalCheck: Type.Optional(
        Type.String({
          description:
            "★ `source` 里没有外部出处时**必填**：你搜过什么、找到什么（**没找到也要写**）。" +
            "★ 不逼你编引用，但逼你**问过外面的世界** —— 没有外部输入，再大的权限也只会自我循环。",
        }),
      ),
      controlAbsent: Type.Optional(
        Type.Union([Type.Literal(""), Type.Literal("这次没有对照"), Type.Literal("有但没记")], {
          description: "★ 没给 `control` 时必填：这次真没有对照，还是有但你没记",
        }),
      ),
      outcome: Type.Union([Type.Literal("活"), Type.Literal("死"), Type.Literal("挂起")], {
        description: "结局：活（假设没被推翻）/ 死（被推翻，说清死因）/ 挂起（缺什么证据）",
      }),
    }),
    execute: async (_id, p) => {
      logToolCall("record_experiment", String((p as { project?: string }).project ?? ""));
      const errs = validateExperiment({ ...p, projectIds: deps.projectIds() });
      if (errs.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "⛔ 拒收（补完再交，别改成自由文本绕过去）：\n" + errs.map((e) => `  · ${e}`).join("\n"),
            },
          ],
          details: {},
        };
      }
      // ★★ 一份 PREREG 只能服务一个实验
      const used = preregAlreadyUsed(deps.lab, p.prereg);
      if (used) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⛔ \`${p.prereg}\` 已经被 **${used.id}** 用过了（${used.claim.slice(0, 40)}…）。` +
                String.fromCharCode(10) +
                "★ 一份 PREREG 只能服务一个实验 —— 否则「跑前预期」会退化成一句通用的免责声明。" +
                String.fromCharCode(10) +
                "★ 给这条实验**另写一份**（把预期逐条写死），再记。",
            },
          ],
          details: {},
        };
      }

      // ★ prereg 必须存在（编不出来的那种证据）
      const preregPath = p.prereg.startsWith("/") || /^[A-Za-z]:/.test(p.prereg) ? p.prereg : join(deps.lab, p.prereg);
      let preregMtime = 0;
      try {
        preregMtime = statSync(preregPath).mtimeMs;
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⛔ PREREG 不在盘上：\`${p.prereg}\`
` +
                "★ 先写它（把预期写死），再跑实验。**没有跑前记录的「意外」不算现象。**",
            },
          ],
          details: {},
        };
      }
      // ★★★ 正确的顺序判据（2026-10-25 修）：PREREG 早于**装置第一次执行**。
      //   原来判的是"早于本轮开跑" —— 那是错的：PREREG 本来就是每实验各写一份、
      //   在本轮内写的 ⇒ 每一行都会被判"本轮补的"（r19/r20 实测 6/6，全是假警报）。
      //   ★ 缺数据 ≠ 假：算不出来时留 null，不默认 true（纪律㉜）。

      // ★ 真跑装置
      const runs: CarrierRun[] = [];
      const problems: string[] = [];
      for (const c of p.carriers) {
        const dir = c.dir.startsWith("/") || /^[A-Za-z]:/.test(c.dir) ? c.dir : join(deps.lab, c.dir);
        if (!insideLabDir(deps.lab, dir)) {
          problems.push(`载体 ${c.dir} 不在本 lab 里面（写边界不变）`);
          continue;
        }
        const ranAt = Date.now();
        // ★ 异步执行：同步版会冻住整个事件循环（见 runCmd 的注释）
        const r = await runCmd(c.cmd, dir);
        const exit = r.exit;
        const out = r.out;
        runs.push({ dir: c.dir, cmd: c.cmd, exit, head: out.slice(0, 600), ranAt });
      }
      if (problems.length > 0) {
        return {
          content: [{ type: "text" as const, text: "⛔ " + problems.join("；") }],
          details: {},
        };
      }

      // ★★★★★ 对照（人造答案）—— 工具**真跑**那条"应该失败"的命令
      //
      //   ★ DESIGN §7③ 要求"读数必须自带人造答案"，以前没有读数、也没结构。
      //   ★★ 判据：`exit !== 0` 才算「该失败时它失败」。它真失败 ⇒ 说明装置不是在瞎报成功。
      //   ★★★ 若它**竟然成功了**（exit === 0），不改判它，但**必须让这件事响**：
      //     返回值里明说"你的对照没失败 ⇒ 这个装置对错不敏感"。
      let controlRun: ExperimentRow["control"];
      let controlWarn = "";
      if (p.control && p.control.cmd.trim()) {
        const cdir = p.control.dir.startsWith("/") || /^[A-Za-z]:/.test(p.control.dir)
          ? p.control.dir
          : join(deps.lab, p.control.dir);
        if (!insideLabDir(deps.lab, cdir)) {
          return {
            content: [{ type: "text" as const, text: "⛔ 对照目录不在本 lab 里面（写边界不变）" }],
            details: {},
          };
        }
        const cr = await runCmd(p.control.cmd, cdir);
        controlRun = { dir: p.control.dir, cmd: p.control.cmd, exit: cr.exit, at: new Date().toISOString() };
        if (cr.exit === 0) {
          controlWarn =
            "\n⚠ **你的对照没失败**（exit=0）⇒ 这个装置对「对/错」不敏感，「跑通了」不能证明「判得对」。";
        }
      }
      const row: ExperimentRow = {
        at: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        id: nextId(deps.lab),
        phenomenonVerdict: "未审",
        reviewedBy: "",
        reviewNote: "",
        by: deps.selfKey,
        project: p.project,
        claim: p.claim,
        killCondition: p.killCondition,
        source: p.source,
        prereg: p.prereg,
        expected: p.expected,
        expectedAtLine: (() => {
          // ★★★★★ 逐字核对：`expected` 必须是 PREREG 文件里**已有的**那一段（不是它事后补的）
          //
          //   ★ 只判"在不在 + 在第几行"，不判它写得对不对（那是内容）。
          //   ★★ 配 `preregBeforeRun` 一起看：两条都成立 ⇒ 预期**确实**先有，机械可查。
          let text = "";
          try {
            text = readFileSync(preregPath, "utf8");
          } catch {
            return 0;
          }
          const lines = text.split(String.fromCharCode(10));
          const needle = p.expected.trim();
          if (!needle) return 0;
          const i = lines.findIndex((l) => l.includes(needle));
          return i >= 0 ? i + 1 : 0;
        })(),
        preregMtime,
        preregBeforeRun: (() => {
          const firstRun = Math.min(...runs.map((r) => r.ranAt ?? Number.POSITIVE_INFINITY));
          if (!Number.isFinite(firstRun)) return false;
          return preregMtime < firstRun;
        })(),
        carriers: runs,
        phenomenon: p.phenomenon,
        phenomenonAbsent: p.phenomenonAbsent as ExperimentRow["phenomenonAbsent"],
        model: p.model,
        conjecture: p.conjecture,
        conjectureState: (p.conjectureState ?? "未验证") as ExperimentRow["conjectureState"],
        conjectureEvidence: p.conjectureEvidence ?? "",
        control: controlRun,
        controlAbsent: (p.controlAbsent ?? "") as ExperimentRow["controlAbsent"],
        externalCheck: p.externalCheck ?? "",
        outcome: p.outcome,
      };
      appendStructured(deps.lab, row);
      const s = sevenStats(readStructured(deps.lab));
      const portable = runs.length >= 2 && runs.every((r) => r.exit === 0);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `✔ 已落账（\`work/experiments.jsonl\`）· ${runs.length} 个载体：\n` +
              runs.map((r) => `  · ${r.dir} ⇒ exit **${r.exit}**`).join("\n") +
              `\n\n★ 跨载体成立：**${portable ? "是" : "否"}**（要 ≥2 个载体都 exit 0）` +
              `\n★ 全账：${s.rows} 条 · 发现型 ${s.discovery} · 跨载体成立 ${s.portable}` +
              (s.discovery === 0
                ? "\n★★ 现在账里 **0 条发现型**（跨载体 + 现象 + 模型）—— 裁决不是发现。"
                : ""),
          },
        ],
        details: {},
      };
    },
  });
}
