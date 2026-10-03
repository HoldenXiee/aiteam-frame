// demo 的环境：**两种 provider 可切**。幂等 —— 反复调用拿到同一套路径。
//
//   （默认）假 provider：本机 HTTP 服务，零成本、不需要 key、离线；
//   AITEAM_DEMO_REAL=1：用宿主的真实凭证 + 一个**免费**模型（opencode-go/space-bunny-free）。
//
// 与 examples/lib/harness.ts 的差别只有一件事：**agentDir / cwd 是仓库里固定的目录**
// （`demo/env/agent` 与 `demo/work`），不是每次 mkdtemp。因为 demo 里会有多个脚本先后跑
// （check.ts 验环境、agent-team.ts 干活），它们必须看到**同一套**环境。
//
// ── 真模式：**用 demo 自己的 key**，全程不碰宿主（这条是血的教训，改过两次）──
//
// 第一版：真模式把 `agentDir` 指向宿主 `~/.pi/agent`，理由是「不复制密钥」。
//   ⇒ 错得很危险：pi 的 auth 存储是**读-改-写**整个 `auth.json`
//     （`auth-storage.js` 的 `withLock`：`fn(current)` 出一份完整 `next` 再整文件写回，
//      且 `ensureFileExists()` 在**每次** withLock 里都先把文件建出来）。
//     实测跑一次真模式，宿主 `auth.json` 从 `{opencode-go, openrouter, opencode}`
//     被重写成只剩 `{opencode-go}` —— **用户另外两个 provider 的凭证被抹掉了**。
//
// 第二版：复制宿主凭证到 `demo/env/real-agent/`。
//   ⇒ 方向对了，但**不符合 demo 的定位**：demo 该用**自己那一套环境**。
//     复制宿主 key 意味着「跑 demo = 烧你自己的额度」，而且用的是你本机 pi 的账号，
//     与 demo 想演示的东西无关。
//
// 现在：真模式用 **`demo/env/auth.json`** —— 那份**独立于宿主**的 demo 凭证
// （gitignored，不进仓库）。demo/agentDir 也换成自己的目录，宿主目录**一个字节都不读、不写**。
//
// 想用自己的 key（例如 demo key 失效了）：把它写进 `demo/env/auth.json`，
// 或设 `AITEAM_DEMO_AUTH=/path/to/auth.json` 指向别处。**别指向宿主** —— 见上面的第一版教训。
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  /** 假模式：`demo/env/agent`；真模式：`demo/env/real-agent`（复制了凭证的**副本**） */
  agentDir: string;
  /** `demo/work`：agent 的工作目录与产物落点（gitignored） */
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

/**
 * 真模型：用 **demo 自己的凭证**（`demo/env/auth.json`），不读也不写宿主 pi 目录。
 *
 * 为什么不是宿主目录 / 不是复制宿主凭证：见文件头「血的教训」那一段。
 * 一句话 —— demo 该用自己的环境；用宿主 key 既会烧用户额度，又可能被 pi 的整文件写回抹掉别的凭证。
 *
 * 已经有 `auth.json` 就不覆盖：留给使用者自己换 key。
 */
async function setupReal(): Promise<DemoEnv> {
  const demoRoot = import.meta.dirname;
  const cwd = join(demoRoot, "work");
  const agentDir = join(demoRoot, "env", "real-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  // demo 自己的凭证：默认 demo/env/auth.json，可用 AITEAM_DEMO_AUTH 指向别处
  const demoAuth = process.env.AITEAM_DEMO_AUTH ?? join(demoRoot, "env", "auth.json");
  const target = join(agentDir, "auth.json");
  if (!existsSync(demoAuth)) {
    throw new Error(
      `真模式需要 demo 自己的凭证：找不到 ${demoAuth}。
` +
        `  · 想用自己的 key：把 auth.json 写到 ${join(demoRoot, "env", "auth.json")}（gitignored）
` +
        `  · 或用 AITEAM_DEMO_AUTH=/path/to/auth.json 指定
` +
        `  · 或干脆不设 AITEAM_DEMO_REAL，跑离线假 provider（默认，零成本）`,
    );
  }
  // 副本进 demo 自己的 agentDir（pi 会对它读-改-写，所以必须不是原件）
  if (!existsSync(target)) copyFileSync(demoAuth, target);
  // 目录 overlay：宿主那份不动，另存一份 demo 自己的（没有也照跑，只是模型目录可能不全）
  const demoStore = join(demoRoot, "env", "models-store.json");
  const storeTarget = join(agentDir, "models-store.json");
  if (!existsSync(storeTarget) && existsSync(demoStore)) copyFileSync(demoStore, storeTarget);

  return { agentDir, cwd, real: true, model: REAL_MODEL_REF, altModel: REAL_MODEL_REF };
}

/** 假 provider：写一份指向本机服务的 models.json，全程离线、零成本。 */
async function setupFaux(): Promise<DemoEnv> {
  const demoRoot = import.meta.dirname;
  const agentDir = join(demoRoot, "env", "agent");
  const cwd = join(demoRoot, "work");
  mkdirSync(cwd, { recursive: true });
  const faux = await startFaux();
  // 两个模型：echo 给普通轮次，echo-alt（reasoning:true）给 setThinking 这类要合法档位的检查
  writeModelsJson(agentDir, faux.baseUrl, [FAUX_MODEL_ID, FAUX_MODEL_ALT_ID]);
  return {
    agentDir,
    cwd,
    baseUrl: faux.baseUrl,
    real: false,
    model: FAUX_MODEL_REF,
    altModel: FAUX_MODEL_ALT_REF,
  };
}
