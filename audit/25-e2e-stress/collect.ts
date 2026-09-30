// 把本项目所有 data-*.json + 被丢弃的中间跑汇总成单个 data.json（机器可读，报告附录用）。
// 跑法：node audit/25-e2e-stress/collect.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// 中途因我方脚本 bug 作废、但确实花了钱的跑（日志仍在，证据可查）
const DISCARDED = [
  { runId: "a-20260930155433", reason: "writer 的 cwd 未接线，落盘去了仓库根；结论有效但交付物缺失", cost: 0.020931 },
  { runId: "f2-first", reason: "slow_worker 用 tools:[] 导致 customTool 未挂上，慢探针没被调用；已被重跑取代", cost: 0.002204 },
  { runId: "s0-smoke", reason: "冒烟标定（两轮真模型调用，跑了两次，未存 json）", cost: 0.000463 },
];

const files = readdirSync(HERE).filter((f) => /^data-.*\.json$/.test(f) && f !== "data.json").sort();
const byName: Record<string, any> = {};
let cost = 0;
const ledger: Array<{ run: string; cost: number; note: string }> = [];

for (const f of files) {
  const j = JSON.parse(readFileSync(join(HERE, f), "utf-8"));
  byName[f] = j;
  let c = 0;
  let note = "";
  if (j.mode) { c = j.hostCost?.total ?? 0; note = `e2e 主跑（写法 ${j.mode}）`; }
  else if (j.scenarios) { c = j.totalCost ?? 0; note = "故障注入"; }
  else if (j.budget) { c = (typeof j.hostCost === "number" ? j.hostCost : (j.hostCost?.total ?? 0)) + (j.fallback?.attempts ?? []).reduce((a: number, x: any) => a + (x.costOutsideBudget ?? 0), 0); note = "紧预算"; }
  ledger.push({ run: f, cost: Number(c.toFixed(6)), note });
  cost += c;
}
for (const d of DISCARDED) {
  ledger.push({ run: d.runId, cost: d.cost, note: `（作废）${d.reason}` });
  cost += d.cost;
}

const out = { generatedFrom: files, ledger, measuredCostTotal: Number(cost.toFixed(6)), runs: byName };
writeFileSync(join(HERE, "data.json"), JSON.stringify(out, null, 2), "utf-8");
console.log(`汇总 ${files.length} 个 live 数据文件 + ${DISCARDED.length} 条作废账 → data.json`);
for (const l of ledger) console.log(`  ${l.run.padEnd(34)} $${l.cost.toFixed(6)}  ${l.note}`);
console.log(`实测总花费 $${out.measuredCostTotal}`);
