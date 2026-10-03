// 06-resources：运行期加载扩展（extensions）与技能（skills）。
//
// 判别力：`extensions.list()` / `skills.list()` 都是**前后各打一次** —— 前面的空/初始态
// 与后面的新条目，不是同一个值打印两遍。
// 技能必须指向**真实存在**的 SKILL.md 目录（skills.add 只接受路径或 Skill 对象，
// 加载不出来会抛错、不静默降级）——这里用 tmpCwd() 临时造一个。
// 扩展用内联工厂：pi 把 ExtensionAPI 交给它，就地注册一个工具。
//
// 跑法：node examples/06-resources.ts
// 期望看到：加载前 extensions.list() 只有桥接自身、skills.list() 为空；
// 加载后 extensions.list() 多一个内联扩展、skills.list() 出现 demo-skill。
//
// 若要用真模型，改这两行：`makeOfflineAgent()` → `makeOfflineAgent({ model: "<provider>/<id>", modelNetwork: true })`
// （默认 ref 在 examples/lib/harness.ts；运行期换模型走 `agent.model.set(...)`，见 07-model.ts）。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent, tmpCwd } from "./lib/harness.ts";

const agent = await makeOfflineAgent();

console.log("[1] 加载之前");
console.log(`    extensions.list() = ${agent.extensions.list().map((e) => e.path).join(", ") || "(空)"}  （共 ${agent.extensions.list().length} 个，第一个是库的常驻桥接）`);
console.log(`    skills.list()     = ${agent.skills.list().map((s) => s.name).join(", ") || "(空)"}`);

console.log("[2] 运行期加一个内联扩展：就地注册一个 shout 工具");
console.log("    —— 扩展注册的工具名会被库自动并进白名单（不并的话在白名单下会静默蒸发）");
await agent.extensions.add((pi) => {
  pi.registerTool(
    defineTool({
      name: "shout",
      label: "Shout",
      description: "把文本变成大写",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, params) => ({
        content: [{ type: "text" as const, text: params.text.toUpperCase() }],
        details: {},
      }),
    }),
  );
});
// 加载失败不静默：路径不存在 / 扩展抛错都在这里读得到
const extErrors = agent.extensions.errors();
if (extErrors.length) throw new Error(`扩展加载失败：${extErrors.map((e) => e.path).join("、")}`);

console.log("[3] 运行期加一个技能：造一个真实存在的 SKILL.md 目录再 add");
const skillDir = join(tmpCwd(), "skills", "demo-skill");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  "---\nname: demo-skill\ndescription: 七面演示用的技能\n---\n\n正文\n",
);
await agent.skills.add(skillDir);
console.log(`    技能目录：${skillDir}`);

console.log("[4] 加载之后");
console.log(`    extensions.list() = ${agent.extensions.list().map((e) => e.path).join(", ")}  （共 ${agent.extensions.list().length} 个）`);
console.log(`    skills.list()     = ${agent.skills.list().map((s) => s.name).join(", ")}`);

agent.dispose();
console.log("\n脚本正常结束，退出码 0");
