// 库自身的**修订指纹**（libRevision）—— 「这份结果来自哪个版本的库」的真源。
//
// ★ 为什么这是库的事，不是实验脚本的事（2026-10-23，接 `outbox/装置缺陷-共享work同名驱动与FRESH清理…`
//   与 `P100` 的「libSha 不同不可引同源」）：
//   · 当前各驱动各自算 `libSha`，而它们算的**只是自己列的那几个文件**：
//     `exp-empty-truth.ts` 只哈希 `surfaces/observe.ts`，`exp-empty-pressure.ts` 只哈希 6 个文件。
//     于是：**只改了 `tools.ts`（shell 边界）/ `lab.ts`（默认边界）/ `sandbox.ts` 的两次运行，
//     会带着同一个 libSha** —— 「同 libSha ⇒ 同一份库」在数据上是**假的**，
//     而跨批引用正是靠这个假设。
//   · 清单由调用方手写 ⇒ 手写漏一项就是一个隐变量（与 `createLab` 手抄 env 字段漏 modelAllow 同族）。
//
// ★ 形状：对 `lib/aiteam/**.ts` **全部源文件**按路径排序后逐文件哈希再合并 ⇒ 任何一行改动都会变。
// ★ 行尾统一成 LF 再哈希：**同源代码**在不同 checkout（CRLF/LF）下应给同一个指纹 ——
//   否则「同步回仓库」这个纯传输动作会被读成「库变了一版」。
// ★ 不静默：源码读不到（被 bundle / 安装成只读包）时 `sha:null, source:"unavailable"`，
//   并把原因写进 `note`；`inspectEnv().warnings` 与 `RunResult.libSha:null` 都能看见。
//   **不**在没量到时编一个「看起来像哈希」的常量。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LibRevision {
  /** 内容指纹（sha256 前 16 位）；`null` = 源码不可读，没量到 */
  sha: string | null;
  /** 参与指纹的文件（相对 `lib/aiteam`，已排序） */
  files: string[];
  /** 指纹从哪来：`files` = 读了源码；`unavailable` = 读不到（没量到） */
  source: "files" | "unavailable";
  /** `source:"unavailable"` 时的原因（不静默） */
  note?: string;
}

let cached: LibRevision | undefined;

/** 递归收集 `.ts` 源文件（不跟符号链接目录） */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    // ★★ 2026-10-26 改库者：**测试文件不进行为指纹**。
    //   libSha 的语义是「这份读数出自哪一版**行为**」（见文件头）。把 `*.test.ts` 算进去，
    //   会让「补了一个回归测试」被读成「库变了一版」—— 于是真正该被怀疑的改动被噪声淹没。
    //   ★ 与 P58 的「广告面 ≠ 能力面」同族：指纹该数的是**被判的东西**，不是仓库里有多少文件。
    else if (entry.isFile() && entry.name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 本库（`lib/aiteam`）当前的修订指纹。进程内缓存（一次读 ~4k 行，代价可忽略）。
 *
 * ★ 用法：把 `res.libSha` 落进每一行数据；它覆盖**全部**库源码，不再依赖调用方手写文件清单。
 */
export function getLibRevision(): LibRevision {
  if (cached) return cached;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // = lib/aiteam（本文件在 agent/ 下）
  try {
    const files = walk(root).sort();
    if (files.length === 0) throw new Error(`没有找到任何 .ts 源文件：${root}`);
    const hash = createHash("sha256");
    for (const file of files) {
      // 路径也参与哈希：改名/移动 = 一个新版本（否则「文件内容换位置」会撞同一个指纹）
      hash.update(relative(root, file).replace(/\\/g, "/"));
      hash.update("\0");
      // 行尾归一（见文件头）：指纹认的是代码，不是 checkout 的换行约定
      const source = readFileSync(file, "utf8").split(String.fromCharCode(13)).join("");
      hash.update(source, "utf8");
      hash.update("\0");
    }
    cached = {
      sha: hash.digest("hex").slice(0, 16),
      files: files.map((f) => relative(root, f).replace(/\\/g, "/")),
      source: "files",
    };
  } catch (err) {
    cached = {
      sha: null,
      files: [],
      source: "unavailable",
      note: `读不到库源码（${root}）：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return cached;
}
