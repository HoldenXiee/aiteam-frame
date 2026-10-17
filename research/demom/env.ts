// demo 的环境：两件事在别处声明不了 —— 目录在哪（agentDir / cwd），凭证从哪来。
//
// 路径**相对本文件**解析，不认 process.cwd()：这样 `cp -r demo demo-exp1` 之后，
// 副本读的是副本自己的 `demo-exp1/agent/`，不是仓库里那个。
//
// 凭证就用 agentDir 里那份。**别指向宿主 ~/.pi/agent** —— pi 的 auth 存储是
// 「读-改-写整个文件」，指向宿主会把那里别的 provider 的 key 抹掉（历史事故）。
//
// 顶层 await（ESM 合法）：本文件被 import 时就把 lab 准备好，后面每课直接用。
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLab } from "../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

export const agentDir = join(here, "agent");
export const cwd = join(here, "work");

/**
 * 模型 ref —— 本实验室（A 集群 / B 工作流）两边**共用同一个**。
 *
 * 当前档位：longcat-2.5-preview-free。
 * 选它的理由：① 在 opencode-go 的目录里真实存在（aiteam 对不在目录里的 ref 直接抛错）；
 * ② 免费（实测 cost 恒为 0，约 4.5s/轮），本实验要跑 N 次 × 两边，成本必须可控。
 *
 * ⚠️ 两边必须同一模型同一思考档 —— 这是「公平性自查表」的第一条（见两个实验室的 README）。
 * ⚠️ 别和「启动 subagent」搞混 —— 那条规则是一律**不传**模型名。
 */
export const MODEL = "opencode-go/longcat-2.5-preview-free";

export const AUTH_PATH = join(agentDir, "auth.json");

mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });
if (!existsSync(AUTH_PATH)) {
  throw new Error(`demo 需要自己的凭证，但这里没有：${AUTH_PATH}\n  · 放一份 auth.json 进去（gitignored）\n  · 注意：别指向宿主 ~/.pi/agent —— pi 会整文件写回，把那里别的 provider 凭证抹掉`);
}

/** 本 demo 唯一的实验室：环境在这里声明一次，后面每课都从它起 agent */
export const lab = await createLab({ agentDir, cwd, modelNetwork: false });
