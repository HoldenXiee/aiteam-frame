// 判据 B 探针 3：models.json / auth.json / settings.json / package.json(node_modules pi package)
// 是否被 spec 管得住。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLab } from "../src/index.ts";
import { writeModelsJson } from "../test/faux-models.ts";

const root = mkdtempSync(join(tmpdir(), "aiteam-isoB3-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
const w = (p: string, c: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };

// models.json 里放 3 个模型
mkdirSync(cwd, { recursive: true });
writeModelsJson(agentDir, "http://127.0.0.1:1", ["echo", "echo-alt", "third-model"]);
// auth.json：给 faux 之外的 provider 放个凭证，看 spec 能不能不看它
w(join(agentDir, "auth.json"), JSON.stringify({ "some-other-provider": { type: "api_key", key: "SOME_KEY_12345" } }));
// settings.json：想用 setting 关掉环境里的扩展（agentDir/extensions）
w(join(agentDir, "extensions", "gen-ext.ts"),
  `export default function (pi: any) { pi.registerTool({ name: "gen_dir_tool", description: "x", parameters: {}, execute: async () => "x" }); }\n`);
w(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-*"] }));
process.env.PI_OFFLINE = "1";

const lab = await createLab({ agentDir, cwd, modelNetwork: false });
console.log("root:", root);
console.log("spec.model 能否选到 models.json 之外的模型（能当选＝范围不由 spec 定）:");
for (const ref of ["faux/echo", "faux/third-model"]) {
  try {
    const a = await lab.createAgent({ model: ref, id: "m-" + ref.replace(/\W/g, "_"), skills: [], extensions: [] });
    console.log(`   ${ref} → 建成功，current=${a.model.current?.id}`);
    a.dispose();
  } catch (e) { console.log(`   ${ref} → 抛错: ${(e as Error).message}`); }
}
try {
  const a = await lab.createAgent({ model: "nope/does-not-exist", skills: [], extensions: [] });
  console.log(`   nope/does-not-exist → 建成功?! current=${a.model.current?.id}`);
  a.dispose();
} catch (e) { console.log(`   nope/does-not-exist → 抛错: ${(e as Error).message.slice(0, 90)}`); }

// model.available 是环境给的，spec 能否收窄它？
const a = await lab.createAgent({ model: "faux/echo", id: "AVAIL", skills: [], extensions: [] });
console.log("model.available（spec 只选了一个，available 仍是全环境）:", a.model.available.map((m: any) => `${m.provider}/${m.id}`).join(", "));
console.log("agentDir/settings.json 里 extensions:['-*'] 有没有关掉 agentDir/extensions 的自动发现？");
console.log("   实际扩展:", JSON.stringify(a.extensions.list().map((e: any) => e.path.split(/[\\/]/).pop())));
console.log("   实际活跃工具:", JSON.stringify(a.io.raw.getActiveToolNames()));
a.dispose();

// inspectEnv 的作用域：它能不能看见 prompts/themes（也是实验室资源）
const rep = await lab.inspectEnv();
console.log("inspectEnv 字段:", Object.keys(rep).join(", "));
console.log("   contexts:", JSON.stringify(rep.contextFiles.map((f) => f.replace(root, ""))));
console.log("   warnings:", JSON.stringify(rep.warnings));
