// 冒烟：确认真模型可用、量出单轮墙钟 / token / 花费，给后面标定预算用。
// 跑法：node audit/25-e2e-stress/s0-smoke.ts
import { createAgent, createAgentHost } from "../../src/index.ts";

const M = "opencode-go/deepseek-v4.1-flash";
const t0 = Date.now();

const host = createAgentHost({ members: {} });
const a = await createAgent({ model: M, role: "你是简洁的工程分析师。", tools: [] }, { host });

const rounds: any[] = [];
for (let i = 1; i <= 2; i++) {
  const s = Date.now();
  const r = await a.prompt(`第 ${i} 轮：用一句话（不超过 40 字）说明「委派的单位是对话不是工作」意味着什么。`);
  rounds.push({
    round: i,
    ms: Date.now() - s,
    text: r.text.trim().slice(0, 80),
    error: r.error ?? null,
    usage: r.usage,
  });
}

console.log(JSON.stringify({
  model: M,
  totalMs: Date.now() - t0,
  rounds,
  hostUsage: host.usage,
  hostCost: host.usage.cost,
}, null, 2));

a.dispose();
host.dispose();
process.exit(0);
