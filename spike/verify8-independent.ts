// verify:8 独立复现：agentDir/AGENTS.md + cwd 及祖先链 AGENTS.md/CLAUDE.md 是否无条件进 system，
// 且 spec 里有没有任何字段能裁掉它。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLab } from "../src/index.ts";
import { writeModelsJson } from "../test/faux-models.ts";
import { startFaux } from "../test/faux-server.ts";

const root = mkdtempSync(join(tmpdir(), "aiteam-v8-"));
const agentDir = join(root, "agent");
// cwd 埋在两层祖先之下，祖先链上放 AGENTS.md / CLAUDE.md
const cwd = join(root, "outer", "inner", "work");
const w = (p: string, c: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
mkdirSync(cwd, { recursive: true });

w(join(agentDir, "AGENTS.md"), "MARK_AGENTDIR_AGENTS\n");
w(join(root, "outer", "AGENTS.md"), "MARK_ANCESTOR_AGENTS\n");
w(join(root, "outer", "inner", "CLAUDE.md"), "MARK_ANCESTOR_CLAUDE\n");
w(join(cwd, "AGENTS.md"), "MARK_CWD_AGENTS\n");

const srv = await startFaux();
writeModelsJson(agentDir, srv.baseUrl, "echo");
process.env.PI_OFFLINE = "1";

const lab = await createLab({ agentDir, cwd, modelNetwork: false });
console.log("root:", root);

// ① spec 全空
const a1 = await lab.createAgent({ model: "faux/echo", id: "ALL" });
console.log("\n[① spec 空] loader.getAgentsFiles():");
console.log("   ", JSON.stringify(a1.extensions.raw.loader.getAgentsFiles().agentsFiles.map((f: any) => f.path.replace(root, ""))));
const sp1: string = a1.io.raw.systemPrompt ?? "";
for (const m of ["MARK_AGENTDIR_AGENTS", "MARK_ANCESTOR_AGENTS", "MARK_ANCESTOR_CLAUDE", "MARK_CWD_AGENTS"]) {
  console.log(`   systemPrompt 含 ${m}:`, sp1.includes(m));
}
await a1.io.prompt("hi");
const c1 = srv.calls.at(-1)!;
for (const m of ["MARK_AGENTDIR_AGENTS", "MARK_ANCESTOR_AGENTS", "MARK_ANCESTOR_CLAUDE", "MARK_CWD_AGENTS"]) {
  console.log(`   实际请求 system 含 ${m}:`, c1.system.includes(m), "| <project_context>:", c1.system.includes("<project_context>"));
}
a1.dispose();

// ② 三刀齐下：skills=[] extensions=[] permissions.only=[] —— 有没有一刀裁到 context 文件？
const a2 = await lab.createAgent({ model: "faux/echo", id: "CUT", skills: [], extensions: [], permissions: { only: [] } });
const sp2: string = a2.io.raw.systemPrompt ?? "";
console.log("\n[② skills=[] extensions=[] permissions.only=[]] systemPrompt 含各 marker:",
  ["MARK_AGENTDIR_AGENTS", "MARK_ANCESTOR_AGENTS", "MARK_ANCESTOR_CLAUDE", "MARK_CWD_AGENTS"].map((m) => `${m}=${sp2.includes(m)}`).join(" "));
a2.dispose();

// ③ spec 里有没有任何字段能裁 context 文件？穷举所有已知字段 + 试几个臆想的
console.log("\n[③ 找 spec 字段] 试 {contextFiles:[]} 与 {noContextFiles:true}:");
for (const extra of [{ contextFiles: [] }, { noContextFiles: true }, { agentsMd: [] }]) {
  try {
    const a = await lab.createAgent({ model: "faux/echo", ...extra } as any);
    const sp: string = a.io.raw.systemPrompt ?? "";
    console.log(`   ${JSON.stringify(extra)} → 建成功，仍含 CWD marker:`, sp.includes("MARK_CWD_AGENTS"));
    a.dispose();
  } catch (e) { console.log(`   ${JSON.stringify(extra)} → 抛错: ${(e as Error).message}`); }
}

// ④ lab.inspectEnv().contextFiles 是否把这条链暴露出来（可观测性，不是"能裁"）
const rep = await lab.inspectEnv();
console.log("\n[④ inspectEnv().contextFiles]:", JSON.stringify(rep.contextFiles.map((f) => f.replace(root, ""))));

await srv.close();
