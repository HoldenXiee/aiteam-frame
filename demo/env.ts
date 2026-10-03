// demo 的环境：**两种 provider 可切**。幂等 —— 反复调用拿到同一套路径。
//
//   （默认）假 provider：本机 HTTP 服务，零成本、不需要 key、离线；
//   AITEAM_DEMO_REAL=1：用宿主 ~/.pi/agent 里的真实凭证 + 一个**免费**模型（opencode-go/space-bunny-free）。
//
// 与 examples/lib/harness.ts 的差别只有一件事：**agentDir / cwd 是仓库里固定的目录**
// （`demo/env/agent` 与 `demo/work`），不是每次 mkdtemp。因为 demo 里会有多个脚本先后跑
// （check.ts 验环境、agent-team.ts 干活），它们必须看到**同一套**环境。
//
// `demo/env/agent/models.json` 只在假 provider 模式下写出（形状见 examples/lib/faux-models.ts:writeModelsJson）。
// **不读** demo/env/ 下 v1 遗留的 auth.json / models-store.json —— 前者含真实 API 密钥，且 v1 结构与现在不同。
// 真模型模式**也不复制**凭证：直接把 agentDir 指向宿主默认目录，凭证始终留在用户自己的 ~/.pi 里。
//
// 想指向别的真模型：设 AITEAM_DEMO_MODEL=provider/id（默认 opencode-go/space-bunny-free）。
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FAUX_MODEL_ALT_ID,
  FAUX_MODEL_ALT_REF,
  FAUX_MODEL_ID,
  FAUX_MODEL_REF,
  writeModelsJson,
} from "../examples/lib/faux-models.ts";
import { startFaux } from "../examples/lib/faux-server.ts";

/** 真模型模式下用的模型（免费档）。要换别的：设 AITEAM_DEMO_MODEL。 */
export const REAL_MODEL_REF = process.env.AITEAM_DEMO_MODEL ?? "opencode-go/space-bunny-free";

export interface DemoEnv {
  /** 假模式：`demo/env/agent`；真模式：宿主默认 agentDir（凭证留在原处） */
  agentDir: string;
  /** `demo/work`：agent 的工作目录与产物落点（gitignored） */
  cwd: string;
  /** **假模式**下本机服务的地址；真模式为 undefined */
  baseUrl?: string;
  /** true = 用真实凭证 + 免费真模型；false = 本机假 provider */
  real: boolean;
  /** 这个模式下 agent 该用的模型 ref */
  model: string;
  /** 升档用的模型 ref（写作阶段）。假模式是 echo-alt，真模式与 `model` 相同（免费档没有更强的那一档） */
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
 * 真模型：**不碰用户凭证**——agentDir 直接指宿主默认目录，pi 自己去读 `auth.json` / `models-store.json`。
 * 所以这里不写任何文件，也不需要 PI_OFFLINE（联网是这件事的前提）。
 */
async function setupReal(): Promise<DemoEnv> {
  const demoRoot = import.meta.dirname;
  const cwd = join(demoRoot, "work");
  mkdirSync(cwd, { recursive: true });
  const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
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
