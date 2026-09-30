// A1/A2 结构化输出的真实可靠性：大样本 + 逐级难化，找出最先失败的 schema。
// 跑法：node audit/23-aggregation/e1-json.ts        （真实花费，并发 2）
import { FLASH as _FLASH, pool, runOnce, saveSection, section, type RunOut, type Spending } from "./_rec.ts";
void _FLASH;

const spend: Spending = { cost: 0, tokens: 0, calls: 0 };

const CODE = [
  "function sum(nums) {",
  "  let t = 0;",
  "  for (const n of nums) t += n;",
  "  return t;",
  "}",
].join("\n");

interface Schema {
  id: string;
  /** 给模型看的字段说明 */
  spec: string;
  /** 返回错误列表，空数组 = 字段类型正确 */
  check: (v: any) => string[];
}

const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

const SCHEMAS: Schema[] = [
  {
    id: "S1-baseline",
    spec: '{"verdict":"pass"|"fail","reason":"一句话","confidence":0~1 的小数}',
    check: (v) => {
      const e: string[] = [];
      if (!["pass", "fail"].includes(v.verdict)) e.push(`verdict=${JSON.stringify(v.verdict)}`);
      if (!isStr(v.reason) || !v.reason) e.push(`reason=${JSON.stringify(v.reason)}`);
      if (!isNum(v.confidence) || v.confidence < 0 || v.confidence > 1) e.push(`confidence=${JSON.stringify(v.confidence)}`);
      return e;
    },
  },
  {
    id: "S2-中文枚举",
    spec: '{"结论":"通过"|"驳回","理由":"一句中文","置信度":0~1 的小数}',
    check: (v) => {
      const e: string[] = [];
      if (!["通过", "驳回"].includes(v.结论)) e.push(`结论=${JSON.stringify(v.结论)}`);
      if (!isStr(v.理由) || !v.理由) e.push(`理由=${JSON.stringify(v.理由)}`);
      if (!isNum(v.置信度) || v.置信度 < 0 || v.置信度 > 1) e.push(`置信度=${JSON.stringify(v.置信度)}`);
      return e;
    },
  },
  {
    id: "S3-嵌套对象",
    spec: '{"meta":{"model":"模型名","round":整数},"score":整数 0~100,"tags":["至少一个字符串"]}',
    check: (v) => {
      const e: string[] = [];
      if (!isObj(v.meta)) e.push(`meta=${JSON.stringify(v.meta)}`);
      else {
        if (!isStr(v.meta.model) || !v.meta.model) e.push(`meta.model=${JSON.stringify(v.meta.model)}`);
        if (!isNum(v.meta.round)) e.push(`meta.round=${JSON.stringify(v.meta.round)}`);
      }
      if (!isNum(v.score)) e.push(`score=${JSON.stringify(v.score)}`);
      if (!Array.isArray(v.tags) || v.tags.length < 1 || !v.tags.every(isStr)) e.push(`tags=${JSON.stringify(v.tags)}`);
      return e;
    },
  },
  {
    id: "S4-对象数组",
    spec: '{"findings":[{"id":"F1","severity":"low"|"medium"|"high","line":整数}]} —— findings 必须恰好 3 条',
    check: (v) => {
      const e: string[] = [];
      if (!Array.isArray(v.findings)) return [`findings=${JSON.stringify(v.findings)}`];
      if (v.findings.length !== 3) e.push(`findings.length=${v.findings.length}`);
      v.findings.forEach((f: any, i: number) => {
        if (!isObj(f)) return e.push(`findings[${i}] 非对象`);
        if (!isStr(f.id)) e.push(`findings[${i}].id=${JSON.stringify(f.id)}`);
        if (!["low", "medium", "high"].includes(f.severity)) e.push(`findings[${i}].severity=${JSON.stringify(f.severity)}`);
        if (!isNum(f.line)) e.push(`findings[${i}].line=${JSON.stringify(f.line)} (类型 ${typeof f.line})`);
      });
      return e;
    },
  },
  {
    id: "S5-类型压力",
    spec: '{"count":整数数字,"ratio":0~1 的小数,"label":"把 count 包成字符串","flag":true 或 false}',
    check: (v) => {
      const e: string[] = [];
      if (!isNum(v.count) || !Number.isInteger(v.count)) e.push(`count=${JSON.stringify(v.count)}`);
      if (!isNum(v.ratio) || v.ratio < 0 || v.ratio > 1) e.push(`ratio=${JSON.stringify(v.ratio)}`);
      if (!isStr(v.label)) e.push(`label=${JSON.stringify(v.label)}（要求字符串，实际 ${typeof v.label}）`);
      if (typeof v.flag !== "boolean") e.push(`flag=${JSON.stringify(v.flag)}`);
      return e;
    },
  },
  {
    id: "S6-可空字段",
    spec: '{"result":{"ok":true 或 false,"msg":"一句话"},"error":null 或字符串} —— 本题必定成功，所以 error 必须是 null',
    check: (v) => {
      const e: string[] = [];
      if (!isObj(v.result)) e.push(`result=${JSON.stringify(v.result)}`);
      else {
        if (typeof v.result.ok !== "boolean") e.push(`result.ok=${JSON.stringify(v.result.ok)}`);
        if (!isStr(v.result.msg)) e.push(`result.msg=${JSON.stringify(v.result.msg)}`);
      }
      if (v.error !== null) e.push(`error=${JSON.stringify(v.error)}（要求 null）`);
      return e;
    },
  },
  {
    id: "S7-长文本值",
    spec: '{"summary":"不少于 300 个汉字的中文总结","keywords":["至少 3 个关键词"]}',
    check: (v) => {
      const e: string[] = [];
      if (!isStr(v.summary)) e.push(`summary=${JSON.stringify(v.summary)}`);
      else {
        const cjk = (v.summary.match(/[\u4e00-\u9fa5]/g) ?? []).length;
        if (cjk < 300) e.push(`summary 汉字数=${cjk}（要求 >=300，总长 ${v.summary.length}）`);
      }
      if (!Array.isArray(v.keywords) || v.keywords.length < 3 || !v.keywords.every(isStr)) e.push(`keywords=${JSON.stringify(v.keywords)}`);
      return e;
    },
  },
  {
    id: "S8-深层混合",
    spec:
      '{"review":{"id":"R1","scores":{"security":0~10,"perf":0~10},"issues":[{"code":"字符串","sev":"P0"|"P1","detail":"一句话"}]},"verdict":"approve"|"reject","notes":null 或字符串} —— issues 至少 1 条',
    check: (v) => {
      const e: string[] = [];
      if (!isObj(v.review)) return [`review=${JSON.stringify(v.review)}`];
      if (!isStr(v.review.id)) e.push(`review.id=${JSON.stringify(v.review.id)}`);
      if (!isObj(v.review.scores)) e.push(`review.scores=${JSON.stringify(v.review.scores)}`);
      else {
        if (!isNum((v.review.scores as any).security)) e.push(`scores.security=${JSON.stringify((v.review.scores as any).security)}`);
        if (!isNum((v.review.scores as any).perf)) e.push(`scores.perf=${JSON.stringify((v.review.scores as any).perf)}`);
      }
      if (!Array.isArray(v.review.issues) || v.review.issues.length < 1) e.push(`review.issues=${JSON.stringify(v.review.issues)}`);
      else
        (v.review.issues as any[]).forEach((it, i) => {
          if (!isObj(it)) return e.push(`issues[${i}] 非对象`);
          if (!isStr(it.code)) e.push(`issues[${i}].code=${JSON.stringify(it.code)}`);
          if (!["P0", "P1"].includes(it.sev as string)) e.push(`issues[${i}].sev=${JSON.stringify(it.sev)}`);
          if (!isStr(it.detail)) e.push(`issues[${i}].detail=${JSON.stringify(it.detail)}`);
        });
      if (!["approve", "reject"].includes(v.verdict)) e.push(`verdict=${JSON.stringify(v.verdict)}`);
      if (!(v.notes === null || isStr(v.notes))) e.push(`notes=${JSON.stringify(v.notes)}`);
      return e;
    },
  },
];

const prompt = (s: Schema, extra: string) =>
  [
    "你是一名代码评审员。请评审下面这个函数，并且**只输出一个 JSON 对象**：不要任何解释文字、不要 markdown 代码块、不要在 JSON 前后加任何内容。",
    "",
    `JSON 的字段要求：${s.spec}`,
    extra,
    "",
    "被评审的代码：",
    CODE,
  ]
    .filter((l) => l !== undefined)
    .join("\n");

/** 把一次原始回复拆开：是否带围栏、去掉围栏后能否 parse、JSON 之外有没有散文 */
function analyze(raw: string) {
  const t = raw.trim();
  const hasFence = /```/.test(t);
  const cleaned = t
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let obj: any;
  let cleanedErr = "";
  try {
    obj = JSON.parse(cleaned);
  } catch (e) {
    cleanedErr = (e as Error).message.slice(0, 80);
  }
  let rawObj: any;
  try {
    rawObj = JSON.parse(t);
  } catch {
    rawObj = undefined;
  }
  const open = cleaned.indexOf("{");
  const close = cleaned.lastIndexOf("}");
  const prose = open >= 0 && close > open ? `${cleaned.slice(0, open)}|||${cleaned.slice(close + 1)}`.trim() : "";
  const hasProse = prose !== "|||" && prose !== "";
  return { hasFence, cleaned, obj, cleanedErr, rawParseOk: rawObj !== undefined, hasProse, prose: hasProse ? prose.slice(0, 120) : "" };
}

interface Row {
  id: string;
  i: number;
  ms: number;
  rawLen: number;
  hasFence: boolean;
  cleanupParseOk: boolean;
  rawParseOk: boolean;
  fieldErrors: string[];
  typeOfBad: boolean;
  hasProse: boolean;
  prose: string;
  err?: string;
  text: string;
  output: number;
  cost: number;
  totalTokens: number;
}

function ev(run: RunOut, i: number, s: Schema): Row {
  const a = analyze(run.text);
  const fieldErrors = a.obj !== undefined ? s.check(a.obj) : [`未解析：${a.cleanedErr}`];
  return {
    id: s.id,
    i,
    ms: run.ms,
    rawLen: run.text.length,
    hasFence: a.hasFence,
    cleanupParseOk: a.obj !== undefined,
    rawParseOk: a.rawParseOk,
    fieldErrors,
    typeOfBad: fieldErrors.some((e) => e.includes("类型")),
    hasProse: a.hasProse,
    prose: a.prose,
    ...(run.error ? { err: run.error } : {}),
    text: run.text,
    output: run.usage.output,
    cost: run.usage.cost,
    totalTokens: run.usage.totalTokens,
  };
}

section("E1 大样本：只输出 JSON（S1 baseline）20 次");
const N1 = Number(process.env.N1 ?? 20);
const rows1 = await pool(Array.from({ length: N1 }, (_, i) => i), 2, async (i) => ev(await runOnce(prompt(SCHEMAS[0], "")), i, SCHEMAS[0]));
for (const r of rows1) console.log(`  #${String(r.i + 1).padStart(2)} ${r.cleanupParseOk ? "parse-ok" : "PARSE-FAIL"} fence=${r.hasFence} prose=${r.hasProse} 字段错=${r.fieldErrors.length} ${r.ms}ms ${r.output}tok`);

section("E2 难化：S2..S8 各 5 次，找最先失败的 schema");
const rows: Row[] = [...rows1];
for (const s of SCHEMAS.slice(1)) {
  const rs = await pool([0, 1, 2, 3, 4], 2, async (i) => ev(await runOnce(prompt(s, "")), i, s));
  rows.push(...rs);
  const ok = rs.filter((r) => r.cleanupParseOk && r.fieldErrors.length === 0).length;
  console.log(`  ${s.id}: 完全合格 ${ok}/5　${rs.map((r) => (r.fieldErrors.length ? `[${r.fieldErrors[0]}]` : "ok")).join(" ")}`);
}

for (const r of rows) {
  spend.cost += r.cost;
  spend.tokens += r.totalTokens;
  spend.calls += 1;
}

const summarize = (id: string) => {
  const rs = rows.filter((r) => r.id === id);
  return {
    runs: rs.length,
    cleanupParseOk: rs.filter((r) => r.cleanupParseOk).length,
    rawParseOk: rs.filter((r) => r.rawParseOk).length,
    fence: rs.filter((r) => r.hasFence).length,
    prose: rs.filter((r) => r.hasProse).length,
    fieldPerfect: rs.filter((r) => r.cleanupParseOk && r.fieldErrors.length === 0).length,
    typedWrong: rs.filter((r) => r.typeOfBad).length,
    avgMs: Math.round(rs.reduce((a, r) => a + r.ms, 0) / rs.length),
    avgOut: Math.round(rs.reduce((a, r) => a + r.output, 0) / rs.length),
    examples: rs.slice(0, 2).map((r) => r.text.slice(0, 400)),
  };
};

const summary = Object.fromEntries(SCHEMAS.map((s) => [s.id, summarize(s.id)]));
console.log("\n汇总：");
for (const [k, v] of Object.entries(summary)) {
  console.log(`  ${k}: parseOk ${v.cleanupParseOk}/${v.runs}　字段全对 ${v.fieldPerfect}/${v.runs}　围栏 ${v.fence}　夹解说 ${v.prose}　类型错 ${v.typedWrong}　均 ${v.avgOut}out/${v.avgMs}ms`);
}

saveSection("e1-json", { summary, rows }, spend);
