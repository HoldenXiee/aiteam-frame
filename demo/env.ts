// demo/env.ts —— 「本地设置的环境」：这个 demo 不碰本机 pi，整套环境就在 demo/env/ 里。
//
// demo/env/ 就是一个 pi 的 agentDir，和 ~/.pi/agent 同构：
//   auth.json                凭证（不进 git：从本机 pi 拷一份，或照 auth.json.example 手填）
//   skills/<名字>/SKILL.md    技能（按名字注入给 agent）
//   extensions/*.ts           插件（自动发现：注册的工具、钩子都生效）
//
// 被 run.ts 复用，也能单独跑：npm run demo:env —— 只准备 + 体检环境，不花模型钱。
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { inspectEnv, type EnvReport, type MemberSpec } from "../src/index.ts";
import { say } from "./log.ts";

export const DEMO_DIR = fileURLToPath(new URL(".", import.meta.url));
/** 这个 demo 自己的环境（agentDir）—— 里面装什么，这个 demo 就生效什么 */
export const ENV_DIR = join(DEMO_DIR, "env");
/** 集群的工作目录（cwd）—— 全队共用它，「共享黑板」就是一个共用文件 */
export const WORK_DIR = join(DEMO_DIR, "work");
export const AUTH_PATH = join(ENV_DIR, "auth.json");

/** 用哪个模型跑这个 demo。换模型只改这一个环境变量：DEMO_MODEL=provider/id */
export const MODEL = process.env.DEMO_MODEL ?? "opencode-go/deepseek-v4.1-flash";

/** 这个 demo 自带的技能名（改 demo/env/skills/ 下的目录名时记得同步） */
export const SKILL_NAME = "cluster-check";

/** 交给库的环境声明：自建 agentDir + 自己的工作目录 + 按名字注入自带的技能 */
export const envSpec: MemberSpec = {
  agentDir: ENV_DIR,
  cwd: WORK_DIR,
  modelNetwork: true,
  skills: [SKILL_NAME],
};

/** 暗号：SKILL.md 与 work/AGENTS.md 各要求模型说一句，两句都回来说明两者都真生效了 */
export const SKILL_PASSPHRASE = "环境自检技能已生效";
export const AGENTS_PASSPHRASE = "工作目录守则已加载";

/** 路径是否落在某个目录里（Windows 盘符大小写与斜杠方向都归一化后再比） */
export function under(file: string, dir: string): boolean {
  const f = resolve(file).replace(/\\/g, "/").toLowerCase();
  const d = resolve(dir).replace(/\\/g, "/").toLowerCase();
  return f === d || f.startsWith(`${d}/`);
}

/**
 * 把环境准备到「能跑」：目录建齐 + 凭证就位。
 * 凭证优先级：demo/env/auth.json（demo 自己带） → 本机 pi 拷一份 → OPENCODE_API_KEY 环境变量。
 * 返回实际走的是哪条路 —— 这件事必须说出来，不能静默。
 */
export function prepareEnv(): string[] {
  mkdirSync(join(ENV_DIR, "skills"), { recursive: true });
  mkdirSync(join(ENV_DIR, "extensions"), { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });

  if (existsSync(AUTH_PATH)) return [`凭证：${AUTH_PATH}（demo 自己带一份，本机 pi 不参与）`];

  const from = join(getAgentDir(), "auth.json");
  if (existsSync(from)) {
    copyFileSync(from, AUTH_PATH);
    return [`凭证：从本机 pi 拷了一份 → ${AUTH_PATH}（从这一句起只认这一份）`];
  }
  if (process.env.OPENCODE_API_KEY) return ["凭证：环境变量 OPENCODE_API_KEY（不落盘）"];

  throw new Error(
    `没有凭证。二选一：\n` +
      `    A. 手写 ${AUTH_PATH}，内容照 ${join(ENV_DIR, "auth.json.example")}\n` +
      `    B. 先设环境变量再跑：OPENCODE_API_KEY=<你的 key>`,
  );
}

/** 体检：这套环境里实际生效了什么（技能 / 插件 / 可用模型 / 上下文文件） */
export async function readDemoEnv(): Promise<EnvReport> {
  return inspectEnv(envSpec);
}

/** 单独跑 `npm run demo:env` 时的入口 */
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  say(`自建环境体检 —— ${ENV_DIR}（本机 pi：${getAgentDir()}，不参与）`);
  for (const line of prepareEnv()) say(`  ${line}`);
  const env = await readDemoEnv();
  say(`  工作目录：${env.cwd}`);
  say(`  技能：${env.skills.map((s) => `${s.name}(${s.scope})`).join("、") || "(无)"}`);
  say(`  插件：${env.extensions.map((e) => `${e.path}[tools=${e.tools.join(",")}]`).join("、") || "(无)"}`);
  say(`  上下文文件：${env.contextFiles.join("、") || "(无)"}`);
  say(`  可用模型：${env.models.map((m) => `${m.provider} ${m.available.length} 个`).join("、") || "(无)"}`);
  say(`  警告：${env.warnings.join(" | ") || "(无)"}`);
  const ok =
    env.skills.some((s) => s.name === SKILL_NAME && under(s.filePath, ENV_DIR)) &&
    env.skills.every((s) => under(s.filePath, ENV_DIR)) &&
    env.extensions.some((e) => under(e.path, ENV_DIR) && e.tools.includes("env_probe")) &&
    env.models.some((m) => m.available.includes(MODEL.split("/")[1] ?? ""));
  say(ok ? "\n环境 OK：技能 / 插件 / 模型都从 demo/env/ 生效，本机 pi 没混进来。" : "\n环境不 OK，见上面输出。");
  process.exit(ok ? 0 : 1);
}
