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
import { createLab } from "../../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

export const agentDir = join(here, "agent");
export const cwd = join(here, "work");

/**
 * 模型 ref —— 研究员定的档位（本次实验一律用它）。
 *
 * ⚠️ **2026-10-15 换档**：`deepseek-v4.1-flash`（之前是 `longcat-2.5-preview-free`）。
 *
 * **为什么换**（实测，不是偏好）：
 * 同一个任务（读 6 份材料做概括），只换模型档位，各跑 3 次：
 *
 * | 档位 | 成功率 | 耗时 |
 * |---|---|---|
 * | `longcat-2.5-preview-free` | **1/3** | ✗75s, 41s, ✗75s |
 * | `deepseek-v4.1-flash` | **3/3** | 21, 28, 23s |
 *
 * longcat 不是"偶尔抽风"，是**稳定的一半概率静默挂死**（prompt 永不 resolve）。
 * 而这个症状**恰好长得像研究现象**：
 *   · T-E 的「委派了然后卡死」（35–36 文件档超时 50%）
 *   · G3-3b 的「`verify=2` 2/3 崩掉、1.3M token / 41 分钟」
 * 两者都被归因成了「模型行为」，但很可能有一半是端点挂死 ——
 * **见 `G0-3-方差基线结果.md` §9「基础设施退化的影响」**（已标红，未重做）。
 *
 * ⚠️ **代价**：与 demom 存量 48 条数据**不再同源**（那批是 longcat 跑的）。
 * 跨项目对比时要记住这一点；同项目内的对照实验不受影响（都是新档位跑）。
 *
 * 注意：这个模型**不在 pi-ai 的内置快照里** —— 必须把 `modelNetwork` 打开
 * （见文件末尾），pi 才会去拉在线目录把它补上。
 *
 * ⚠️ 别和「启动 subagent」搞混 —— 那条规则是一律**不传**模型名。
 */
export const MODEL = "opencode-go/deepseek-v4.1-flash";

export const AUTH_PATH = join(agentDir, "auth.json");

mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });
if (!existsSync(AUTH_PATH)) {
  throw new Error(`demo 需要自己的凭证，但这里没有：${AUTH_PATH}\n  · 放一份 auth.json 进去（gitignored）\n  · 注意：别指向宿主 ~/.pi/agent —— pi 会整文件写回，把那里别的 provider 凭证抹掉`);
}

/** 本 demo 唯一的实验室：环境在这里声明一次，后面每课都从它起 agent */
export const lab = await createLab({ agentDir, cwd, modelNetwork: true });

/**
 * 另一个实验室：**只换工作目录**。
 *
 * ★ 为什么需要它（F′ 2026-10-16）★
 *
 * `cwd` 是**实验室级**的（v2 刻意把它从 spec 里拿掉了）—— 一个 agent 改不了自己的 cwd。
 * 所以要测「结构级的通信协议」（下游 agent **物理上看不到** corpus），
 * 唯一正当的做法就是给它**另一个实验室**。
 *
 * 这正是本库的设计意图：环境是实验室的事，不是 spec 的事。
 */
export function labAt(dir: string): Promise<Awaited<typeof lab>> {
  return createLab({ agentDir, cwd: dir, modelNetwork: true });
}

// ★ `modelNetwork: true` 这里是**必须**的（demo/ 那边是 false，别照抄）★
//
// 为什么：`longcat-2.5-preview-free` 不在 pi-ai 的内置模型快照里。打开这个开关之后，
// pi 会拉在线目录把它合并进来，并缓存到 `<agentDir>/models-store.json`。
// 官方机制（读自 `pi-coding-agent/dist/core/remote-catalog-provider.js`）：
//
//     GET {catalogBaseUrl，默认 https://pi.dev}/api/models/providers/opencode-go
//           ?types=chat,image,classifier
//     默认每 4 小时最多刷新一次（REMOTE_CATALOG_REFRESH_INTERVAL_MS），
//     带 ETag 校验；只刷新**有凭证**的 provider。
//
// 手动核对在线目录里有哪些模型（实测直连可用，本机 http 代理 10809 当时是挂的）：
//
//     curl -s "https://pi.dev/api/models/providers/opencode-go?types=chat,image,classifier"

