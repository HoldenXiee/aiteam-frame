// 唯一导出入口，不做逻辑。
export type * from "./agent/types.ts";
export { createLab } from "./agent/lab.ts";
export type { Lab, LabOptions } from "./agent/lab.ts";
export type { EnvReport } from "./agent/env.ts";
// 沙箱：给模型写代码编排 agent 的手段。返回的是普通 AgentTool，用 agent.tools.add() 加进去。
export { createSandbox } from "./surfaces/sandbox.ts";
