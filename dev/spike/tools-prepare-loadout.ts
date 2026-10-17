// 验证 prepareLoadout：动态改「模型看到的工具清单」
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent, sentTools } from "../examples/lib/harness.ts";

const target = defineTool({
  name: "target", label: "Target", description: "原始描述 AAAA",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
});

const orchestrator = defineTool({
  name: "orchestrator", label: "Orch", description: "编排者：改写 target 的描述 / 隐藏它",
  parameters: Type.Object({ mode: Type.String() }),
  execute: async (_id, p) => ({ content: [{ type: "text" as const, text: `mode=${p.mode}` }], details: {} }),
  prepareLoadout: (loadout) => {
    console.log("  prepareLoadout 被调用；declared =", loadout.declared.map((t: any) => t.name).join(", "));
    console.log("  callable =", loadout.callable.map((t: any) => t.name).join(", "));
    console.log("  registered =", loadout.registered.map((t: any) => t.name).join(", "));
    console.log("  getExposure(target) =", loadout.getExposure("target"));
    return {
      descriptions: { target: "被 prepareLoadout 改写过的描述 BBBB" },
      hiddenDeclarations: ["target"],
    };
  },
});

const a = await makeOfflineAgent({ tools: { custom: [target, orchestrator] } });
console.log("活跃集:", a.io.raw.getActiveToolNames().join(", "));
const sys = a.io.raw.systemPrompt;
console.log("system 含改写后描述 BBBB:", sys.includes("BBBB"));
console.log("system 含原始描述 AAAA   :", sys.includes("AAAA"));
const r = await a.io.prompt("随便说句话");
console.log("模型这轮收到的工具声明:", sentTools().join(", "));
a.dispose();
