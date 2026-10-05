// 隔离度探针 · cwd 线索：一个「只声明自定义 agentDir / cwd」的实验室，
// 它的 agent 的系统提示词里会不会夹带 agentDir / cwd 之外（祖先目录）的文件内容？
//
// 判据 A（外部泄漏）：createLab({ agentDir, cwd }) 声明的实验室之外的环境不得影响本实验室的 agent。
//
// 做法：temp 下造一棵有层次的目录树 ——
//   <root>/AGENTS.md              ← 祖先目录，实验室外
//   <root>/CLAUDE.md              ← 祖先目录，同一层还有 CLAUDE.md
//   <root>/work/AGENTS.md         ← 实验室 cwd 里，实验室内的
//   <root>/work/deep/             ← agent 真正的工作目录（cwd 指这里）
// 起一个只声明 agentDir/cwd 的实验室，把 agent 的 systemPrompt 打出来。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在任何 ModelRuntime 建起来之前设
process.env.PI_OFFLINE = "1";

import { createLab } from "../src/index.ts";
import { startFaux } from "../test/faux-server.ts";
import { FAUX_MODEL_REF, writeModelsJson } from "../test/faux-models.ts";

const faux = await startFaux();

const root = mkdtempSync(join(tmpdir(), "aiteam-iso-cwd-"));
const agentDir = join(root, "lab-agent");          // 实验室自己的环境目录
const cwd = join(root, "work", "deep");            // 实验室 cwd（agent 的工作目录）
mkdirSync(cwd, { recursive: true });
writeModelsJson(agentDir, faux.baseUrl);

// 祖先链上的文件（全部在 createLab 声明的两个目录之外）
const OUTER = "OUTER-ANCESTOR-MARKER-8f21 —— 这段文字在实验室两个目录之外";
writeFileSync(join(root, "AGENTS.md"), `# 祖先 AGENTS.md\n${OUTER}-A\n`);
writeFileSync(join(root, "CLAUDE.md"), `# 祖先 CLAUDE.md\n${OUTER}-C\n`);
// 实验室 cwd 的祖先 work/ 里也有一个（在 cwd 之外，但在 root 之内）
writeFileSync(join(root, "work", "AGENTS.md"), `# work 层 AGENTS.md\n${OUTER}-W\n`);
// agentDir 自己的上下文文件（在实验室声明范围内）
writeFileSync(join(agentDir, "AGENTS.md"), `# agentDir 的 AGENTS.md\nLAB-AGENTDIR-MARKER\n`);

const lab = await createLab({ agentDir, cwd, modelNetwork: false });
const agent = await lab.createAgent({ model: FAUX_MODEL_REF, id: "probe" });

const sys = agent.io.raw.systemPrompt;
const report = await lab.inspectEnv();

console.log("\n=== 环境声明 ===");
console.log("  agentDir :", agentDir);
console.log("  cwd      :", cwd);
console.log("  ancestor root:", root);

console.log("\n=== inspectEnv().contextFiles（库自己列的 AGENTS.md 链） ===");
for (const f of report.contextFiles) console.log("  ·", f);

console.log("\n=== systemPrompt 里的 <project_instructions> 段 ===");
const m = sys.match(/<project_context>[\s\S]*?<\/project_context>/);
console.log(m ? m[0] : "（无 project_context 段）");

console.log("\n=== 判据 A 核查 ===");
const leaks = [
  ["祖先 AGENTS.md (root)", OUTER + "-A"],
  ["祖先 CLAUDE.md (root)", OUTER + "-C"],
  ["work 层 AGENTS.md", OUTER + "-W"],
];
let leaked = false;
for (const [label, marker] of leaks) {
  const hit = sys.includes(marker);
  if (hit) leaked = true;
  console.log(`  ${hit ? "✗ 泄漏" : "✓ 未出现"}  ${label}`);
}
console.log(`  ${sys.includes("LAB-AGENTDIR-MARKER") ? "✓ 出现" : "✗ 缺失"}  agentDir 自己的 AGENTS.md（实验室声明范围内）`);
console.log(`\n  结论：${leaked ? "有实验室外文件进入系统提示词 → 违反判据 A" : "无外部文件进入 → 未违反"}`);

// ground truth：发一轮，看假服务**实际收到**的 system 里有没有这些外部内容
await agent.io.prompt("说一句话");
const sent = faux.calls[faux.calls.length - 1]?.system ?? "";
console.log("\n=== 模型实际收到的 system（ground truth） ===");
for (const [label, marker] of [...leaks, ["agentDir", "LAB-AGENTDIR-MARKER"]] as [string, string][]) {
  console.log(`  ${sent.includes(marker) ? "含" : "不含"}  ${label}`);
}

agent.dispose();
await faux.close();
