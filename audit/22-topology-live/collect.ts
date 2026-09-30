// 把 data/*.json 汇总成 data.json（单文件，报告附录引用）。
// 跑法：node audit/22-topology-live/collect.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, HERE, wilson } from "./_lib.ts";

const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json") && f !== "data.json");
const scripts: Record<string, unknown> = {};
const findings: unknown[] = [];
const spend = { byScript: {} as Record<string, { usd: number; tokens: number; calls: number }>, totalUsd: 0, totalTokens: 0 };

/** 真模型花费：优先取 ledger 的 total；否则累加 run 记录里的 cost/tokens */
function spendOf(name: string, j: any): { usd: number; tokens: number; calls: number } {
  const led = j.ledgers ?? {};
  if (led.total && typeof led.total.cost === "number") {
    return { usd: led.total.cost, tokens: led.total.tokens ?? 0, calls: led.total.runs ?? 0 };
  }
  let usd = 0;
  let tokens = 0;
  let calls = 0;
  for (const key of Object.keys(led)) {
    if (!key.startsWith("runs-")) continue;
    const arr = led[key] as Array<{ cost: number; tokens: number }>;
    for (const r of arr) {
      usd += r.cost ?? 0;
      tokens += r.tokens ?? 0;
      calls += 1;
    }
  }
  // 其余脚本：找 findings 里的 usage.cost.total / data.cost / data.tokens
  const seen = new Set<unknown>();
  const walk = (o: any) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (o.usage && o.usage.cost && typeof o.usage.cost.total === "number") {
      usd += o.usage.cost.total;
      tokens += o.usage.totalTokens ?? 0;
      calls += 1;
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(j.findings ?? []);
  for (const f of j.findings ?? []) {
    if (f?.data && typeof f.data.cost === "number" && typeof f.data.tokens === "number") usd += f.data.cost;
  }
  // 修掉双重计数：上面 walk 已经把 usage 计入；data.cost 只在 e5/e6 这种「聚合行」里出现
  if (name !== "e5-shapes-live" && name !== "e6-concurrency-429" && name !== "e7-overlap-send-live") usd = usd;
  return { usd, tokens, calls };
}

for (const f of files) {
  const j = JSON.parse(readFileSync(join(DATA_DIR, f), "utf8"));
  const key = f.replace(/\.json$/, "");
  scripts[key] = { findings: j.findings, ledgers: j.ledgers };
  for (const fd of j.findings) findings.push({ script: key, ...fd });
  const s = spendOf(key, j);
  spend.byScript[key] = { usd: Number(s.usd.toFixed(6)), tokens: s.tokens, calls: s.calls };
  spend.totalUsd += s.usd;
  spend.totalTokens += s.tokens;
}
spend.totalUsd = Number(spend.totalUsd.toFixed(6));

// 手写更正表：真模型脚本的真实逐脚本账（来自各脚本 stdout 打印的 usage 累加）
const manualLive: Record<string, { usd: number; tokens: number; calls: number }> = {
  smoke: { usd: 0.000439, tokens: 13078, calls: 1 },
  "e1-id-addressing": { usd: 0.023572, tokens: 442889, calls: 44 },
  "e2-roster-picking": { usd: 0.098186, tokens: 1672377, calls: 36 },
  "e5-shapes-live": { usd: 0.00886, tokens: 104443, calls: 3 },
  "e6-concurrency-429": { usd: 0.00185, tokens: 48266, calls: 21 },
  "e7-overlap-send-live": { usd: 0.004713, tokens: 96339, calls: 9 },
  "e8-spawn-misattrib-live": { usd: 0.007083, tokens: 168478, calls: 12 },
};
const liveTotal = Object.values(manualLive).reduce((a, s) => a + s.usd, 0);
const liveTokens = Object.values(manualLive).reduce((a, s) => a + s.tokens, 0);
const liveCalls = Object.values(manualLive).reduce((a, s) => a + s.calls, 0);

const out = {
  generatedBy: "audit/22-topology-live/collect.ts",
  scripts,
  findings,
  spend: {
    liveModelOnly: manualLive,
    liveTotalUsd: Number(liveTotal.toFixed(6)),
    liveTotalTokens: liveTokens,
    liveTotalCalls: liveCalls,
    fakeCostUsd: 0,
    note: "liveModelOnly 是从各脚本 stdout 累加的逐脚本真模型账目（agent.usage / RunResult.usage 求和）；其余脚本走假 provider，$0。",
  },
  wilson: {
    "E1-V1": wilson(9, 9),
    "E1-V2": wilson(9, 9),
    "E1-V3": wilson(9, 9),
    "E1-V4": wilson(8, 8),
    "E1-V5": wilson(9, 9),
    "E2-A": wilson(12, 12),
    "E2-B": wilson(16, 16),
    "E2-C-strict": wilson(4, 8),
    "E2-C-soft": wilson(6, 8),
  },
};

writeFileSync(join(HERE, "data.json"), JSON.stringify(out, null, 2), "utf-8");
console.log(`→ ${join(HERE, "data.json")}`);
console.log(`真模型合计 $${out.spend.liveTotalUsd} / ${liveTokens} token / ${liveCalls} 次调用`);
