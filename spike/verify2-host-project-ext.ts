// 独立复核：cwd/.pi/extensions（宿主项目级）在 spec.extensions 不写时是否连工具一起注入 agent。
// 走库真实入口 createLab / lab.createAgent，对着本机假 provider（零成本）。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLab } from "../src/index.ts";
import { faux, fauxAgentDir, sentTools, FAUX_MODEL_REF } from "../test/helpers.ts";

process.env.PI_OFFLINE = "1";

const cwd = mkdtempSync(join(tmpdir(), "aiteam-verify2-"));
const extDir = join(cwd, ".pi", "extensions");
mkdirSync(extDir, { recursive: true });
writeFileSync(
  join(extDir, "leak-ext.ts"),
  `import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool(defineTool({
    name: "zz_host_project_tool",
    label: "zz_host_project_tool",
    description: "宿主项目扩展注册的工具",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  }));
}
`,
);

const lab = await createLab({ agentDir: fauxAgentDir, cwd, modelNetwork: false });

// 1) spec 不写 extensions
const a = await lab.createAgent({ model: FAUX_MODEL_REF });
await a.io.prompt("hi");
const unspecified = sentTools();
console.log("[1] spec 不写 extensions        tools =", unspecified.join(", "));
console.log("    includes zz_host_project_tool =", unspecified.includes("zz_host_project_tool"));
console.log("    extensions.list paths          =", a.extensions.list().map((e) => e.path).join(" | "));
a.dispose();

// 2) spec.extensions: []
const b = await lab.createAgent({ model: FAUX_MODEL_REF, extensions: [] });
await b.io.prompt("hi");
const empty = sentTools();
console.log("[2] spec.extensions: []         tools =", empty.join(", "));
console.log("    includes zz_host_project_tool =", empty.includes("zz_host_project_tool"));
b.dispose();

// 3) spec.extensions: [某个无关扩展] —— 宿主项目扩展该被裁掉
const other = join(cwd, "unrelated-ext.ts");
writeFileSync(
  other,
  `import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool(defineTool({
    name: "zz_declared_only", label: "zz_declared_only", description: "显式声明",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  }));
}
`,
);
const c = await lab.createAgent({ model: FAUX_MODEL_REF, extensions: [other] });
await c.io.prompt("hi");
const declaredOnly = sentTools();
console.log("[3] spec.extensions:[unrelated]  tools =", declaredOnly.join(", "));
console.log("    host leak present =", declaredOnly.includes("zz_host_project_tool"),
  "/ declared present =", declaredOnly.includes("zz_declared_only"));
c.dispose();

await faux.close();
