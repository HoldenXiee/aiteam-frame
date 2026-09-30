// B9 thinking 对真实生成质量的影响：一道需要真推理的计数题，四档各 5 次
// 跑法：node audit/23-aggregation/e6-thinking.ts
// 正解 66969（脚本自带暴力校验，见文件末）
import { pool, runOnce, saveSection, section, type Spending } from "./_rec.ts";

const spend: Spending = { cost: 0, tokens: 0, calls: 0 };
const N = Number(process.env.N ?? 5);
const ANSWER = 66969;

// 暴力核对正解（1..1e6：十进制表示里 7 恰好出现两次，且不含 0）
function brute(): number {
  let c = 0;
  for (let i = 1; i <= 1_000_000; i++) {
    const s = String(i);
    if ((s.match(/7/g) ?? []).length === 2 && !s.includes("0")) c++;
  }
  return c;
}
const truth = brute();
if (truth !== ANSWER) throw new Error(`正解算错：${truth}`);

const PROMPT = [
  "在 1 到 1000000（含两端）之间，有多少个整数满足下面两个条件：",
  "(a) 它的十进制表示里数字 7 恰好出现两次；",
  "(b) 它的十进制表示里不含数字 0。",
  "请仔细推理，最后一行只输出答案数字本身（纯数字，不要千分位分隔符、不要单位）。",
].join("\n");

const LEVELS = ["off", "low", "high", "max"] as const;

function extractAnswer(text: string): number | undefined {
  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].replace(/[,\s]/g, "").match(/\d{2,}/);
    if (m) return Number(m[0]);
  }
  const all = text.replace(/[,\s]/g, "").match(/\d{2,}/g);
  return all ? Number(all[all.length - 1]) : undefined;
}

section(`E9 thinking 四档 × 难题（${N} 次/档，正解 ${ANSWER}）`);
const rows = [];
for (const level of LEVELS) {
  const rs = await pool(Array.from({ length: N }, (_, i) => i), 2, async (i) => {
    const r = await runOnce(PROMPT, { thinking: level });
    spend.cost += r.usage.cost;
    spend.tokens += r.usage.totalTokens;
    spend.calls += 1;
    const got = extractAnswer(r.text);
    const row = {
      level,
      effective: r.thinkingEffective,
      i,
      got,
      correct: got === ANSWER,
      ms: r.ms,
      output: r.usage.output,
      totalTokens: r.usage.totalTokens,
      cost: r.usage.cost,
      tail: r.text.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 60) ?? "",
      text: r.text,
      ...(r.error ? { error: r.error } : {}),
    };
    console.log(`  请求=${level.padEnd(4)} 实际档=${row.effective.padEnd(5)} #${i + 1} ${row.ms}ms ${row.output}tok　答案=${got} ${row.correct ? "✓" : "✗"}`);
    return row;
  });
  rows.push(...rs);
}

const summary = Object.fromEntries(
  LEVELS.map((lv) => {
    const rs = rows.filter((r) => r.level === lv);
    const out = rs.map((r) => r.output);
    return [
      lv,
      {
        effective: rs[0]?.effective,
        correct: rs.filter((r) => r.correct).length,
        runs: rs.length,
        outputAvg: Math.round(out.reduce((a, b) => a + b, 0) / out.length),
        outputMin: Math.min(...out),
        outputMax: Math.max(...out),
        msAvg: Math.round(rs.reduce((a, r) => a + r.ms, 0) / rs.length),
        answers: rs.map((r) => r.got),
      },
    ];
  }),
);
console.log("\n汇总：");
for (const [k, v] of Object.entries(summary)) {
  console.log(`  请求 ${k} → 实际 ${v.effective}：正确 ${v.correct}/${v.runs}　答案 ${JSON.stringify(v.answers)}　输出 ${v.outputMin}-${v.outputMax}（均 ${v.outputAvg}）tok　均 ${v.msAvg}ms`);
}

saveSection("e6-thinking", { problem: PROMPT, answer: ANSWER, n: N, summary, rows }, spend);
