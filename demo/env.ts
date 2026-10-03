// demo 的环境：**两种 provider 可切**。幂等 —— 反复调用拿到同一套路径。
//
//   （默认）假 provider：本机 HTTP 服务，零成本、不需要 key、离线；
//   AITEAM_DEMO_REAL=1：用 demo **自己的**凭证 + 一个免费模型（opencode-go/space-bunny-free）。
//
// ── 目录分两层（改过一次，之前是混在一起的）──
//
//   demo/env/                  ← **配置源**（你提供的、不常变；手工放，脚本只读）
//     auth.json                    真模式的凭证（gitignored）
//     models-store.json            真模式的模型目录缓存（gitignored，可选）
//
//   demo/run/                  ← **运行时产物**（脚本生成；删掉即可重建，gitignored）
//     faux/                        假 provider 的 agentDir
//       models.json                指向本机假服务
//       skills/demo-skill/SKILL.md **demo 自己的**技能（证明自动发现这条路是通的）
//       extensions/demo-ext.ts     **demo 自己的**扩展（它注册一个工具 + 一个钩子）
//     real/                        真模式的 agentDir（凭证**副本**放在这里）
//     (cwd 是 demo/work，见下)
//
// 为什么必须分：pi 会在任何 agentDir 里**自己造** `auth.json` / `models-store.json`
// （`auth-storage.js` 的 `ensureFileExists`）。放同一层时，空壳产物会和你的配置源混在一起，
// 分不清哪个是真的、哪个能删。分层后：**`demo/run/` 整个可以随时删**，`demo/env/` 只放你给的源。
//
// ── 真模式的两条硬约束（都是血教训，见 demo/README.md）──
//
// 1. **不碰宿主 `~/.pi/agent`**：pi 的 auth 存储是**读-改-写整个 auth.json**
//    （`auth-storage.js` 的 `withLock` 把 `fn(current)` 出的完整 `next` 整文件写回）。
//    曾经把 agentDir 指到宿主目录 ⇒ 实测把用户 `auth.json` 里另外两个 provider 的凭证抹掉。
// 2. **不借宿主的 key**：那样跑 demo 会烧用户自己的额度、用他本机 pi 的账号。
//    真模式只用 `demo/env/auth.json`（demo 自己的账号）。
//
// 想用自己的 key：写进 `demo/env/auth.json`，或设 `AITEAM_DEMO_AUTH=/path/to/auth.json`
// （那份文件会被**复制**进 `demo/run/real/`，原件只读）。**别指向宿主** —— 见上面第 1 条。
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  /** **运行时产物**目录里的 agentDir（假：`demo/run/faux`；真：`demo/run/real`） */
  agentDir: string;
  /** `demo/work`：agent 的工作目录与产物落点 */
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

/** 配置源目录（脚本只读）：`demo/env/` */
const envDir = (): string => join(import.meta.dirname, "env");
/** 运行时产物目录（可随时整个删）：`demo/run/` */
const runDir = (): string => join(import.meta.dirname, "run");
/** 工作目录与产物落点：`demo/work/` */
const workDir = (): string => join(import.meta.dirname, "work");

/**
 * 真模型：用 **demo 自己的凭证**，不读也不写宿主 pi 目录。
 *
 * 凭证**复制**进 `demo/run/real/` 而不是直接指 `demo/env/auth.json`：pi 会对 agentDir
 * 里的 auth.json 读-改-写（刷新 token、写回），不能让它去动你给的源文件。
 */
async function setupReal(): Promise<DemoEnv> {
  const cwd = workDir();
  const agentDir = join(runDir(), "real");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const source = process.env.AITEAM_DEMO_AUTH ?? join(envDir(), "auth.json");
  if (!existsSync(source)) {
    throw new Error(
      `真模式需要 demo 自己的凭证，但找不到 ${source}\n` +
        `  · 想用自己的 key：把 auth.json 写到 ${join(envDir(), "auth.json")}（gitignored）\n` +
        `  · 或用 AITEAM_DEMO_AUTH=/path/to/auth.json 指定\n` +
        `  · 或干脆不设 AITEAM_DEMO_REAL，跑离线假 provider（默认，零成本）\n` +
        `  · 注意：别指向宿主 ~/.pi/agent —— pi 会整文件写回，把那里别的 provider 凭证抹掉`,
    );
  }
  // 已经是同一份（上次复制过）就不重复复制，留给人自己换 key 的余地
  copyIfAbsent(source, join(agentDir, "auth.json"));
  copyIfAbsent(join(envDir(), "models-store.json"), join(agentDir, "models-store.json"));
  // pi 会 ensure 这两个文件；先建空的，省得它在别处建
  copyIfAbsent(join(envDir(), "settings.json"), join(agentDir, "settings.json"));
  seedOwnResources(agentDir);   // 同上：真模式也要有自己的技能与扩展
  return { agentDir, cwd, real: true, model: REAL_MODEL_REF, altModel: REAL_MODEL_REF };
}

/**
 * 往 agentDir 里塞**这个环境自己的**技能与扩展。
 *
 * 为什么要有这一步：demo 的 agentDir 如果只有 `models.json`，那 `skills.list()` / `extensions.list()`
 * 返回空**并不能证明隔离做对了** —— 空可能是因为「隔离成功」，也可能是因为「这条发现路径根本没被走到」。
 * 塞一份自己的进去之后，判据变强了：
 *   - 能看到**自己的**那一份 ⇒ 自动发现这条路是通的；
 *   - 看不到宿主的那些 ⇒ 隔离真的生效（宿主 `~/.pi/agent` 里有 2 个技能 4 个插件，见 `check.ts` 第 8 项）。
 *
 * 两边都要成立才叫「只有自己的」。只有一条的话，另一步照样可能出问题却看不出来。
 */
function seedOwnResources(agentDir: string): void {
  // 技能：真的 SKILL.md（pi 要求 filePath 指向真文件，虚拟路径会 ENOENT）
  const skillDir = join(agentDir, "skills", "demo-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: demo-skill",
      "description: demo 环境自带的技能，用来证明「只有自己的环境」这条判据是活的。",
      "---",
      "",
      "# demo-skill",
      "",
      "这是 demo 的 agentDir 里发现的技能。**它只存在于这个目录** ——",
      "宿主的 `~/.pi/agent/skills/` 里没有它，所以自检里「只看到自己的」和「看得到自己的」两条都得成立。",
      "",
    ].join("\n"),
  );

  // 扩展：一个真插件（注册工具 + 一个钩子），证明自动发现这条线通
  const extDir = join(agentDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(
    join(extDir, "demo-ext.ts"),
    [
      "// demo 环境自带的扩展：它只存在于这个 agentDir 里。",
      "// 作用是让「扩展自动发现」这条路径有个**可观察的**结果 —— 否则 list() 返回空说明不了任何事。",
      "import { defineTool } from \"@earendil-works/pi-coding-agent\";",
      "import { Type } from \"typebox\";",
      "",
      "export default function (pi) {",
      "  pi.registerTool(",
      "    defineTool({",
      "      name: \"demo_env_tool\",",
      "      label: \"Demo Env Tool\",",
      "      description: \"由 demo 自己环境里的扩展注册；只在这个 agentDir 下存在。\",",
      "      parameters: Type.Object({ text: Type.Optional(Type.String()) }),",
      "      execute: async (_id, p) => ({",
      "        content: [{ type: \"text\", text: `demo-env:${p.text ?? \"\"}` }],",
      "        details: {},",
      "      }),",
      "    }),",
      "  );",
      "}",
      "",
    ].join("\n"),
  );
}

/** 假 provider：写一份指向本机服务的 models.json，全程离线、零成本。 */
async function setupFaux(): Promise<DemoEnv> {
  const cwd = workDir();
  const agentDir = join(runDir(), "faux");
  mkdirSync(cwd, { recursive: true });
  const faux = await startFaux();
  // 两个模型：echo 给普通轮次，echo-alt（reasoning:true）给 setThinking 这类要合法档位的检查
  writeModelsJson(agentDir, faux.baseUrl, [FAUX_MODEL_ID, FAUX_MODEL_ALT_ID]);
  seedOwnResources(agentDir);   // 这个环境自己的技能与扩展（隔离判据要靠它们才是活的）
  return {
    agentDir,
    cwd,
    baseUrl: faux.baseUrl,
    real: false,
    model: FAUX_MODEL_REF,
    altModel: FAUX_MODEL_ALT_REF,
  };
}

function copyIfAbsent(from: string, to: string): void {
  if (existsSync(from) && !existsSync(to)) copyFileSync(from, to);
}
