/**
 * ★★★★★ 工具使用账（2026-10-26）
 *
 * ★ 为什么需要：我量「`spawn_line` 有没有被用」时，只能去**产物正文**里 grep 关键词
 *   （4/366），而 `_topology.log` 里**根本没有工具调用行** ⇒
 *   「这个工具是死的」和「用了但没写进产物」我分不清（纪律㉔）。
 *
 * ★★ 记什么：每次工具调用一行 `tool:<名字>` + 可选的短摘要。
 *   不记参数全文（那会把日志撑爆），只记"谁、哪一件"。
 *
 * ★★★ 判据（写在这里，免得以后又想歪）：
 *   一个工具**连续两轮 0 次调用** ⇒ 要么它没用，要么它没接上 ⇒ 必须去查（纪律㉖）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LAB } from "../paths.ts";

export function logToolCall(name: string, extra?: string): void {
  try {
    const dir = join(LAB, "work");
    mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()}  tool:${name}${extra ? `  ${extra.slice(0, 120)}` : ""}\n`;
    appendFileSync(join(dir, "_topology.log"), line, "utf8");
  } catch {
    // ★ 记不上账**不许**影响工具本身（使用账是观测，不是功能）
  }
}

/**
 * ★★★★★ 谁和谁之间发生了一件事（2026-10-27）
 *
 * ★ 为什么要单独记：时间线上那张"网"要有**边**。
 *   之前日志里只有 `tool:challenge`（不知道挑战的是谁）和 `flow 辩证：共 9 次（hands-on←2…）`
 *   （只有收尾时的一次汇总）⇒ 画不出"逐步长出来的关系网"。
 * ★★ 记法：`edge <kind> <from>→<to>`，一行一条边，带时间戳。
 *   kind：challenge / consult / feedback（专家回流给研究员）/ steer（规则注入）
 */
export function logEdge(from: string, to: string, kind: string): void {
  try {
    const dir = join(LAB, "work");
    mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()}  edge:${kind}  ${from}→${to}\n`;
    appendFileSync(join(dir, "_topology.log"), line, "utf8");
  } catch {
    /* 观测不影响功能 */
  }
}
