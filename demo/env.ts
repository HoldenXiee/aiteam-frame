// demo 的离线环境：本机假 provider + 自己的 agentDir / cwd。幂等 —— 反复调用拿到同一套路径。
//
// 与 examples/lib/harness.ts 的差别只有一件事：**agentDir / cwd 是仓库里固定的目录**
// （`demo/env/agent` 与 `demo/work`），不是每次 mkdtemp。因为 demo 里会有多个脚本先后跑
// （check.ts 验环境、agent-team.ts 干活），它们必须看到**同一套**环境。
//
// `demo/env/agent/models.json` 是这里写出来的（形状见 examples/lib/faux-models.ts:writeModelsJson）。
// **不读** demo/env/ 下 v1 遗留的 auth.json / models-store.json —— 前者含真实 API 密钥，
// 且 v1 结构与现在不同。假 provider 的 apiKey 是写死在 models.json 里的 "faux-key"。
//
// `PI_OFFLINE=1` 在 import 时就钉死（与 harness 同一手）：demo 不联网是硬保证，不是运气。
// 想指向真模型的人把这一行与下面的 writeModelsJson 换掉即可（README 有写）。
// 注：ESM 会把 import 提升到这行**之前**执行，所以它实际发生在 faux-models / faux-server 求值之后。
// 今天无害（pi 惰性读环境变量 + demo/check.ts 里所有调用都显式传 modelNetwork:false，双保险），
// 但别指望它挡得住「模块加载期就联网」的行为。
process.env.PI_OFFLINE = "1";

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FAUX_MODEL_ALT_ID, FAUX_MODEL_ID, writeModelsJson } from "../examples/lib/faux-models.ts";
import { startFaux } from "../examples/lib/faux-server.ts";

export interface DemoEnv {
  /** `demo/env/agent`：models.json 所在处（gitignored） */
  agentDir: string;
  /** `demo/work`：agent 的工作目录与产物落点（gitignored） */
  cwd: string;
  /** 本机假 provider 的地址，形如 http://127.0.0.1:PORT/v1 */
  baseUrl: string;
}

let cached: Promise<DemoEnv> | undefined;

/** 幂等：同一个进程里连调两次拿到**同一个** promise；跨进程拿到同一套路径。 */
export function ensureEnv(): Promise<DemoEnv> {
  cached ??= setup();
  return cached;
}

async function setup(): Promise<DemoEnv> {
  const demoRoot = import.meta.dirname;
  const agentDir = join(demoRoot, "env", "agent");
  const cwd = join(demoRoot, "work");
  mkdirSync(cwd, { recursive: true });
  const faux = await startFaux();
  // 两个模型：echo 给普通轮次，echo-alt（reasoning:true）给 setThinking 这类要合法档位的检查
  writeModelsJson(agentDir, faux.baseUrl, [FAUX_MODEL_ID, FAUX_MODEL_ALT_ID]);
  return { agentDir, cwd, baseUrl: faux.baseUrl };
}
