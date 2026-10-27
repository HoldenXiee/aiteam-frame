// ★★★ 快照：把第一集群（hunt）的成果与研究路径，拷进第二集群（forge）自己的文件夹
//
// ══════════════════════════════════════════════════════════════════
// ★★★ 设计者裁定（2026-10-19，逐字）：
//
//   「第一集群和第二集群是分开的，既然他们的研究员文件夹是分开，
//     那完全可以，**是独立的环境**啊。且第二集群应该是**定期或阶段性运行**的，
//     那就可以把**第一集群的成果、研究路径等等内容**，在第二集群运行前
//     **复制到第二集群研究员文件夹中**，让它**在完全独立的环境中运行**。」
//
//   「你可以理解为**第一集群是主线，第二集群是定期或阶段性沉淀**。」
// ══════════════════════════════════════════════════════════════════
//
// ──────────────────────────────────────────────────────────────────
// ★★★ 为什么必须"拷过来"而不是"只读挂载"（我上一版错在哪）
//
// ★ 我上一版：让 forge 直接读 `hunt/`（路径写进它的提示词）。
//   ⇒ 看起来能用，但**不是独立环境**，而且有三个真实问题：
//
//   ① ★★ **它读到的是"现在"，不是"这一批"**
//      hunt 是**主线，一直在动** —— forge 分析到一半，hunt 又加了 20 份产物。
//      ⇒ forge 的结论对应的是**一个漂移的原料集**，事后无法复现。
//
//   ② ★★ **它没有属于自己的历史**
//      forge 是**阶段性沉淀** —— 它应该能说"上一批沉淀到 P60，这一批是 P61–P120"。
//      共用文件系统 ⇒ 没有"批"的概念，每次都在全体上重做。
//
//   ③ ★ **边界靠守卫守，而不是靠"它本来就没有"**
//      只读挂载 ⇒ 必须靠 `gate` 拦写入。★ 而**没有那个路径**比"有路径但拦住"强得多：
//      目标不存在，它连试都不会试（少一类反复撞墙，`P12`）。
//
// ★★★ 拷过来的版本把这三条一起解决：
//   ① 快照是**冻结的** ⇒ 结论对应一个确定的原料集（纪律⑩：改语料后新旧数据不混用）
//   ② 有 `batches.jsonl` ⇒ 每次沉淀是**一批**，能对账"这批看了什么、上批看到哪"
//   ③ forge 的空间里**只有它自己的东西** ⇒ 边界变成物理事实
// ──────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════
// ★★★ 2026-10-20 拆分：这个文件**两集群共用一份**，放在 `research/clusters/` 顶层。
//
//   ★ 为什么它可以共用（而其它件按裁定各复制一份）：
//     它是一个**单向搬运器** —— 读 hunt、写 forge，方向固定。
//     ★ 它**不属于任何一个集群的运行时**：集群跑起来之后不会调它。
//     ⇒ 复制两份只会带来"两边快照逻辑分叉"的风险，没有任何好处。
//
//   ★★ 原来它 import `./paths.ts` 的 `CLUSTER` 来判断"我现在是谁"。
//     拆分后**没有"当前集群"这个概念了** —— 这个文件只知道两端：
//       源 = hunt（第一集群）· 目标 = forge（第二集群）
// ══════════════════════════════════════════════════════════════════

import { candidates } from "./hunt/topology/tidy.ts";
import { cpSync, existsSync, mkdirSync, readdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convergedGate } from "./hunt/topology/converged-gate.ts";
import { readStructured, sevenStats } from "./hunt/tools/record-experiment.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** 仓库根（从 research/clusters/ 往上 3 层） */
const REPO = join(here, "..", "..");

/**
 * ★★★ 快照的两端 —— 都是**常量**，不再是"当前集群"。
 *
 * ★ 为什么不能再用 `LAB`：`LAB` 曾经是"当前集群"的空间 ——
 *   在 hunt 里调它得到 hunt，于是快照会拷进 hunt 自己（实测踩过这个坑）。
 *   ★★ 快照的方向是**单向且固定**的：hunt → forge。
 */
export const SOURCE_CLUSTER = "hunt";
export const SECOND_CLUSTER = "forge";
const SOURCE_LAB = join(REPO, "research/labfirst", SOURCE_CLUSTER);
const FORGE_LAB = join(REPO, "research/labfirst", SECOND_CLUSTER);

/** 快照落在哪：★ forge 自己空间里的一个子目录 */
export const SNAPSHOT_DIR = "source";

/**
 * ★ 拷什么（设计者裁定：「成果 + 研究路径」）。
 *
 * ★★ 为什么是这两样，而不是全拷：
 *   · `outbox/` = **成果**（它研究出了什么）
 *   · `work/`   = **研究路径**（它是怎么研究出来的 —— 脚本、jsonl、日志）
 *   ★ 后者才是关键：**只读结论只能复述，读了路径才能看出它的判据错在哪**。
 *
 * ★ 不拷的：`lib/`（那是库的拷贝，不是研究成果）· `.git/` · 锁文件 · 临时目录
 */
const COPY_DIRS = ["outbox", "work"] as const;

/** ★ work/ 里这些不拷（不是研究内容，是运行时垃圾） */
const WORK_SKIP = new Set([
  "_cluster.lock",
  "_lib-rev.jsonl", // ★ 那是**它自己**的 lib 修订号，对 forge 无意义
  "debate.jsonl", // ★ 那是它三个员工之间的对话，不该污染 forge 的判断
]);

/**
 * ★★★ 不拷的**目录名**（2026-10-19 实测发现，实打实的教训）。
 *
 * ★ 现象：第一次做快照拷了 **82,511 个文件 / 57MB**。
 *   拆开一看 —— **77,449 个（94%）是 `corpus/` 副本**：
 *   实验装置把语料**每个臂、每轮各拷一份** ⇒ 同一份语料在快照里出现 **1376 次**。
 *
 * ★★ 为什么这是个真问题（不是"大一点无所谓"）：
 *   · 语料是**材料**，不是**产出** —— 它不回答"第一集群发现了什么"
 *   · forge 要的是**研究路径**（怎么做的、量了什么），不是重复的材料副本
 *   · 1376 份副本会让它**把注意力花在噪音上**（而它的上下文是有限的）
 *
 * ★ 真正的研究路径只有 **4,972 个文件**（runs/、脚本、日志）—— 拷这些就够了。
 * ★ 若 forge 需要具体语料，它自己造一份就是（它有一模一样的实验能力）。
 */
const DIR_SKIP = new Set(["corpus", "node_modules", ".git", "_trash"]);

/**
 * ★★★★★ 2026-10-27 · **垃圾会被快照复制进 forge 的空间**（实测）
 *
 * ★ 现象：`batch-011` 有 **726MB**，其中 **720MB 是 hunt 的 `work/`**：
 *   `P800-lostupd/` 360MB、`runs/` 33MB、`P370-drain/` 25MB …… 全是探针 scratch。
 * ⇒ 第一集群的垃圾**每拍一批就复制一份**（11 批共 2.6GB），
 *   而且 **forge 也要读 `work/`**（研究路径）⇒ 垃圾同时污染**它的上下文**。
 *
 * ★★ 修法：用**与 tidy 完全同一把尺子**（`topology/tidy.ts` 的 `candidates`）——
 *   「超大 scratch / 拷进来的 node_modules / 碎文件洪水」不进快照。
 * ★ 为什么这是对的而不是"偷懒"：forge 要的是**研究路径**（怎么做的、量了什么）；
 *   超大 scratch 不是路径，是**中间垃圾**。它真要复算，自己造一份就是。
 * ★★★ 判据：下一批 `batches.jsonl` 的 `bytes` 应大幅下降（改前 662MB）。
 */
let SNAPSHOT_SKIP_DIRS: Set<string> | null = null;

/** 拍快照前算一次（纯形状判定，不读内容）；算不出来就不跳（宁可大，不要乱跳）*/
function refreshJunk(src: string): void {
  try {
    SNAPSHOT_SKIP_DIRS = new Set(candidates(src).map((c) => c.rel.split("/").pop() ?? ""));
  } catch {
    SNAPSHOT_SKIP_DIRS = null;
  }
}

/** ★ 一个路径要不要跳过（任何一层目录名命中就跳） */
function shouldSkip(p: string): boolean {
  const parts = p.split(/[/\\]/);
  const name = parts[parts.length - 1] ?? "";
  if (DIR_SKIP.has(name) || WORK_SKIP.has(name) || name.endsWith(".lock")) return true;
  // ★ 垃圾候选（同一把尺子：>50MB 或 >2000 文件 或 拷了 node_modules）
  if (SNAPSHOT_SKIP_DIRS?.has(name)) return true;
  return parts.some((x) => DIR_SKIP.has(x));
}

export interface SnapshotResult {
  /** 第几批（从 1 开始） */
  batch: number;
  /** 拷了多少文件 / 字节 */
  files: number;
  bytes: number;
  /** 快照落在哪（相对 forge 空间） */
  dir: string;
  /** ★ 上一批之后 outbox 新增了多少份（增量） */
  freshOutbox: number;
  at: string;
}

/** 读已有的批次记录（没有 ⇒ 空数组） */
function readBatches(): SnapshotResult[] {
  const p = join(FORGE_LAB, "work", "batches.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as SnapshotResult;
      } catch {
        return null;
      }
    })
    .filter((x): x is SnapshotResult => x !== null);
}

/** 目录里有多少文件、多大（跳过 .git） */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (DIR_SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        try {
          bytes += readFileSync(p).length;
        } catch {
          /* 读不到就不算 */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * ★★★ 做一次快照。
 *
 * @param force 已存在快照时也覆盖（默认**不覆盖** —— 见下）
 *
 * ★★ 为什么不覆盖：**快照是冻结的证据**。
 *   若每批都覆盖，上一批的结论就**无法复现**（纪律⑩）。
 *   ⇒ 每批一个目录：`source/batch-001/`、`source/batch-002/`…
 */
export function takeSnapshot(opts: { force?: boolean } = {}): SnapshotResult {
  const src = SOURCE_LAB;
  refreshJunk(src);   // ★ 垃圾候选（同一把尺子，见上面的长注释）
  if (!existsSync(src)) {
    throw new Error(
      `快照失败：找不到第一集群 \`${SOURCE_CLUSTER}\` 的空间：${src}\n` +
        `  ★ 第二集群的原料必须是**第一集群真的跑出来的东西**。先让第一集群跑起来。`,
    );
  }

  const prev = readBatches();
  // ★★★★★ 2026-10-27 · **批号不能只按账本行数算**
  //
  //   ★ 实测（设计者那轮收尾）：
  //       error  快照失败：快照目录已存在 …\sourceatch-010
  //     原因：账本 `batches.jsonl` 里 9 行，而目录已经到 batch-010
  //     （我自己回退过一次账本行但**没删目录**）⇒ 行数+1 撞上了已有目录 ⇒ 这一轮**没拍成**。
  //   ★★ 修：取「账本行数」与「已有目录最大号」的**较大者** +1。
  //     这样不管账本和磁盘怎么错位，都不会撞。
  const maxDir = (() => {
    try {
      return readdirSync(join(FORGE_LAB, SNAPSHOT_DIR))
        .map((d) => Number(/^batch-(\d+)$/.exec(d)?.[1] ?? 0))
        .reduce((a, b) => Math.max(a, b), 0);
    } catch {
      return 0;
    }
  })();
  const maxLedger = (() => {
    try {
      return prev.reduce((a, b) => Math.max(a, Number((b as { batch?: number }).batch ?? 0)), 0);
    } catch {
      return 0;
    }
  })();
  const batch = Math.max(maxDir, maxLedger, prev.length) + 1;
  const rel = `${SNAPSHOT_DIR}/batch-${String(batch).padStart(3, "0")}`;
  const dst = join(FORGE_LAB, rel);

  if (existsSync(dst) && !opts.force) {
    throw new Error(`快照目录已存在：${dst}\n  ★ 快照是冻结的证据，不默认覆盖（要覆盖传 force）。`);
  }
  mkdirSync(dst, { recursive: true });

  for (const d of COPY_DIRS) {
    const from = join(src, d);
    if (!existsSync(from)) continue;
    cpSync(from, join(dst, d), {
      recursive: true,
      // ★★ 统一走 `shouldSkip`（含 corpus 排除 —— 见它的注释：94% 是重复材料）
      filter: (p) => !shouldSkip(p),
    });
  }

  // ★ 上一批之后新增的 outbox 有多少（增量对账）
  const prevOutbox = prev.length ? prev[prev.length - 1]! : null;
  const now = readdirSync(join(src, "outbox")).filter((f) => f.endsWith(".md")).length;
  const freshOutbox = prevOutbox ? Math.max(0, now - (prevOutbox as unknown as { outboxTotal?: number }).outboxTotal!) : now;

  const { files, bytes } = measure(dst);
  const result: SnapshotResult = {
    batch,
    files,
    bytes,
    dir: rel,
    freshOutbox: Number.isFinite(freshOutbox) ? freshOutbox : now,
    at: new Date().toISOString(),
  };
  // ★ 顺带记下 outbox 总数（下一批算增量用）
  const rec = { ...result, outboxTotal: now } as SnapshotResult & { outboxTotal: number };

  mkdirSync(join(FORGE_LAB, "work"), { recursive: true });
  appendFileSync(join(FORGE_LAB, "work", "batches.jsonl"), JSON.stringify(rec) + "\n");

  // ★ 把 hunt 的收敛门判决抄过来（逐字，不改）
  const gateLines: string[] = (() => {
    try {
      const rows = readStructured(SOURCE_LAB);
      const g = convergedGate(SOURCE_LAB, rows);
      const seven = sevenStats(rows);
      return [
        `- **收敛门**：${g.pass ? "✔ 通过" : "⛔ **未通过**"} — ${g.verdict}`,
        `- 结构化实验 **${seven.rows}** 条 · 跨载体成立 ${seven.portable} · 现象被独立审 ${seven.reviewed}（判"补的" ${seven.calledFake}）`,
        `- ★ **经同侪认证的发现 ${seven.discovery} 条** · 反例型 ${seven.refuting} 条`,
        "★ 读它的 `work/experiments.jsonl` 可以逐条复核（含每条的命令与退出码）",
      ];
    } catch (e) {
      return [`- ⛔ 收敛门判决读不到：${(e as Error).message}`];
    }
  })();

  // ★ 给人看的一页摘要（研究助手/审查者读这个就够）
  writeFileSync(
    join(dst, "_SNAPSHOT.md"),
    [
      `# 快照 batch-${String(batch).padStart(3, "0")}`,
      "",
      `> 从第一集群 \`${SOURCE_CLUSTER}\` 拷来 · ${result.at}`,
      `> ★★ 这是**冻结的证据** —— 它对应第一集群在那一刻的样子，之后不再变。`,
      "",
      "| | |",
      "|---|---|",
      `| 批号 | ${batch} |`,
      `| 文件数 | ${files} |`,
      `| 大小 | ${(bytes / 1024 / 1024).toFixed(1)} MB |`,
      `| outbox 总数 | ${now} |`,
      `| outbox 增量 | ${result.freshOutbox} |`,
      "",
      "## 里面有什么",
      "",
      `- \`outbox/\` —— **成果**（第一集群研究出了什么）`,
      `- \`work/\` —— **研究路径**（它是怎么研究出来的：脚本、原始读数、日志）`,
      "",
      "★★ **只读结论只能复述；读了 `work/` 才能看出它的判据错在哪。**",
      "",
      "## ★ 第一集群自己的质量门（它自己写的账，我照抄）",
      "",
      gateLines.join("\n"),
    ].join("\n"),
  );

  return result;
}

/** 最近一次快照（没有 ⇒ undefined） */
export function latestSnapshot(): SnapshotResult | undefined {
  const all = readBatches();
  return all.length ? all[all.length - 1] : undefined;
}
