// 本轮共用的 data.json 累加器：每个脚本 save(键, 值)，最后合成一份。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "data.json");

export function save(key: string, value: unknown): void {
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(FILE, "utf-8"));
  } catch {
    /* 首次运行没有文件 */
  }
  all[key] = value;
  writeFileSync(FILE, JSON.stringify(all, null, 2), "utf-8");
  console.log(`\n→ data.json[${key}] 已写入（${JSON.stringify(value).length} 字节）`);
}

/** 事件收集器：订阅全部事件并计数 */
export function spy(agent: any): { counts: Record<string, number>; log: string[] } {
  const counts: Record<string, number> = {};
  const log: string[] = [];
  for (const ev of ["text", "thinking", "tool_start", "tool_end", "turn", "error", "done"] as const) {
    counts[ev] = 0;
    agent.on(ev, (p: any) => {
      counts[ev] += 1;
      if (ev !== "text" && ev !== "thinking") log.push(`${ev}:${JSON.stringify(p).slice(0, 200)}`);
    });
  }
  return { counts, log };
}
