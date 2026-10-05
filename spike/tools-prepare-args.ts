// 探针：prepareArguments（参数兼容层）、executionMode、defaultActive、annotations
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent } from "../examples/lib/harness.ts";

const compat = defineTool({
  name: "compat_tool", label: "Compat", description: "接受旧参数名",
  parameters: Type.Object({ query: Type.String() }),
  // 模型可能传 { q: "..." }（老写法），这里兜底
  prepareArguments: (args: unknown) => {
    const a = args as Record<string, unknown>;
    console.log("  prepareArguments 收到:", JSON.stringify(a));
    return { query: (a.query ?? a.q ?? "（空）") as string };
  },
  execute: async (_id, p) => ({ content: [{ type: "text" as const, text: `query=${p.query}` }], details: {} }),
});

const a = await makeOfflineAgent({ tools: { custom: [compat] } });
console.log("-- 传新参数名 --");
let r = await a.io.prompt('[[tool:compat_tool]] [[args:{"query":"hello"}]] 调用它');
console.log("  error:", r.error, "| text:", r.text.slice(0, 100));
console.log("-- 传旧参数名 q --");
r = await a.io.prompt('[[tool:compat_tool]] [[args:{"q":"old-style"}]] 调用它');
console.log("  error:", r.error, "| text:", r.text.slice(0, 100));
a.dispose();
