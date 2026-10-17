// 验证 executionMode：一轮里同时发两个工具调用，看它们是并发还是串行
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent } from "../examples/lib/harness.ts";

const log: string[] = [];
function mk(name: string, mode?: "sequential" | "parallel") {
  return defineTool({
    name, label: name, description: `测试用 ${name}`,
    parameters: Type.Object({ tag: Type.String() }),
    ...(mode ? { executionMode: mode } : {}),
    execute: async (_id, p) => {
      log.push(`START ${name}(${p.tag})`);
      await new Promise((r) => setTimeout(r, 120));
      log.push(`END   ${name}(${p.tag})`);
      return { content: [{ type: "text" as const, text: `${name} done` }], details: {} };
    },
  });
}

// 一次回复里发两个工具调用 [[call:NAME {...}]]
const CALLS = '[[call:alpha {"tag":"1"}]][[call:beta {"tag":"2"}]]';

console.log("=== 默认（无 executionMode）===");
let a = await makeOfflineAgent({ tools: { custom: [mk("alpha"), mk("beta")] } });
log.length = 0;
let r = await a.io.prompt(`${CALLS} 两个都调用`);
console.log(log.map((l) => "  " + l).join("\n") || `  (没调工具) error=${r.error}`);
const overlapDefault = log[0]?.startsWith("START") && log[1]?.startsWith("START");
console.log(`  判定：${overlapDefault ? "并发（两个 START 相邻）" : "串行"}`);
a.dispose();

console.log("\n=== alpha 标 sequential ===");
a = await makeOfflineAgent({ tools: { custom: [mk("alpha", "sequential"), mk("beta")] } });
log.length = 0;
r = await a.io.prompt(`${CALLS} 两个都调用`);
console.log(log.map((l) => "  " + l).join("\n") || `  (没调工具) error=${r.error}`);
const overlapSeq = log[0]?.startsWith("START") && log[1]?.startsWith("START");
console.log(`  判定：${overlapSeq ? "并发（sequential 没生效）" : "串行（sequential 生效）"}`);
a.dispose();
