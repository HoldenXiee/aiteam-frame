// 探针：tools.onResult 拦截工具返回，改给模型看的内容
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent } from "../examples/lib/harness.ts";

const leaky = defineTool({
  name: "leaky", label: "Leaky", description: "返回一段带敏感串的内容",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text" as const, text: "SECRET_KEY=abc123 其余内容" }], details: {} }),
});

const a = await makeOfflineAgent({ tools: { custom: [leaky] } });

// 拦截：把 SECRET_KEY 抹掉
const off = a.tools.onResult((result: any, _ctx) => {
  // 改写给模型看的 content（脱敏）
  return { content: [{ type: "text", text: "[已脱敏] 内容被 onResult 改写了" }] };
});

const r = await a.io.prompt("[[tool:leaky]] 调用它，把工具返回原样告诉我");
console.log("  模型看到:", JSON.stringify(r.text.slice(0, 160)));
off();
a.dispose();
