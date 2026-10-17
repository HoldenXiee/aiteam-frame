// 验证 exposure 各值：谁能进活跃集、能否被 ctx.executeTool 调到
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent } from "../examples/lib/harness.ts";

const mk = (name: string, exposure?: any) => defineTool({
  name, label: name, description: `测试 ${name}`,
  parameters: Type.Object({}),
  ...(exposure ? { exposure } : {}),
  execute: async () => ({ content: [{ type: "text" as const, text: `${name}-ran` }], details: {} }),
});

const VALUES = ["direct", "model-only", "codemode", "deferred", "hidden"];

for (const v of VALUES) {
  const a = await makeOfflineAgent({ tools: { custom: [mk("probe_" + v.replace("-", ""), v)] } });
  const active = a.io.raw.getActiveToolNames();
  const name = "probe_" + v.replace("-", "");
  console.log(`exposure="${v}"`.padEnd(22), "在活跃集？", active.includes(name) ? "✓" : "✗");
  a.dispose();
}

// hidden 能不能被 ctx.executeTool 调到？
console.log("\n=== hidden 工具：模型看不到，外层能否调用 ===");
const hidden = mk("secret_step", "hidden");
const outer = defineTool({
  name: "call_secret", label: "CallSecret", description: "调 hidden 工具",
  parameters: Type.Object({}),
  execute: async (_id, _p, _s, _u, ctx) => {
    console.log("    ctx.tools =", ctx.tools.map((t:any)=>t.name).join(", "));
    const out: any = await ctx.executeTool("secret_step", {});
    console.log("    isError =", out.isError, "| result =", JSON.stringify(out.result).slice(0,100));
    return { content: [{ type: "text" as const, text: `outer 收到: ${JSON.stringify(out).slice(0, 120)}` }], details: {} };
  },
});
const a = await makeOfflineAgent({ tools: { custom: [hidden, outer] } });
console.log("  活跃集:", a.io.raw.getActiveToolNames().join(", "));
console.log("  ctx.tools 可调用:", (await a.io.prompt("[[tool:call_secret]] 调它")).text.slice(0, 200));
a.dispose();
