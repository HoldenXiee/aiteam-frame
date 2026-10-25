// 唯一导出入口，不做逻辑。
export type * from "./agent/types.ts";
export { createLab } from "./agent/lab.ts";
export type { Lab, LabOptions } from "./agent/lab.ts";
export type { EnvReport } from "./agent/env.ts";
// 沙箱：给模型写代码编排 agent 的手段。返回的是普通 AgentTool，用 agent.tools.add() 加进去。
export { createSandbox } from "./surfaces/sandbox.ts";
// ★ PREREG 行内 provenance（2026-10-21 从 hunt 的私有副本并入）
//   让「这一行是拿哪份冻结判据算的」成为每一行自带的对账字段，
//   并且**篡改会红**（四种人造篡改 4/4 检出）。
export { openRunLog, freezeCriteria, verifyRunLog, verifySealedRow, sha12File, shaFile, canonicalJson } from "./runlog.ts";
export type { RunLog, RunLogOptions, RowVerdict, RowReport, RunLogReport, VerifyOptions, FrozenCriteria, RowSeal } from "./runlog.ts";
export { getLibRevision } from "./agent/revision.ts";
export { getEnvRevision } from "./agent/env-revision.ts";
