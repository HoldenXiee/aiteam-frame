// 探针：验证"结构保证型共享"模式——宿主监听 round_completed 事件，
// 由框架代码（而非模型裁量）把分身产出自动落盘到共享黑板文件。
// 背景：指令式共享（成员描述 / lead 派工转述 / role 注入）在大任务上全部失效；
// 事件驱动的结构落盘 3/3 场次全部成功。本探针固化该模式供 GUIDE 引用。
// 跑法：node audit/verify-structural-blackboard.ts
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentHost, createAgent } from "../src/index.ts";
import { startFaux } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";
import { runTool } from "../test/helpers.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);
const workDir = mkdtempSync(join(tmpdir(), "aiteam-bb-"));
const blackboard = join(workDir, "blackboard.md");

const host = createAgentHost({ members: { worker: { description: "计算成员", tools: [] } } });

// 结构保证的核心：宿主事件 → 框架代码落盘，模型无裁量权
host.on("round_completed", ({ agent, result }) => {
  if (agent.id === "lead") return;
  const text = String(result?.text ?? "").trim();
  if (!text) return;
  appendFileSync(blackboard, `\n## [${agent.id}]\n\n${text}\n`, "utf-8");
});

const lead = await createAgent(
  { model: FAUX_MODEL_REF, cwd: workDir, agentDir: made.agentDir, tools: ["spawn_agent"] },
  { host, modelRuntime: made.runtime },
);
await runTool("spawn_agent", { member: "worker", task: "echo:worker-output-42" }, { agent: lead, host } as never);
await host.dispose();

const ok = existsSync(blackboard) && readFileSync(blackboard, "utf-8").includes("worker-output-42");
console.log(ok
  ? `✓ 结构保证型共享生效：分身产出已自动落盘 ${blackboard}`
  : `✗ 黑板未写入`);
process.exit(ok ? 0 : 1);
