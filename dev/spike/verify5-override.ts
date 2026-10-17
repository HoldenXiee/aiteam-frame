import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "v5-"));
const work = join(root, "work");
const agentDir = join(root, "agent");
mkdirSync(join(work, "deep"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(root, "AGENTS.md"), "ANCESTOR-ROOT\n");
writeFileSync(join(work, "AGENTS.override.md"), "OVERRIDE-WORK\n");
writeFileSync(join(work, "AGENTS.md"), "ANCESTOR-WORK\n");

const files = loadProjectContextFiles({ cwd: join(work, "deep"), agentDir });
for (const f of files) console.log(" ·", f.path.replace(root, "<tmp>"), "=>", JSON.stringify(f.content.trim()));
console.log("work/ 同目录：AGENTS.override.md 生效 =", files.some(f => f.content.includes("OVERRIDE-WORK")));
console.log("work/ 同目录：AGENTS.md 被遮蔽 =", !files.some(f => f.content.includes("ANCESTOR-WORK")));
console.log("祖先 root 仍出现（override 不遮蔽祖先） =", files.some(f => f.content.includes("ANCESTOR-ROOT")));
