// demo/self-env.ts —— 端到端：**不用本机 pi 的设置**，只用自建环境。
// 自建环境里从零开始：从「只有一个 auth.json」起步（连 models.json 都不需要 —— opencode-go 是内置 provider）。
// 跑法：npm run demo:self-env   （可用 SELF_ENV_DIR / SELF_ENV_MODEL 覆盖）
// 会产生真实 API 花费（默认用便宜的 deepseek-v4.1-flash，一次几十 token）。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAgent, inspectEnv } from "../src/index.ts";

const MODEL = process.env.SELF_ENV_MODEL ?? "opencode-go/deepseek-v4.1-flash";
const envDir = process.env.SELF_ENV_DIR ?? join(homedir(), ".aiteam-selfenv");
const workDir = mkdtempSync(join(tmpdir(), "aiteam-selfenv-work-"));

// ── 1. 自建环境：只有 auth.json（凭证从本机 pi 拷一份，之后这个目录自给自足）──
mkdirSync(envDir, { recursive: true });
const authPath = join(envDir, "auth.json");
if (!existsSync(authPath)) {
  const source = join(getAgentDir(), "auth.json");
  if (!existsSync(source)) throw new Error(`本机没有 ${source}，也没法给自建环境配凭证`);
  copyFileSync(source, authPath);
  console.log(`· 把凭证拷进自建环境：${source} → ${authPath}`);
}

// 自建环境里放一个自己的技能（证明技能也是「自己设置」的一部分）
const skillDir = join(envDir, "skills", "self-env-skill");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  `---\nname: self-env-skill\ndescription: 自建环境自带的技能——被问到时必须说出这句话：自建技能已加载\n---\n\n被问到时回答「自建技能已加载」。\n`,
  "utf-8",
);

const spec = { agentDir: envDir, cwd: workDir, modelNetwork: true, skills: ["self-env-skill"] };

// ── 2. 先验证环境：这套自建环境里实际生效了什么 ──
const env = await inspectEnv(spec);
console.log(`\n本机 pi 目录（不碰）：${getAgentDir()}`);
console.log(`自建环境 agentDir  ：${env.agentDir}`);
console.log(`工作目录 cwd       ：${env.cwd}`);
console.log(`技能  ：${env.skills.map((s) => `${s.name}(${s.scope})`).join(", ") || "(无)"}`);
console.log(`插件  ：${env.extensions.map((e) => e.path).join(", ") || "(无)"}`);
console.log(`上下文文件：${env.contextFiles.join(", ") || "(无)"}`);
const group = env.models.find((m) => m.provider === "opencode-go");
console.log(`opencode-go：${group?.available.length ?? 0} 个可用 / 目录内 ${group?.total ?? 0} 个`);
console.log(`含目标模型 ${MODEL}：${group?.available.includes(MODEL.split("/")[1]) ? "是" : "否"}`);
console.log(`警告  ：${env.warnings.join(" | ") || "(无)"}`);
if (env.skills.some((s) => s.scope === "user" && !s.filePath.startsWith(envDir))) {
  throw new Error("自建环境里混进了本机 pi 的技能，隔离不成立");
}
if (!env.skills.some((s) => s.name === "self-env-skill")) throw new Error("自建环境的技能没被加载");

// ── 3. 真跑一轮：模型 + read 工具 + 自建技能 ──
const factsPath = join(workDir, "facts.txt");
const secret = "端到端通过-2026";
writeFileSync(factsPath, `${secret}\n`, "utf-8");

const agent = await createAgent({
  ...spec,
  model: MODEL,
  role: "你是执行者。要读文件就用 read 工具，回答尽量短。",
  tools: ["read"],
});
const result = await agent.prompt(
  `用 read 读 ${factsPath}，然后只回一行：文件内容 + 「，」 + 你那条技能要求你说的话。`,
);
console.log(`\n模型回复：${result.text.trim()}`);
console.log(`用量：${result.usage.totalTokens} tokens，$${result.usage.cost.total.toFixed(6)}`);
console.log(`本轮状态：${agent.status}${result.error ? `（出错：${result.error}）` : ""}`);

agent.dispose();
const ok = result.text.includes(secret) && result.text.includes("自建技能已加载");
console.log(ok ? "\n端到端通过：自建环境 + opencode-go 模型 + 工具 + 技能全部生效" : "\n未达预期，见上面输出");
process.exit(ok ? 0 : 1);
