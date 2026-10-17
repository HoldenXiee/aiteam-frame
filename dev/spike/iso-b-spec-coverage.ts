// 判据 B 探针：实验室（agentDir / cwd）里所有能被发现的东西，逐个回答「spec 能裁吗」。
// 造一个「什么都有」的临时环境（skills/extensions/prompts/themes/SYSTEM.md/APPEND_SYSTEM.md/
// AGENTS.md/models.json/.pi / .agents），然后起 spec 各档的 agent，看生效集合。
// 离线、零成本：只读 loader / session，不调模型。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildLoader } from "../src/agent/loader.ts";
import { writeModelsJson } from "../test/faux-models.ts";

const root = mkdtempSync(join(tmpdir(), "aiteam-isoB-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
const fakeHome = join(root, "home");

const w = (p: string, content: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

// ── agentDir 里的每一类资源 ──
w(join(agentDir, "skills", "gen-skill", "SKILL.md"), "---\nname: gen-skill\ndescription: 实验室自带的技能\n---\n");
w(join(agentDir, "extensions", "gen-ext.ts"), `export default function (pi: any) { pi.registerTool({ name: "gen_tool_from_dir", description: "x", parameters: {}, execute: async () => "x" }); }\n`);
w(join(agentDir, "prompts", "gen-prompt.md"), "# gen-prompt\n");
w(join(agentDir, "themes", "gen-theme.json"), `{"name":"gen-theme"}\n`);
w(join(agentDir, "SYSTEM.md"), "你是实验室 SYSTEM.md 定义的系统提示词。\n");
w(join(agentDir, "APPEND_SYSTEM.md"), "APPEND_SYSTEM.md 追加段。\n");
w(join(agentDir, "AGENTS.md"), "agentDir 的 AGENTS.md。\n");
w(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-*"] }));
// 宿主式的东西（判据 A，但这里看 spec 能不能裁）
w(join(fakeHome, ".agents", "skills", "home-skill", "SKILL.md"), "---\nname: home-skill\ndescription: home skill\n---\n");
// cwd 侧
w(join(cwd, "AGENTS.md"), "cwd 的 AGENTS.md。\n");
w(join(cwd, ".pi", "SYSTEM.md"), "项目 SYSTEM.md。\n");
w(join(cwd, ".pi", "skills", "proj-skill", "SKILL.md"), "---\nname: proj-skill\ndescription: proj skill\n---\n");
w(join(cwd, ".agents", "skills", "agents-skill", "SKILL.md"), "---\nname: agents-skill\ndescription: agents skill\n---\n");
writeModelsJson(agentDir, "http://127.0.0.1:1", "echo");

process.env.PI_OFFLINE = "1";
// getHomeDir() = process.env.HOME || homedir()（package-manager.js:82）
process.env.HOME = fakeHome;

const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });

const show = (title: string, loader: DefaultResourceLoader) => {
  const skills = loader.getSkills().skills.map((s) => `${s.name}(${s.sourceInfo?.scope ?? "?"})`);
  const exts = loader.getExtensions().extensions.map((e) => e.path.replace(root, ""));
  const prompts = loader.getPrompts().prompts.map((p: any) => p.name);
  const themes = loader.getThemes().themes.map((t: any) => t.name);
  const agents = loader.getAgentsFiles().agentsFiles.map((f) => f.path.replace(root, ""));
  console.log(`\n── ${title} ──`);
  console.log(`  skills  :`, JSON.stringify(skills));
  console.log(`  exts    :`, JSON.stringify(exts));
  console.log(`  prompts :`, JSON.stringify(prompts));
  console.log(`  themes  :`, JSON.stringify(themes));
  console.log(`  agentsMd:`, JSON.stringify(agents));
  console.log(`  SYSTEM.md source : ${loader.getSystemPromptSource()?.path?.replace(root, "") ?? "(无)"}`);
  console.log(`  APPEND sources   : ${JSON.stringify(loader.getAppendSystemPromptSources().map((s) => s.path.replace(root, "")))}`);
  console.log(`  systemPrompt 头部: ${JSON.stringify((loader.getSystemPrompt() ?? "").slice(0, 60))}`);
  console.log(`  appendSystemPrompt: ${JSON.stringify(loader.getAppendSystemPrompt().map((s) => s.slice(0, 40)))}`);
};

const mk = (spec: Parameters<typeof buildLoader>[0]) =>
  buildLoader(spec, { cwd, agentDir, settingsManager: SettingsManager.inMemory({}) });

console.log("root:", root);
console.log("HOME:", process.env.HOME);

show("① spec 什么都不写（全给）", await mk({}));
show("② spec.skills=[] spec.extensions=[]（想全裁）", await mk({ skills: [], extensions: [] }));
show("③ spec.skills=['gen-skill'] only", await mk({ skills: ["gen-skill"] }));
show("④ spec.extensions=[] only（skills 不写）", await mk({ extensions: [] }));

// 看 prompts / themes 有没有对应的 spec 字段
import("../src/agent/create-agent.ts").then(() => {});
