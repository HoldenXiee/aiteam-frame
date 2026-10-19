// 实验室环境 —— ★★★ 关键：这里 import 的是**研究员那份可写的库**
//
// ★★★ 为什么必须 import `lib/` 而不是仓库的 `src/`（设计疏漏，2026-10-18 修）：
//
//   原来：
//     env.ts → src/index.ts（仓库那份，只读）
//     而研究员改的是 lib/aiteam/（可写）
//     ★★ ⇒ **它改了 lib/，实验跑的还是 src/ —— 改了等于没改。**
//     ★ 手册里还写着"你可以改 lib/"，那是**给了一条走不通的路**（P12 的反面）。
//
//   现在：
//     env.ts → labfirst/lab-3b/lib/aiteam/index.ts（★ 它改的那份）
//     ★★ ⇒ **它改了什么，它的实验就跑什么。分层打通。**
//
// ★ 分层的完整形状：
//     aiteam 库（lib/，可写）
//       └─ 研究员的实验代码（work/，它写它跑）
//            └─ 它起的 agent
//
// ★★ 风险与对策：它可能把 lib/ 改坏 → 实验起不来。
//    ⇒ lib/ 是**独立 git 仓库**（见 runner.ts 开工前的自检），改坏可回退。

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ★★★ 这一行是分层的关键：import 研究员可写的那份库
//   ★★ 用**动态 import**（`await import(LAB_ENTRY)`）—— 静态 import 要求字面量路径，
//     而我们要让它从 `paths.ts` 算出来（同一份代码能跑不同集群）。
import { LAB_ENTRY, DOCS, LAB, MODEL } from "./paths.ts";
// ★ Windows 路径必须转 `file://` URL 才能动态 import（`D:\...` 会被当成协议）
import { pathToFileURL } from "node:url";
const aiteam = (await import(pathToFileURL(LAB_ENTRY).href)) as typeof import("../../src/index.ts");
export const { createLab } = aiteam;
import type { Lab as _Lab } from "../../src/index.ts";
export type Lab = _Lab;

const here = dirname(fileURLToPath(import.meta.url));

/** 共用环境（材料区里的那份：凭证 / models.json / extensions / skills） */
export const AGENT_DIR = join(DOCS, "装置/agent");
const AUTH = join(AGENT_DIR, "auth.json");

if (!existsSync(AUTH)) {
  throw new Error(
    `集群需要自己的凭证，但没有：${AUTH}\n` +
      `  · 放一份 auth.json 进去（gitignored）\n` +
      `  · ★ 别指向宿主 ~/.pi/agent —— pi 会整文件写回，把别的 provider 凭证抹掉`,
  );
}

/**
 * 起一个实验室。
 *
 * ★★ cwd 必须钳在集群空间之内：写错路径不会报错，只会**静默新建一个目录**
 *    （本项目已因此留下过垃圾 —— 探针脚本漏写了 `labfirst`）。
 */
export async function labAt(cwd: string): Promise<Lab> {
  const norm = (s: string) => s.replace(/\\/g, "/");
  const root = norm(LAB);
  if (!norm(cwd).startsWith(root)) {
    throw new Error(
      `labAt 的 cwd 必须在集群空间之内：\n  收到 ${cwd}\n  应在 ${root} 之下\n` +
        `  ★ 不允许在空间之外建目录 —— 写错路径会静默长出垃圾（本项目吃过这个亏）`,
    );
  }
  mkdirSync(cwd, { recursive: true });
  // ★★★ 把实验室钳在**单一型号**上（2026-10-18 实测事故的修复）：
  //   事故：集群每一处 `MODEL` 都钉死了，**仍然漏了一个入口** ——
  //     · `sandbox.spawn({ model })` 的 model 是**模型运行时自己填的参数**
  //     · 不传 model 时旧行为落到 **pi 的全局默认**（实测 = kimi-k3，不在允许列表里）
  //   ⇒ 一个只想要 deepseek 的实验室，静默地向别的型号发了请求。
  // ★ 这两条现在都在库层堵住了（`modelAllow` / `defaultModel` 过三个入口），
  //   这里把集群的声明接上去 —— **机制在库，政策在使用者代码**。
  return createLab({
    agentDir: AGENT_DIR,
    cwd,
    modelNetwork: true,
    modelAllow: [MODEL],
    defaultModel: MODEL,
  });
}

export { MODEL };
