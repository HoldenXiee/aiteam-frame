// smoke.ts —— 三步确认「这套东西在这台机器上活着」。约 $0.0002。
//
//   node demo/smoke.ts
//
// 三步：① 环境自检（0 成本，不建 agent）② 库能跑（真模型一次）③ 书在读得到的位置。
// 任何一步 ✗ 都会告诉你原因和出路 —— 不静默失败。
import { createLab } from "../src/index.ts";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const agentDir = join(here, "agent");
const cwd = join(here, "work");
const MODEL = "opencode-go/deepseek-v4.1-flash";

let failed = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string, why: string) => { failed++; console.log(`  ✗ ${m}\n      → ${why}`); };

// ── ① 环境自检（零成本）──────────────────────────────────────
console.log("[1] 环境自检（不建 agent、不花钱）");
if (!existsSync(join(agentDir, "auth.json"))) {
  bad("凭证", `没有 ${join(agentDir, "auth.json")} —— 放一份 {"opencode-go":{"type":"api_key","key":"…"}} 进去`);
} else {
  const lab = await createLab({ agentDir, cwd, modelNetwork: false, modelAllow: [MODEL], defaultModel: MODEL });
  const env = await lab.inspectEnv();
  const [provider, id] = MODEL.split("/");
  const group = env.models.find((g) => g.provider === provider);
  if (group?.available.includes(id)) ok(`模型 ${MODEL} 在位`);
  else bad(`模型 ${MODEL}`, `不在可用列表里 —— 凭证没配 / id 拼错 / provider 名不对`);

  if (env.warnings.length) console.log(`      ⚠ 环境有 ${env.warnings.length} 条 warning：${env.warnings.join("；")}`);
  ok(`技能 ${env.skills.length} 个 · 扩展 ${env.extensions.length} 个 · 上下文文件 ${env.contextFiles.length} 个`);

  // ── ② 库能跑（真模型一次）────────────────────────────────
  console.log("[2] 库能跑：真模型回一句话");
  const agent = await lab.createAgent({ id: "smoke", model: MODEL, permissions: { only: [] } });
  const r = await agent.io.prompt("只回答两个字：可以");
  await agent.dispose();
  if (r.error) bad("模型调用", r.error);
  else ok(`模型说「${r.text.trim()}」· 成本 $${r.usage.cost.total.toFixed(6)}`);
}

// ── ③ 书在读得到的位置 ─────────────────────────────────────
console.log("[3] 书");
const book = join(root, "book");
if (!existsSync(join(book, "全书.md"))) bad("全书.md", "没有合并本 —— 用 book/src/ 下的原文");
else ok(`book/全书.md ${(statSync(join(book, "全书.md")).size / 1024).toFixed(0)} KB`);
const chapters = existsSync(join(book, "src")) ? readdirSync(join(book, "src", "05-集群产出")).filter((f) => f.endsWith(".md")).length : 0;
ok(`book/src/05-集群产出/ ${chapters} 章`);

console.log(failed === 0 ? "\n全部通过 —— 可以用 src/index.ts 开工了。先读 AGENTS.md。" : `\n${failed} 项没通过，见上面的出路。`);
// ★ 不调 process.exit()：模型运行时还有异步句柄在收尾，硬退出会在 Windows 上触发
//   libuv 断言（`!(handle->flags & UV_HANDLE_CLOSING)`）。设 exitCode 让它自然退出。
process.exitCode = failed === 0 ? 0 : 1;
