// A4 软约束 vs 硬约束：题目里写「必须只输出 JSON」 vs 用唯一可用工具强制提交
// 跑法：node audit/23-aggregation/e3-soft-hard.ts
import { Type } from "typebox";
import { defineAgentTool } from "../../src/index.ts";
import { pool, runOnce, saveSection, section, type Spending } from "./_rec.ts";

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

const SPEC = '{"findings":[{"id":"F1","severity":"low"|"medium"|"high","line":整数}]} —— findings 必须恰好 3 条';

/** 与 e1 的 S4 同一套字段校验 */
function checkFindings(v: any): string[] {
  const e: string[] = [];
  if (!v || typeof v !== "object") return ["不是对象"];
  if (!Array.isArray(v.findings)) return [`findings=${JSON.stringify(v.findings)}`];
  if (v.findings.length !== 3) e.push(`findings.length=${v.findings.length}`);
  v.findings.forEach((f: any, i: number) => {
    if (!f || typeof f !== "object") return e.push(`findings[${i}] 非对象`);
    if (typeof f.id !== "string") e.push(`findings[${i}].id`);
    if (!["low", "medium", "high"].includes(f.severity)) e.push(`findings[${i}].severity=${JSON.stringify(f.severity)}`);
    if (typeof f.line !== "number") e.push(`findings[${i}].line=${JSON.stringify(f.line)}`);
  });
  return e;
}

function analyze(raw: string) {
  const t = raw.trim();
  const cleaned = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    return { parsed: true as const, errors: checkFindings(obj), obj };
  } catch (e) {
    return { parsed: false as const, errors: [`未解析：${(e as Error).message.slice(0, 60)}`], obj: undefined };
  }
}

// ── 臂 A：软约束（纯文本里要求 JSON）─────────────────────────────
const softPrompt = [
  "你是一名代码评审员。请评审下面这个函数。",
  "**必须只输出一个 JSON 对象**，不要任何解释文字、不要 markdown 代码块。",
  `JSON 的字段要求：${SPEC}`,
  "",
  CODE,
].join("\n");

// ── 臂 B：硬约束（唯一可用工具就是提交工具，必须提交）────────────
// ── 臂 C：半硬（工具可用，但只用「请」提示）─────────────────────
const hardPrompt = [
  "你是一名代码评审员。请评审下面这个函数。",
  "你**必须调用 submit_review 工具**提交结果 —— 这是你唯一能把结果交给我的通道，不调用就等于没有回答。",
  `字段要求：${SPEC}`,
  "",
  CODE,
].join("\n");
const mildPrompt = [
  "你是一名代码评审员。请评审下面这个函数。",
  "请把结果通过 submit_review 工具提交。",
  `字段要求：${SPEC}`,
  "",
  CODE,
].join("\n");

interface Row {
  arm: string;
  i: number;
  ms: number;
  output: number;
  cost: number;
  totalTokens: number;
  toolCalls: number;
  paramsValid: number;
  paramsInvalid: number;
  textJsonOk: boolean;
  textJsonErrors: string[];
  err?: string;
  text: string;
  submissions: unknown[];
}

async function runArm(arm: string, prompt: string, i: number): Promise<Row> {
  const seen: { params: unknown; ok: boolean }[] = [];
  const tool = defineAgentTool({
    name: "submit_review",
    label: "提交评审",
    description: "提交结构化的代码评审结果（唯一的结果提交通道）",
    parameters: Type.Object({
      findings: Type.Array(
        Type.Object({ id: Type.String(), severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]), line: Type.Number() }),
      ),
    }),
    execute: async (params) => {
      seen.push({ params, ok: checkFindings(params).length === 0 });
      return { content: [{ type: "text" as const, text: "已记录" }], details: {} };
    },
  });
  const r = await runOnce(prompt, arm === "A-软约束" ? {} : { tools: ["submit_review"], customTools: [tool] });
  spend.cost += r.usage.cost;
  spend.tokens += r.usage.totalTokens;
  spend.calls += 1;
  const a = analyze(r.text);
  const row: Row = {
    arm,
    i,
    ms: r.ms,
    output: r.usage.output,
    cost: r.usage.cost,
    totalTokens: r.usage.totalTokens,
    toolCalls: seen.length,
    paramsValid: seen.filter((s) => s.ok).length,
    paramsInvalid: seen.filter((s) => !s.ok).length,
    textJsonOk: a.parsed && a.errors.length === 0,
    textJsonErrors: a.errors,
    submissions: seen.map((s) => s.params),
    ...(r.error ? { err: r.error } : {}),
    text: r.text,
  };
  console.log(
    `  ${arm} #${String(i + 1).padStart(2)} ${r.ms}ms ${r.usage.output}tok　工具调用 ${seen.length} 次（参数合格 ${row.paramsValid}）　文本 JSON 合格=${row.textJsonOk} ${a.errors[0] ?? ""}`,
  );
  return row;
}

section(`E4 软约束 vs 硬约束（每臂 ${N} 次）`);
const arms: Array<[string, string]> = [
  ["A-软约束", softPrompt],
  ["B-硬约束", hardPrompt],
  ["C-半硬", mildPrompt],
];
const rows: Row[] = [];
for (const [name, prompt] of arms) {
  const rs = await pool(Array.from({ length: N }, (_, i) => i), 2, (i) => runArm(name, prompt, i));
  rows.push(...rs);
}

const sum = (name: string) => {
  const rs = rows.filter((r) => r.arm === name);
  return {
    runs: rs.length,
    toolCalled: rs.filter((r) => r.toolCalls > 0).length,
    paramsValid: rs.filter((r) => r.paramsValid > 0).length,
    paramsAllValid: rs.filter((r) => r.toolCalls > 0 && r.paramsInvalid === 0).length,
    textJsonOk: rs.filter((r) => r.textJsonOk).length,
    avgMs: Math.round(rs.reduce((a, r) => a + r.ms, 0) / rs.length),
  };
};
const summary = Object.fromEntries(arms.map(([n]) => [n, sum(n)]));
console.log("\n汇总：");
for (const [k, v] of Object.entries(summary)) {
  console.log(
    `  ${k}: 工具被调用 ${v.toolCalled}/${v.runs}　工具参数合格 ${v.paramsValid}/${v.runs}（全部合格 ${v.paramsAllValid}）　文本里也有合格 JSON ${v.textJsonOk}/${v.runs}　均 ${v.avgMs}ms`,
  );
}

saveSection("e3-soft-hard", { spec: SPEC, n: N, summary, rows }, spend);
