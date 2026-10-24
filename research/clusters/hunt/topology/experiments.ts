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
  /** 引用了装置但**不在盘上**的（★ 这类是"证据落空"，单独报，不许并进覆盖率） */
  deviceMissing: number;
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
export function parseLedger(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(String.fromCharCode(10))) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.split("|").map((c) => c.trim());
    // cells[0] 是空（行首 |）；至少要有 id + 一个结局格
    if (cells.length < 4) continue;
    const id = cells[1] ?? "";
    if (!id || /^[-:\s]+$/.test(id)) continue; // 分隔行
    if (/^(编号|id|实验)/i.test(id)) continue; // 表头
    // ★ 结局取**最后一格非空**（表头顺序可能变，取尾部最稳）
    const tail = cells.slice(2).filter((c) => c && !/^[-:\s]+$/.test(c));
    const last = tail.length ? tail[tail.length - 1]! : "";
    rows.push({ id, outcome: classifyOutcome(last), cause: last, anchored: hasAnchor(last) });
  }
  return rows;
}

/** 没有账时：从文件名推断实验（★ 只认编号前缀，其它一律不算） */
export function inferRows(arts: Artifact[], prefixes = ["P"]): Row[] {
  const re = new RegExp(`^(${prefixes.join("|")})\\d+`, "i");
  return arts
    .filter((a) => re.test(a.file))
    .map((a) => {
      const head = a.text.slice(0, 4000);
      // ★ 「死」的推断只认明写的结局栏，不从语气猜
      const m = head.match(/(?:结局|状态|结论)[：:]\s*([^\n]{0,80})/);
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
    deviceMissing: missing,
  };
}

/** 渲染（★ 缺数据写「未声明」，绝不写 0 —— 纪律㉜） */
export function renderExperiments(s: Stats, att: Attribution, mix: SourceMix): string {
  const pct = (v: number | null) => (v === null ? "未声明" : `${Math.round(v * 100)}%`);
  const L: string[] = [];
  L.push(
    `★ 实验账[${s.mode}]：共 ${s.total} · 活 ${s.byOutcome.active} · 死 ${s.byOutcome.dead}` +
      ` · 挂起 ${s.byOutcome.parked} · 移交 ${s.byOutcome.handoff} · **未声明 ${s.byOutcome.unsaid}**`,
  );
  L.push(`   新开：24h ${s.newLast24h} · 7d ${s.newLast7d}   ← ★ 主判据（DESIGN §9）`);
  L.push(`   死因可判死：${pct(s.deadCauseJudgeable)}   装置覆盖：${pct(s.deviceCoverage)}（证据落空 ${s.deviceMissing} 条）`);
  L.push(`   ★★ 投递驱动比：${pct(att.share)}（${att.deliveryDriven}/${att.total}）—— 反向指标，越低越好`);
  L.push(
    `   灵感出处：外部材料 ${mix.external} · 跨学科 ${mix.interdisciplinary} · 明写出处 ${mix.declared}` +
      `（共 ${mix.total}）`,
  );
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
): { stats: Stats; att: Attribution; mix: SourceMix; rows: Row[] } {
  if (labRoot.replace(/[\\/]+$/, "").endsWith("outbox") || labRoot.endsWith("work")) {
    throw new Error(
      `readExperiments 要的是**集群空间根**（如 research/labfirst/hunt），拿到的是「${labRoot}」。` +
        `★ 传错根会静默返回空 —— 所以这里直接抛错。`,
    );
  }
  const outboxDir = join(labRoot, "outbox");
  const arts = readArtifacts(outboxDir);
  const ledgerPath = join(outboxDir, "EXPERIMENTS.md");

  let rows: Row[];
  let mode: Stats["mode"];
  if (existsSync(ledgerPath)) {
    rows = parseLedger(readFileSync(ledgerPath, "utf8"));
    mode = "ledger";
  } else {
    rows = inferRows(arts);
    mode = "inferred";
  }

  const byFile = new Map(arts.map((a) => [a.file, a]));
  const refsByRow = new Map<string, string[]>();
  for (const r of rows) {
    const a = byFile.get(r.id);
    refsByRow.set(r.id, a ? deviceRefs(a.text) : []);
  }
  const stats = experimentStats(
    rows,
    {
      refsFor: (id) => refsByRow.get(id) ?? [],
      exists: (p) => existsSync(join(labRoot, p)) || existsSync(join(labRoot, "..", "..", "..", p)),
    },
    { now, mtimeOf: (id) => byFile.get(id)?.mtimeMs },
    mode,
  );

  return { stats, att: deliveryDriven(arts), mix: sourceMix(arts), rows };
}
