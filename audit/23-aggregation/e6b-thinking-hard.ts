// B9 进阶：换一道更难的计数题（要比较两个数字的出现次数），只跑有区分度的三档
// 跑法：node audit/23-aggregation/e6b-thinking-hard.ts
// 正解 304598（脚本自带暴力校验）
import { pool, runOnce, saveSection, section, type Spending } from "./_rec.ts";

const spend: Spending = { cost: 0, tokens: 0, calls: 0 };
const N = Number(process.env.N ?? 4);
const ANSWER = 304598;

function brute(): number {
  let c = 0;
  for (let i = 1; i <= 1_000_000; i++) {
    const s = String(i);
    if ((s.match(/7/g) ?? []).length > (s.match(/3/g) ?? []).length) c++;
  }
  return c;
}
const truth = brute();
if (truth !== ANSWER) throw new Error(`正解算错：${truth}`);

const PROMPT = [
  "在 1 到 1000000（含两端）之间，有多少个整数 n 满足：n 的十进制表示里，数字 7 出现的次数**严格多于**数字 3 出现的次数？",
  "请仔细推理。最后一行只输出答案数字本身（纯数字，不要千分位分隔符、不要单位）。",
].join("\n");

const LEVELS = ["low", "high", "max"] as const;

function extractAnswer(text: string): number | undefined {
  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].replace(/[,\s]/g, "").match(/\d{2,}/);
    if (m) return Number(m[0]);
  }
  const all = text.replace(/[,\s]/g, "").match(/\d{2,}/g);
  return all ? Number(all[all.length - 1]) : undefined;
}

section(`E9b 更难题 × 三档（${N} 次/档，正解 ${ANSWER}）`);
const rows = [];
for (const level of LEVELS) {
  const rs = await pool(Array.from({ length: N }, (_, i) => i), 2, async (i) => {
    const r = await runOnce(PROMPT, { thinking: level });
    spend.cost += r.usage.cost;
    spend.tokens += r.usage.totalTokens;
    spend.calls += 1;
    const got = extractAnswer(r.text);
    const row: Record<string, unknown> = {
      level,
      effective: r.thinkingEffective,
      i,
      got,
      correct: got === ANSWER,
      ms: r.ms,
      output: r.usage.output,
      totalTokens: r.usage.totalTokens,
      cost: r.usage.cost,
      chars: r.text.length,
      tail: r.text.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 60) ?? "",
      text: r.text,
      ...(r.error ? { error: r.error } : {}),
    };
    console.log(`  请求=${level.padEnd(4)} #${i + 1} ${row.ms}ms ${row.output}tok　答案=${got} ${row.correct ? "✓" : "✗"}`);
    return row as never;
  });
  rows.push(...rs);
}

const summary = Object.fromEntries(
  LEVELS.map((lv) => {
    const rs = rows.filter((r: any) => r.level === lv);
    const out = rs.map((r: any) => r.output as number);
    return [
      lv,
      {
        correct: rs.filter((r: any) => r.correct).length,
        runs: rs.length,
        answers: rs.map((r: any) => r.got),
        outputAvg: Math.round(out.reduce((a, b) => a + b, 0) / out.length),
        outputMax: Math.max(...out),
        msAvg: Math.round(rs.reduce((a: number, r: any) => a + r.ms, 0) / rs.length),
      },
    ];
  }),
);
console.log("\n汇总：");
for (const [k, v] of Object.entries(summary)) {
  console.log(`  ${k}：正确 ${v.correct}/${v.runs}　答案 ${JSON.stringify(v.answers)}　输出均 ${v.outputAvg}（最大 ${v.outputMax}）tok　均 ${v.msAvg}ms`);
}

saveSection("e6b-thinking-hard", { problem: PROMPT, answer: ANSWER, n: N, summary, rows }, spend);
