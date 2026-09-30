import { SettingsManager, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "probe-ext-"));
writeFileSync(join(root, "bad.ts"), "export default function (pi) { this is not valid (((\n");
writeFileSync(join(root, "good.ts"), 'export default function (pi) { pi.registerTool({ name: "good_tool", label: "g", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }); }\n');
for (const p of [[join(root,"bad.ts")],[join(root,"good.ts")],[join(root,"nope.ts")]]) {
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({}), additionalExtensionPaths: p });
  await loader.reload();
  const ex: any = loader.getExtensions();
  console.log("path=", p[0].split(/[\/]/).pop(), "keys=", Object.keys(ex));
  console.log("  extensions=", JSON.stringify((ex.extensions??[]).map((e:any)=>({path:e.path,tools:[...(e.tools?.keys?.()??[])]}))));
  for (const k of ["errors","diagnostics","warnings"]) if (ex[k]) console.log(`  ${k}=`, JSON.stringify(ex[k]).slice(0,500));
}
