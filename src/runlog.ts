// 行内 provenance：让「这一行是拿哪份冻结判据算的」成为每一行自带的对象。
//
// 为什么在这一层（库）而不是每个 exp-*.ts 各写一遍：
//   1) 写入路径只有一处 → 不靠「记得」；驱动照旧 append(rec) 就行。
//   2) 每次 append 都**重算** PREREG/driver/judge 的 sha ⇒ 「跑中改判据」当场抛错（HARK 的窗口就在这里）。
//   3) 旧批没有字段 ⇒ 反查器判 UNTRACEABLE；**缺失是一个判决，不是默认通过**。
//
// ★★★ 2026-10-25 追加：印章从「只绑指针」升级到「绑指针 + 绑字节 + 绑顺序」。
//   由头是 outbox/手段XV-判据可反查性分级-窗口内容绑定0行-行内印章只绑指针不绑数据-剩余缺口122行.md §4：
//   四种人造篡改（删行 / 等长改值 / 截尾 / 换序）对旧印章 **4/4 未检出** —— 旧 criteria 只证明
//   「这一行是在判据 X 之下 append 的」，**不证明这一行的内容没被改过**。
//   现在每行多一个 seal（seq / rowSha / prev / chainSha），代价是 append 里一次 sha256，
//   换来 windowSha 那个贵机制才有的**内容与顺序绑定**（windowSha 在本语料是 0 行通过）。
//
// 最小用法（驱动里两行）：
//   const log = openRunLog({ file: "runs/x.jsonl", experiment: "x", driverFile: fileURLToPath(import.meta.url) });
//   log.append(rec);
//   console.log(log.head());   // ★ 把这个值记到 outbox/PREREG（出带外锚点），尾截断才可判
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SHA_ALGO = "sha256" as const;

function shaBuf(buf: Buffer | string, len: number): string {
  return createHash(SHA_ALGO).update(buf).digest("hex").slice(0, len);
}

export interface FrozenCriteria {
  /** 本批的实验名（= runs 文件名去后缀 / 行的 experiment 字段） */
  experiment: string;
  /** PREREG 文件路径（相对 cwd 或绝对）；找不到就是 null（默认会在 open 时抛错） */
  prereg: string | null;
  preregSha: string | null;
  preregBytes: number | null;
  /** 产出这些行的驱动源码 */
  driver: string | null;
  driverSha: string | null;
  /** 被驱动 import 的判据模块（可选） */
  judge: { file: string; sha: string }[];
  /** = sha(preregSha | driverSha | judge...) —— 一行一个值，可与 PREREG 相互定位 */
  criteriaSha: string;
  frozenAt: string;
  /**
   * ★ 自描述（2026-10-24 · hands-on）：本对象里所有 sha 的**算法与截断宽度**。
   * 为什么必须进对象：语料里已有第二个生产者用**同一个字段名**存**不同宽度**的哈希
   * （work/_seal.mjs 的 preregSha = sha256 前 **16** hex；这里默认 **12**）。
   * 用一个宽度去比另一源集的字段**不报错，只静默得到 0 个匹配**
   * （实测 joinable = 0/2：work/runs/h4-lattice2.txt §5）。⇒ 跨源比较必须先比 shaAlgo/shaLen 再比值。
   */
  shaAlgo: "sha256";
  shaLen: number;
  /**
   * ★ 身份（2026-10-24 · hands-on，采纳 outbox/手段XIV 的处方）：被盖章的批是哪个模型、是否 mock。
   * 语料现状：mock 只写在 11/115 个批、49 行里（work/runs/h4-chal3.txt）⇒ 「没写 mock」与「真模型」不可分。
   * 这里**只记驱动声明的值**；缺就记 null + source:"missing" —— 缺失是一个判决，不是 false。
   */
  identity: { model: string | null; mock: boolean | null; source: "declared" | "missing" };
}

/**
 * ★★★ 每一行的内容/顺序印章（2026-10-25）。
 *
 * 字段 · 绑住什么 · 拦住哪种篡改：
 *   rowSha   —— 本行正文（含 criteria，即含指针）逐字段规范化后的 sha → 等长改值 · 改指针 · 加/删字段
 *   prev     —— 上一行的 rowSha → 换序 · 删中间行 · 插入行
 *   seq      —— 本行在文件里的序号（1 起）→ 插入 · 删行
 *   chainSha —— sha(seq | prev | rowSha)；RunLog.head() 返回最后一个值 = **出带外锚点** → 尾截断（须配合锚点）
 *
 * ★ 它绑的是**语义内容**（JSON 解析后逐字段规范化），不是字面字节：
 *   重新序列化（缩进 / 键序 / 行尾）**不该**判红，改一个值**必须**判红。
 */
export interface RowSeal {
  seq: number;
  rowSha: string;
  prev: string | null;
  chainSha: string;
  shaAlgo: "sha256";
  shaLen: number;
  sealedAt: string;
}

export interface RunLogOptions {
  /** 目标 jsonl（相对 cwd 或绝对） */
  file: string;
  experiment: string;
  /** 默认：当前工作目录下的 PREREG-<experiment>.md */
  preregFile?: string;
  /** 驱动源码路径。ESM 下从调用栈取不可靠 ⇒ **必须显式传**（缺省时 driverSha=null，反查器会判不可定位） */
  driverFile?: string;
  judgeFiles?: string[];
  /** 允许没有 PREREG（默认 false：缺失即抛错，不静默写 null） */
  allowMissingPrereg?: boolean;
  /** 驱动声明的身份（可选）。★ 不传就记 null + source:"missing"，不要假装它是 false。 */
  model?: string;
  mock?: boolean;
  /**
   * ★ 哈希截断宽度（默认 12）。存在的理由只有一个：**让两套印章能 join**。
   * 语料里 work/_seal.mjs 用 16、本库用 12 ⇒ 字面可 join 的对数 = 0/2 且不报错。
   * 用本库产生行的一侧声明 shaLen: 16 即可与 seal 记录同宽；宽度仍不同时
   * verifyRunLog({ shaLen }) 会判 **WIDTH-MISMATCH**（不再是静默 0 个匹配）。
   */
  shaLen?: number;
}

export function sha12File(f: string): string | null {
  if (!existsSync(f)) return null;
  return shaBuf(readFileSync(f), 12);
}

/** 与 sha12File 同源，但可指定宽度（跨源 join 用） */
export function shaFile(f: string, len = 12): string | null {
  if (!existsSync(f)) return null;
  return shaBuf(readFileSync(f), len);
}

/**
 * 规范化 JSON：键排序、丢 undefined、递归。
 * ★ 判据是「解析后的内容相等 ⇔ 串相等」，所以**键序与缩进不影响**、**值变一个字符就变**。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** 一行的「正文」= 整行去掉 seal（印章不能盖住自己） */
function rowBody(row: Record<string, unknown>): string {
  const clone: Record<string, unknown> = {};
  for (const k of Object.keys(row)) if (k !== "seal") clone[k] = row[k];
  return canonicalJson(clone);
}

export function freezeCriteria(opts: RunLogOptions): FrozenCriteria {
  const shaLen = opts.shaLen ?? 12;
  if (!Number.isInteger(shaLen) || shaLen < 4 || shaLen > 64) {
    throw new Error("[runlog] shaLen 只能是 4..64 的整数，收到「" + String(opts.shaLen) + "」");
  }
  const preregPath = opts.preregFile ?? join(process.cwd(), "PREREG-" + opts.experiment + ".md");
  const preregSha = shaFile(preregPath, shaLen);
  if (!preregSha && !opts.allowMissingPrereg) {
    throw new Error("[runlog] 找不到冻结判据 " + preregPath + " —— 拒绝写没有 provenance 的行");
  }
  const driver = opts.driverFile ?? null;
  const driverSha = driver ? shaFile(driver, shaLen) : null;
  const judge = (opts.judgeFiles ?? [])
    .filter((f) => existsSync(f))
    .map((f) => ({ file: f, sha: shaFile(f, shaLen) as string }));
  const criteriaSha = shaBuf(
    [preregSha ?? "-", driverSha ?? "-", ...judge.map((j) => j.sha)].join("|"),
    shaLen,
  );
  return {
    experiment: opts.experiment,
    prereg: preregSha ? resolve(preregPath) : null,
    preregSha,
    preregBytes: preregSha ? readFileSync(preregPath).length : null,
    driver,
    driverSha,
    judge,
    criteriaSha,
    frozenAt: new Date().toISOString(),
    shaAlgo: SHA_ALGO,
    shaLen,
    identity: {
      model: opts.model ?? null,
      mock: opts.mock ?? null,
      source: opts.model !== undefined || opts.mock !== undefined ? "declared" : "missing",
    },
  };
}

export interface RunLog {
  readonly criteria: FrozenCriteria;
  /** 写一行；注入 t（无则补）、criteria、seal。冻结物在跑中变过 ⇒ 抛错、不写。 */
  append(rec: Record<string, unknown>): Record<string, unknown>;
  /**
   * ★ 链头（最后一行 chainSha；空文件为 null）。
   * 把它抄到 outbox/ 或 PREREG 里 = **出带外锚点**。没有锚点时，**尾截断不可判**
   * （删掉最后几行后，剩下的仍然是一条自洽的链 —— 这是哈希链的固有边界，不是实现缺陷）。
   */
  head(): string | null;
  /** 已写行数（含本进程 open 之前就在文件里的） */
  count(): number;
  /** open 时若上一行没有印章（旧行 / 别的写者 / 末行残缺），这里是原因；null = 链连续 */
  readonly chainBreak: string | null;
}

function fp(c: FrozenCriteria): string {
  const now = {
    p: c.prereg ? shaFile(c.prereg, c.shaLen) : null,
    d: c.driver ? shaFile(c.driver, c.shaLen) : null,
    j: c.judge.map((x) => shaFile(x.file, c.shaLen)).join(","),
  };
  return [now.p ?? "-", now.d ?? "-", now.j].join("|");
}

function readRows(file: string): { rows: Record<string, unknown>[]; badTail: number } {
  if (!existsSync(file)) return { rows: [], badTail: 0 };
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const rows: Record<string, unknown>[] = [];
  let badTail = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) rows.push(v as Record<string, unknown>);
      else badTail += 1;
    } catch {
      badTail += 1;
    }
  }
  return { rows, badTail };
}

function sealOf(row: Record<string, unknown>): RowSeal | null {
  const s = row.seal as RowSeal | undefined;
  if (!s || typeof s !== "object") return null;
  if (typeof s.rowSha !== "string" || typeof s.seq !== "number" || typeof s.chainSha !== "string") return null;
  return s;
}

export function openRunLog(opts: RunLogOptions): RunLog {
  const criteria = freezeCriteria(opts);
  const expected = fp(criteria);
  const file = resolve(opts.file);
  mkdirSync(dirname(file), { recursive: true });

  // ★ 续写时先接上已有的链：不接，就等于每开一次进程重开一条链（链接强度从 1 开始，无声）。
  const { rows: existing, badTail } = readRows(file);
  const last = existing.length ? existing[existing.length - 1] : undefined;
  const lastSeal = last ? sealOf(last) : null;
  let prev: string | null = lastSeal ? lastSeal.rowSha : null;
  let nextSeq = lastSeal ? lastSeal.seq + 1 : existing.length + 1;
  let chainBreak: string | null = null;
  if (existing.length && !lastSeal) {
    chainBreak = "上一行没有印章（旧行 / 别的写者）⇒ 新行从一条新链开始，链接强度只从这一行起算";
  }
  if (badTail > 0) {
    chainBreak = "文件末有 " + badTail + " 行不是合法 JSON（上次写到一半？）⇒ 新行从一条新链开始";
    if (!lastSeal) {
      prev = null;
      nextSeq = existing.length + 1;
    }
  }

  return {
    criteria,
    chainBreak,
    head: () => prev,
    count: () => nextSeq - 1,
    append(rec) {
      const now = fp(criteria);
      if (now !== expected) {
        throw new Error(
          "[runlog] 冻结判据在跑中被改（" +
            String(criteria.prereg ?? "-") +
            "）：期望 " +
            expected +
            " 实测 " +
            now +
            " —— 拒绝写行",
        );
      }
      const body: Record<string, unknown> = { ...rec, t: rec.t ?? new Date().toISOString(), criteria };
      const rowSha = shaBuf(rowBody(body), criteria.shaLen);
      const seq = nextSeq;
      const chainSha = shaBuf([String(seq), prev ?? "-", rowSha].join("|"), criteria.shaLen);
      const seal: RowSeal = {
        seq,
        rowSha,
        prev,
        chainSha,
        shaAlgo: SHA_ALGO,
        shaLen: criteria.shaLen,
        sealedAt: new Date().toISOString(),
      };
      const row: Record<string, unknown> = { ...body, seal };
      appendFileSync(file, JSON.stringify(row) + "\n");
      prev = rowSha;
      nextSeq = seq + 1;
      return row;
    },
  };
}

// ---------------------------------------------------------------------------
// 反查器：对一行 / 一整个文件给判决。★ 缺失是判决（UNSEALED），不是通过。
// ---------------------------------------------------------------------------

export type RowVerdict =
  /** 印章与内容、顺序、前驱全部相符 */
  | "OK"
  /** 老行 / 别的写者：没有 seal ⇒ 无法判内容，不是通过 */
  | "UNSEALED"
  /** 本行正文被改过（等长改值 / 改指针 / 加删字段都会命中） */
  | "BYTES-CHANGED"
  /** 本行的 prev 与上一行的 rowSha 不符 ⇒ 换序 / 删中间行 / 插入了外来行 */
  | "LINK-BROKEN"
  /** seq 不连续 ⇒ 中间少了行 */
  | "SEQ-GAP"
  /** 印章宽度与 criteria.shaLen（或反查时声明的 shaLen）不同 ⇒ 跨源 join 静默为 0 的那种 */
  | "WIDTH-MISMATCH"
  /** seal 自己声明的位置是「新链起点」且不在第 1 行 ⇒ 段落开始（信息，不是篡改） */
  | "CHAIN-RESTART"
  /** 这一行不是合法 JSON 对象 */
  | "UNPARSEABLE";

export interface RowReport {
  /** 1 起的行号（含非法行） */
  line: number;
  seq: number | null;
  verdict: RowVerdict;
  /** 人读的原因（判决依据，不是断言） */
  detail: string;
}

export interface RunLogReport {
  file: string;
  rows: RowReport[];
  counts: Record<RowVerdict, number>;
  /** ★ 只有「全部行 OK」才算 true；UNSEALED / CHAIN-RESTART 都算 false */
  ok: boolean;
  verdict: "OK" | "PARTIAL" | "TAMPERED" | "EMPTY";
  /** 最后一行的 chainSha（= RunLog.head()，可与出带外锚点比） */
  head: string | null;
  /** 反查时用的宽度（null = 用每行自称的 shaLen） */
  shaLen: number | null;
}

export interface VerifyOptions {
  /** 期望的哈希宽度（与另一源集 join 时必填）：与行自称不符 ⇒ WIDTH-MISMATCH */
  shaLen?: number;
  /** 出带外锚点：RunLog.head() 在跑完时打印的那个值。不符 ⇒ 尾被改过（削尾 / 追加） */
  headSha?: string;
}

const VERDICTS: RowVerdict[] = [
  "OK",
  "UNSEALED",
  "BYTES-CHANGED",
  "LINK-BROKEN",
  "SEQ-GAP",
  "WIDTH-MISMATCH",
  "CHAIN-RESTART",
  "UNPARSEABLE",
];

/**
 * 反查一个 runlog 文件（零 API、纯本地）。
 * 判据跑前人造答案：work/_kb-runlog-ut.mjs（8 条：正确 / 删行 / 等长改值 / 尾截断+锚点 /
 * 换序 / 旧行无印章 / 宽度不符 / 正常续写）。
 */
export function verifyRunLog(file: string, opts: VerifyOptions = {}): RunLogReport {
  const abs = resolve(file);
  const rows: RowReport[] = [];
  const rawLines = existsSync(abs)
    ? readFileSync(abs, "utf8").split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""))
    : [];
  let lastRowSha: string | null = null;
  let expectSeq = 1;
  let head: string | null = null;

  const push = (r: RowReport): void => {
    rows.push(r);
  };

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = idx + 1;
    const raw = rawLines[idx] as string;
    if (raw.trim() === "") continue;
    let row: Record<string, unknown>;
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      row = v as Record<string, unknown>;
    } catch {
      push({ line, seq: null, verdict: "UNPARSEABLE", detail: "这一行不是合法 JSON 对象" });
      expectSeq += 1;
      continue;
    }
    const seal = sealOf(row);
    if (!seal) {
      push({
        line,
        seq: null,
        verdict: "UNSEALED",
        detail: "没有 seal ⇒ 内容无法判（缺失是判决，不是通过）",
      });
      lastRowSha = null;
      expectSeq += 1;
      continue;
    }
    head = seal.chainSha;
    const criteria = row.criteria as FrozenCriteria | undefined;
    // 1) 宽度：先比表示层，再比值（否则唯一症状是「0 个匹配」）
    const declared = typeof criteria?.shaLen === "number" ? criteria.shaLen : null;
    if (seal.shaLen !== declared || (opts.shaLen !== undefined && seal.shaLen !== opts.shaLen)) {
      push({
        line,
        seq: seal.seq,
        verdict: "WIDTH-MISMATCH",
        detail:
          "seal.shaLen=" +
          seal.shaLen +
          " / criteria.shaLen=" +
          String(declared) +
          " / 反查声明=" +
          String(opts.shaLen === undefined ? "未声明" : opts.shaLen),
      });
      lastRowSha = seal.rowSha;
      expectSeq = seal.seq + 1;
      continue;
    }
    // 2) 内容：本行正文
    const recomputed = shaBuf(rowBody(row), seal.shaLen);
    if (recomputed !== seal.rowSha) {
      push({
        line,
        seq: seal.seq,
        verdict: "BYTES-CHANGED",
        detail: "rowSha 记录 " + seal.rowSha + " 实测 " + recomputed + "（这一行的正文与写它时不同）",
      });
      lastRowSha = seal.rowSha;
      expectSeq = seal.seq + 1;
      continue;
    }
    // 3) 顺序：seq
    if (seal.seq !== expectSeq) {
      push({
        line,
        seq: seal.seq,
        verdict: "SEQ-GAP",
        detail: "期望 seq=" + expectSeq + " 实测 " + seal.seq + "（中间少了行 / 插入了行）",
      });
      lastRowSha = seal.rowSha;
      expectSeq = seal.seq + 1;
      continue;
    }
    // 4) 顺序：前驱
    if (seal.prev !== lastRowSha) {
      if (seal.prev === null) {
        push({
          line,
          seq: seal.seq,
          verdict: "CHAIN-RESTART",
          detail: "本行声明自己是一条新链的起点（上一段没有印章 / 换了写者）",
        });
        lastRowSha = seal.rowSha;
        expectSeq = seal.seq + 1;
        continue;
      }
      push({
        line,
        seq: seal.seq,
        verdict: "LINK-BROKEN",
        detail:
          "prev=" +
          seal.prev +
          " 而上一行 rowSha=" +
          String(lastRowSha) +
          "（换序 / 删中间行 / 插了外来行）",
      });
      lastRowSha = seal.rowSha;
      expectSeq = seal.seq + 1;
      continue;
    }
    // 5) 链条自洽：chainSha
    const chain = shaBuf([String(seal.seq), seal.prev ?? "-", seal.rowSha].join("|"), seal.shaLen);
    if (chain !== seal.chainSha) {
      push({
        line,
        seq: seal.seq,
        verdict: "BYTES-CHANGED",
        detail: "chainSha 记录 " + seal.chainSha + " 实测 " + chain + "（seq/prev/rowSha 之一被改）",
      });
      lastRowSha = seal.rowSha;
      expectSeq = seal.seq + 1;
      continue;
    }
    push({ line, seq: seal.seq, verdict: "OK", detail: "内容 / 顺序 / 前驱 / 链全符" });
    lastRowSha = seal.rowSha;
    expectSeq = seal.seq + 1;
  }

  const counts = {} as Record<RowVerdict, number>;
  for (const v of VERDICTS) counts[v] = 0;
  for (const r of rows) counts[r.verdict] += 1;

  // ★ 尾截断：没有出带外锚点时**判不出**（剩下的链自洽）—— 有锚点就当场判红。
  let headMismatch = false;
  if (opts.headSha !== undefined && opts.headSha !== head) {
    headMismatch = true;
    push({
      line: rawLines.length,
      seq: null,
      verdict: "BYTES-CHANGED",
      detail: "链头不符：锚点 " + opts.headSha + " 实测 " + String(head) + "（末尾行被删 / 被追加 / 被替换）",
    });
    counts["BYTES-CHANGED"] += 1;
  }

  const tampered =
    counts["BYTES-CHANGED"] + counts["LINK-BROKEN"] + counts["SEQ-GAP"] + counts["WIDTH-MISMATCH"] > 0;
  const ok = rows.length > 0 && counts.OK === rows.length && !headMismatch;
  const verdict: RunLogReport["verdict"] =
    rows.length === 0 ? "EMPTY" : ok ? "OK" : tampered ? "TAMPERED" : "PARTIAL";
  return { file: abs, rows, counts, ok, verdict, head, shaLen: opts.shaLen === undefined ? null : opts.shaLen };
}

/** 只核一行（分析里引一行数据时用）：按 seq 或 rowSha 定位，返回那一行的判决 */
export function verifySealedRow(
  file: string,
  ref: { seq?: number; rowSha?: string },
  opts: VerifyOptions = {},
): RowReport | null {
  const report = verifyRunLog(file, opts);
  for (const r of report.rows) {
    if (ref.seq !== undefined && r.seq === ref.seq) return r;
    if (ref.rowSha !== undefined && r.detail.includes(ref.rowSha)) return r;
  }
  return null;
}
