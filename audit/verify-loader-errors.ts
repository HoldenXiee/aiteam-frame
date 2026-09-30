// 复核 06-failures 的 E3 根因：扩展加载失败的原因存在于 loader.getExtensions().errors 里，而库从不读它
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "aiteam-err-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");

for (const [label, file, body] of [
  ["路径不存在", join(root, "nope.ts"), null],
  ["语法错误", join(root, "bad.ts"), "export default function (pi) { this is not valid ((( "],
  ["正常", join(root, "good.ts"), "export default function (pi) { pi.registerTool({ name:'good_tool', label:'G', description:'d', parameters:{type:'object',properties:{}}, execute: async()=>({content:[{type:'text',text:'ok'}],details:{}}) }); }"],
] as const) {
  if (body !== null) writeFileSync(file, body);
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory({}), additionalExtensionPaths: [file],
  });
  await loader.reload();
  const g = loader.getExtensions() as any;
  console.log(`\n── ${label} ──`);
  console.log(`  keys = ${JSON.stringify(Object.keys(g))}`);
  console.log(`  extensions = ${JSON.stringify(g.extensions.map((e: any) => ({ path: e.path.split(/[\/]/).pop(), tools: [...e.tools.keys()] })))}`);
  console.log(`  errors = ${JSON.stringify(g.errors)}`);
  console.log(`  warnings = ${JSON.stringify(g.warnings)}`);
}
