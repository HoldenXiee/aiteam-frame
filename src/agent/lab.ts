// 实验室（Lab）：环境所有者与唯一启动入口 —— agentDir / cwd 在这里定死，之后本实验室起的分身共用它们。
// 本任务阶段是纯加法：旧的顶层 createAgent / inspectEnv 原样保留，这里只是转调，两个出口并存。
import { existsSync } from "node:fs";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgent, getSharedRuntime } from "./create-agent.ts";
import { inspectEnv, type EnvReport } from "./env.ts";
import type { Agent, AgentInit } from "./types.ts";

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

export interface Lab {
  readonly agentDir: string;
  readonly cwd: string;
  createAgent(spec?: AgentInit): Promise<Agent>;
  inspectEnv(): Promise<EnvReport>;
  /** @internal 仅供测试断言 runtime 复用 */
  modelRuntimeForTest(): ModelRuntime;
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
  // 复用宿主级共享 runtime（决策 #8）：同一个 agentDir 的实验室与顶层 createAgent 拿到同一份，
  // 不许自己 new —— 否则第二个实验室会去读第一份的 models.json / auth.json。
  const modelRuntime = opts.modelRuntime ?? (await getSharedRuntime(agentDir, { modelNetwork, catalogBaseUrl }));
  const shared = { agentDir, cwd, modelNetwork, catalogBaseUrl };

  return {
    agentDir,
    cwd,
    // 本实验室的两个目录是定死的，spec 在后：里面再给 agentDir / cwd 会覆盖实验室这两个
    createAgent: (spec = {}) => createAgent({ ...shared, ...spec }),
    inspectEnv: () => inspectEnv(shared),
    modelRuntimeForTest: () => modelRuntime,
  };
}
