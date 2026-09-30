// 第 7 部分专用脚手架：记录「现象/数据/结论」并合并写入 audit/07-observability/data.json。
// 刻意不写 audit/findings/（那是别的部分的共享文件）；也刻意不设任何环境变量，
// 这样真模型脚本 import 它以后仍然读 ~/.pi/agent。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data.json");

export interface Finding {
  id: string;
  question: string;
  observed: string;
  data?: unknown;
  verdict: "OK" | "GAP" | "PARTIAL" | "INFO";
  conclusion: string;
}

const findings: Finding[] = [];
let currentSection = "";

export function section(title: string): void {
  currentSection = title;
  console.log(`\n═══ ${title} ═══`);
}

export function record(f: Omit<Finding, "id"> & { id?: string }): void {
  const finding: Finding = { id: f.id ?? "-", ...f } as Finding;
  findings.push(finding);
  const badge = { OK: "✓ OK ", GAP: "✗ GAP", PARTIAL: "~PART", INFO: "·INFO" }[finding.verdict];
  console.log(`${badge} [${finding.id}] ${finding.question}`);
  console.log(`    现象：${finding.observed}`);
  console.log(`    结论：${finding.conclusion}`);
  if (finding.data !== undefined) {
    const s = typeof finding.data === "string" ? finding.data : JSON.stringify(finding.data);
    console.log(`    数据：${s.length > 1200 ? `${s.slice(0, 1200)}…(+${s.length - 1200})` : s}`);
  }
}

/** 追加记录并即时落盘（长实验中途崩了也能保住前面的证据） */
export function flush(name: string): void {
  const all: Record<string, unknown> = existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf-8")) : {};
  all[name] = { section: currentSection, findings };
  writeFileSync(DATA, JSON.stringify(all, null, 2), "utf-8");
}

export function dump(name: string, extra?: Record<string, unknown>): void {
  const all: Record<string, unknown> = existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf-8")) : {};
  all[name] = { section: currentSection, findings, ...(extra ? { extra } : {}) };
  writeFileSync(DATA, JSON.stringify(all, null, 2), "utf-8");
  const counts = findings.reduce<Record<string, number>>((a, f) => ({ ...a, [f.verdict]: (a[f.verdict] ?? 0) + 1 }), {});
  console.log(`\n→ ${DATA}  [${name}] 共 ${findings.length} 条：${JSON.stringify(counts)}`);
}

export function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export const num = (n: number, digits = 2) => Number(n.toFixed(digits));
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 事件载荷里有活对象（session）时 stringify 会抛错 —— 先试再降级 */
export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "undefined";
  } catch (e) {
    return `<不可序列化: ${(e as Error).message}>`;
  }
}
