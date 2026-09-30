// 本目录专用的 data.json 累加器：多个脚本跑完合并成一份机器可读数据。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "data.json");

export function save(key: string, value: unknown): void {
  mkdirSync(HERE, { recursive: true });
  const all = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf-8")) : {};
  all[key] = value;
  writeFileSync(FILE, JSON.stringify(all, null, 2), "utf-8");
  console.log(`   → data.json["${key}"] 已写入`);
}

/** 整段原文保留（不截断），用于贴进 FINDINGS 的 error 串 */
export function raw(e: unknown): string {
  const err = e as Error;
  return err?.stack ? `${err.name}: ${err.message}\n      at ${(err.stack.split("\n")[1] ?? "").trim()}` : String(e);
}
