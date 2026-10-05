// 判据 B 探针 2：把「实验室里被发现的东西」逐个追到**真 agent** 的可见面（system prompt /
// 活跃工具 / skills.list），看 spec 能不能裁掉它。用真 createLab + createAgent，假 provider。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLab } from "../src/index.ts";
import { writeModelsJson } from "../test/faux-models.ts";

const root = mkdtempSync(join(tmpdir(), "aiteam-isoB2-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
const w = (p: string, c: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };

w(join(agentDir, "skills", "gen-skill", "SKILL.md"), "---\nname: gen-skill\ndescription: 实验室自带技能\n---\n");
w(join(agentDir, "extensions", "gen-ext.ts"),
  `export default function (pi: any) { pi.registerTool({ name: "gen_dir_tool", description: "from agentDir/extensions", parameters: {}, execute: async () => "x" }); }\n`);
w(join(agentDir, "prompts", "gen-prompt.md"), "---\ndescription: gen prompt\n---\nPROMPT_BODY\n");
w(join(agentDir, "themes", "gen-theme.json"), JSON.stringify({ name: "gen-theme", colors: {} }) + "\n");
w(join(agentDir, "SYSTEM.md"), "SYSTEM_MD_FROM_AGENTDIR\n");
w(join(agentDir, "APPEND_SYSTEM.md"), "APPEND_FROM_AGENTDIR\n");
w(join(agentDir, "AGENTS.md"), "AGENTS_MD_FROM_AGENTDIR\n");
w(join(cwd, "AGENTS.md"), "AGENTS_MD_FROM_CWD\n");
writeModelsJson(agentDir, "http://127.0.0.1:1", "echo");
process.env.PI_OFFLINE = "1";

const spec = (s: Record<string, unknown>) => s;
const dump = (t: string, a: any) => {
  const sp: string = a.io.raw.systemPrompt ?? "";
  const hit = (needle: string) => (sp.includes(needle) ? "✓在" : "✗无");
  console.log(`\n── ${t} ──`);
  console.log(`  systemPrompt len=${sp.length}`);
  console.log(`  agentsMd 注入     : ${hit("AGENTS_MD_FROM_AGENTDIR")} / cwd: ${hit("AGENTS_MD_FROM_CWD")}`);
  console.log(`  SYSTEM.md 生效    : ${hit("SYSTEM_MD_FROM_AGENTDIR")}`);
  console.log(`  <tools> 段是否还在: ${sp.includes("<tools>") ? "✓在" : "✗无（被 SYSTEM.md 换掉了）"}`);
  console.log(`  skills 段         : ${hit("gen-skill")}`);
  console.log(`  活跃工具          : ${JSON.stringify(a.io.raw.getActiveToolNames())}`);
  console.log(`  gen_dir_tool 可见 : ${a.io.raw.getActiveToolNames().includes("gen_dir_tool") ? "✓" : "✗"}`);
  console.log(`  agent.prompts 数  : ${a.extensions.raw.loader.getPrompts().prompts.length}`);
  console.log(`  themes 数         : ${a.extensions.raw.loader.getThemes().themes.length}`);
};

console.log("root:", root);
const lab = await createLab({ agentDir, cwd, modelNetwork: false });

const a1 = await lab.createAgent(spec({ model: "faux/echo", id: "ALL" }));
dump("① spec 空（全给）", a1);

const a2 = await lab.createAgent(spec({ model: "faux/echo", id: "CUT", skills: [], extensions: [], permissions: { only: [] } }));
dump("② spec.skills=[] extensions=[] permissions.only=[]", a2);

const a3 = await lab.createAgent(spec({ model: "faux/echo", id: "P" }));
console.log("\n③ prompts/themes 有没有 spec 字段？AgentSpec 可写字段 = id,role,model,thinking,permissions,tools,context,skills,extensions");
try {
  await lab.createAgent({ model: "faux/echo", prompts: [] } as any);
} catch (e) { console.log("   createAgent({prompts:[]}) →", (e as Error).message); }
try {
  await lab.createAgent({ model: "faux/echo", themes: [] } as any);
} catch (e) { console.log("   createAgent({themes:[]}) →", (e as Error).message); }
try {
  await lab.createAgent({ model: "faux/echo", systemPrompt: "x" } as any);
} catch (e) { console.log("   createAgent({systemPrompt}) →", (e as Error).message); }

// SYSTEM.md 能否被某个 spec 字段抵掉？试 role（它走 appendSystemPrompt）
const a4 = await lab.createAgent(spec({ model: "faux/echo", id: "ROLE", role: "你是 ROLE 追加段。", skills: [], extensions: [] }));
console.log("\n④ role 追加后 systemPrompt 尾部 120 字：");
console.log("   ", JSON.stringify((a4.io.raw.systemPrompt ?? "").slice(-120)));
console.log("   SYSTEM.md 仍在？", (a4.io.raw.systemPrompt ?? "").includes("SYSTEM_MD_FROM_AGENTDIR") ? "✓仍在" : "✗已无");

// prompts 会不会进 system prompt / 影响模型？
console.log("\n⑤ gen-prompt 的内容进了 systemPrompt 吗？", (a1.io.raw.systemPrompt ?? "").includes("PROMPT_BODY") ? "✓在" : "✗不在（只是 slash 命令素材）");

for (const a of [a1, a2, a3, a4]) a.dispose();
