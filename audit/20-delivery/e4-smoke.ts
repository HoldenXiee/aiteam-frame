// E4 冒烟：真模型 1 次调用，记录实际 token 与花费（决定后续样本量）
import { createAgent } from "../../src/index.ts";
const t0 = Date.now();
const a = await createAgent({ model: "opencode-go/deepseek-v4.1-flash", cwd: process.cwd() });
const r = await a.prompt("只回一个数字：2+2 等于几？");
console.log(`文本=${JSON.stringify(r.text)} 本轮 tokens=${r.usage.totalTokens} cost=$${r.usage.cost.total.toFixed(6)} 累计=${a.usage.totalTokens} 用时=${Date.now() - t0}ms`);
a.dispose();
