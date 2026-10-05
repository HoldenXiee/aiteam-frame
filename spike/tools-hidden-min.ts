// 最小复现：hidden 工具能否被 ctx.executeTool 调到？变量分别控制
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent } from "../examples/lib/harness.ts";

async function trial(label: string, hiddenExposure: any, hiddenParams: any, callArgs: any) {
  const inner = defineTool({
    name: "inner", label: "inner", description: "内部步骤",
    ...(hiddenExposure ? { exposure: hiddenExposure } : {}),
    parameters: hiddenParams,
    execute: async (_id, p) => ({ content: [{ type: "text" as const, text: `inner(${JSON.stringify(p)})` }], details: {} }),
  });
  const outer = defineTool({
    name: "outer", label: "outer", description: "外层",
    parameters: Type.Object({}),
    execute: async (_id, _p, _s, _u, ctx) => {
      const out: any = await ctx.executeTool("inner", callArgs);
      return { content: [{ type: "text" as const, text: `isError=${out.isError} ${JSON.stringify(out.result?.content?.[0]?.text ?? out.result).slice(0, 60)}` }], details: {} };
    },
  });
  const a = await makeOfflineAgent({ tools: { custom: [inner, outer] } });
  const r = await a.io.prompt("[[tool:outer]] 调");
  console.log(`${label.padEnd(46)} → ${r.text.replace(/^echo:/, "").slice(0, 90)}`);
  a.dispose();
}

await trial("exposure=hidden + ctx.executeTool(args)", "hidden", Type.Object({ n: Type.Number() }), { n: 1 });
await trial("exposure=hidden + args={}", "hidden", Type.Object({ n: Type.Number() }), {});
await trial("无 exposure + ctx.executeTool(args)", undefined, Type.Object({ n: Type.Number() }), { n: 1 });
await trial("exposure=direct + ctx.executeTool(args)", "direct", Type.Object({ n: Type.Number() }), { n: 1 });
