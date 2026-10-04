// demo 的环境：**两种 provider 可切**，共用**同一个**环境目录。幂等 —— 反复调用拿到同一套路径。
//
//   （默认）假 provider：本机 HTTP 服务，零成本、不需要 key、离线；
//   AITEAM_DEMO_REAL=1：用 demo **自己的**凭证 + 一个免费模型（opencode-go/space-bunny-free）。
//
// ── 环境就是 `demo/agent/`（= agentDir）：哪些是仓库里的真文件、哪些是动态的 ──
//
//   进 git（人写的，可手改）：  skills/<名>/SKILL.md · extensions/<名>.ts · README.md（环境规范）
//   动态（本脚本或 pi 写）：    models.json（假 provider 地址；端口随机 ⇒ 只能是生成物，不能签入）
//                              auth.json（真模式唯一凭证，gitignored）
//                              models-store.json · settings.json（pi 自己写：前者联网时，后者只在你改过设置时）
//   cwd：                       demo/work/（agent 在哪干活、产物落哪）
//
// 为什么把环境做成仓库里的真目录：环境即目录、目录即配置。技能与扩展走 pi 的**自动发现**
// （放着就生效，不用写进 spec），所以「改环境 = 改文件」「review 环境 = 看 diff」。
// 每一档管什么见 `demo/agent/README.md`。
//
// `demo/run/` 是**遗留**：v2 早先的运行时产物目录，**不再写入**（旧 checkout 的残留由 .gitignore
// 与 tsconfig 的 exclude 忽略）。
//
// ── 真模式的两条硬约束（都是血教训，见 demo/README.md）──
//
// 1. **不碰宿主 `~/.pi/agent`**：pi 的 auth 存储是**读-改-写整个 auth.json**
//    （`auth-storage.js` 的 `withLock` 把 `fn(current)` 出的完整 `next` 整文件写回）。
//    曾经把 agentDir 指到宿主目录 ⇒ 实测把用户 `auth.json` 里另外两个 provider 的凭证抹掉。
// 2. **不借宿主的 key**：那样跑 demo 会烧用户自己的额度、用他本机 pi 的账号。
//    真模式只用 demo 自己的凭证（`demo/agent/auth.json`，或 AITEAM_DEMO_AUTH 指定的那份）。
//
// 想用自己的 key：写进 `demo/agent/auth.json`（推荐，gitignored），或设
// `AITEAM_DEMO_AUTH=/path/to/auth.json`（那份文件会被**复制**进 `demo/agent/auth.json`，原件只读）。
// **别指向宿主** —— 见上面第 1 条。
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FAUX_MODEL_ALT_ID,
  FAUX_MODEL_ID,
  FAUX_MODEL_ALT_REF,
  FAUX_MODEL_REF,
  writeModelsJson,
} from "../examples/lib/faux-models.ts";
import { startFaux } from "../examples/lib/faux-server.ts";

/** 真模型模式下用的模型（免费档）。要换别的：设 AITEAM_DEMO_MODEL。 */
export const REAL_MODEL_REF = process.env.AITEAM_DEMO_MODEL ?? "opencode-go/space-bunny-free";

export interface DemoEnv {
  /** **环境目录（就是 agentDir）**：`demo/agent/` —— 技能与扩展是仓库里的真文件 */
  agentDir: string;
  /** `demo/work/`：agent 的工作目录与产物落点 */
  cwd: string;
  /** **假模式**下本机服务的地址；真模式为 undefined */
  baseUrl?: string;
  /** true = 用真实凭证 + 免费真模型；false = 本机假 provider */
  real: boolean;
  /** 这个模式下 agent 该用的模型 ref */
  model: string;
  /** 升档用的模型 ref（写作阶段）。假模式是 echo-alt，真模式与 `model` 相同 */
  altModel: string;
}

let cached: Promise<DemoEnv> | undefined;

/** 幂等：同一个进程里连调两次拿到**同一个** promise；跨进程拿到同一套路径。 */
export function ensureEnv(): Promise<DemoEnv> {
  cached ??= setup();
  return cached;
}

async function setup(): Promise<DemoEnv> {
  if (process.env.AITEAM_DEMO_REAL === "1") return setupReal();
  return setupFaux();
}

/** 环境目录（**就是 agentDir**）：`demo/agent/` —— 技能与扩展是仓库里的真文件，见该目录的 README */
const agentDir = (): string => join(import.meta.dirname, "agent");
/** 工作目录与产物落点：`demo/work/` */
const workDir = (): string => join(import.meta.dirname, "work");

/**
 * 真模型：用 **demo 自己的凭证**，不读也不写宿主 pi 目录。
 *
 * 凭证**复制**进 `demo/agent/auth.json` 而不是直接指源文件：pi 会对 agentDir 里的 auth.json
 * 读-改-写（刷新 token、写回），不能让它去动你给的那份源文件。
 *
 * 判「已在位」用 `hasCredentials()` 而不是 `existsSync()`：pi 会在**任何** agentDir 里 ensure
 * 一个 `{}` 空壳（`auth-storage.js` 的 `ensureFileExists`，跑过一次假模式就有）。只判存在的话，
 * 那个空壳会把「三处都没有凭证 ⇒ 明确报错」这条路堵死，变成后面读不到模型。
 *
 * 来源优先级：`AITEAM_DEMO_AUTH`（显式指定，**总是赢**，坏了就报错）> `demo/agent/auth.json`
 * 里已在位的那份。
 */
async function setupReal(): Promise<DemoEnv> {
  const cwd = workDir();
  const dir = agentDir();
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });

  const target = join(dir, "auth.json");
  const explicit = process.env.AITEAM_DEMO_AUTH;
  if (explicit && !hasCredentials(explicit)) {
    // 显式指定的那份永远赢 —— 所以它坏掉时不能静默退回别的来源，那会变成「按 README 换了 key，{
    // 烧的却是旧账号」。
    throw new Error(
      `AITEAM_DEMO_AUTH 指的那份不可用：${explicit}\n` +
        `  · 它必须是一个**含凭证的 JSON 对象**（pi 的空壳 \`{}\` 不算）\n` +
        `  · 或干脆不设 AITEAM_DEMO_AUTH，改用 ${target}（推荐）`,
    );
  }
  if (explicit) {
    copyFileSync(explicit, target);
  } else if (!hasCredentials(target)) {
    // 顺序：env 变量（已处理）> 环境目录里那份
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

/** 这份 auth.json 里真有凭证吗？`{}`（pi 造的空壳）不算 —— 见 setupReal 的注释 */
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
