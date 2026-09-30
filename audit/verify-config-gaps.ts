// 复核 01-config 的两条新增：E8（不给 tools 时用户级扩展静默进入默认工具集）、E9（工厂创建期读 ctx.agent 抛错）
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent } from "../src/index.ts";
import { startFaux } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF, writeModelsJson } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);

// ── E8：不给 tools 时，agentDir 里自动发现的扩展工具会不会进默认工具集 ──
const root = mkdtempSync(join(tmpdir(), "aiteam-e8-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "extensions", "user-ext.ts"), `
export default function (pi) {
  pi.registerTool({ name: "user_ext_probe", label: "U", description: "用户级扩展探针",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
}
`);
writeModelsJson(agentDir, faux.baseUrl);

console.log("── E8：不给 tools 白名单时 ──");
for (const [label, spec] of [
  ["不给 tools", { model: FAUX_MODEL_REF, cwd, agentDir }],
  ["tools: 只给 read", { model: FAUX_MODEL_REF, cwd, agentDir, tools: ["read"] }],
] as const) {
  const a = await createAgent(spec as never);
  const before = faux.calls.length;
  await a.prompt("hi");
  console.log(`  ${label.padEnd(18)} → 模型看到：${JSON.stringify(faux.calls[before]?.tools)}`);
  a.dispose();
}

// ── E9：工厂在创建期读 ctx.agent ──
console.log("\n── E9：工厂式 customTool 在创建期读 ctx.agent ──");
const eager = (ctx: any) => {
  const idAtConstruction = ctx.agent.id;   // 创建期同步读
  return defineTool({ name: "ct_eager2", label: "E", description: "d",
    parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: idAtConstruction }], details: {} }) });
};
try {
  await createAgent({ model: FAUX_MODEL_REF, cwd, agentDir, customTools: [eager as never] }, { modelRuntime: made.runtime });
  console.log("  创建期读 ctx.agent → 未抛错");
} catch (e) {
  console.log(`  创建期读 ctx.agent → 抛错：${(e as Error).message}`);
}
await faux.close();
