// verify:8 补充冒烟：把 lab.cwd 指到真实仓库工作区（其祖先链上有 AGENTS.md），看真仓库的指令文档是否进 system。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLab } from "../src/index.ts";
import { writeModelsJson } from "../test/faux-models.ts";
import { startFaux } from "../test/faux-server.ts";

// 真实仓库工作区：D:/space/aiteam/test 有 AGENTS.md
const realCwd = process.cwd();
console.log("真实仓库 cwd:", realCwd, "有 AGENTS.md:", (await import("node:fs")).existsSync(join(realCwd, "AGENTS.md")));

const root = mkdtempSync(join(tmpdir(), "aiteam-v8b-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
const srv = await startFaux();
writeModelsJson(agentDir, srv.baseUrl, "echo");
process.env.PI_OFFLINE = "1";

const lab = await createLab({ agentDir, cwd: realCwd, modelNetwork: false });
const a = await lab.createAgent({ model: "faux/echo", id: "REAL" });
const sp: string = a.io.raw.systemPrompt ?? "";
// 真实仓库 AGENTS.md 的正文在 system 里有没有（取一段独特字符串）
console.log("system 含仓库 AGENTS.md 首行标记:", sp.includes("两条硬规则"));
console.log("loader.getAgentsFiles():", JSON.stringify(a.extensions.raw.loader.getAgentsFiles().agentsFiles.map((f: any) => f.path)));
a.dispose();
await srv.close();
