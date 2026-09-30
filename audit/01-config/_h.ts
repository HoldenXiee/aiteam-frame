// 本目录自用的小脚手架（不往 audit/findings/ 写，避免和其他 agent 的文件交叉）。
// 与 audit/_harness.ts 同形，只是落盘位置在 audit/01-config/data/。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, "data");

export interface Finding {
  id: string;
  question: string;
  observed: string;
  data?: unknown;
  verdict: "OK" | "GAP" | "PARTIAL" | "INFO";
  conclusion: string;
}

let findings: Finding[] = [];
let currentSection = "";

export function section(title: string): void {
  currentSection = title;
  console.log(`\n\x1b[1m═══ ${title} ═══\x1b[0m`);
}

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
    console.log(`     数据：${s.length > 1200 ? `${s.slice(0, 1200)}…(+${s.length - 1200})` : s}`);
  }
}

export function check(id: string, question: string, ok: boolean, observed: string, conclusion: string, data?: unknown): void {
  record({ id, question, observed, verdict: ok ? "OK" : "GAP", conclusion, data });
}

/** 本脚本的发现落到 audit/01-config/data/<name>.json */
export function dump(name: string, extra?: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify({ script: name, section: currentSection, extra, findings }, null, 2), "utf-8");
  const counts = findings.reduce<Record<string, number>>((a, f) => ({ ...a, [f.verdict]: (a[f.verdict] ?? 0) + 1 }), {});
  console.log(`\n→ ${path}　共 ${findings.length} 条：${JSON.stringify(counts)}`);
  findings = [];
}

/** 汇总 data/ 下所有分片 */
export function merge(): string {
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json") && f !== "merged.json");
  const parts = files.map((f) => JSON.parse(readFileSync(join(DATA_DIR, f), "utf-8")) as { script: string; findings: Finding[] });
  const out = { generatedFrom: files.sort(), findings: parts.flatMap((p) => p.findings) };
  const path = join(HERE, "data.json");
  writeFileSync(path, JSON.stringify(out, null, 2), "utf-8");
  console.log(`→ ${path}　合并 ${files.length} 个分片，共 ${out.findings.length} 条`);
  return path;
}

export const num = (n: number, digits = 1) => Number(n.toFixed(digits));
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
