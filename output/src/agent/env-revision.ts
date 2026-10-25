// 环境内容指纹（envRevision）—— 「这份结果跑在哪一版 agentDir 上」的真源。
//
// ★ 为什么这是库的事，不是实验脚本的事（2026-10-24，接 `outbox/装置缺陷-run身份缺env这一半`）：
//   · run 行已经钉了 `libSha`（库）与 `corpusHash`（语料），**唯独没有 env**。
//     而 agentDir（技能 / 扩展 / 模型目录）是**共享的、可写的、在 lab 窗口内真的被改过**的
//     （实测 3 个 SKILL.md 的 mtime 落在 2026-10-23T17:34Z / 2026-10-24T02:58Z / 03:23Z）。
//   · 技能内容**真的进过模型**：`work/runs/` 1750 行里 401 行（23%）的 tool 参数里带 `SKILL.md`。
//   ⇒ 两个 `libSha` 相同的 run，可能一个读过某版技能、一个没读过，记录上完全一样。
//   ⇒ 「同 libSha 就同源」这条在**环境**这一半上是假的；
//     `corpusHash` 的存在理由与此完全同构（语料也会变、也有哈希）。
//
// ★ 形状与 `libRevision`（`revision.ts`）同一手法：对 agentDir 下**全部内容文件**按路径排序后
//   逐文件哈希再合并 ⇒ 任何一行改动都会变；行尾统一成 LF 再哈希（同源代码在不同 checkout 下应给同一个指纹）。
//   ★ 差别只有一处，也正是这一份必须**自己采样**的原因：库源码在一次运行里不会变，**环境会**。
//   所以这里**不**做进程级缓存 —— 采样时刻 = 建 agent 时刻（`envAt` 就是那一刻，不是跑完时刻）。
//
// ★ 不入指纹的东西**必须逐个点名**（见 `skipped`），不静默排除：
//   · `auth.json` 等凭证：内容不进记录（凭证不该进 git / jsonl），只记 `authPresent`。
//   · `sessions` 目录：`sessionStorage:"files"` 会往这里写；它是**本次运行的数据**，不是环境。
//   · `models-store.json`：远程目录的**缓存**（网络改写的不确定态）。它变不代表「模型看到的技能/规则变了」，
//     留着会让同一批的 envSha 因无关原因抖动 —— 排除，并在 `skipped` 里写出来。
//   · `node_modules` / `packages` / `logs` / `crash-logs` / 缓存目录：安装产物 / 运行时日志。
// ★ 不静默：agentDir 读不到时 `sha:null, source:"unavailable"` + `note`，**不编哈希**。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export interface EnvRevision {
  /** 内容指纹（sha256 前 16 位）；`null` = 没量到（agentDir 读不到），不是「和谁都一样」 */
  sha: string | null;
  /** 参与指纹的文件（相对 agentDir，已排序） */
  files: string[];
  /** ★ 口径可见：这次指纹盖住了**几个文件**（同 `libRevision.files.length` 的教训：数字要能被复核） */
  fileCount: number;
  /** 指纹从哪来：`files` = 读了 agentDir；`unavailable` = 读不到（没量到） */
  source: "files" | "unavailable";
  /** ★ 采样时刻（ISO）= 建 agent 时刻。env 会变，所以「哪一刻量的」是读数的一部分 */
  at: string;
  /** 凭证是否在位（**只记存在，不记内容**） */
  authPresent: boolean;
  /** ★ 被排除的条目（相对路径 + 原因），逐个点名，不静默 */
  skipped: string[];
  /** `source:"unavailable"` 时的原因 */
  note?: string;
}

/** 目录名：运行时数据 / 安装产物，不是「模型看到的环境」 */
const SKIP_DIR_NAMES = ["sessions", "logs", "crash-logs", "node_modules", "packages", "cache", ".cache", "tmp"];
/** 文件名：凭证，只记存在 */
const CREDENTIAL_FILES = ["auth.json", "credentials.json", "token.json", "auth-token.json"];
/** 文件名：远程目录缓存（网络改写的不确定态） */
const CACHE_FILES = ["models-store.json"];
/** 单文件上限：超过就记成 skipped（**不静默截断**）——正常的 env 文件都在 KB 级 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const BACKSLASH = String.fromCharCode(92);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const toPosix = (p: string): string => p.split(BACKSLASH).join("/");
const baseName = (rel: string): string => {
  const i = rel.lastIndexOf("/");
  return i < 0 ? rel : rel.slice(i + 1);
};

/**
 * 采样一次 agentDir 的内容指纹。**不缓存**：环境会变，「这次跑的时候是哪一版」只能当场量。
 *
 * ★ 用法：库在**建 agent 时**调一次，结果挂在该 agent 的每一份 `RunResult` 上
 *   （`envSha` / `envFiles` / `envAt`）；`inspectEnv().envRevision` 是**自检那一刻**的另一次采样，
 *   两者时刻不同（各自的 `at` 说得清）。
 */
export function getEnvRevision(agentDir: string): EnvRevision {
  const at = new Date().toISOString();
  const empty = (note: string): EnvRevision => ({
    sha: null,
    files: [],
    fileCount: 0,
    source: "unavailable",
    at,
    authPresent: false,
    skipped: [],
    note,
  });
  if (!agentDir) return empty("没有 agentDir");
  if (!existsSync(agentDir)) return empty("agentDir 不存在：" + agentDir);

  const skipped: string[] = [];
  let authPresent = false;
  const collected: { rel: string; file: string }[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push(toPosix(relative(agentDir, dir)) + "/(读不到：" + String(err) + ")");
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = toPosix(relative(agentDir, full));
      // 符号链接目录不跟（与 revision.ts 同：跟出去会让指纹取决于链接目标的外部状态）
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.includes(entry.name)) skipped.push(rel + "/(运行时数据，不是环境)");
        else walk(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped.push(rel + "(符号链接，未跟随)");
        continue;
      }
      if (!entry.isFile()) continue;
      const name = baseName(rel);
      if (CREDENTIAL_FILES.includes(name)) {
        if (name === "auth.json") authPresent = true;
        skipped.push(rel + "(凭证：只记存在，不记内容)");
        continue;
      }
      if (CACHE_FILES.includes(name)) {
        skipped.push(rel + "(远程目录缓存：不确定态，不代表模型看到的环境)");
        continue;
      }
      let bytes = 0;
      try {
        bytes = readFileSync(full).length;
      } catch (err) {
        skipped.push(rel + "(读不到：" + String(err) + ")");
        continue;
      }
      if (bytes > MAX_FILE_BYTES) {
        skipped.push(rel + "(超过 " + MAX_FILE_BYTES + " 字节，未入指纹)");
        continue;
      }
      collected.push({ rel, file: full });
    }
  }

  try {
    walk(agentDir);
    collected.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const hash = createHash("sha256");
    for (const item of collected) {
      // 路径也参与哈希：改名 / 移动 = 一个新环境（否则「技能换位置」会撞同一个指纹）
      hash.update(item.rel);
      hash.update(NUL);
      // 行尾归一（同 revision.ts）：指纹认的是内容，不是 checkout 的换行约定
      hash.update(readFileSync(item.file, "utf8").split(CR).join(""), "utf8");
      hash.update(NUL);
    }
    if (collected.length === 0) {
      // 空目录不是「一个空环境」的同义词：没量到内容就说没量到
      return {
        sha: null,
        files: [],
        fileCount: 0,
        source: "unavailable",
        at,
        authPresent,
        skipped,
        note: "agentDir 里没有任何可入指纹的内容文件：" + agentDir,
      };
    }
    return {
      sha: hash.digest("hex").slice(0, 16),
      files: collected.map((item) => item.rel),
      fileCount: collected.length,
      source: "files",
      at,
      authPresent,
      skipped,
    };
  } catch (err) {
    const failed = empty("读不到 agentDir（" + agentDir + "）：" + String(err));
    return { ...failed, authPresent, skipped };
  }
}
