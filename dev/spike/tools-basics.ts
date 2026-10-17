// 基础文档的断言核对
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent, sentTools } from "../examples/lib/harness.ts";

// ① 返回 "文本" 而不是数组，会怎样？
const badReturn = defineTool({
  name: "bad_return", label: "Bad", description: "返回字符串而不是数组",
  parameters: Type.Object({}),
  // @ts-expect-error 故意的
  execute: async () => ({ content: "纯文本", details: {} }),
});
const a1 = await makeOfflineAgent({ tools: { custom: [badReturn] } });
const r1 = await a1.io.prompt("[[tool:bad_return]] 调用它");
console.log("① 返回非数组 content:");
console.log("   error:", r1.error, "| text:", JSON.stringify(r1.text.slice(0, 120)));
a1.dispose();

// ② execute 里 throw 会怎样？
const thrower = defineTool({
  name: "thrower", label: "Thrower", description: "抛异常",
  parameters: Type.Object({}),
  execute: async () => { throw new Error("BOOM-工具内部异常"); },
});
const a2 = await makeOfflineAgent({ tools: { custom: [thrower] } });
const r2 = await a2.io.prompt("[[tool:thrower]] 调用它");
console.log("\n② execute 抛异常:");
console.log("   error:", r2.error);
console.log("   text:", JSON.stringify(r2.text.slice(0, 160)));
a2.dispose();

// ③ 参数 schema 校验失败会怎样？
const strict = defineTool({
  name: "strict", label: "Strict", description: "要一个数字",
  parameters: Type.Object({ n: Type.Number() }),
  execute: async (_id, p) => ({ content: [{ type: "text" as const, text: `n=${p.n} type=${typeof p.n}` }], details: {} }),
});
const a3 = await makeOfflineAgent({ tools: { custom: [strict] } });
const r3 = await a3.io.prompt('[[tool:strict]] [[args:{"n":"不是数字"}]] 调用');
console.log("\n③ 参数类型不对:");
console.log("   error:", r3.error, "| text:", JSON.stringify(r3.text.slice(0, 160)));
const r3b = await a3.io.prompt('[[tool:strict]] [[args:{"wrong":"字段名错了"}]] 调用');
console.log("   字段名错: error:", r3b.error, "| text:", JSON.stringify(r3b.text.slice(0, 160)));
a3.dispose();
