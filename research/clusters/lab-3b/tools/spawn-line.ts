// spawn_line —— ★ agent 触发：派一条**探索支线**
//
// ★ 依据 P22：**自主溯源是它的默认行为** —— 它自己知道哪条路值得试。
// ★★ 子 agent 不继承父的上下文（B5/P20）⇒ 所以 `task` 必须**自包含**。

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Agent, Lab } from "../../../../src/index.ts";
import { attachGate } from "../guard.ts";
import { MODEL, READONLY_TOOLS, REPO } from "../paths.ts";

const LINE_ROLE =
  "你是一条**探索支线**上的子研究员。★ 你只看到这条任务，没有别的上下文。\n" +
  "★ 把活干完，把**结论**交回来（不是过程）。有证据就带证据 id。";

export function makeSpawnLine(deps: { lab: Lab; onSpawn: (a: Agent) => void }) {
  return defineTool({
    name: "spawn_line",
    label: "SpawnLine",
    description:
      "派一条**探索支线**：起一个子研究员去试一条路，只把结论带回来。" +
      "★ 子 agent **不继承你的上下文** —— 你要把够它独立开工的信息写进 task。",
    parameters: Type.Object({
      task: Type.String({ description: "这条支线要干什么（自包含：背景 + 要什么结论）" }),
      read: Type.Optional(Type.Array(Type.String(), { description: "允许它读的路径（默认整个仓库）" })),
    }),
    execute: async (_id, p) => {
      const child = await deps.lab.createAgent({
        id: `line-${Date.now().toString(36)}`,
        model: MODEL,
        role: LINE_ROLE,
        permissions: { only: [...READONLY_TOOLS] },
      });
      attachGate(child);
      deps.onSpawn(child);
      const res = await child.io.prompt(`${p.task}\n\n★ 你可以读：${(p.read ?? [REPO]).join(", ")}`);
      child.dispose();
      return { content: [{ type: "text" as const, text: res.text ?? "(空)" }], details: {} };
    },
  });
}
