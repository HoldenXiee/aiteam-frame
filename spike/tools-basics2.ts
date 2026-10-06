// 工厂式工具、signal、以及「同一个工具定义给两个 agent」
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent } from "../examples/lib/harness.ts";
import { defineTool as dt } from "@earendil-works/pi-coding-agent";

// ① 工厂式：拿得到 ctx.agent
const factoryTool = (ctx: { agent: { id: string } }) =>
  defineTool({
    name: "whoami", label: "WhoAmI", description: "报告自己是哪个 agent",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: `agent id = ${ctx.agent.id}` }], details: {} }),
  });

const a1 = await makeOfflineAgent({ id: "alpha", tools: { custom: [factoryTool] } });
const a2 = await makeOfflineAgent({ id: "beta", tools: { custom: [factoryTool] } });
console.log("① 工厂式（同一份定义给两个 agent）:");
console.log("   alpha:", (await a1.io.prompt("[[tool:whoami]] 你是谁")).text.replace(/^echo:/, ""));
console.log("   beta :", (await a2.io.prompt("[[tool:whoami]] 你是谁")).text.replace(/^echo:/, ""));
a1.dispose(); a2.dispose();

// ② signal：abort 后工具还继续跑吗？
let sawAbort = false;
const slow = dt({
  name: "slow", label: "Slow", description: "慢工具，观察 signal",
  parameters: Type.Object({}),
  execute: async (_id, _p, signal) => {
    for (let i = 1; i <= 30; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (signal?.aborted) { sawAbort = true; return { content: [{ type: "text" as const, text: `在第 ${i} 步看到 abort` }], details: {} }; }
    }
    return { content: [{ type: "text" as const, text: "跑完了" }], details: {} };
  },
});
const a3 = await makeOfflineAgent({ tools: { custom: [slow] } });
const p = a3.io.prompt("[[tool:slow]] 跑").catch(() => {});
await new Promise((r) => setTimeout(r, 400));
await a3.io.abort();
await p;
console.log("\n② signal 在 abort 后可见:", sawAbort);
a3.dispose();
