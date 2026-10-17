// 判据 B 探针 7：SYSTEM.md 整体替换后，AGENTS.md 与工具 schema 在请求里是否还在（具体后果）。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLab } from "../src/index.ts";
import { writeModelsJson } from "../test/faux-models.ts";
import { startFaux } from "../test/faux-server.ts";

const root = mkdtempSync(join(tmpdir(), "aiteam-isoB7-"));
const agentDir = join(root, "agent"); const cwd = join(root, "work");
const w=(p:string,c:string)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,c)};
mkdirSync(cwd,{recursive:true});
const srv = await startFaux();
writeModelsJson(agentDir, srv.baseUrl, "echo");
w(join(cwd,"AGENTS.md"),"CWD_AGENTS_MD_MARKER\n");
process.env.PI_OFFLINE="1";

const lab = await createLab({agentDir, cwd, modelNetwork:false});
const a = await lab.createAgent({model: "faux/echo", id:"nosys"});
await a.io.prompt("hi");
let c = srv.calls.at(-1)!;
console.log("[无 SYSTEM.md] system 含 AGENTS.md marker:", c.system.includes("CWD_AGENTS_MD_MARKER"));
console.log("               system 含 <tools>:", c.system.includes("<tools>"));
console.log("               system 含 <project_context>:", c.system.includes("<project_context>"));
console.log("               请求里的 tools:", JSON.stringify(c.tools));
console.log("               system len:", c.system.length);
a.dispose();

w(join(agentDir,"SYSTEM.md"),"ONLY_THIS\n");
const lab2 = await createLab({agentDir, cwd, modelNetwork:false});
const b = await lab2.createAgent({model: "faux/echo", id:"sys"});
await b.io.prompt("hi");
c = srv.calls.at(-1)!;
console.log("[有 SYSTEM.md] system === " + JSON.stringify(c.system));
console.log("               system 含 AGENTS.md marker:", c.system.includes("CWD_AGENTS_MD_MARKER"));
console.log("               system 含 <tools>:", c.system.includes("<tools>"));
console.log("               请求里的 tools（schema 还在，但系统提示没告诉模型怎么用）:", JSON.stringify(c.tools));
b.dispose();
await srv.close();
