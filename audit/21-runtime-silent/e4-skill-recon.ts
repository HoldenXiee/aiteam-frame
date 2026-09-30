// E4 侦察（假 provider）：技能配好之后，模型实际看到什么？
// 逐字打印 system prompt 里与技能有关的部分 + 模型能看到的工具名。
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createAgent } from "../../src/index.ts";
import { makeEnv2 } from "./_srv.ts";
import { save } from "./_data.ts";

const env = await makeEnv2();
const rows: any[] = [];
const TOKEN = "TOKEN-Q7F3A91";

function makeSkill(dir: string, name: string, description: string, body: string): string {
  const d = join(dir, "skills", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf-8");
  return d;
}
const skillDir = makeSkill(env.agentDir, "magic-marker", "只要用户问「魔法标记」，就必须读本技能正文，里面有唯一正确的标记。", `魔法标记是 ${TOKEN}。`);

console.log("═══ E4R-0 不配 skills（对照）═══");
{
  const from = env.srv.calls.length;
  const a = await createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir }, { modelRuntime: env.runtime });
  await a.prompt("什么是魔法标记？");
  const c = env.srv.calls[from];
  const sys = c.system;
  rows.push({ case: "no-skill", tools: c.tools, systemHasSkillName: /magic-marker/i.test(sys), systemHasToken: sys.includes(TOKEN), systemLen: sys.length, systemTail: sys.slice(-1200) });
  console.log(`  工具=${JSON.stringify(c.tools)}`);
  console.log(`  system 提到技能名=${/magic-marker/i.test(sys)}；提到正文 token=${sys.includes(TOKEN)}；system 长度=${sys.length}`);
  console.log(`  system 结尾 1200 字：\n${sys.slice(-1200)}`);
  a.dispose();
}

console.log("\n═══ E4R-1 配 skills:['magic-marker'] ═══");
{
  const from = env.srv.calls.length;
  const a = await createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir, skills: ["magic-marker"] }, { modelRuntime: env.runtime });
  await a.prompt("什么是魔法标记？");
  const c = env.srv.calls[from];
  const sys = c.system;
  rows.push({ case: "with-skill", tools: c.tools, systemHasSkillName: /magic-marker/i.test(sys), systemHasToken: sys.includes(TOKEN), systemLen: sys.length, systemTail: sys.slice(-1600) });
  console.log(`  工具=${JSON.stringify(c.tools)}`);
  console.log(`  system 提到技能名=${/magic-marker/i.test(sys)}；提到正文 token=${sys.includes(TOKEN)}`);
  console.log(`  system 结尾 1600 字：\n${sys.slice(-1600)}`);
  a.dispose();
}
console.log(`\n（技能文件：${join(skillDir, "SKILL.md")}）`);

console.log("\n═══ E4R-2 agentDir/skills 下放两个技能，只声明其中一个 ═══");
{
  makeSkill(env.agentDir, "beta-skill", "BETA 技能：只有声明它的时候才该被看到。", "BETA 正文");
  const from = env.srv.calls.length;
  const a = await createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir, skills: ["magic-marker"] }, { modelRuntime: env.runtime });
  await a.prompt("hi");
  const sys = env.srv.calls[from].system;
  rows.push({ case: "filter-one", 提到magic: /magic-marker/.test(sys), 提到beta: /beta-skill/.test(sys) });
  console.log(`  声明 skills:['magic-marker'] → system 里 magic-marker=${/magic-marker/.test(sys)}，未声明的 beta-skill=${/beta-skill/.test(sys)}`);
  a.dispose();
}

console.log("\n═══ E4R-3 技能配了，但 tools 白名单里没有 read ═══");
{
  const from = env.srv.calls.length;
  const a = await createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir, skills: ["magic-marker"], tools: ["bash"] }, { modelRuntime: env.runtime });
  await a.prompt("hi");
  const c = env.srv.calls[from];
  const sys = c.system;
  rows.push({ case: "no-read-tool", tools: c.tools, 提到技能: /magic-marker/.test(sys), 指示用read: /Use the read tool to load a skill/.test(sys), systemTail: sys.slice(-900) });
  console.log(`  工具=${JSON.stringify(c.tools)}；system 里有技能=${/magic-marker/.test(sys)}；system 仍叫它用 read 工具=${/Use the read tool to load a skill/.test(sys)}`);
  console.log(`  system 结尾 900 字：\n${sys.slice(-900)}`);
  a.dispose();
}

console.log("\n═══ E4R-4 Skill 对象指向 agentDir 之外的路径 ═══");
{
  const outside = join(env.root, "outside-skill");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "SKILL.md"), `---\nname: outside-skill\ndescription: 在 agentDir 之外，自动发现扫不到。\n---\n\nOUTSIDE-BODY ${TOKEN}\n`, "utf-8");
  const from = env.srv.calls.length;
  const a = await createAgent(
    { model: env.model, cwd: env.cwd, agentDir: env.agentDir, skills: [{ name: "outside-skill", description: "外部技能", filePath: join(outside, "SKILL.md") } as any] },
    { modelRuntime: env.runtime },
  );
  await a.prompt("hi");
  const sys = env.srv.calls[from].system;
  rows.push({ case: "skill-object-outside", 提到技能: /outside-skill/.test(sys), 提到正文: sys.includes("OUTSIDE-BODY") });
  console.log(`  声明 Skill 对象（agentDir 之外）→ system 里有它=${/outside-skill/.test(sys)}；正文进去了=${sys.includes("OUTSIDE-BODY")}`);
  a.dispose();
}
save("e4recon", rows);
await env.srv.close();
