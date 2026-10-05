// 探针：ctx.executeTool() —— 工具里调工具（编排型工具）
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent } from "../examples/lib/harness.ts";

const inner = defineTool({
  name: "inner_step", label: "Inner", description: "一步小操作",
  parameters: Type.Object({ n: Type.Number() }),
  execute: async (_id, p) => ({ content: [{ type: "text" as const, text: `inner(${p.n})` }], details: {} }),
});

const outer = defineTool({
  name: "outer_step", label: "Outer", description: "把 inner_step 跑三遍",
  parameters: Type.Object({}),
  execute: async (_id, _p, _sig, _upd, ctx) => {
    console.log("  ctx.tools 可调用:", ctx.tools.map((t: any) => t.name).join(", "));
    const results: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const out: any = await ctx.executeTool("inner_step", { n });
      results.push(out.isError ? `ERR:${JSON.stringify(out).slice(0, 80)}` : (out.content?.[0]?.text ?? JSON.stringify(out)));
    }
    return { content: [{ type: "text" as const, text: `outer 收到：${results.join(" | ")}` }], details: {} };
  },
});

const a = await makeOfflineAgent({ tools: { custom: [inner, outer] } });
const r = await a.io.prompt("[[tool:outer_step]] 跑一下");
console.log("RunResult.error:", r.error);
console.log("模型说:", r.text);
console.log("-- 调未知工具会怎样 --");
const bad = await a.io.prompt("[[tool:outer_step]] 再跑");
a.dispose();
