// 24-uncovered 自用脚手架：与 audit/_harness.ts 同 API，但落盘在 audit/24-uncovered/data.json，
// 避免往 audit/findings/ 里写（那是别的 agent 的目录）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "data.json");

export interface Finding {
  id: string;
  question: string;
  observed: string;
  data?: unknown;
  verdict: "OK" | "GAP" | "PARTIAL" | "INFO";
  conclusion: string;
  script?: string;
}

const ALL: Finding[] = [];
let currentScript = "?";
let currentSection = "";

export function script(name: string): void {
  currentScript = name;
}

export function section(title: string): void {
  currentSection = title;
  console.log(`\n\x1b[1m═══ ${title} ═══\x1b[0m`);
}

export function record(f: Omit<Finding, "id"> & { id?: string }): void {
  const finding: Finding = { id: f.id ?? "-", script: currentScript, ...f } as Finding;
  ALL.push(finding);
  const badge = { OK: "\x1b[32m✓ OK \x1b[0m", GAP: "\x1b[31m✗ GAP\x1b[0m", PARTIAL: "\x1b[33m~PART\x1b[0m", INFO: "\x1b[36m·INFO\x1b[0m" }[finding.verdict];
  console.log(`${badge} [${finding.id}] ${finding.question}`);
  console.log(`     现象：${finding.observed}`);
  console.log(`     结论：${finding.conclusion}`);
  if (finding.data !== undefined) {
    const s = typeof finding.data === "string" ? finding.data : JSON.stringify(finding.data);
    console.log(`     数据：${s.length > 1200 ? `${s.slice(0, 1200)}…(+${s.length - 1200})` : s}`);
  }
}

/** 合并进 data.json（保留其它脚本已写入的条目） */
export function dump(): void {
  let prev: { findings: Finding[] } = { findings: [] };
  try {
    prev = JSON.parse(readFileSync(OUT, "utf-8")) as { findings: Finding[] };
  } catch {
    /* 首次运行 */
  }
  // 同一脚本的条目整体替换（旧 id 不再出现就应被清掉）
  const kept = prev.findings.filter((f) => f.script !== currentScript);
  const merged = [...kept, ...ALL];
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), section: currentSection, findings: merged }, null, 2), "utf-8");
  const counts = ALL.reduce<Record<string, number>>((a, f) => ({ ...a, [f.verdict]: (a[f.verdict] ?? 0) + 1 }), {});
  console.log(`\n→ ${OUT}　本脚本 ${ALL.length} 条：${JSON.stringify(counts)}（累计 ${merged.length} 条）`);
}

export const num = (n: number, d = 1) => Number(n.toFixed(d));
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** 最小二乘斜率 */
export const slope = (ys: number[]) => {
  const n = ys.length;
  if (n < 2) return Number.NaN;
  const xm = (n - 1) / 2;
  const ym = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  ys.forEach((y, i) => {
    sxy += (i - xm) * (y - ym);
    sxx += (i - xm) ** 2;
  });
  return sxy / sxx;
};
