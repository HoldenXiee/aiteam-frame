// 独立核实：cwd 上级目录的 .agents/skills 是否沿父链被发现并进 agent。
// 用真实库入口 createLab，而不是直连 pi —— 要核实的是「库有没有管住」。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLab } from "../src/index.ts";
import { FAUX_MODEL_REF, makeFauxRuntime } from "../test/faux-models.ts";
import { startFaux } from "../test/faux-server.ts";

process.env.PI_OFFLINE = "1";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);

// 模拟「宿主项目」：父目录有 .agents/skills，且父目录是 git 根
const hostRoot = mkdtempSync(join(tmpdir(), "ancestor-host-"));
mkdirSync(join(hostRoot, ".git"), { recursive: true });
const probeSkillDir = join(hostRoot, ".agents", "skills", "zz-ancestor-leak-probe");
mkdirSync(probeSkillDir, { recursive: true });
writeFileSync(
  join(probeSkillDir, "SKILL.md"),
  "---\nname: zz-ancestor-leak-probe\ndescription: ancestor leak probe\n---\n\n父项目技能。\n",
);

// 实验室 cwd 在宿主项目内部（一层子目录）
const labCwd = join(hostRoot, "sub", "work");
mkdirSync(labCwd, { recursive: true });

console.log("hostRoot =", hostRoot);
console.log("labCwd   =", labCwd);

const lab = await createLab({ agentDir: made.agentDir, cwd: labCwd, modelNetwork: false });

const env = await lab.inspectEnv();
const skillNames = env.skills.map((s) => s.name);
console.log("\n[inspectEnv().skills]", JSON.stringify(skillNames));
console.log("含 zz-ancestor-leak-probe（inspectEnv）：", skillNames.includes("zz-ancestor-leak-probe"));

const a = await lab.createAgent({ model: FAUX_MODEL_REF, id: "noSpec" });
console.log("agent.skills.list() =", JSON.stringify(a.skills.list().map((s) => s.name)));
console.log(
  "[spec 不写 skills] system 含 probe：",
  a.io.raw.systemPrompt.includes("zz-ancestor-leak-probe"),
);

const b = await lab.createAgent({ model: FAUX_MODEL_REF, id: "emptyWhitelist", skills: [] });
console.log("agent.skills.list() (skills:[]) =", JSON.stringify(b.skills.list().map((s) => s.name)));
console.log(
  "[spec.skills: []] system 含 probe：",
  b.io.raw.systemPrompt.includes("zz-ancestor-leak-probe"),
);

a.dispose();
b.dispose();

// 第二轮：真跑一次 prompt，看模型实际收到的 system（ground truth）
const c = await lab.createAgent({ model: FAUX_MODEL_REF, id: "realRun" });
await c.io.prompt("hi");
const last = faux.calls[faux.calls.length - 1];
console.log("\n[faux 收到] system 含 probe：", last.system.includes("zz-ancestor-leak-probe"));
c.dispose();
await faux.close();

console.log("[inspectEnv warnings]", JSON.stringify(env.warnings));
