// 04-guards 专用极简记录器：独立落盘 audit/04-guards/data.json，不碰共享 findings/。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data.json");

export interface F {
  id: string;
  question: string;
  observed: string;
  verdict: "OK" | "GAP" | "PARTIAL" | "INFO";
  conclusion: string;
  data?: unknown;
}

export function section(t: string): void {
  console.log(`\n\x1b[1m═══ ${t} ═══\x1b[0m`);
}

export function rec(exp: string, f: F): void {
  console.log(`\x1b[36m[${f.verdict}]\x1b[0m ${f.id} ${f.question}`);
  console.log(`  现象：${f.observed}`);
  console.log(`  结论：${f.conclusion}`);
  save(exp, f);
}

/** 每个实验一个 key，重复跑覆盖 */
function save(exp: string, f: F): void {
  const all: Record<string, F[]> = existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf-8")) : {};
  const arr = all[exp] ?? [];
  const i = arr.findIndex((x) => x.id === f.id);
  if (i >= 0) arr[i] = f;
  else arr.push(f);
  all[exp] = arr;
  writeFileSync(DATA, JSON.stringify(all, null, 2), "utf-8");
}

export function note(exp: string, f: F): void {
  save(exp, f);
  console.log(`\x1b[36m[note ${f.id}]\x1b[0m ${f.observed}`);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
