// E8 前置：真模型 deepseek-v4.1-flash 上，「请求的 thinking 档位 → 实际生效档位」的映射（零 API 花费，只读 session）
// 跑法：node audit/23-aggregation/e0b-levels.ts
import { createAgent } from "../../src/index.ts";
import { saveSection } from "./_rec.ts";

const rows: Array<{ requested: string; effective: string }> = [];
for (const t of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
  const a = await createAgent({ model: "opencode-go/deepseek-v4.1-flash", thinking: t as never });
  rows.push({ requested: t, effective: a.session.thinkingLevel });
  console.log(`  ${t.padEnd(8)} → session.thinkingLevel = ${a.session.thinkingLevel}`);
  a.dispose();
}
const b = await createAgent({ model: "opencode-go/deepseek-v4.1-flash" });
const m = (b.session as unknown as { model: Record<string, unknown> }).model;
const model = { id: m?.id, reasoning: m?.reasoning, thinkingLevelMap: m?.thinkingLevelMap, cost: m?.cost, contextWindow: m?.contextWindow, maxTokens: m?.maxTokens };
b.dispose();
console.log("  model:", JSON.stringify(model));

saveSection("e0b-levels", { model: "opencode-go/deepseek-v4.1-flash", mapping: rows, modelMeta: model });
