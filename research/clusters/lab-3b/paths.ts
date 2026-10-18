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

/** ★ 集群的名字 —— 目录名与它一致 */
export const CLUSTER = "lab-3b";

/** ★ 集群的空间（它自己读写的地方，独立 git 仓库） */
export const LAB = join(REPO, "research/labfirst", CLUSTER);

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
