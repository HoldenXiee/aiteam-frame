import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent } from "../src/index.ts";
import { startFaux, sleep } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);

// 假 provider 下让模型调 submit：脚本 [[tool:submit]]
let submitted: unknown = null;
const submit = defineTool({
  name: "submit", label: "Submit", description: "提交结构化结果",
  parameters: Type.Object({ verdict: Type.String() }),
  execute: async (_id, p) => { submitted = p; return { content: [{ type: "text" as const, text: "已收" }], details: {} }; },
});
const a = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir, tools: ["submit"], customTools: [submit] }, { modelRuntime: made.runtime });
const r = await a.prompt('[[tool:submit]] [[args:{"verdict":"pass"}]]');
await sleep(200);
console.log(`  工具收到参数         = ${JSON.stringify(submitted)}`);
console.log(`  RunResult.text       = ${JSON.stringify(r.text)}`);
console.log(`  RunResult.usage      = ${r.usage.totalTokens}`);
console.log(`  设计者能从 RunResult 拿到结构化结果吗：${r.text.includes("pass") ? "能" : "**不能（只在工具闭包里）**"}`);
console.log(`  但可以用 details / 闭包变量兜住：工具闭包里 submitted=${JSON.stringify(submitted)}`);
a.dispose();
await faux.close();
