// 冒烟：确认真模型可用 + 记录单次 token/花费。跑法：node audit/23-aggregation/e0-smoke.ts
import { createAgent } from "../../src/index.ts";
const t0 = Date.now();
const a = await createAgent({ model: "opencode-go/deepseek-v4.1-flash" });
const r = await a.prompt("只回一个词：OK");
console.log(JSON.stringify({ text: r.text, usage: r.usage, ms: Date.now() - t0, thinkingLevel: a.session.thinkingLevel }, null, 1));
a.dispose();
