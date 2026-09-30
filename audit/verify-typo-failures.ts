// 复核 21-runtime-silent 的三条高严重度静默失败
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/index.ts";
import { startFaux, sleep } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF, writeModelsJson } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);

// 造一个 agentDir，里面放一个「未声明」的技能
const root = mkdtempSync(join(tmpdir(), "aiteam-typo-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
mkdirSync(join(agentDir, "skills", "magic-marker"), { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "skills", "magic-marker", "SKILL.md"),
  "---\nname: magic-marker\ndescription: 未声明的技能探针\n---\n\n正文暗号 SKILL-BODY-SECRET-5150\n");
writeModelsJson(agentDir, faux.baseUrl);
const base = { model: FAUX_MODEL_REF, cwd, agentDir };
const probe = async (label: string, spec: any) => {
  const a = await createAgent({ ...base, ...spec });
  const before = faux.calls.length;
  await a.prompt("hi");
  const c = faux.calls[before];
  const out = { tools: c?.tools, skillInSystem: /magic-marker/.test(c?.system ?? "") };
  a.dispose();
  return out;
};

console.log("═══ ① onToolCall 键名写错 → 审批门是否静默失效 ═══");
for (const [label, key] of [["onToolCall（写对）", "onToolCall"], ["onToolcall（小写 c）", "onToolcall"], ["OnToolCall", "OnToolCall"]] as const) {
  let called = 0;
  const gate = async () => { called++; return { block: true, reason: "拦下" }; };
  const a = await createAgent({ ...base, [(key as string)]: gate } as never);
  const before = faux.calls.length;
  await a.prompt("[[tool:read]] [[args:{\"path\":\"x\"}]]");
  await sleep(150);
  console.log(`  ${label.padEnd(20)} 门被调用 ${called} 次，工具结果=${JSON.stringify((a.lastResult?.text ?? "").slice(0, 40))}`);
  a.dispose();
}

console.log("\n═══ ② tools 写错一个字符 → 工具集是否塌成空 ═══");
for (const [label, tools] of [["['read']（写对）", ["read"]], ["['Read']（大写）", ["Read"]], ["'read'（字符串不是数组）", "read"]] as const) {
  const r = await probe(label, { tools });
  console.log(`  ${label.padEnd(28)} 模型看到 ${JSON.stringify(r.tools)}`);
}

console.log("\n═══ ③ skills 是不是白名单 ═══");
for (const [label, spec] of [["不声明 skills", {}], ["只声明别的技能", { skills: [] }]] as const) {
  const r = await probe(label, spec);
  console.log(`  ${label.padEnd(20)} system 里出现未声明的 magic-marker：${r.skillInSystem}`);
}
{
  const r = await probe("不声明", {});
  console.log(`  未声明的技能正文（SKILL-BODY-SECRET-5150）进 system 了吗：${/SKILL-BODY-SECRET-5150/.test((faux.calls.at(-1) as any).system)}`);
}
await faux.close();
