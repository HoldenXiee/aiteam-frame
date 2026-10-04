// 实验室（Lab）：环境所有者与唯一启动入口 —— agentDir / cwd / 网络开关 / runtime 在这里定死，
// 之后本实验室起的全部分身共用它们。spec 只说「这个 agent 用哪些」，不参与环境声明。
import { existsSync } from "node:fs";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentInLab, getSharedRuntime, registerLabEnv } from "./create-agent.ts";
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

export async function createLab(opts: LabOptions): Promise<Lab> {
  const agentDir = required(opts.agentDir, "agentDir");
  const cwd = required(opts.cwd, "cwd");
  // 当场检查（await 之前）：不存在的 cwd 要等到建 session 才炸，那时已经建了一堆东西、文案也难看
  if (!existsSync(cwd)) throw new Error(`createLab：cwd 不存在：${cwd}`);

  const { modelNetwork, catalogBaseUrl } = opts;
  // agentDir「原本是否存在」必须在这里定：下面取的 runtime 会顺手把目录建出来（ModelRuntime.create 实测如此），
  // 等到 inspectEnv 再 existsSync 就已经看不到这个诊断了。
  const agentDirExisted = existsSync(agentDir);
  // 复用宿主级共享 runtime（决策 #8）：同一个 agentDir 的实验室拿到同一份，不许自己 new ——
  // 否则第二个实验室会去读第一份的 models.json / auth.json。
  // 注入的那份优先，并且**真的**给这个实验室起的 agent 用（见下面的 registerLabEnv）。
  const modelRuntime = opts.modelRuntime ?? (await getSharedRuntime(agentDir, { modelNetwork, catalogBaseUrl }));
  const env = { agentDir, cwd, modelNetwork, catalogBaseUrl };

  const lab: Lab = {
    agentDir,
    cwd,
    // 环境只在实验室，spec 里没有 agentDir / cwd 这类字段可写（写了会被拒），无从覆盖
    createAgent: (spec = {}) => createAgentInLab(lab, spec),
    inspectEnv: () => inspectEnv({ ...env, agentDirExisted, modelRuntime }),
  };
  // 内部环境记录（含 runtime）：导出的 Lab 接口上没有它，createAgentInLab 只从这里取
  registerLabEnv(lab, { agentDir, cwd, modelRuntime });
  return lab;
}
