// B7 真模型方差：同输入跑 10 次，量化文本/token/耗时抖动
// 跑法：node audit/23-aggregation/e4b-live-variance.ts
import { createHash } from "node:crypto";
import { pool, runOnce, saveSection, section, type Spending } from "./_rec.ts";

const spend: Spending = { cost: 0, tokens: 0, calls: 0 };
const N = Number(process.env.N ?? 10);
const PROMPT = "用不超过 80 个汉字解释「幂等」（idempotent）在 HTTP 接口里的含义。只给解释，不要标题、不要列表。";
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

section(`E6 真模型：同输入 ${N} 次，产出/token/耗时方差`);
const rows = await pool(Array.from({ length: N }, (_, i) => i), 2, async (i) => {
  const r = await runOnce(PROMPT);
  spend.cost += r.usage.cost;
  spend.tokens += r.usage.totalTokens;
  spend.calls += 1;
  const row = {
    i,
    sha: h(r.text),
    chars: r.text.length,
    ms: r.ms,
    input: r.usage.input,
    output: r.usage.output,
    cacheRead: r.usage.cacheRead,
    totalTokens: r.usage.totalTokens,
    cost: r.usage.cost,
    text: r.text,
    ...(r.error ? { error: r.error } : {}),
  };
  console.log(`  #${String(i + 1).padStart(2)} sha=${row.sha}　${row.chars}字　${row.ms}ms　out=${row.output}tok in=${row.input} cache=${row.cacheRead} total=${row.totalTokens}`);
  return row;
});

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { min: s[0], max: s[s.length - 1], med: mid, range: s[s.length - 1] - s[0], ratio: Number((s[s.length - 1] / Math.max(1, s[0])).toFixed(2)) };
};

const summary = {
  distinctTexts: new Set(rows.map((r) => r.sha)).size,
  chars: stat(rows.map((r) => r.chars)),
  ms: stat(rows.map((r) => r.ms)),
  output: stat(rows.map((r) => r.output)),
  totalTokens: stat(rows.map((r) => r.totalTokens)),
  cacheRead: stat(rows.map((r) => r.cacheRead)),
  cost: stat(rows.map((r) => r.cost)),
  samples: rows.slice(0, 4).map((r) => r.text.slice(0, 60)),
};
console.log(
  `\n文本去重 ${summary.distinctTexts}/${N}　字数 ${summary.chars.min}-${summary.chars.max}（中位 ${summary.chars.med}）`,
);
console.log(
  `耗时 ${summary.ms.min}-${summary.ms.max}ms（中位 ${summary.ms.med}，极差 ${summary.ms.range}ms = ${summary.ms.ratio}×）`,
);
console.log(
  `输出 token ${summary.output.min}-${summary.output.max}（中位 ${summary.output.med}，极差 ${summary.output.range}）　总 token ${summary.totalTokens.min}-${summary.totalTokens.max}（极差 ${summary.totalTokens.range} = ${summary.totalTokens.ratio}×）`,
);

saveSection("e4b-live-variance", { prompt: PROMPT, n: N, summary, rows }, spend);
