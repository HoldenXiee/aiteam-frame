// 实验室环境 —— 从材料区借来的一份环境（凭证 / models.json / extensions / skills）
//
// ★ 为什么环境在 docs/装置/agent/ 而不在这里：
//   环境是**材料**（历次实验共用），不是这个集群的代码。
//   ★ 集群的代码只描述"怎么跑"，环境属于"拿什么跑"。

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLab, type Lab } from "../../../src/index.ts";
import { DOCS, MODEL, REPO } from "./paths.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** 共用环境（材料区里的那份） */
export const AGENT_DIR = join(DOCS, "装置/agent");
const AUTH = join(AGENT_DIR, "auth.json");

if (!existsSync(AUTH)) {
  throw new Error(
    `集群需要自己的凭证，但没有：${AUTH}\n` +
      `  · 放一份 auth.json 进去（gitignored）\n` +
      `  · ★ 别指向宿主 ~/.pi/agent —— pi 会整文件写回，把别的 provider 凭证抹掉`,
  );
}

/** 起一个实验室；cwd 决定 agent 的工作根（每个实例一个子目录） */
export async function labAt(cwd: string): Promise<Lab> {
  mkdirSync(cwd, { recursive: true });
  return createLab({ agentDir: AGENT_DIR, cwd, modelNetwork: true });
}

export { MODEL, REPO };
