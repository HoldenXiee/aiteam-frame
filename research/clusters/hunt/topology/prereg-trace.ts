// ★★★★★ 判据冻结了，但**数据能不能反查回判据**（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// 这个文件是**集群自己发现的缺陷**（不是我提的）
//
//   `onInstrumentReview` 第一次真跑（2026-10-21）时，`inspirer` 挑了
//   「把判据冻结成一份 PREREG」这件它反复用了 **72 次**的东西，查出：
//
//     PREREG-*.md          72 份
//     exp-*.ts             75 个
//     runs/*.jsonl        101 批 / 1750 行
//     ★ 带 preregId/preregSha/criteriaSha/judgeSha 的行   **0 / 1750**
//     ★ 32/101 批是 STALE（今天盘上那份 driver 不是跑过的那份）
//     ★ 26/101 批连 driver 都没有
//     ⇒ 可机械恢复的只有 43/101
//
//   ★★★ 它自己的结论（比我可能给的任何说法都准）：
//     「缺陷成立，但**理由要改**：不是「没有链接」，是
//       「**链接看起来有、实际只有 43% 能恢复**」」
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么这比"某个结论错了"严重得多
//
//   判据冻结（PREREG）是**整个实验方法的地基**：跑之前把"怎么算成功"写死，
//   跑完就不许改。它是这个项目**唯一**防"事后挑判据"的办法。
//
//   ★★★ 而如果**数据和那份冻结的判据之间没有可恢复的链接**：
//     · 你无法证明「这 1750 行是按那份判据算的」
//     · 也无法证明「判据没被改过」（STALE 的那 32 批就是证据）
//   ⇒ 那么"跑前冻结"这件事，**只在纸面上成立**。
//
// ★★ 这不是某个实验错了，是**所有旧实验的可复查性都打了折**。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 这个文件只做一件事：**把它算出来、摆出来**（不替它决定怎么修）
//
//   ★ 为什么只报数（硬规则①）：
//     "该怎么把 hash 写进行里" 是**实验方法的设计**，属于集群。
//     我能判死的是「有没有链接」，不能替它设计链接。
// ══════════════════════════════════════════════════════════════════════════

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const NL = String.fromCharCode(10);

/**
 * ★★★★★ 一条 **封口记录**（`work/seals.jsonl`，集群自己设计的修法）
 *
 * ★★★ 为什么必须认它（2026-10-21，差点犯的错）：
 *   集群的修法**不是**把 `preregSha` 写进每一行，而是在**批结束时**写一条 seal，
 *   用**字节窗口**（`startBytes`~`endBytes`）覆盖这一批的全部行。
 *
 *   ⇒ 如果我的读数只认"行里有字段"，那么**它修好了我也永远报 0/1750** ——
 *     一个永远红的量具会逼它去做**无用功**（把 hash 重复写进 1750 行）。
 *
 *   ★★ 所以判据必须是「**行级字段 或 seal 覆盖**」，不是只看一种。
 *   ★ 这正是纪律㉔：量具记的字段必须能回答你想问的问题 —— 而问题变了（修法变了），
 *     量具就得跟着变。
 */
export type Seal = {
  batch: string;
  prereg?: string;
  preregSha?: string;
  driver?: string;
  driverSha?: string;
  criteriaSha?: string;
  /** ★ 字节窗口：这批数据被 seal 覆盖的区间 */
  startBytes?: number;
  endBytes?: number;
  t0?: string;
  t1?: string;
};

/** ★ 一条 seal 是否覆盖某个文件的**全部内容** */
export function sealCovers(seal: Seal, fileBytes: number): boolean {
  if (typeof seal.startBytes !== "number" || typeof seal.endBytes !== "number") return false;
  return seal.startBytes <= 0 && seal.endBytes >= fileBytes;
}

/** ★ 能指回判据的字段名（★ 认这些就等于"链接存在"） */
export const TRACE_FIELDS = ["preregId", "preregSha", "criteriaSha", "judgeSha", "preregFile"] as const;

export type BatchTrace = {
  /** jsonl 文件名（`runs/xxx.jsonl`） */
  batch: string;
  /** 行数 */
  rows: number;
  /** ★ 带可追溯字段的行数（0 = 一行都反查不回去） */
  traced: number;
  /** ★ 有没有同名 driver（`exp-*.ts`）*/
  driver?: string;
  /**
   * ★ 有没有同名 PREREG（`PREREG-<batch>.md`）。
   *
   * ★★★ 这里**故意不判 STALE**（2026-10-21）：
   *   集群自己报的是 STALE 32/101（它用 git 历史判"盘上那份 driver 不是跑过的那份"）。
   *   我第一版用 **mtime**（driver 比 jsonl 新）判，得 9/101 —— **两个数差 23**。
   *   ★★ 而 mtime 回答"现在"，不回答"当时"——**正是纪律㉛禁掉的用法**。
   *   ⇒ 所以这个读数**只报"有没有"**，不报"是不是过期"：
   *     过期与否必须读 git（那是"那时候的记录"），而那是**下一个工具**，不是这个。
   *   ★ 宁可少报一个数，也不报一个我知道量错的数。
   */
  prereg: "none" | "present";
  /**
   * ★★★★★ 有 seal 覆盖这一批吗（★ 覆盖全部字节才算）
   * ★★ 这是**新口径**：集群的修法在批级别，不在行级别。
   */
  sealed: boolean;
};

export type PreregReport = {
  /** PREREG 份数 */
  preregs: number;
  /** driver 个数 */
  drivers: number;
  /** 批数 */
  batches: number;
  /** 总行数 */
  rows: number;
  /** ★ 带可追溯字段的行数（全库） */
  tracedRows: number;
  /** ★ 可机械恢复（有 driver 且不是 stale 且 jsonl 存在）的批数 */
  recoverable: number;
  /** ★★ 被封口覆盖的批数（新口径） */
  sealedBatches: number;
  /** ★★★ 被封口覆盖的行数（新口径 —— 这才是"修好之后该涨的数"） */
  sealedRows: number;
  /**
   * ★★★★★ **机制出生之后**新增的批里，封口覆盖了多少（这才是该看的比例）
   *
   * ★★★ 为什么必须分开（2026-10-21，**集群第二次纠正我的分母**）：
   *
   *   我先报「4/108 批被封口 ⇒ 96% 不经过它」。
   *   集群的原话：
   *     「『96% 不经过』的分母是「**全部历史数据**」，而机制 06:33:59Z 才出生。
   *       **98/109 批出生早于机制本身**；能走的 8 批走了 6 批」
   *
   *   ★★ 我复核（按行内 `t` 轴，不用 mtime）：出生前 **101** 批 · 出生后 **8** 批 · 已封口 **6**。
   *     ⇒ 真读数是 **6/8 = 75% 已覆盖**，不是 96% 没覆盖。
   *
   *   ★★★ 教训：`sealed/总批数` 这个比例**永远很小**，因为它把"机制还没出生"的年代
   *     也算进了分母。★ 一个机制上线后，**唯一有意义的分母是它出生之后的数据**。
   *     （与纪律㉛同源：拿"现在"当"当时"一定错；这里更隐蔽 —— 拿"全部历史"当"它出生后"。）
   */
  sinceBirth: {
    /** ★ 机制出生时刻（最早一条 seal 的 t0）*/
    at?: string;
    /** ★ 出生后新增的批数（★ 用行内 `t` 判，不用 mtime） */
    batches: number;
    /** ★ 其中已封口 */
    sealed: number;
  };
  /** ★ 逐批明细 */
  detail: BatchTrace[];
};

/**
 * ★ 纯函数：算「判据 → 数据」的可追溯性（纪律⑦：可离线重判）
 *
 * @param files `work/` 下的文件名清单（只要 `PREREG-*.md` / `exp-*.ts` / `runs/*.jsonl`）
 * @param readJsonl 读一个 jsonl 的行
 * @param mtimeOf 取 mtime（ms）
 */
export function preregTraceability(
  files: string[],
  readJsonl: (batch: string) => string[],
  /** ★ seal 记录（`work/seals.jsonl` 的每一条）；没有就传 `[]` */
  seals: Seal[] = [],
  /** ★ 取文件字节数（判 seal 是否覆盖全部内容） */
  bytesOf?: (batch: string) => number,
): PreregReport {
  const preregs = files.filter((f) => /^PREREG-.*\.md$/.test(f));
  const drivers = files.filter((f) => /^exp-.*\.ts$/.test(f));
  const batches = files.filter((f) => /^runs\/.*\.jsonl$/.test(f)).map((f) => f.slice(5));

  const detail: BatchTrace[] = [];
  let rows = 0;
  let tracedRows = 0;
  let recoverable = 0;
  let sealedBatches = 0;
  let sealedRows = 0;

  // ★★★ 机制出生时刻 = 最早那条 seal 的 t0
  const birth = seals
    .map((x) => (x.t0 ? Date.parse(x.t0) : NaN))
    .filter((x) => !isNaN(x))
    .sort((a, b) => a - b)[0];
  let birthBatches = 0;
  let birthSealed = 0;

  for (const b of batches) {
    const stem = b.replace(/\.jsonl$/, "");
    const lines = readJsonl(b);
    const n = lines.filter((l) => l.trim()).length;
    rows += n;

    // ★ 可追溯 = 至少一行的 JSON 里出现那些字段名
    const traced = lines.filter((l) => TRACE_FIELDS.some((k) => l.includes(`"${k}"`))).length;
    tracedRows += traced;

    // ★ 找同名 driver（`PREREG-X.md` ↔ `exp-X.ts` ↔ `runs/X.jsonl`）
    const driver = drivers.find((d) => d === `exp-${stem}.ts`) ?? drivers.find((d) => d.includes(stem.slice(0, 8)));
    const preregName = `PREREG-${stem}.md`;
    const hasPre = preregs.includes(preregName);

    const prereg: BatchTrace["prereg"] = hasPre ? "present" : "none";

    // ★ "可恢复" = **结构上**齐了（有 driver + 有 PREREG）；不判过期
    // ★★★ seal 覆盖（新口径）：字节窗口盖住整个文件才算
    const bytes = bytesOf ? bytesOf(`runs/${b}`) : 0;
    const sealed = seals
      .filter((x) => x.batch === stem)
      .some((x) => (bytes > 0 ? sealCovers(x, bytes) : true));
    if (sealed) {
      sealedBatches++;
      sealedRows += n;
    }

    // ★★★ 出生后判定：用**行内 `t`**（"那时候的记录"），不用 mtime
    if (birth !== undefined) {
      const ts = lines
        .map((l) => {
          try {
            const d = JSON.parse(l) as { t?: string };
            return d.t ? Date.parse(d.t) : NaN;
          } catch {
            return NaN;
          }
        })
        .filter((x) => !isNaN(x));
      if (ts.length) {
        const first = Math.min(...ts);
        if (first >= birth) {
          birthBatches++;
          if (sealed) birthSealed++;
        }
      }
    }

    const rec = !!driver && prereg === "present";
    if (rec) recoverable++;

    detail.push({ batch: b, rows: n, traced, driver, prereg, sealed });
  }

  const sinceBirth = {
    at: birth !== undefined ? new Date(birth).toISOString() : undefined,
    batches: birthBatches,
    sealed: birthSealed,
  };

  return {
    preregs: preregs.length,
    drivers: drivers.length,
    batches: batches.length,
    rows,
    tracedRows,
    recoverable,
    sealedBatches,
    sealedRows,
    sinceBirth,
    detail,
  };
}

/** ★ 从盘上读（runner 用） */
export function readPreregTraceability(workDir: string): PreregReport {
  // ★★★★★ 2026-10-21 · 根传错时必须**响**，不许静默返回"没有"
  //
  //   ★★★ 实测：我自己在临时脚本里传了集群根 `research/labfirst/hunt`
  //     而不是 `…/work`，读具返回「（还没有 runs/*.jsonl）」——
  //     **看起来像"这轮没数据"，其实是根传错了**（真实是 115 批/1788 行）。
  //   ★ 这正是纪律㉙ 的镜像：**量具不响 ≠ 没问题，可能是我的拿法不对**。
  //     但量具也不该让这种错**悄悄过去** —— 它有能力分辨。
  const runsDir = join(workDir, "runs");
  const looksLikeClusterRoot = !existsSync(runsDir) && existsSync(join(workDir, "work", "runs"));
  if (looksLikeClusterRoot) {
    throw new Error(
      `[prereg-trace] 根传错了：\`${workDir}\` 下没有 runs/，但它下面有 work/runs/ ` +
        `⇒ 应该传 \`${join(workDir, "work")}\`。★ 拒绝返回"没有数据"（那是假读数）`,
    );
  }
  const files: string[] = [];
  if (existsSync(workDir)) {
    for (const f of readdirSync(workDir)) files.push(f);
  }
  if (existsSync(runsDir)) {
    for (const f of readdirSync(runsDir)) if (f.endsWith(".jsonl")) files.push(`runs/${f}`);
  }
  // ★ 读 seal 记录（集群自己设计的修法；没有这个文件就是空数组，不炸）
  const seals: Seal[] = [];
  const sealPath = join(workDir, "seals.jsonl");
  if (existsSync(sealPath)) {
    for (const ln of readFileSync(sealPath, "utf8").split(NL)) {
      if (!ln.trim()) continue;
      try {
        seals.push(JSON.parse(ln) as Seal);
      } catch {
        /* 坏行跳过 */
      }
    }
  }

  return preregTraceability(
    files,
    (b) => {
      const p = join(workDir, "runs", b);
      return existsSync(p) ? readFileSync(p, "utf8").split(NL) : [];
    },
    seals,
    (b) => {
      const p = join(workDir, b);
      return existsSync(p) ? statSync(p).size : 0;
    },
  );
}

/** ★ 渲染成一行读数 */
export function renderPrereg(r: PreregReport): string {
  if (!r.batches) return "（还没有 runs/*.jsonl）";
  const none = r.detail.filter((d) => d.prereg === "none").length;
  return (
    `PREREG ${r.preregs} 份 · driver ${r.drivers} 个 · 数据 ${r.batches} 批/${r.rows} 行 · ` +
    // ★ 旧口径（行级字段）—— 集群的修法不在这一层，所以它可能恒为 0，别拿它当唯一判据
    // ★★★ 有意义的分母：机制出生**之后**的批（★ 全库那个比例永远 <6%，别拿它当判据）
    (r.sinceBirth.batches
      ? `★★ 机制出生后新增 ${r.sinceBirth.batches} 批，已封口 ${r.sinceBirth.sealed}` +
        `（${Math.round((r.sinceBirth.sealed / r.sinceBirth.batches) * 100)}%）· `
      : "") +
    `行级字段 ${r.tracedRows}/${r.rows}` +
    ` · 全库被封口 ${r.sealedBatches}/${r.batches} 批（★ 分母含机制出生前，别单独引用）` +
    (none ? ` · 无同名 PREREG ${none}` : "")
  );
}
