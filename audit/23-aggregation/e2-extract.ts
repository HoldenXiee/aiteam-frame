// A3 自由散文 + 事后正则抽取：不强制格式的代价有多大（复测既有报告的 2/5）
// 跑法：node audit/23-aggregation/e2-extract.ts
import { pool, runOnce, saveSection, section, type RunOut, type Spending } from "./_rec.ts";

const spend: Spending = { cost: 0, tokens: 0, calls: 0 };
const N = Number(process.env.N ?? 10);

const CODE = [
  "async function loadAll(ids) {",
  "  const out = [];",
  "  for (const id of ids) {",
  "    out.push(await fetch(`/api/item/${id}`).then(r => r.json()));",
  "  }",
  "  return out;",
  "}",
].join("\n");

// 故意不提任何格式要求（这正是「不强制格式」的实验条件）
const PROMPT = [
  "你是一名资深工程师。请评审下面这个函数，给出你的评分（0 到 10 分）和你的推荐结论（在方案A「保持现状」与方案B「改为并发+重试」之间选一个）。",
  "",
  CODE,
].join("\n");

// ── 既有报告 audit/08-aggregation.ts 用过的抽取器（原样复刻，作为对照基线）──
function scoreOfLegacy(text: string): number | undefined {
  const m = text.match(/"score"\s*:\s*(\d+)/) ?? text.match(/(\d+)\s*\/\s*10/);
  return m ? Number(m[1]) : undefined;
}
function labelOfLegacy(text: string): string | undefined {
  const m = text.match(/"label"\s*:\s*"([^"]+)"/);
  return m ? m[1] : undefined;
}
function extractJson(text: string): Record<string, unknown> | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const p: unknown = JSON.parse(m[0]);
    return p && typeof p === "object" ? (p as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ── 更宽容的抽取器（把「方案A/方案B」当标签、把 x/10 或「N 分」当分数）──
function scoreOfLoose(text: string): number | undefined {
  const m =
    text.match(/"score"\s*:\s*(\d+)/) ??
    text.match(/(\d+)\s*\/\s*10/) ??
    text.match(/评分[^\d]{0,6}(\d+)/) ??
    text.match(/(\d+)\s*分/);
  return m ? Number(m[1]) : undefined;
}
function labelOfLoose(text: string): string | undefined {
  const m = text.match(/"label"\s*:\s*"([^"]+)"/) ?? text.match(/方案\s*([A-Za-z])/);
  return m ? (/^[A-Za-z]$/.test(m[1]) ? `方案${m[1]}` : m[1]) : undefined;
}

interface Row {
  i: number;
  ms: number;
  output: number;
  cost: number;
  totalTokens: number;
  legacyScore?: number;
  legacyLabel?: string;
  looseScore?: number;
  looseLabel?: string;
  jsonParsed: boolean;
  text: string;
  err?: string;
}

section(`E3 自由散文 + 事后正则（N=${N}）`);
const rows: Row[] = await pool(
  Array.from({ length: N }, (_, i) => i),
  2,
  async (i) => {
    const r: RunOut = await runOnce(PROMPT);
    spend.cost += r.usage.cost;
    spend.tokens += r.usage.totalTokens;
    spend.calls += 1;
    const ls = scoreOfLegacy(r.text);
    const ll = labelOfLegacy(r.text);
    const os = scoreOfLoose(r.text);
    const ol = labelOfLoose(r.text);
    const row: Row = {
      i,
      ms: r.ms,
      output: r.usage.output,
      cost: r.usage.cost,
      totalTokens: r.usage.totalTokens,
      ...(ls !== undefined ? { legacyScore: ls } : {}),
      ...(ll !== undefined ? { legacyLabel: ll } : {}),
      ...(os !== undefined ? { looseScore: os } : {}),
      ...(ol !== undefined ? { looseLabel: ol } : {}),
      jsonParsed: extractJson(r.text) !== undefined,
      text: r.text,
      ...(r.error ? { err: r.error } : {}),
    };
    console.log(
      `  #${String(i + 1).padStart(2)} ${r.ms}ms ${r.usage.output}tok　旧抽取 score=${row.legacyScore} label=${row.legacyLabel}　宽松抽取 score=${row.looseScore} label=${row.looseLabel}`,
    );
    return row;
  },
);

const legacyBoth = rows.filter((r) => r.legacyScore !== undefined && r.legacyLabel !== undefined).length;
const legacyAny = rows.filter((r) => r.legacyScore !== undefined || r.legacyLabel !== undefined).length;
const looseBoth = rows.filter((r) => r.looseScore !== undefined && r.looseLabel !== undefined).length;
const looseAny = rows.filter((r) => r.looseScore !== undefined || r.looseLabel !== undefined).length;

console.log(
  `\n旧抽取器（audit/08 原样）：两个字段都拿到 ${legacyBoth}/${N}；至少拿到一个 ${legacyAny}/${N}；带 JSON 的 ${rows.filter((r) => r.jsonParsed).length}/${N}`,
);
console.log(`宽松抽取器：两个字段都拿到 ${looseBoth}/${N}；至少拿到一个 ${looseAny}/${N}`);

saveSection(
  "e2-extract",
  {
    prompt: PROMPT,
    n: N,
    legacy: { both: legacyBoth, any: legacyAny, jsonParsed: rows.filter((r) => r.jsonParsed).length },
    loose: { both: looseBoth, any: looseAny },
    rows,
  },
  spend,
);
