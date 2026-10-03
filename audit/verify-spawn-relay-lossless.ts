// 探针：验证 spawn_agent 返回通道的载荷完整性——worker 的产出文本经 spawn 通道
// 原样回到调用方。假 provider，零成本。
// 背景：多 agent 实验中 12 行数字链在"完整编排"下塌缩（0/12），本探针证明
// 塌缩不是 spawn 返回通道造成的——通道本身无损（有损的是并行协调与汇总环节）。
// 跑法：node audit/verify-spawn-relay-lossless.ts
import { createAgent, createAgentHost } from "../src/index.ts";
import { startFaux } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";
import { runTool } from "../test/helpers.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);

const host = createAgentHost({ members: { worker: { description: "计算成员", tools: [] } } });
const lead = await createAgent(
  { model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir, tools: ["spawn_agent"] },
  { host, modelRuntime: made.runtime },
);

// worker 的假响应是 echo:前缀——回显完整任务文本。任务文本里埋一份多行"数据表"，
// 用于验证多行载荷（而非单行）经通道后逐字保留。
const payload = [
  "RELAY-MARKER-8f3a1c",
  '{"procurement":{"P01":42354,"P02":39226,"P03":28296}}',
].join("\n");
const result = await runTool(
  "spawn_agent",
  { member: "worker", task: `计算以下数据并原样返回：\n${payload}` },
  { agent: lead, host } as never,
);
const returned = (result.content?.[0] as any)?.text ?? "";
host.dispose();
await faux.close();

const ok = payload.split("\n").every((line) => returned.includes(line));
console.log(ok
  ? `✓ spawn 返回通道无损：多行载荷（标记 + JSON）逐字到达调用方`
  : `✗ 通道有损，返回内容：${JSON.stringify(returned.slice(0, 200))}`);
process.exit(ok ? 0 : 1);
