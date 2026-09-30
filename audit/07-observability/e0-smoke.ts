// 真模型冒烟：确认 opencode-go/deepseek-v4.1-flash 可用，并实测单次调用 token/花费。
// 跑法：node audit/07-observability/e0-smoke.ts
import { createAgent } from "../../src/index.ts";
import { dump, record, section } from "./_local.ts";

const MODEL = "opencode-go/deepseek-v4.1-flash";

section("E0 真模型冒烟");
const t0 = Date.now();
const agent = await createAgent({ model: MODEL, tools: [] });
const r = await agent.prompt("只回答两个字：收到");
const ms = Date.now() - t0;
record({
  id: "E0",
  question: "真模型可用性与单次调用成本",
  observed: `model=${MODEL} 耗时=${ms}ms text=${JSON.stringify(r.text.slice(0, 40))} usage=${JSON.stringify(r.usage)}`,
  verdict: "INFO",
  conclusion: "可用；后续真模型实验的样本量按此单价外推。",
  data: { model: MODEL, ms, text: r.text, usage: r.usage },
});
agent.dispose();
dump("e0-smoke", { realCostUsd: r.usage.cost.total });
