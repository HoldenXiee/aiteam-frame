// 专家名册 —— ★ 代码里的表（不走模型的"选择"）
//
// ★ 依据 P3：**不要指望模型自己分工** —— 分工要由代码写死。
// ★ 依据 P13：**"允许它做 X" 它是不会做的** —— 所以角色的出现由拓扑决定，
//   不是"它想请谁就请谁"。

import * as inspector from "./inspector.ts";
import * as archivist from "./archivist.ts";
import * as inspirer from "./inspirer.ts";
import * as libsmith from "./libsmith.ts";
import * as watchdog from "./watchdog.ts";
import { ALL_TOOLS, READONLY_TOOLS } from "../paths.ts";

/** 一个专家 = 提示词工厂 + 工具白名单 */
export type Expert = {
  /** 生成角色描述（处境 + 地盘） */
  role: (why: string, focus?: string) => string;
  /** 生成投递给它的那一次 */
  prompt: () => string;
  /** ★ 它能看到哪些工具 —— 只读的专家永远只读 */
  tools: readonly string[];
};

export const EXPERTS = {
  inspector: { ...inspector, tools: READONLY_TOOLS },
  archivist: { ...archivist, tools: READONLY_TOOLS },
  inspirer: { ...inspirer, tools: READONLY_TOOLS },
  watchdog: { ...watchdog, tools: READONLY_TOOLS },
  /** ★ 只有它能写 —— 而且只能写 lib/（守卫管着） */
  libsmith: { ...libsmith, tools: ALL_TOOLS },
} as const satisfies Record<string, Expert>;

export type ExpertName = keyof typeof EXPERTS;

export const EXPERT_NAMES = Object.keys(EXPERTS) as ExpertName[];
