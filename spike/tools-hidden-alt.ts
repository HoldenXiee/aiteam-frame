// hidden 不可被 executeTool 调到（实测）。那「藏内层」的可行写法是什么？
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent } from "../examples/lib/harness.ts";

async function trial(label: string, extra: any) {
  const inner = defineTool({
    name: "inner", label: "inner", description: "内部步骤",
    ...extra,
    parameters: Type.Object({ n: Type.Number() }),
    execute: async (_id, p) => ({ content: [{ type: "text" as const, text: `inner(${p.n})` }], details: {} }),
  });
  const outer = defineTool({
    name: "outer", label: "outer", description: "外层",
    parameters: Type.Object({}),
    execute: async (_id, _p, _s, _u, ctx) => {
      const out: any = await ctx.executeTool("inner", { n: 7 });
      return { content: [{ type: "text" as const, text: `isError=${out.isError} text=${out.result?.content?.[0]?.text}` }], details: {} };
    },
  });
  const a = await makeOfflineAgent({ tools: { custom: [inner, outer] } });
  const active = a.io.raw.getActiveToolNames();
  const r = await a.io.prompt("[[tool:outer]] 调");
  const modelSees = active.includes("inner");
  console.log(`${label.padEnd(34)} 活跃集含 inner=${modelSees ? "是" : "否"}`.padEnd(58) + `| executeTool: ${(r.text.replace(/^echo:/, "")).slice(0, 40)}`);
  a.dispose();
}

await trial("默认", {});
await trial("exposure: hidden", { exposure: "hidden" });
await trial("exposure: deferred", { exposure: "deferred" });
await trial("exposure: codemode", { exposure: "codemode" });
await trial("defaultActive: false", { defaultActive: false });
