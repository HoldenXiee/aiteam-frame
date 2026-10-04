// demo 的环境：`demo/agent/` 就是 agentDir —— 环境即目录、目录即配置。
//
//   进 git（人写的）：  skills/<名>/SKILL.md · extensions/<名>.ts · README.md（规范见该目录 README）
//   动态（生成物）：    auth.json（**凭证**，gitignored）· models-store.json · settings.json（pi 写）
//   cwd：               demo/work/（agent 在哪干活、产物落哪）
//
// **这个 demo 用真模型**（默认 `opencode-go/space-bunny-free`，免费档）：
//   · 换模型：AITEAM_DEMO_MODEL=provider/id
//   · 换凭证：AITEAM_DEMO_AUTH=/path/to/auth.json（会被**复制**进 demo/agent/auth.json，原件只读）
//   · 没凭证会**明确报错**，不静默退回别的来源
//
// 真模式的唯一一条硬约束（血教训，细节见 demo/README.md）：**不碰宿主 `~/.pi/agent`** ——
// pi 的 auth 存储读-改-写整个 auth.json，实测曾把用户那里别的 provider 凭证抹掉。
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 用哪个模型。默认免费档；换别的：设 AITEAM_DEMO_MODEL。 */
export const REAL_MODEL_REF = process.env.AITEAM_DEMO_MODEL ?? "opencode-go/space-bunny-free";

/** 只回答「这个 demo 的环境在哪」；字段语义见 `demo/agent/README.md` */
export interface DemoEnv {
  agentDir: string; cwd: string; real: true; model: string;
}

let cached: Promise<DemoEnv> | undefined;
/** 幂等：同一个进程里连调两次拿到**同一个** promise；跨进程拿到同一套路径。 */
export function ensureEnv(): Promise<DemoEnv> {
  return (cached ??= setup());
}

/** 环境目录（= agentDir）。**相对本文件解析** —— 这是「复制 demo/ 就复制了环境」的全部机关：
 *  改成绝对路径或 process.cwd() 推导，副本就会去用原 demo 的环境。 */
const agentDir = (): string => join(import.meta.dirname, "agent");
/** cwd：agent 的工作目录与产物落点 */
const workDir = (): string => join(import.meta.dirname, "work");

/**
 * 凭证**复制**进 `demo/agent/auth.json` 而不是直接指源文件：pi 会对 agentDir 里的 auth.json
 * 读-改-写（刷新 token、写回），不能让它去动你给的那份源文件。
 *
 * 判「已在位」用 `hasCredentials()` 而不是 `existsSync()`：pi 会在**任何** agentDir 里 ensure 一个
 * `{}` 空壳（`auth-storage.js` 的 `ensureFileExists`），只判存在会把「没有凭证 ⇒ 明确报错」这条路
 * 堵死。显式指定的那份**永远赢**，所以它坏掉时就报错 —— 不能静默退回别的来源，
 * 那会变成「按 README 换了 key，烧的却是旧账号」。
 */
async function setup(): Promise<DemoEnv> {
  const cwd = workDir();
  const dir = agentDir();
  const target = join(dir, "auth.json");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });

  const explicit = process.env.AITEAM_DEMO_AUTH;
  if (explicit && !hasCredentials(explicit)) {
    throw new Error(
      `AITEAM_DEMO_AUTH 指的那份不可用：${explicit}\n` +
        `  · 它必须是一个**含凭证的 JSON 对象**（pi 的空壳 \`{}\` 不算）\n` +
        `  · 或干脆不设 AITEAM_DEMO_AUTH，改用 ${target}（推荐）`,
    );
  }
  if (explicit) {
    copyFileSync(explicit, target);
  } else if (!hasCredentials(target)) {
    throw new Error(
      `这个 demo 跑真模型，需要凭证，但没有：\n` +
        `  · 推荐：把 auth.json 写到 ${target}（gitignored）\n` +
        `  · 或用 AITEAM_DEMO_AUTH=/path/to/auth.json 指一份\n` +
        `  · 想换模型：AITEAM_DEMO_MODEL=provider/id（默认 ${REAL_MODEL_REF}）\n` +
        `  · 注意：别指向宿主 ~/.pi/agent —— pi 会整文件写回，把那里别的 provider 凭证抹掉`,
    );
  }
  return { agentDir: dir, cwd, real: true, model: REAL_MODEL_REF };
}

/** 这份 auth.json 里真有凭证吗？`{}`（pi 造的空壳）不算 —— 见 setup 的注释。 */
function hasCredentials(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}
