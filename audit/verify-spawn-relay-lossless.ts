// 探针：验证"使用者代码中继"的无损性——worker 的产出文本经使用者代码
// 原样进入下一个 agent 的上下文。假 provider，零成本。
// 背景：多 agent 实验中 12 行数字链在"完整编排"下塌缩（0/12），本探针证明
// 塌缩不是中继造成的——单上下文输出与中继传递在 N≤40 都无损（实验室 relay_curve）。
// 适配重构后架构：编排在使用者代码（host 层已移除）。
// 跑法：node audit/verify-spawn-relay-lossless.ts
import { makeOfflineAgent } from "../examples/lib/harness.ts";
import { faux } from "../examples/lib/harness.ts";

const payload = [
  "RELAY-MARKER-8f3a1c",
  '{"procurement":{"P01":42354,"P02":39226,"P03":28296}}',
].join("\n");

// 调用 1：worker 收到含多行载荷的任务，假 provider 原样回显
const worker = await makeOfflineAgent({ id: "worker", role: "计算成员：原样返回收到的内容。" });
const workerRun = await worker.io.prompt(`计算以下数据并原样返回：\n${payload}`);
const workerText = workerRun.text ?? "";

// 使用者代码中继：把 worker 的产出原样喂给 lead（这就是多 agent 的交接通道）
const lead = await makeOfflineAgent({ id: "lead", role: "主持人：基于下属返回的内容作答。" });
const leadRun = await lead.io.prompt(
  `你的 worker 通过 spawn 返回了以下结果：\n\n<worker_result>\n${workerText}\n</worker_result>\n\n请原样复述这份结果。`,
);

const ok =
  payload.split("\n").every((line) => (leadRun.text ?? "").includes(line)) &&
  (faux.calls.at(-1)?.lastUser ?? "").includes("RELAY-MARKER-8f3a1c");
console.log(ok
  ? `✓ 中继无损：多行载荷（标记 + JSON）从 worker 产出经使用者代码完整进入 lead 的上下文`
  : `✗ 中继有损：worker 文本 ${JSON.stringify(workerText.slice(0, 120))} / lead 收到 ${JSON.stringify((faux.calls.at(-1)?.lastUser ?? "").slice(0, 200))}`);
