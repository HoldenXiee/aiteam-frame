// 独立复现：环境 agentDir/APPEND_SYSTEM.md 是否被 loader 恒传的空数组静默抑制？
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLab } from "../src/index.ts";
import { writeModelsJson } from "../test/faux-models.ts";

const root = mkdtempSync(join(tmpdir(), "aiteam-verify9-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
const w = (p: string, c: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
const MARK = "APPEND_FROM_AGENTDIR_XYZ";
w(join(agentDir, "APPEND_SYSTEM.md"), MARK + "\n");
mkdirSync(cwd, { recursive: true });
writeModelsJson(agentDir, "http://127.0.0.1:1", "echo");
process.env.PI_OFFLINE = "1";

const lab = await createLab({ agentDir, cwd, modelNetwork: false });

// 1) 环境声明了 APPEND_SYSTEM.md，inspectEnv 报了什么？
const rep = await lab.inspectEnv();
console.log("1) inspectEnv.appendSystemPromptFiles =", JSON.stringify(rep.appendSystemPromptFiles));
console.log("   inspectEnv.warnings 里有 APPEND 字样？", rep.warnings.filter((x) => /APPEND/i.test(x)));

// 2) 真 agent（无 role）的 systemPrompt 里有没有 APPEND 内容？
const a = await lab.createAgent({ model: "faux/echo", id: "no-role" });
const sp: string = a.io.raw.systemPrompt ?? "";
console.log("2) 无 role: systemPrompt len =", sp.length, "| APPEND 内容在？", sp.includes(MARK));

// 3) 有 role 时呢（role 走 appendSystemPrompt，会把发现的那条也带上吗？）
const b = await lab.createAgent({ model: "faux/echo", id: "with-role", role: "ROLE_ABC" });
const sp2: string = b.io.raw.systemPrompt ?? "";
console.log("3) 有 role: ROLE 在？", sp2.includes("ROLE_ABC"), "| APPEND(环境) 在？", sp2.includes(MARK));

// 4) 直接看底层 loader
console.log("4) raw loader getAppendSystemPromptSources =", JSON.stringify(a.io.raw.loader.getAppendSystemPromptSources()));

a.dispose(); b.dispose();
