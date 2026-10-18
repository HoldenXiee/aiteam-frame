// 实验室（Lab）：环境所有者与唯一启动入口 —— agentDir / cwd / 网络开关 / runtime 在这里定死，
// 之后本实验室起的全部分身共用它们。spec 只说「这个 agent 用哪些」，不参与环境声明。
import { existsSync } from "node:fs";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentInLab, getSharedRuntime } from "./create-agent.ts";
import { inspectEnv, type EnvReport } from "./env.ts";
import type { Agent, AgentSpec } from "./types.ts";

export interface LabOptions {
  /** 环境目录：凭证(auth.json)、模型目录(models.json)、技能、插件、SYSTEM.md 都从这里找。必填 */
  agentDir: string;
  /** 工作目录：这个实验室启动的全部 agent 共用。必填 */
  cwd: string;
  /** 模型目录是否联网刷新，默认 true */
  modelNetwork?: boolean;
  /** 覆盖模型目录源，默认 https://pi.dev */
  catalogBaseUrl?: string;
  /** 直接注入 modelRuntime（测试 / 高级用）；不传就走宿主级共享的那个 */
  modelRuntime?: ModelRuntime;
  /**
   * ★★★ 这个实验室**只允许**解析这些型号（可选）。
   *
   * ★ 为什么需要（实测事故，2026-10-18）：把每一处 `model` 都钉死了仍会漏 ——
   *   · `sandbox.spawn({ model })` 的 `model` 是**模型运行时自己填的参数**
   *   · 不传 `model` 时旧行为落到 **pi 的全局默认**（使用者控制不到）
   *   ⇒ 一个只声明了 `opencode-go/deepseek-v4.1-flash` 的实验室**静默地**用了别的型号。
   *
   * ★★ 是**机制不是策略**：库不说"不许用谁"，只是"这个实验室的型号集是这些"——
   *   与 `permissions.only`（工具白名单）同一种性质。声明什么由使用者定。
   * ★ 三个入口同时受限：创建期 `spec.model` / 不传时的默认 / 运行期 `agent.model.set()`。
   * 不传 ⇒ 不限制（保持旧行为）。
   */
  modelAllow?: readonly string[];
  /**
   * ★★ 没给 `model` 时用哪个型号。
   * ★ 治的是上面那条的第二半：旧行为是"不解析"⇒ 落到 pi 的全局默认。
   * 它**必须**在 `modelAllow` 里（否则构造时就报错）。
   */
  defaultModel?: string;
}

/** 对外只有这四个成员：环境（两个目录）+ 两个动作。runtime 等实现细节不在接口上。 */
export interface Lab {
  readonly agentDir: string;
  readonly cwd: string;
  createAgent(spec?: AgentSpec): Promise<Agent>;
  inspectEnv(): Promise<EnvReport>;
}

/** undefined 与空串一视同仁：两个目录都是「没有就活不下去」的东西，不必区分两种缺失 */
function required(value: string | undefined, field: string): string {
  if (value === undefined || value === "") throw new Error(`createLab：${field} 必填`);
  return value;
}

// 默认值 `{}` 只为「不传就报本库的错」那条路径服务：`{}` 会立刻在 required() 上抛
// 「createLab：agentDir 必填」，而不是给调用者一个原生 TypeError（两处缺失两套文案）。
// 用 `as LabOptions` 保住类型层的「必填」——TS 调用者少传 agentDir 仍编译不过。
export async function createLab(opts: LabOptions = {} as LabOptions): Promise<Lab> {
  const agentDir = required(opts.agentDir, "agentDir");
  const cwd = required(opts.cwd, "cwd");
  // 当场检查（await 之前）：不存在的 cwd 要等到建 session 才炸，那时已经建了一堆东西、文案也难看
  if (!existsSync(cwd)) throw new Error(`createLab：cwd 不存在：${cwd}`);

  const { modelNetwork, catalogBaseUrl, modelAllow, defaultModel } = opts;
  if (defaultModel && modelAllow && !modelAllow.includes(defaultModel)) {
    throw new Error(
      `createLab：defaultModel「${defaultModel}」不在 modelAllow 里。\n` +
        `  允许的：${modelAllow.join("、")}\n` +
        `  ★ 两者不一致时，"没给 model"的 agent 会立刻报错——先在这里拦住。`,
    );
  }
  // agentDir「原本是否存在」必须在这里定：下面取的 runtime 会顺手把目录建出来（ModelRuntime.create 实测如此），
  // 等到 inspectEnv 再 existsSync 就已经看不到这个诊断了。
  const agentDirExisted = existsSync(agentDir);
  // 复用宿主级共享 runtime（决策 #8）：同一个 agentDir 的实验室拿到同一份，不许自己 new ——
  // 否则第二个实验室会去读第一份的 models.json / auth.json。
  // 注入的那份优先，并且**真的**给这个实验室起的 agent 用（createAgentInLab 直接收这份环境）。
  const modelRuntime = opts.modelRuntime ?? (await getSharedRuntime(agentDir, { modelNetwork, catalogBaseUrl }));
  const env = { agentDir, cwd, modelNetwork, catalogBaseUrl, modelAllow, defaultModel };

  const lab: Lab = {
    agentDir,
    cwd,
    // 环境只在实验室，spec 里没有 agentDir / cwd 这类字段可写（写了会被拒），无从覆盖
    // ★★ 必须展开 `env` —— 否则新加的环境字段（modelAllow / defaultModel）到这里就被丢掉，
    //    白名单静默失效（2026-10-18 实测到：手写对象漏字段 ⇒ 白名单形同虚设）。
    createAgent: (spec = {}) => createAgentInLab({ ...env, modelRuntime }, spec),
    inspectEnv: () => inspectEnv({ ...env, agentDirExisted, modelRuntime }),
  };
  return lab;
}
