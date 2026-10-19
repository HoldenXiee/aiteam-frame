// 路径与常量 —— 全集群唯一的路径来源（★ 别在别处写死路径）
//
// ★ 布局（2026-10-18 定）：
//   research/clusters/<集群名>/      ← 集群的**代码**（本目录）
//   research/labfirst/<集群名>/      ← 集群的**空间**（它的 inbox/outbox/work/lib，独立 git）
//   research/docs/                   ← 这个研究方向的**材料**（成果/实验/装置）

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** 本文件所在目录 = 集群的代码目录 */
const here = dirname(fileURLToPath(import.meta.url));

/** 仓库根（从 research/clusters/<名>/ 往上 3 层） */
export const REPO = join(here, "..", "..", "..");

/**
 * ★★★ 集群的名字 —— 目录名与它一致。
 *
 * ★★ 可以用环境变量 `CLUSTER=lab-2` 切换（2026-10-19）：
 *   同一份集群代码要能跑**不同使命的集群** ——
 *     · `lab-3b` = 广探索 / 冗余 / 创新（第一集群）
 *     · `lab-2`   = 体系化 / 实际检验 / 归纳批判（第二集群）
 *   ★ 它们的代码**同源**（路径、守卫、锁、回退、lib 自检全都一样），
 *     **差别只在提示词与规则表** —— 这正是「集群的使命是使用者代码，不是库」的落实。
 */
export const CLUSTER = process.env.CLUSTER ?? "lab-3b";

/** ★ 集群的空间（它自己读写的地方，独立 git 仓库） */
export const LAB = join(REPO, "research/labfirst", CLUSTER);

/**
 * ★★★ 它可写的那份库的入口（分层的关键，2026-10-19 参数化）。
 *
 * ★ 为什么要从 `paths.ts` 算而不写死：
 *   同一份集群代码要能跑多个集群（`lab-3b` 广探索 / `lab-2` 体系化）——
 *   而两个集群**各自有一份可写的 lib/**（互不干扰，它改坏只影响自己）。
 */
export const LAB_ENTRY = join(LAB, "lib/aiteam/index.ts");

/** 这个研究方向的材料（成果 / 实验 / 规划 / 装置） */
export const DOCS = join(REPO, "research/docs");

/** 设计源 */
export const DESIGN = join(REPO, "dev/docs/DESIGN.md");

// ─────────────── 工具白名单 ───────────────

/** 能研究、能写自己的东西 */
export const ALL_TOOLS = ["bash", "read", "write", "edit", "grep", "find", "ls"];

/** ★ 只读 —— 审查者/复审者/启发者/看门狗都用这个（它们不该改东西） */
export const READONLY_TOOLS = ["bash", "read", "grep", "find", "ls"];

/** 模型（会话默认档） */
export const MODEL = "opencode-go/deepseek-v4.1-flash";
