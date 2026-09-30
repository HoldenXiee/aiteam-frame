// 冒烟：1 次真模型调用，验证（a）凭证可用（b）toolCall/toolResult 解析可用（c）记录真实花费。
// 跑法：node audit/22-topology-live/smoke.ts
import { createAgent, createAgentHost } from "../../src/index.ts";
import { FLASH, makeSink, turn, workDir } from "./_lib.ts";

const sink = makeSink("smoke");
const cwd = workDir("smoke");

const host = createAgentHost({
  defaults: { model: FLASH },
  members: { worker: { description: "工人：只回一句极简回答" } },
  maxAgents: 8,
} as never);
const lead = await createAgent({ model: FLASH, cwd, tools: ["spawn_agent", "send_message"] }, { host });

const t1 = await turn(lead, "用 spawn_agent 让 worker 回答「1+1 等于几」，只回一个数字。然后一句话汇报。");
const afterSpawn = { calls: t1.calls, results: t1.results.map((r) => r.text.slice(0, 80)) };
const worker = host.list().find((a) => a.member === "worker");

const t2 = await turn(lead, "用 send_message 给刚才那个 worker 发一句「请确认收到」。");
const sendCall = t2.calls.find((c) => c.name === "send_message");

sink.ledger("smoke", {
  t1: { calls: t1.calls, results: t1.results, tokens: t1.tokens, cost: t1.cost, ms: t1.ms },
  t2: { calls: t2.calls, results: t2.results.map((r) => r.text.slice(0, 80)), tokens: t2.tokens, cost: t2.cost, ms: t2.ms },
  workerId: worker?.id,
  hostUsage: host.usage,
  executionTimeMs: t1.ms + t2.ms,
});
sink.add({
  id: "S1",
  question: "真模型凭证是否可用；session.messages 能否取到工具调用与工具结果的 ground truth",
  method: "node audit/22-topology-live/smoke.ts",
  observed: [
    `第1轮工具调用=${JSON.stringify(t1.calls)}`,
    `第1轮工具结果=${JSON.stringify(afterSpawn.results)}`,
    `worker.id=${worker?.id}`,
    `第2轮工具调用=${JSON.stringify(t2.calls)}`,
    `第2轮工具结果=${JSON.stringify(t2.results.map((r) => r.text.slice(0, 60)))}`,
    `宿主用量 totalTokens=${host.usage.totalTokens} cost=$${host.usage.cost.total.toFixed(6)}`,
    `墙钟 ${t1.ms + t2.ms}ms`,
  ].join("\n     "),
  verdict: t1.calls.length > 0 && t2.calls.length > 0 ? "OK" : "GAP",
  conclusion: "真模型 + ground truth 解析可用；本轮实际花费见 data/smoke.json。",
  data: { workerId: worker?.id, hostUsage: host.usage },
});

host.dispose();
console.log(`\n→ ${sink.path}`);
