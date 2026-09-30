import { createAgent } from "../../src/index.ts";
const MODELS = ["openrouter/mistralai/mistral-saba", "openrouter/qwen/qwen-2.5-72b-instruct", "opencode-go/hy3"];
for (const m of MODELS) {
  const t0 = Date.now();
  try {
    const a = await createAgent({ model: m, tools: [] });
    const r = await a.prompt("只回数字 1");
    console.log(`${m}: error=${JSON.stringify(r.error ?? null)} text=${JSON.stringify(r.text.trim().slice(0,40))} tok=${r.usage.totalTokens} cost=$${r.usage.cost.total.toFixed(6)} ${Date.now()-t0}ms`);
    a.dispose();
  } catch (e) { console.log(`${m}: THROW ${(e as Error).message.slice(0,150)}`); }
}
