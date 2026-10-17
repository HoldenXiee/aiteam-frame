// 判据 B 探针 5：APPEND_SYSTEM.md / themes / prompts 的发现与「spec 裁不掉」的确认。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "aiteam-isoB5-"));
const agentDir = join(root, "agent"); const cwd = join(root, "work");
const w=(p:string,c:string)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,c)};
w(join(agentDir,"APPEND_SYSTEM.md"),"APPEND_FROM_AGENTDIR\n");
w(join(agentDir,"SYSTEM.md"),"SYSTEM_FROM_AGENTDIR\n");
w(join(agentDir,"prompts","p.md"),"---\ndescription: p\n---\nBODY\n");
w(join(agentDir,"themes","t.json"),JSON.stringify({name:"t",colors:{fg:"#fff",bg:"#000"}})+"\n");
mkdirSync(cwd,{recursive:true});

// A) 完全不传 appendSystemPrompt（pi CLI 就是这样）
const l1 = new DefaultResourceLoader({cwd, agentDir, settingsManager: SettingsManager.inMemory({})});
await l1.reload();
console.log("A) 不传 appendSystemPrompt: appendSources =", JSON.stringify(l1.getAppendSystemPromptSources().map(s=>s.path.replace(root,""))), "| append =", JSON.stringify(l1.getAppendSystemPrompt()));

// B) 传 appendSystemPrompt: [] （本库 loader.ts 的实际行为：role 为空时传空数组）
const l2 = new DefaultResourceLoader({cwd, agentDir, settingsManager: SettingsManager.inMemory({}), appendSystemPrompt: []});
await l2.reload();
console.log("B) 传 appendSystemPrompt: [] → appendSources =", JSON.stringify(l2.getAppendSystemPromptSources().map(s=>s.path.replace(root,""))), "| append =", JSON.stringify(l2.getAppendSystemPrompt()));

// C) 本库真 loader（buildLoader）
const { buildLoader } = await import("../src/agent/loader.ts");
const l3 = await buildLoader({}, {cwd, agentDir, settingsManager: SettingsManager.inMemory({})});
console.log("C) buildLoader({}) → appendSources =", JSON.stringify(l3.getAppendSystemPromptSources().map(s=>s.path.replace(root,""))));
console.log("   prompts =", JSON.stringify(l3.getPrompts().prompts.map((p:any)=>p.name)));
console.log("   themes  =", JSON.stringify(l3.getThemes().themes.map((t:any)=>t.name)));
const l4 = await buildLoader({role:"ROLE_X", skills:[], extensions:[]}, {cwd, agentDir, settingsManager: SettingsManager.inMemory({})});
console.log("D) buildLoader({role}) → append =", JSON.stringify(l4.getAppendSystemPrompt()), "| SYSTEM 生效=", (l4.getSystemPrompt()??"").includes("SYSTEM_FROM_AGENTDIR"));
