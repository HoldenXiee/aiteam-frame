// 独立复现：SYSTEM.md 能否被 spec 里的任何一类字段阻止/消除
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLab } from "../src/index.ts";
import { writeModelsJson } from "../test/faux-models.ts";
import { startFaux } from "../test/faux-server.ts";

const root = mkdtempSync(join(tmpdir(), "aiteam-verify7-"));
const agentDir = join(root, "agent"); const cwd = join(root, "work");
const w=(p:string,c:string)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,c)};
mkdirSync(cwd,{recursive:true});
const srv = await startFaux();
writeModelsJson(agentDir, srv.baseUrl, "echo");
process.env.PI_OFFLINE="1";

// 放 SYSTEM.md，并且三刀齐下 + role
w(join(agentDir,"SYSTEM.md"),"ONLY_THIS\n");
const lab = await createLab({agentDir, cwd, modelNetwork:false});

// ① 全部能裁的字段齐上：skills=[] extensions=[] permissions.only=[] role + 其他字段
const a = await lab.createAgent({
  model: "faux/echo", id:"locked",
  skills: [], extensions: [], permissions: { only: [] },
  role: "ROLE_APPEND_MARKER", context: { autoCompact: false }, tools: { custom: [] },
});
const rep = await lab.inspectEnv();
const before = srv.calls.length;
await a.io.prompt("hi");
const c = srv.calls.at(-1)!;
console.log("① spec 全字段齐上后 system ===", JSON.stringify(c.system.slice(0,60))+"...");
console.log("   system 含 <tools>:", c.system.includes("<tools>"));
console.log("   system 含 SYSTEM.md 内容 ONLY_THIS:", c.system.includes("ONLY_THIS"));
console.log("   system 含 ROLE_APPEND_MARKER:", c.system.includes("ROLE_APPEND_MARKER"));
console.log("   inspectEnv().systemPromptFile:", rep.systemPromptFile);
console.log("   inspectEnv() warnings 含 SYSTEM.md:", rep.warnings.some(x=>x.includes("SYSTEM.md")));
a.dispose();

// ② 同 lab、同强制 SYSTEM.md，两个不同 spec 的 agent 是否都拿到同一个被顶掉的 system
const b = await lab.createAgent({ model:"faux/echo", id:"b", role:"ROLE_B" });
await b.io.prompt("hi");
const cb = srv.calls.at(-1)!;
console.log("② 第二个 agent system 含 ONLY_THIS:", cb.system.includes("ONLY_THIS"), "含 <tools>:", cb.system.includes("<tools>"), "含 ROLE_B:", cb.system.includes("ROLE_B"));
b.dispose();
await srv.close();
