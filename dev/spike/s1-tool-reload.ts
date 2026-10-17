// S1：reload 之后新注册的扩展工具，模型能不能看到？能不能真被调用？
// 规格 §3.4 的「常驻桥接扩展」全靠这条成立。
import { check, head, rig } from "./_pi.ts";
import { defineTool, type InlineExtension, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

head("S1 运行期加工具（table + reload）");

const executed: string[] = [];
function makeTool(name: string): ToolDefinition {
  return defineTool({
    name,
    label: name,
    description: `探路工具 ${name}`,
    parameters: Type.Object({ text: Type.Optional(Type.String()) }),
    execute: async () => {
      executed.push(name);
      return { content: [{ type: "text" as const, text: `${name} 执行了` }], details: {} };
    },
  }) as ToolDefinition;
}

const table = new Map<string, ToolDefinition>();
const bridge: InlineExtension = (pi) => {
  for (const tool of table.values()) pi.registerTool(tool);
};

const r = await rig([bridge]);
try {
  await r.session.prompt("baseline");
  const baseTools = r.lastCall()?.tools ?? [];
  check("基线：未加工具时模型看不到 probe_new", !baseTools.includes("probe_new"), baseTools.join(","));

  // ── 加工具 ──
  table.set("probe_new", makeTool("probe_new"));
  await r.session.reload();

  const active = r.session.getActiveToolNames();
  check("reload 后 getActiveToolNames() 含新工具", active.includes("probe_new"), active.join(","));

  await r.session.prompt("after-add");
  const afterTools = r.lastCall()?.tools ?? [];
  check("reload 后模型**真的收到**新工具的 schema", afterTools.includes("probe_new"), afterTools.join(","));

  // ── 真调用一次 ──
  executed.length = 0;
  await r.session.prompt("[[tool:probe_new]]");
  check("新工具**真的能被执行**", executed.includes("probe_new"), `executed=[${executed.join(",")}]`);

  // ── 删工具 ──
  table.delete("probe_new");
  await r.session.reload();
  await r.session.prompt("after-remove");
  const removedTools = r.lastCall()?.tools ?? [];
  check("remove + reload 后模型看不到它了", !removedTools.includes("probe_new"), removedTools.join(","));

  console.log(`\n  请求次数：${r.calls.length}（每次一行 tools = 模型实际收到的声明面）`);
  r.calls.forEach((c, i) => console.log(`   #${i + 1} tools=[${c.tools.join(",")}]`));
} finally {
  await r.close();
}