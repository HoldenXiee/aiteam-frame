// A4 补充臂 D：题目说「只输出 JSON」，而环境里还挂着一个提交工具 —— 两套契约冲突时模型走哪条
// 跑法：node audit/23-aggregation/e3b-conflict.ts
import { Type } from "typebox";
import { defineAgentTool } from "../../src/index.ts";
import { pool, runOnce, saveSection, section, type Spending } from "./_rec.ts";

const spend: Spending = { cost: 0, tokens: 0, calls: 0 };
const N = Number(process.env.N ?? 10);

const CODE = ["async function loadAll(ids) {", "  const out = [];", "  for (const id of ids) out.push(await fetch(`/api/item/${id}`).then(r => r.json()));", "  return out;", "}"].join("\n");
const SPEC = '{"findings":[{"id":"F1","severity":"low"|"medium"|"high","line":整数}]} —— findings 必须恰好 3 条';

// 与 A 臂完全相同的措辞：只字不提工具
const PROMPT = [
  "你是一名代码评审员。请评审下面这个函数。",
  "**必须只输出一个 JSON 对象**，不要任何解释文字、不要 markdown 代码块。",
  `JSON 的字段要求：${SPEC}`,
  "",
  CODE,
].join("\n");

function check(v: any): string[] {
  const e: string[] = [];
  if (!v || !Array.isArray(v.findings)) return ["无 findings 数组"];
  if (v.findings.length !== 3) e.push(`length=${v.findings.length}`);
  v.findings.forEach((f: any, i: number) => {
    if (!["low", "medium", "high"].includes(f?.severity)) e.push(`[${i}].severity`);
    if (typeof f?.line !== "number") e.push(`[${i}].line`);
  });
  return e;
}

section(`E4b 契约冲突：说「只输出 JSON」，但挂着一个 submit_review 工具（N=${N}）`);
const rows = await pool(Array.from({ length: N }, (_, i) => i), 2, async (i) => {
  let calls = 0;
  let valid = 0;
  const tool = defineAgentTool({
    name: "submit_review",
    label: "提交评审",
    description: "提交结构化的代码评审结果",
    parameters: Type.Object({
      findings: Type.Array(
        Type.Object({ id: Type.String(), severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]), line: Type.Number() }),
      ),
    }),
    execute: async (p) => {
      calls += 1;
      if (check(p).length === 0) valid += 1;
      return { content: [{ type: "text" as const, text: "已记录" }], details: {} };
    },
  });
  const r = await runOnce(PROMPT, { tools: ["submit_review"], customTools: [tool] });
  spend.cost += r.usage.cost;
  spend.tokens += r.usage.totalTokens;
  spend.calls += 1;
  let textJson = false;
  let textJsonErr = "";
  const cleaned = r.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    textJson = check(JSON.parse(cleaned)).length === 0;
  } catch (e) {
    textJsonErr = (e as Error).message.slice(0, 60);
  }
  console.log(`  #${String(i + 1).padStart(2)} ${r.ms}ms ${r.usage.output}tok　工具调用 ${calls} 次（合格 ${valid}）　文本 JSON 合格=${textJson} ${textJsonErr}`);
  return { i, ms: r.ms, output: r.usage.output, cost: r.usage.cost, totalTokens: r.usage.totalTokens, toolCalls: calls, toolValid: valid, textJsonOk: textJson, textJsonErr, text: r.text };
});

const toolRoute = rows.filter((r) => r.toolValid > 0).length;
const textRoute = rows.filter((r) => r.textJsonOk).length;
const neither = rows.filter((r) => r.toolValid === 0 && !r.textJsonOk).length;
const both = rows.filter((r) => r.toolValid > 0 && r.textJsonOk).length;
console.log(`\n走工具 ${toolRoute}/${N}　走文本 ${textRoute}/${N}　两边都合格 ${both}　两边都不合格 ${neither}`);

saveSection("e3b-conflict", { n: N, toolRoute, textRoute, both, neither, summary: { toolRoute, textRoute, both, neither }, rows }, spend);
