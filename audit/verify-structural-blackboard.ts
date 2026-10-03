// 探针：结构保证型共享黑板模式（重构后架构下的形态）。
// 重构后多 agent 编排在使用者代码：黑板由使用者代码写（blackboard.jsonl）——
// 本探针固化"写侧落盘 → 读侧注入"的完整回路：worker 产出 → 黑板 → 读者 agent 上下文。
// 跑法：node audit/verify-structural-blackboard.ts
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeOfflineAgent } from "../examples/lib/harness.ts";

const workDir = mkdtempSync(join(process.env.TEMP ?? "tmp", "aiteam-bb-"));
const blackboard = join(workDir, "blackboard.jsonl");

const worker = await makeOfflineAgent({ id: "worker", role: "计算成员：原样返回收到的内容。" });
const SECRET = "BOARD-MARKER-d41a9f";
const workerRun = await worker.io.prompt(`输出以下一行：${SECRET}`);
const workerText = workerRun.text ?? "";

// 写侧：使用者代码把分身产出落盘（结构保证——不经过任何模型裁量）
appendFileSync(blackboard, JSON.stringify({ agent: worker.id, output: workerText }) + "\n", "utf-8");

// 读侧：读者 agent 的上下文里注入黑板内容
const reader = await makeOfflineAgent({ id: "reader", role: "审核成员：基于黑板内容作答。" });
const board = readFileSync(blackboard, "utf-8");
const readerRun = await reader.io.prompt(`共享黑板内容如下：\n<blackboard>\n${board}\n</blackboard>\n请原样复述黑板里的输出。`);

const ok =
  existsSync(blackboard) &&
  (readerRun.text ?? "").includes(SECRET) &&
  board.includes(worker.id);
console.log(ok
  ? `✓ 黑板回路无损：worker 产出 → blackboard.jsonl（${(readFileSync(blackboard, "utf-8").length)} 字节）→ reader 上下文`
  : `✗ 黑板回路有损`);
