// 判据 B 探针 4：settings.json 到底被读没有（inMemory）、HOME 对 ~/.agents/skills 的影响、
// cwd 祖先目录的 .pi / .agents 发现。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLab } from "../src/index.ts";
import { writeModelsJson } from "../test/faux-models.ts";

const root = mkdtempSync(join(tmpdir(), "aiteam-isoB4-"));
const agentDir = join(root, "agent");
const cwd = join(root, "outer", "inner", "work");
const w = (p: string, c: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
mkdirSync(cwd, { recursive: true });
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n`;

writeModelsJson(agentDir, "http://127.0.0.1:1", ["echo"]);
w(join(agentDir, "extensions", "gen-ext.ts"),
  `export default function (pi: any) { pi.registerTool({ name: "gen_dir_tool", description: "x", parameters: {}, execute: async () => "x" }); }\n`);
w(join(agentDir, "skills", "gen-skill", "SKILL.md"), skill("gen-skill"));
// agentDir/settings.json 里显式关掉自动发现
w(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-*"], skills: ["-*"] }));
// cwd 祖先链上的 .pi 与 .agents
w(join(root, "outer", ".pi", "skills", "ancestor-pi-skill", "SKILL.md"), skill("ancestor-pi-skill"));
w(join(root, "outer", "inner", ".agents", "skills", "ancestor-agents-skill", "SKILL.md"), skill("ancestor-agents-skill"));
process.env.PI_OFFLINE = "1";

console.log("root:", root);
const lab = await createLab({ agentDir, cwd, modelNetwork: false });
const a = await lab.createAgent({ model: "faux/echo", id: "T" });
console.log("spec 空时 skills:", JSON.stringify(a.skills.list().map((s) => s.name)));
console.log("spec 空时 exts  :", JSON.stringify(a.extensions.list().map((e) => e.path.split(/[\\/]/).pop())));
console.log("活跃工具        :", JSON.stringify(a.io.raw.getActiveToolNames()));
console.log("→ agentDir/settings.json 的 extensions:['-*'] 生效了吗？(gen_dir_tool 在=没生效)");
a.dispose();

// HOME 能不能挪走 ~/.agents/skills
const fakeHome = join(root, "fakehome");
w(join(fakeHome, ".agents", "skills", "fakehome-skill", "SKILL.md"), skill("fakehome-skill"));
process.env.HOME = fakeHome;
console.log("\n把 process.env.HOME 指到", fakeHome, "后重建 lab：");
const lab2 = await createLab({ agentDir, cwd, modelNetwork: false });
const b = await lab2.createAgent({ model: "faux/echo", id: "H", skills: [] });
console.log("  spec.skills=[] 时 skills:", JSON.stringify(b.skills.list().map((s) => s.name)));
b.dispose();
// 真实宿主目录的 skills 会不会漏进来
const realHome = join(root, "real-lookalike");
w(join(realHome, ".agents", "skills", "realhost-skill", "SKILL.md"), skill("realhost-skill"));
const c = await lab2.createAgent({ model: "faux/echo", id: "H2" });
console.log("  spec 空时 skills:", JSON.stringify(c.skills.list().map((s) => s.name)));
console.log("  → 有没有 C:\\Users\\Holder\\.agents\\skills 的东西？",
  JSON.stringify(c.skills.list().filter((s) => !s.filePath.startsWith(root)).map((s) => s.filePath)));
c.dispose();
