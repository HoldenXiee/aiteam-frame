// 验证 promptGuidelines 在 system 里的确切位置
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent } from "../examples/lib/harness.ts";

const t = defineTool({
  name: "guided", label: "Guided", description: "带 guidelines 的工具",
  promptGuidelines: ["GUIDELINE-XYZ 这是指引"],
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
});
const a = await makeOfflineAgent({ tools: { custom: [t] } });
const sys = a.io.raw.systemPrompt;
const i = sys.indexOf("GUIDELINE-XYZ");
console.log("位置:", i, "/", sys.length);
console.log("--- 上下文 600 字 ---");
console.log(sys.slice(Math.max(0, i - 500), i + 200));
a.dispose();
