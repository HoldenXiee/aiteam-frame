// 探针 3 · 修法可行性：pi 的 DefaultResourceLoader 有没有能关掉/过滤上下文文件的开关？
// 直接问 pi SDK（不经 src/），验证：
//   (a) noContextFiles: true  → 一个 contextFile 都没有
//   (b) agentsFilesOverride    → 能按路径过滤，只留实验室声明范围内的
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

process.env.PI_OFFLINE = "1";

const root = mkdtempSync(join(tmpdir(), "aiteam-fix-"));
const agentDir = join(root, "lab-agent");
const cwd = join(root, "work", "deep");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(root, "AGENTS.md"), "ANCESTOR-LEAK\n");
writeFileSync(join(agentDir, "AGENTS.md"), "LAB-AGENTDIR\n");

async function load(opts: object) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    ...opts,
  });
  await loader.reload();
  return loader.getAgentsFiles().agentsFiles.map((f) => f.path.replace(root, "<root>"));
}

console.log("基线（当前 aiteam 走的路）     :", await load({}));
console.log("noContextFiles: true          :", await load({ noContextFiles: true }));
console.log(
  "agentsFilesOverride 只留 agentDir:",
  await load({
    agentsFilesOverride: (base) => ({
      agentsFiles: base.agentsFiles.filter((f) => f.path.startsWith(agentDir)),
    }),
  }),
);
console.log(
  "agentsFilesOverride 只留实验室两目录 (cwd/agentDir):",
  await load({
    agentsFilesOverride: (base) => ({
      agentsFiles: base.agentsFiles.filter((f) => f.path.startsWith(agentDir) || f.path.startsWith(cwd)),
    }),
  }),
);
