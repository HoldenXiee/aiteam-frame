// 调研脚手架：统一记录「现象 / 数据 / 结论」，并落 JSON 供报告引用。
// 每个 audit 脚本独立跑：node audit/01-config.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Finding {
  /** 清单里的编号，如 "1.1" */
  id: string;
  /** 要回答的问题 */
  question: string;
  /** 观察到的现象 —— 只写事实，不写结论 */
  observed: string;
  /** 支撑现象的数据 */
  data?: unknown;
  /** 由现象得出的结论；"OK" / "GAP" / "PARTIAL" 便于汇总 */
  verdict: "OK" | "GAP" | "PARTIAL" | "INFO";
  /** 结论文字 */
  conclusion: string;
}

const findings: Finding[] = [];
let currentSection = "";

export function section(title: string): void {
  currentSection = title;
  console.log(`\n\x1b[1m═══ ${title} ═══\x1b[0m`);
}

/** 默认不做判断，只记录现象 */
export function record(f: Omit<Finding, "id"> & { id?: string }): void {
  const finding: Finding = { id: f.id ?? "-", ...f } as Finding;
  findings.push(finding);
  const badge = { OK: "\x1b[32m✓ OK \x1b[0m", GAP: "\x1b[31m✗ GAP\x1b[0m", PARTIAL: "\x1b[33m~PART\x1b[0m", INFO: "\x1b[36m·INFO\x1b[0m" }[
    finding.verdict
  ];
  console.log(`${badge} [${finding.id}] ${finding.question}`);
  console.log(`     现象：${finding.observed}`);
  console.log(`     结论：${finding.conclusion}`);
  if (finding.data !== undefined) {
    const s = typeof finding.data === "string" ? finding.data : JSON.stringify(finding.data);
    console.log(`     数据：${s.length > 900 ? `${s.slice(0, 900)}…(+${s.length - 900})` : s}`);
  }
}

/** 短工具：断言式记录 */
export function check(
  id: string,
  question: string,
  ok: boolean,
  observed: string,
  conclusion: string,
  data?: unknown,
): void {
  record({ id, question, observed, verdict: ok ? "OK" : "GAP", conclusion, data });
}

/** 把本脚本的发现落到 audit/findings/<name>.json */
export function dump(name: string): void {
  const path = join(HERE, "findings", `${name}.json`);
  writeFileSync(path, JSON.stringify({ section: currentSection, findings }, null, 2), "utf-8");
  const counts = findings.reduce<Record<string, number>>((a, f) => ({ ...a, [f.verdict]: (a[f.verdict] ?? 0) + 1 }), {});
  console.log(`\n→ ${path}　共 ${findings.length} 条：${JSON.stringify(counts)}`);
}

/** 造一个孤立 agentDir（含 models.json）+ cwd，不占用 test/ 的共享 faux */
export function isolatedRoot(prefix = "aiteam-audit-"): { root: string; agentDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, agentDir, cwd };
}

export function ms<T>(fn: () => T): [T, number] {
  const t = process.hrtime.bigint();
  const v = fn();
  return [v, Number(process.hrtime.bigint() - t) / 1e6];
}

export async function msAsync<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = process.hrtime.bigint();
  const v = await fn();
  return [v, Number(process.hrtime.bigint() - t) / 1e6];
}

export const num = (n: number, digits = 1) => Number(n.toFixed(digits));
