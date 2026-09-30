import { createAgent } from "../src/index.ts";
import { startFaux } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";
const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);

// 假 provider 的模型是 reasoning:false，先看它；再用真模型看真档位
console.log("── 假 provider 模型（reasoning:false）──");
for (const t of [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
  const a = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir, ...(t ? { thinking: t } : {}) }, { modelRuntime: made.runtime });
  console.log(`  请求 ${String(t).padEnd(8)} → session.thinkingLevel = ${a.session.thinkingLevel}`);
  a.dispose();
}
await faux.close();

// 真模型：不传 modelRuntime/agentDir，走本机配置
console.log("\n── 真模型 opencode-go/deepseek-v4.1-flash ──");
for (const t of [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
  try {
    const a = await createAgent({ model: "opencode-go/deepseek-v4.1-flash", tools: [], ...(t ? { thinking: t } : {}) });
    console.log(`  请求 ${String(t).padEnd(8)} → session.thinkingLevel = ${a.session.thinkingLevel}`);
    a.dispose();
  } catch (e) { console.log(`  请求 ${String(t).padEnd(8)} → 抛错：${(e as Error).message.slice(0, 70)}`); }
}
