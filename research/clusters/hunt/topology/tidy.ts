// tidy —— ★★★★★ 让集群**整理自己的空间**（2026-10-27 设计者交办）
//
// ══════════════════════════════════════════════════════════════════════
// ★★★ 设计者原话：
//   「research/labfirst 里面文件夹很乱啊，hunt 集群在工作时，**不会自己整理**
//     文件夹里面的内容吗，一定要**定时把里面废物文件**（尤其是废弃文档，
//     **直接删掉**，**留痕都是对上下文的污染**）删了。」
//
// ★★★ 为什么这条不是"打扫卫生"，是**研究质量问题**（实测账）：
//   `work/` **157519 个文件 / 1.1GB**，最大的三个是集群自己造的 scratch：
//     · `P800-lostupd/`     412 文件 / 360MB（399 个 jsonl 中间读数）
//     · `brief2/env-list/node_modules/`  **144MB** ← 一次探针把整个 node_modules 拷了一份
//     · `P480-namedzero/corpus/`        6516 个 txt / 63MB（语料副本）
//   而**成果** `outbox/` 只有 **6MB** ⇒ 垃圾是产物的 **180 倍**。
//
//   ★★ 两个可数的后果：
//     ① 研究员的角色提示里写着「读 `work/` 是研究路径」⇒ 垃圾**直接进上下文**；
//     ② `onPlateau` 每 tick 扫 `work/`（138135 文件 / 482MB）⇒ **事件循环停几十秒**
//        ⇒ tick 1 次/45 分钟、到点不收尾（exit=124）。**这是我踩过的第三个阻塞源。**
//     ⇒ 所以「清理」不是美观问题：**垃圾会让装置变慢、让上下文变脏。**
//
// ★★★ 谁决定删什么（硬规则①）：
//   **集群决定**。我只做三件事：
//     ① 给**机械可查的护栏**（下面 `guard()`）：不许出自己空间、不许碰成果/证据/账本；
//     ② 给**废物的候选清单**（`candidates()`：只看形状 —— 拷进来的 node_modules、
//        几千个语料副本、超大 scratch），**不判断内容价值**；
//     ③ 给**后果可查的读数**（`report()`）：清了多少文件/字节，清掉的有没有被引用过。
//
//   ★ 为什么不"我直接 rm"：那是**替集群拍板**（硬规则①）。
//     但「它不动手」有过先例（`spawn_line` 连续三轮 0 次）⇒ 所以做成**规则 + 配额**
//     （`onTidy`，每 20 分钟一次，带候选清单和拒收理由），不是一句"请保持整洁"。
//
// ★★ 留痕怎么处理（设计者："留痕都是对上下文的污染"）：
//   不直接 `rm`，而是**移进 `work/_trash/<时间戳>/`**，并在**下一轮 tidy** 里真删
//   （保留期 2 小时）。理由：① `rm` 不可逆，一次误判就把证据删了；
//   ② 但要**在视野里消失** —— `_trash/` 是单一目录、不会被 `work/*/` 的清单展示，
//   也不进处境表 ⇒ **对上下文等于已消失**，同时留一条可回退的路。
// ══════════════════════════════════════════════════════════════════════

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 一个目录的规模 */
export type DirStat = { rel: string; files: number; bytes: number; newestMs: number };

/** 仓库/空间里**永远不许 tidy 碰**的东西（机械白名单，不是内容判断） */
export const PROTECTED = [
  "outbox", // ★ 成果
  "inbox", // ★ 设计者投进来的东西
  "lib", // ★ 它能写的那份库
  "source", // ★ 快照原料（forge）
  "work/runs", // ★ 轮转归档的日志
  "work/_trash", // tidy 自己的隔离区（由 purge 管，不许手动指进来）
  "work/experiments.jsonl", // ★ 实验账
  "work/_topology.log", // ★ 拓扑日志（当前轮）
  "work/_cluster.lock", // ★ 单实例锁
  "work/_tidy.jsonl", // ★ 清理账
  "work/PROJECTS.md",
  ".git",
] as const;

/**
 * ★★★★ `work/` 顶层**必须留**的文件（2026-10-27 补：散文件才是"看起来乱"的主体）
 *
 * ★ 实测：`work/` 顶层 **3028 个散文件 / 15MB**，其中 **2276 个没有任何产物引用**
 *   （`.cb18-rowgate.bak.ts`、`_probe-*.md`、`.outbox-coverage-files.txt` …）。
 *   ★★ 而第一版护栏写着「只许清目录」⇒ **它想清也清不了**（这是设计缺口，不是它懒）。
 *
 * ★ 留下的这些是**账本与指示**，不是 scratch：
 */
export const WORK_KEEP = new Set([
  "experiments.jsonl",
  "challenges.jsonl",
  "port.json",
  "port.jsonl",
  "JOURNAL.md",
  "_topology.log",
  "_tidy.jsonl",
  "_cluster.lock",
  "_lib-rev.jsonl",
  "_处境.md",
  "_SNAPSHOT.md",
  "_focus.txt",
  "_stop-request",
  "_brk.txt",
  "_tidy.md",
]);

/**
 * ★★★★ 形状本身就是垃圾的目录（2026-10-27）
 *
 * ★ `work/` 里任意一层的 `node_modules` **永远不是研究证据** —— 它是"把整个环境拷了一份"的产物。
 *   ★★ 实测代价：`work/brief2/env-list/node_modules` **144MB / 19456 个文件**，
 *     而产物正文里提到过这个路径 ⇒ 我的"被引用就不许清"判据把它锁死了。
 *   ★★★ 判据分层（这一条很重要）：**"被引用"不等于"是证据"**。
 *     产物写「我们拷了整份 node_modules（144MB）」是在**描述代价**，不是"这些文件是我的读数"。
 *   ⇒ 这一类**不看引用**，按形状直接算垃圾（`.venv` / `__pycache__` 同理）。
 */
export const ALWAYS_JUNK = new Set(["node_modules", ".venv", "__pycache__", ".cache", ".pnpm-store"]);

/** 路径里有没有一段是"形状即垃圾" */
export function shapeJunk(rel: string): boolean {
  return rel.split("/").some((seg) => ALWAYS_JUNK.has(seg));
}

/** 判定常量 —— 写死在这里，测试与运行时**同一份**（纪律⑪：判据与指令同源） */
export const TIDY = {
  /** 单个目录大于这个字节数 ⇒ 算"大 scratch"候选 */
  bigDirBytes: 50 * 1024 * 1024,
  /** 文件数超过这个 ⇒ 算"碎文件洪水"候选 */
  manyFiles: 2000,
  /** `_trash` 保留多久后才真删（毫秒） */
  trashTtlMs: 2 * 3600_000,
  /** 一次调用最多清几个目录（配额：防止一口气把证据全清了） */
  maxPathsPerCall: 3,
  /** 一次调用最多清几个顶层散文件（它们小而碎，配额放大） */
  maxFilesPerCall: 200,
} as const;

/**
 * ★★★ 护栏：给一条相对路径，说它能不能被清。
 *
 * ★ 纯函数、**不碰文件系统**（`exists` 由调用方传）⇒ 可以离线重判（纪律⑦）。
 * ★★ 返回 `null` = 放行；返回字符串 = 拒收理由（会原样回给集群，它看得到为什么）。
 */
export function guard(
  lab: string,
  rel: string,
  opts: { exists?: (abs: string) => boolean; allowFiles?: boolean } = {},
): string | null {
  const exists = opts.exists ?? ((p: string) => existsSync(p));
  if (!rel || typeof rel !== "string") return "空路径";
  // ① 不许出空间
  const abs = resolve(lab, rel);
  const back = relative(lab, abs);
  if (isAbsolute(rel) || rel.includes("..") || back.startsWith("..") || isAbsolute(back)) {
    return "越界：只许清你自己空间里的东西（不许绝对路径、不许 ..）";
  }
  const norm = back.split(sep).join("/");
  // ② 不许碰白名单
  for (const p of PROTECTED) {
    if (norm === p || norm.startsWith(`${p}/`)) return `受保护：${p}（成果/证据/账本/日志不许清）`;
  }
  // ③ 不许清空间根、不许清 work 根
  if (norm === "" || norm === "." || norm === "work") return "不许清整个空间或整个 work/";
  // ④ 目录随便清；**文件要显式打开**（默认不许：一份产物就是一个结论）
  const a = join(lab, norm);
  if (!exists(a)) return "不存在";
  let isDir = false;
  try {
    isDir = statSync(a).isDirectory();
  } catch {
    return "读不到（权限/链接？）";
  }
  if (!isDir) {
    if (!opts.allowFiles) return "单文件默认不许清（可能是成果）；清散文件请用 tidy_space 的 files 入口";
    if (WORK_KEEP.has(basename(norm))) return `受保护：${basename(norm)} 是账本/指示`;
  }
  return null;
}

/** 目录规模（★ 深度封顶 + 文件数封顶：踩过 `onPlateau` 全树扫的坑，不许再来一次） */
export function dirStat(root: string, rel: string, cap = 20000): DirStat {
  let files = 0;
  let bytes = 0;
  let newestMs = 0;
  const walk = (dir: string, depth: number): void => {
    if (files >= cap) return;
    let ents: import("node:fs").Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (files >= cap) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // ★ 深度封顶 6：踩过 `onPlateau` 全树扫（138135 文件）把事件循环冻住的坑
        if (depth < 6 && e.name !== ".git") walk(p, depth + 1);
      } else {
        files++;
        try {
          const st = statSync(p);
          bytes += st.size;
          if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
        } catch {
          /* 读不到就不算 */
        }
      }
    }
  };
  walk(join(root, rel), 0);
  return { rel, files, bytes, newestMs };
}

/** `_trash/` 里的相对路径 → 原始位置（用于"被引用了就不能真删"的回退） */
export function origOf(trashRel: string): string {
  const parts = trashRel.split("/");
  // work/_trash/<ISO>/<原路径...>
  return parts.slice(3).join("/");
}

/**
 * ★★★★ 候选清单 —— **只看形状，不看内容**（我不判价值，硬规则①）
 *
 * 三条机械特征（每条都能一眼复核）：
 *   ① 里面**拷了 node_modules**（`brief2/env-list/node_modules` 144MB 就是这么来的）
 *   ② 目录里**文件数 > 2000**（碎文件洪水：一次探针扒了 6516 个 txt）
 *   ③ 单个目录 **> 50MB**（超大 scratch：399 个 jsonl 就 360MB）
 * ★ 都会**排除**受保护路径与 `_trash`。
 */
export function candidates(lab: string, opts: { cap?: number } = {}): (DirStat & { why: string[] })[] {
  const work = join(lab, "work");
  if (!existsSync(work)) return [];
  let ents: import("node:fs").Dirent[] = [];
  try {
    ents = readdirSync(work, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: (DirStat & { why: string[] })[] = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (e.name === "_trash" || e.name === "runs") continue;
    const rel = `work/${e.name}`;
    if (guard(lab, rel) !== null) continue;
    const st = dirStat(lab, rel, opts.cap ?? 20000);
    const why: string[] = [];
    if (existsSync(join(lab, rel, "node_modules"))) why.push("里面拷了 node_modules（整个环境被复制）");
    if (existsSync(join(lab, rel, "env", "node_modules")) || existsSync(join(lab, rel, "env-list", "node_modules"))) {
      why.push("里面有 env*/node_modules（整个环境被复制）");
    }
    if (st.files > TIDY.manyFiles) why.push(`文件数 ${st.files} > ${TIDY.manyFiles}`);
    if (st.bytes > TIDY.bigDirBytes) why.push(`${Math.round(st.bytes / 1048576)}MB > 50MB`);
    if (why.length) out.push({ ...st, why });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/**
 * ★★★ 被引用过就不能清（机械判定，不是内容判断）
 *
 * 查三处**账本**里有没有出现这个路径（或它的目录名）：
 *   `work/experiments.jsonl`（实验账，带 PREREG 与证据 id）
 *   `outbox/PROJECTS.md`（项目表）
 *   `outbox/CONVERGED.md`（收敛状态表）
 * ★★ 判据故意粗：宁可**拒收**也不误删 —— 一次误删的代价是"证据链断了"，
 *   而拒收的代价只是"少清一个目录"。
 */
export function referencedIn(
  lab: string,
  rel: string,
  opts: { requirePathish?: boolean } = {},
): string | null {
  const name = basename(rel);
  const outboxRef = outboxMentions(lab, rel, opts);
  if (outboxRef) return outboxRef;
  const files = ["work/experiments.jsonl", "outbox/PROJECTS.md", "outbox/CONVERGED.md", "work/_SNAPSHOT.md"];
  for (const f of files) {
    const p = join(lab, f);
    if (!existsSync(p)) continue;
    let txt = "";
    try {
      txt = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (txt.includes(rel) || (name.length >= 6 && txt.includes(name))) return f;
  }
  return null;
}

/**
 * ★★★★ 485 份产物里有没有提到这个目录（2026-10-27 补）
 *
 * ★ 为什么必须补：我第一版只查 4 个**账本**文件 —— 而产物的正文里写着
 *   「见 `work/exp-xxx` 的读数」这种话，删了它同样会断链。
 * ★★ 判据故意粗（提到就算）：**宁可少清一个目录，不可误删一条证据**。
 * ★ 一次 tidy 只读一遍 outbox（按目录 mtime 缓存），不许每候选读 485 次。
 */
let OB_CACHE: { key: string; text: string } | null = null;

/** ★ 全部"账本 + 产物"的正文（缓存）—— 判"有没有被引用"只看它 */
export function refText(lab: string): string {
  const dir = join(lab, "outbox");
  const ledgers = ["work/experiments.jsonl", "outbox/PROJECTS.md", "outbox/CONVERGED.md", "work/_SNAPSHOT.md"];
  let key = "";
  let text = "";
  try {
    const ents = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.name.endsWith(".md")) : [];
    key = String(ents.length) + ":" + ents.reduce((a, e) => Math.max(a, statSync(join(dir, e.name)).mtimeMs), 0);
    if (OB_CACHE && OB_CACHE.key === key) return OB_CACHE.text;
    for (const e of ents) {
      try {
        text += readFileSync(join(dir, e.name), "utf8");
      } catch {
        /* skip */
      }
    }
    for (const f of ledgers) {
      const q = join(lab, f);
      if (existsSync(q)) {
        try {
          text += readFileSync(q, "utf8");
        } catch {
          /* skip */
        }
      }
    }
    OB_CACHE = { key, text };
  } catch {
    return "";
  }
  return text;
}

function outboxMentions(lab: string, rel: string, opts: { requirePathish?: boolean } = {}): string | null {
  const dir = join(lab, "outbox");
  if (!existsSync(dir)) return null;
  let key = "";
  try {
    const ents = readdirSync(dir, { withFileTypes: true }).filter((e) => e.name.endsWith(".md"));
    key = String(ents.length) + ":" + ents.reduce((a, e) => Math.max(a, statSync(join(dir, e.name)).mtimeMs), 0);
    if (!OB_CACHE || OB_CACHE.key !== key) {
      let text = "";
      for (const e of ents) {
        try {
          text += readFileSync(join(dir, e.name), "utf8");
        } catch {
          /* 读不到就跳过 */
        }
      }
      OB_CACHE = { key, text };
    }
  } catch {
    return null;
  }
  const name = basename(rel);
  const text = OB_CACHE.text;
  if (text.includes(rel)) return "outbox（某份产物引了这个路径）";
  if (name.length < 6) return null;
  // ★★★ 2026-10-27 · 修一个**假阳性**（它让我连 node_modules 都清不掉）
  //   ★ 现象：产物正文里出现 `node_modules` 这个词（它在讨论"拷进来的环境"），
  //     我的判据就判「被引用」⇒ `work/brief2/env-list/node_modules`（144MB）清不动。
  //   ★★ 判据修正：**通用词必须带路径分隔符才算引用**（`.../node_modules`、`env-list/node_modules`），
  //     光秃秃的一个词不算。★ 目录用这一档（证据要求严）；单个散文件仍放宽（它们小，宁可留）。
  if (opts.requirePathish) {
    return text.includes("/" + name) || text.includes("\\" + name) ? "outbox（某份产物引了这个路径）" : null;
  }
  return text.includes(name) ? "outbox（某份产物提了这个目录名）" : null;
}

/**
 * ★★★★★ 顶层散文件（2026-10-27 补：这才是"看起来乱"的主体）
 *
 * ★ 判据（机械）：`work/` **顶层**的普通文件，排除 `WORK_KEEP`、排除被账本/产物引用的。
 * ★★ 为什么只扫顶层、不递归：递归会碰到实验结果目录内部，那不是"乱"，那是它的装置。
 */
export function looseScratch(lab: string): { rel: string; bytes: number; newestMs: number }[] {
  const work = join(lab, "work");
  if (!existsSync(work)) return [];
  let ents: import("node:fs").Dirent[] = [];
  try {
    ents = readdirSync(work, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { rel: string; bytes: number; newestMs: number }[] = [];
  for (const e of ents) {
    if (!e.isFile()) continue;
    if (WORK_KEEP.has(e.name)) continue;
    const rel = `work/${e.name}`;
    if (guard(lab, rel, { allowFiles: true }) !== null) continue;
    if (referencedIn(lab, rel)) continue;
    let bytes = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(join(lab, rel));
      bytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    out.push({ rel, bytes, newestMs: mtimeMs });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/**
 * ★★★★★ `prune-inside` —— 目录被引用，但**里面绝大多数文件没被引用**（2026-10-27）
 *
 * ★ 实测（这就是"1.1G 清不动"的真相）：
 *   | 目录 | 文件 | 体积 | 名字被引用的 |
 *   |---|---|---|---|
 *   | `P800-lostupd` | 412 | **358MB** | **12 个（约 0MB）** |
 *   | `brief2` | 19976 | 115MB | 1233（8MB）|
 *   | `P480-namedzero` | 6516 | **49MB** | **6 个** |
 *   | `P370-drain` | 66 | 24MB | 66（全被引用 ⇒ 别动）|
 *
 * ⇒ 大部分体积是**没有任何东西引用的 bulk**。清它不会断证据链（被引用的留着）。
 * ★★ 但**有风险**：某个脚本可能靠 glob 读同目录的数据 ⇒ 所以这是**可选动作**（`mode`），
 *   由集群决定用不用；默认动作仍然是"整目录清"。
 * ★ 清掉的写一份 `MANIFEST.txt` 进 `_trash/<stamp>/`（2 小时后内容没了，但**名字还在**）。
 */
export function pruneUnreferenced(
  lab: string,
  dirRel: string,
  opts: { cap?: number; olderThanMs?: number } = {},
  now = new Date(),
): { moved: TidyRow[]; kept: number; refused: string | null } {
  const reason = guard(lab, dirRel);
  if (reason) return { moved: [], kept: 0, refused: reason };
  const text = refText(lab);
  const cap = opts.cap ?? 500;
  const older = opts.olderThanMs ?? 3600_000;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const trashRoot = join(lab, "work/_trash", stamp);
  const moved: TidyRow[] = [];
  let kept = 0;
  const walk = (dir: string, depth: number): void => {
    if (moved.length >= cap) return;
    let ents: import("node:fs").Dirent[] = [];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (moved.length >= cap) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 6 && e.name !== ".git") walk(p, depth + 1);
        continue;
      }
      if (text.includes(e.name)) {
        kept++;
        continue;
      }
      let st: import("node:fs").Stats;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (now.getTime() - st.mtimeMs < older) {
        kept++;
        continue;
      }
      const rel = relative(lab, p).split(sep).join("/");
      try {
        mkdirSync(join(trashRoot, rel, ".."), { recursive: true });
        renameSync(p, join(trashRoot, rel));
      } catch {
        continue;
      }
      const row: TidyRow = {
        at: now.toISOString(),
        action: "moved",
        rel,
        files: 1,
        bytes: st.size,
        why: `prune-inside：${dirRel} 里没被任何账本/产物引用的 bulk`,
      };
      moved.push(row);
      appendTidyLog(lab, row);
    }
  };
  walk(join(lab, dirRel), 0);
  if (moved.length > 0) {
    try {
      const NL = String.fromCharCode(10);
      const man = moved.map((m) => `${m.rel}` + "	" + `${m.bytes}`).join(NL);
      mkdirSync(trashRoot, { recursive: true });
      appendFileSync(join(trashRoot, "MANIFEST.txt"), `${now.toISOString()}` + NL + dirRel + NL + man + NL, "utf8");
    } catch {
      /* 清单写不上不影响清理 */
    }
  }
  return { moved, kept, refused: null };
}

/** 真删 / 移走 的落账行 */
export type TidyRow = { at: string; action: "moved" | "purged"; rel: string; orig?: string; files: number; bytes: number; why: string };

export function appendTidyLog(lab: string, row: TidyRow): void {
  try {
    mkdirSync(join(lab, "work"), { recursive: true });
    const line = `${row.at}  tidy:${row.action}  ${row.rel}  files=${row.files}  mb=${(row.bytes / 1048576).toFixed(1)}  ${row.why.replace(/\s+/g, " ").slice(0, 100)}\n`;
    appendFileSync(join(lab, "work/_tidy.jsonl"), line, "utf8");
  } catch {
    /* 记不上账不影响清理 */
  }
}

/**
 * ★★★★★ 执行一次清理（工具层调用它）
 *
 * 语义：
 *   · 每个放行的目录**移进** `work/_trash/<ISO>/<原路径>`（同一分区 ⇒ rename 是瞬时的）
 *   · 落一行账（`work/_tidy.jsonl`）
 *   · 顺手**真删** `_trash` 里超过 TTL 的旧批次（这就是"留痕不会长期污染"的落实）
 *
 * ★ 拒收的**不抛错**：返回 `{ok:false, refused:[{rel, reason}]}` ——
 *   集群看得到理由就能改（纪律⑳：拦的同时必须给路）。
 */
export function applyTidy(
  lab: string,
  req: { paths: string[]; why: string; kind?: string },
  now = new Date(),
): { ok: boolean; moved: TidyRow[]; refused: { rel: string; reason: string }[]; purged: TidyRow[] } {
  const moved: TidyRow[] = [];
  const refused: { rel: string; reason: string }[] = [];
  const paths = (req.paths ?? []).filter((p) => typeof p === "string");
  if (paths.length === 0) return { ok: false, moved, refused: [{ rel: "(空)", reason: "没给路径" }], purged: [] };
  const fileCount = paths.filter((p) => {
    try {
      return !statSync(resolve(lab, p)).isDirectory();
    } catch {
      return false;
    }
  }).length;
  const dirCount = paths.length - fileCount;
  if (dirCount > TIDY.maxPathsPerCall || fileCount > TIDY.maxFilesPerCall) {
    return {
      ok: false,
      moved,
      refused: [
        {
          rel: `(共 ${paths.length} 条：${dirCount} 目录 / ${fileCount} 文件)`,
          reason: `配额：一次最多 ${TIDY.maxPathsPerCall} 个目录、${TIDY.maxFilesPerCall} 个散文件（防止一口气清掉证据）`,
        },
      ],
      purged: [],
    };
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const trashRoot = join(lab, "work/_trash", stamp);

  for (const rel of paths) {
    const norm = rel.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
    const reason = guard(lab, norm, { allowFiles: true });
    if (reason) {
      refused.push({ rel: norm, reason });
      continue;
    }
    const refd = shapeJunk(norm) ? null : referencedIn(lab, norm, { requirePathish: true });
    if (refd) {
      refused.push({ rel: norm, reason: `被账本引用（${refd}）⇒ 清了会让证据链断掉。要清就先在账本里处置它` });
      continue;
    }
    const st = (() => {
      try {
        const a = join(lab, norm);
        if (!statSync(a).isDirectory()) return { rel: norm, files: 1, bytes: statSync(a).size, newestMs: 0 };
      } catch {
        /* 落到 dirStat */
      }
      return dirStat(lab, norm);
    })();
    const dest = join(trashRoot, norm);
    try {
      mkdirSync(join(trashRoot, norm, ".."), { recursive: true });
      renameSync(join(lab, norm), dest);
    } catch (e) {
      refused.push({ rel: norm, reason: `移不动：${(e as Error).message.slice(0, 80)}` });
      continue;
    }
    const row: TidyRow = { at: now.toISOString(), action: "moved", rel: norm, files: st.files, bytes: st.bytes, why: `${req.kind ?? "scratch"}：${req.why}` };
    moved.push(row);
    appendTidyLog(lab, row);
  }

  const purged = purgeTrash(lab, now);
  return { ok: moved.length > 0, moved, refused, purged };
}

/** 从 `2026-10-27T10-00-00-000Z` 这样的批次名解出毫秒（解不出返回 0）*/
export function stampOf(name: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
  if (!m) return 0;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(t) ? t : 0;
}

/** ★ 真删 `_trash` 里过期的批次（TTL 之后留痕**真的消失**） */
export function purgeTrash(lab: string, now = new Date()): TidyRow[] {
  const root = join(lab, "work/_trash");
  if (!existsSync(root)) return [];
  const out: TidyRow[] = [];
  let ents: import("node:fs").Dirent[] = [];
  try {
    ents = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const abs = join(root, e.name);
    // ★ 用**目录名里的时间戳**判年龄，不看 mtime ——
    //   mtime 会被"上次触碰"改写，而批次名就是它出生的时刻（纪律㉛：问历史只能读当时的记录）
    let ts = stampOf(e.name);
    if (!ts) {
      try {
        ts = statSync(abs).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now.getTime() - ts < TIDY.trashTtlMs) continue;
    const st = dirStat(root, e.name);
    try {
      rmSync(abs, { recursive: true, force: true });
    } catch {
      continue;
    }
    const row: TidyRow = { at: now.toISOString(), action: "purged", rel: `work/_trash/${e.name}`, files: st.files, bytes: st.bytes, why: `超过保留期（${Math.round(TIDY.trashTtlMs / 3600000)}h）⇒ 留痕真删` };
    out.push(row);
    appendTidyLog(lab, row);
  }
  return out;
}

/** 读数：这一轮清了多少 / 还剩多少候选 */
export function report(lab: string): {
  moved: TidyRow[];
  purged: TidyRow[];
  totalFiles: number;
  totalBytes: number;
  top: (DirStat & { why: string[] })[];
} {
  const rows: TidyRow[] = [];
  const p = join(lab, "work/_tidy.jsonl");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^\S+\s+tidy:(moved|purged)\s+(\S+)\s+files=(\d+)\s+mb=([\d.]+)/.exec(line);
      if (!m) continue;
      rows.push({ at: line.slice(0, 24), action: m[1] as "moved" | "purged", rel: m[2]!, files: Number(m[3]), bytes: Number(m[4]) * 1048576, why: "" });
    }
  }
  const cands = candidates(lab);
  const totalFiles = cands.reduce((a, c) => a + c.files, 0);
  const totalBytes = cands.reduce((a, c) => a + c.bytes, 0);
  return {
    moved: rows.filter((r) => r.action === "moved"),
    purged: rows.filter((r) => r.action === "purged"),
    totalFiles,
    totalBytes,
    top: cands.slice(0, 6),
  };
}

/** 给处境表/规则用的一行事实（★ 只给事实，不给任务） */
export function renderTidyFacts(lab: string): string {
  const r = report(lab);
  if (r.moved.length === 0 && r.totalFiles === 0) return "";
  const mb = (n: number) => `${Math.round(n / 1048576)}MB`;
  const lines = [
    `★ 你的 work/ 里**垃圾候选**（只看形状，不看内容）：${r.totalFiles} 个文件 / ${mb(r.totalBytes)}`,
    ...r.top.map((c) => `  · \`${c.rel}\` ${c.files} 文件 / ${mb(c.bytes)} — ${c.why.join("；")}`),
    r.moved.length > 0 ? `  已清（历史累计）：${r.moved.length} 个目录 / ${mb(r.moved.reduce((a, m) => a + m.bytes, 0))}` : "",
    "  ★ 工具 `tidy_space` 可以清（护栏：不许碰 outbox/inbox/lib/账本/被引用的目录）",
  ];
  return lines.filter(Boolean).join("\n");
}
