// 判据 B 探针 6：cwd/.pi 的 extensions/prompts/themes，与 spec 各档的对应。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildLoader } from "../src/agent/loader.ts";
const root = mkdtempSync(join(tmpdir(), "aiteam-isoB6-"));
const agentDir = join(root, "agent"); const cwd = join(root, "work");
const w=(p:string,c:string)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,c)};
mkdirSync(cwd,{recursive:true});
w(join(cwd,".pi","extensions","proj-ext.ts"),`export default function(pi:any){pi.registerTool({name:"proj_ext_tool",description:"x",parameters:{},execute:async()=>"x"})}\n`);
w(join(cwd,".pi","prompts","proj-prompt.md"),"---\ndescription: proj\n---\nX\n");
w(join(cwd,".pi","themes","proj-theme.json"),JSON.stringify({name:"proj-theme",colors:{fg:"#fff",bg:"#000"}})+"\n");
w(join(cwd,".pi","skills","proj-skill","SKILL.md"),"---\nname: proj-skill\ndescription: p\n---\n");
const mk=(s:any)=>buildLoader(s,{cwd,agentDir,settingsManager:SettingsManager.inMemory({})});
for (const [t,s] of [["① 空",{}],["② exts=[]",{extensions:[]}],["③ exts=[] skills=[]",{extensions:[],skills:[]}]] as any) {
  const l = await mk(s);
  console.log(`${t}: exts=${JSON.stringify(l.getExtensions().extensions.map(e=>e.path.replace(root,"")))} prompts=${JSON.stringify(l.getPrompts().prompts.map((p:any)=>p.name))} themes=${JSON.stringify(l.getThemes().themes.map((t:any)=>t.name))} skills=${JSON.stringify(l.getSkills().skills.map(s=>s.name))}`);
}
