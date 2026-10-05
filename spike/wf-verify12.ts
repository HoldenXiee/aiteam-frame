// 独立复现「inspectEnv 报告 vs agent 实际拿到」的不一致 + withheld 字段是否存在。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLab } from "../src/index.ts";
import { startFaux } from "../test/faux-server.ts";
import { FAUX_MODEL_REF, makeFauxRuntime } from "../test/faux-models.ts";

process.env.PI_OFFLINE = "1";
const faux = await startFaux();
const { runtime } = await makeFauxRuntime(faux.baseUrl);

const labDir = mkdtempSync(join(tmpdir(), "wf-verify12-agent-"));
const work = mkdtempSync(join(tmpdir(), "wf-verify12-work-"));

// agentDir 里放技能 + 扩展（环境自动发现）
mkdirSync(join(labDir, "skills", "env-s1"), { recursive: true });
writeFileSync(join(labDir, "skills", "env-s1", "SKILL.md"), "---\nname: env-s1\ndescription: x\n---\n\nA\n");
mkdirSync(join(labDir, "skills", "env-s2"), { recursive: true });
writeFileSync(join(labDir, "skills", "env-s2", "SKILL.md"), "---\nname: env-s2\ndescription: x\n---\n\nB\n");

mkdirSync(join(work, ".pi", "extensions"), { recursive: true });
const extSrc = (t: string) => `export default function (pi) {
  pi.registerTool({ name: "${t}", label: "${t}", description: "x",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
}\n`;
writeFileSync(join(work, ".pi", "extensions", "p.ts"), extSrc("env_tool_p"));
writeFileSync(join(work, ".pi", "extensions", "q.ts"), extSrc("env_tool_q"));

const lab = await createLab({ agentDir: labDir, cwd: work, modelNetwork: false, modelRuntime: runtime });
const report = await lab.inspectEnv();

const a = await lab.createAgent({
  model: FAUX_MODEL_REF,
  skills: ["env-s1"],
  extensions: [join(work, ".pi", "extensions", "p.ts")],
});

const repSkills = report.skills.map((s) => s.name).sort();
const agSkills = a.skills.list().map((s) => s.name).sort();
const repExtTools = report.extensions.flatMap((e) => e.tools).sort();
const agExtTools = a.extensions.list().flatMap((e) => [...e.tools.keys()]).sort();

console.log("inspectEnv 技能:", JSON.stringify(repSkills));
console.log("agent 实际技能:", JSON.stringify(agSkills));
console.log("inspectEnv 扩展工具:", JSON.stringify(repExtTools));
console.log("agent 实际扩展工具:", JSON.stringify(agExtTools));
console.log("EnvReport keys:", JSON.stringify(Object.keys(report)));
console.log("EnvReport 有 withheld 吗:", "withheld" in report);
console.log("warnings:", JSON.stringify(report.warnings, null, 0));
console.log("warnings 里提到 env-s2 / env_tool_q 吗:",
  report.warnings.some((w) => /env-s2|env_tool_q/.test(w)));

// 反向：不写 spec 的 agent 拿到的资源
const b = await lab.createAgent({ model: FAUX_MODEL_REF });
console.log("无 spec agent 技能:", JSON.stringify(b.skills.list().map((s) => s.name).sort()));
console.log("无 spec agent 扩展工具:", JSON.stringify(b.extensions.list().flatMap((e) => [...e.tools.keys()]).sort()));

a.dispose(); b.dispose();
await faux.close();
