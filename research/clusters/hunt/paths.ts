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
 * ★★★ 集群的名字 —— 目录名、空间名、代码名三者一致。
 *
 * ★★★ 2026-10-20 拆分（设计者裁定）：
 *   「为什么代码还是放在同一个文件夹中，还是用环境变量来区分，
 *     这样**非常不便于优化**。你先把这两个集群的代码分开，
 *     然后再重新写架构（**forge 单独是要单独设计的**）」
 *
 * ★ 原来是 `process.env.CLUSTER ?? "hunt"` —— 一个环境变量决定 5701 行走哪条分支。
 * ★★ 现在**没有切换**：这份代码只服务 `hunt`（第一集群：广探索 / 冗余 / 创新）。
 *   要改另一个集群 ⇒ 去 `research/clusters/<另一个>/`，**互不相干**。
 *   这是「两个集群不可能同时优化，只能分开优化」在代码边界上的落实。
 */
export const CLUSTER = "hunt";

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

/**
 * ★★★ 外部材料通道的工具名（2026-10-21）。
 *
 * ★ 为什么必须单独列：本库的 `permissions.only` 是**硬白名单** —— 名单之外的
 *   工具连注册表都进不去。研究员原来 `only: [...ALL_TOOLS]`，
 *   而那 7 个名字里没有 web ⇒ 扩展明明装好了，**它手上 0 个 web 工具**。
 * ★★ 这是集群自己抓到的（`outbox/P108-外部材料通道探针…`）：
 *   「我的工具表里 **0 个** web 工具」—— 而我当时用一个**没设 `only`** 的探针 agent
 *   验过"能搜"，于是误以为接上了（纪律㉖ 的又一层：接上 ≠ 它手上真的有）。
 */
export const WEB_TOOLS = [
  "web_search",
  "fetch_content",
  "get_search_content",
  "source_check",
] as const;

/** ★ 只读 —— 审查者/复审者/启发者/看门狗都用这个（它们不该改东西） */
export const READONLY_TOOLS = ["bash", "read", "grep", "find", "ls"];

/** 模型（会话默认档） */
export const MODEL = "opencode-go/deepseek-v4.1-flash";
