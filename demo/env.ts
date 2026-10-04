// demo 的环境：同一个环境目录，**两种 provider 可切**，幂等（反复调用拿到同一套路径）。
//
//   环境目录 = `demo/agent/`（= agentDir）—— 环境即目录、目录即配置：
//     进 git（人写的）：skills/<名>/SKILL.md · extensions/<名>.ts · README.md（规范见该目录 README）
//     动态（生成物）：  models.json（假 provider 地址：**端口随机 ⇒ 只能是生成物，不能签入**）
//                       auth.json（真模式唯一凭证，gitignored）· models-store.json · settings.json（pi 写）
//   cwd：             demo/work/（agent 在哪干活、产物落哪）
//
//   （默认）假 provider：本机 HTTP 服务，零成本、不需要 key、离线；
//   AITEAM_DEMO_REAL=1：用 demo **自己的**凭证 + 免费真模型（opencode-go/space-bunny-free）。
//
// 真模式两条血教训（细节见 demo/README.md）：**不碰宿主 `~/.pi/agent`**（pi 的 auth 存储读-改-写整个
// auth.json，实测曾把用户那里别的 provider 凭证抹掉）、**不借宿主的 key**（那会烧用户自己的额度）。
// 凭证只从 `AITEAM_DEMO_AUTH`（总是赢、坏了报错）或 `demo/agent/auth.json`（推荐，gitignored）来。
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FAUX_MODEL_ALT_ID, FAUX_MODEL_ID, FAUX_MODEL_ALT_REF, FAUX_MODEL_REF, writeModelsJson } from "../examples/lib/faux-models.ts";
import { startFaux } from "../examples/lib/faux-server.ts";

/** 真模型模式下用的模型（免费档）。要换别的：设 AITEAM_DEMO_MODEL。 */
export const REAL_MODEL_REF = process.env.AITEAM_DEMO_MODEL ?? "opencode-go/space-bunny-free";

/** 只回答「这个 demo 的环境在哪」；字段语义见 `demo/agent/README.md` */
export interface DemoEnv {
  agentDir: string; cwd: string; baseUrl?: string; real: boolean; model: string; altModel: string;
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

const setup = (): Promise<DemoEnv> => (process.env.AITEAM_DEMO_REAL === "1" ? setupReal() : setupFaux());

/**
 * 真模式：用 **demo 自己的凭证**，不读也不写宿主 pi 目录。凭证**复制**进 `demo/agent/auth.json`
 * 而不是直接指源文件：pi 会对 agentDir 里的 auth.json 读-改-写（刷新 token、写回）。
 *
 * 判「已在位」用 `hasCredentials()` 而不是 `existsSync()`：pi 会在**任何** agentDir 里 ensure 一个
 * `{}` 空壳（`auth-storage.js` 的 `ensureFileExists`，跑过一次假模式就有），只判存在会把
 * 「两处都没有 ⇒ 明确报错」这条路堵死。显式指定的那份**永远赢**，所以它坏掉时就报错 —— 不能静默退回
 * 别的来源，那会变成「按 README 换了 key，烧的却是旧账号」。
 */
async function setupReal(): Promise<DemoEnv> {
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
      `真模式需要 demo 自己的凭证，但两处都没有：\n` +
        `  · ${target}（推荐：把 auth.json 放这里，gitignored）\n` +
        `  · 或 AITEAM_DEMO_AUTH=/path/to/auth.json\n` +
        `  · 或干脆不设 AITEAM_DEMO_REAL，跑离线假 provider（默认，零成本）\n` +
        `  · 注意：别指向宿主 ~/.pi/agent —— pi 会整文件写回，把那里别的 provider 凭证抹掉`,
    );
  }
  return { agentDir: dir, cwd, real: true, model: REAL_MODEL_REF, altModel: REAL_MODEL_REF };
}

/** 这份 auth.json 里真有凭证吗？`{}`（pi 造的空壳）不算 —— 见 setupReal 的注释。 */
function hasCredentials(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

/** 假 provider：写一份指向本机服务的 models.json，全程离线、零成本。 */
async function setupFaux(): Promise<DemoEnv> {
  const cwd = workDir();
  const dir = agentDir();
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const faux = await startFaux();
  // 两个模型：echo 给普通轮次，echo-alt（reasoning:true）给 setThinking 这类要合法档位的检查
  writeModelsJson(dir, faux.baseUrl, [FAUX_MODEL_ID, FAUX_MODEL_ALT_ID]);
  return { agentDir: dir, cwd, baseUrl: faux.baseUrl, real: false, model: FAUX_MODEL_REF, altModel: FAUX_MODEL_ALT_REF };
}
