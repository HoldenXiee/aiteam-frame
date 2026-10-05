// 探针 2 · 语义核实：
//  (1) AGENTS.override.md 是「同目录内排第一」还是「遮蔽祖先整条链」？
//  (2) 上溯到哪停？—— 是不是一路到盘根（会读到宿主用户目录的 AGENTS.md）？
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

const short = (p: string) => p.replace(homedir(), "~");

// ── (1) 同目录优先级 + 是否遮蔽祖先 ──
const root = mkdtempSync(join(tmpdir(), "aiteam-ctx-"));
const agentDir = join(root, "lab-agent");
const cwd = join(root, "work", "deep");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });

writeFileSync(join(root, "AGENTS.md"), "ANCESTOR-ROOT\n");
writeFileSync(join(root, "work", "AGENTS.md"), "ANCESTOR-WORK\n");
writeFileSync(join(root, "work", "AGENTS.override.md"), "OVERRIDE-WORK\n");
writeFileSync(join(cwd, "AGENTS.md"), "LEAF-AGENTS\n");
writeFileSync(join(cwd, "CLAUDE.md"), "LEAF-CLAUDE\n");

const files = loadProjectContextFiles({ cwd, agentDir });
console.log("=== (1) override 语义 ===");
for (const f of files) console.log("  ·", short(f.path), "=>", JSON.stringify(f.content.trim()));
console.log("  work/ 同目录：AGENTS.override.md 生效 =", files.some((f) => f.content.includes("OVERRIDE-WORK")));
console.log("  work/ 同目录：AGENTS.md 被遮蔽    =", !files.some((f) => f.content.includes("ANCESTOR-WORK")));
console.log("  祖先 root 仍出现（override 不遮蔽祖先）=", files.some((f) => f.content.includes("ANCESTOR-ROOT")));
console.log("  leaf cwd：CLAUDE.md 被 AGENTS.md 遮蔽 =", !files.some((f) => f.content.includes("LEAF-CLAUDE")));

// ── (2) 上溯到哪停 ──
console.log("\n=== (2) 上溯范围 ===");
// 盘根/用户目录上是否真有会被读到的上下文文件
const HOME = homedir();
for (const name of ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"]) {
  console.log(`  ${short(join(HOME, name))} 存在 = ${existsSync(join(HOME, name))}`);
}
console.log("  上溯是否越过用户目录到盘根（如 C:/AGENTS.md）：");
console.log(`    C:/AGENTS.md 存在 = ${existsSync("C:/AGENTS.md")}`);
console.log("    源码 resource-loader.js:175-186 的 while 循环用 dirname() 直到 parentDir===currentDir 才停 → 会一直上溯到盘根");
