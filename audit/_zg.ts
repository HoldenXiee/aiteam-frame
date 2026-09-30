import { createAgent } from "../src/index.ts";
const cands = ["openrouter/qwen/qwen3-32b", "openrouter/mistralai/mistral-saba", "openrouter/qwen/qwen-2.5-7b-instruct", "openrouter/qwen/qwen3-14b"];
const FILL = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ".repeat(60);
for (const m of cands) {
  const out: string[] = [];
  for (const chars of [500, 20000, 200000]) {
    try {
      const a = await createAgent({ model: m, tools: [] });
      const r = await a.prompt(`只回答两个字：收到。${"\n\n"}${FILL.repeat(Math.ceil(chars / FILL.length)).slice(0, chars)}`);
      out.push(`${chars}字符→${r.error ? "ERR" : `ok text=${r.text.trim().length}字 tok=${r.usage.totalTokens}`}`);
      a.dispose();
    } catch (e) { out.push(`${chars}字符→抛错 ${String((e as Error).message).slice(0, 40)}`); }
  }
  console.log("  " + m.padEnd(44) + out.join("  "));
}
