// 真模型冒烟：确认可用性 + 实测单价（用于外推整个真模型专项的成本）
import { createAgent } from "../src/index.ts";
const MODELS = ["opencode-go/deepseek-v4.1-flash", "opencode-go/qwen3.8-flash", "opencode-go/mimo-v2.6-flash", "opencode-go/glm-5.3-flash", "opencode-go/deepseek-v4-pro"];
console.log("模型可用性与单价（各跑一轮「回答一个字：好」）");
for (const m of MODELS) {
  try {
    const t0 = Date.now();
    const a = await createAgent({ model: m });
    const r = await a.prompt("只回答一个字：好");
    const u = r.usage;
    console.log(`  ${m.padEnd(36)} ok  ${Date.now() - t0}ms  in=${u.input} out=${u.output} reasoning=${(u as any).reasoning ?? 0} total=${u.totalTokens}  cost=$${u.cost.total.toFixed(6)}  text=${JSON.stringify(r.text.slice(0, 12))}`);
    a.dispose();
  } catch (e) {
    console.log(`  ${m.padEnd(36)} 失败：${(e as Error).message.slice(0, 70)}`);
  }
}
