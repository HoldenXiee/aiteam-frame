// B6 假 provider 下的逐字节确定性（10 次，基线复核）
// 跑法：node audit/23-aggregation/e4a-faux-determinism.ts
import { createHash } from "node:crypto";
import { createAgent } from "../../src/index.ts";
import { makeEnv } from "../_faux.ts";
import { saveSection, section } from "./_rec.ts";

const env = await makeEnv();
const { agentDir, cwd, runtime, model } = env;
const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const mk = () => createAgent({ model, cwd, agentDir, tools: [] }, { modelRuntime: runtime });

section("E5a 假 provider：同输入 10 次是否逐字节一致");
const rows: Array<{ i: number; text: string; sha: string; usage: number; events: string; ms: number }> = [];
for (let i = 0; i < 10; i++) {
  const a = await mk();
  const ev: string[] = [];
  a.on("text", () => ev.push("text"));
  a.on("turn", () => ev.push("turn"));
  a.on("done", () => ev.push("done"));
  const t0 = Date.now();
  const r = await a.prompt("固定输入-确定性探针");
  rows.push({ i, text: r.text, sha: h(r.text), usage: r.usage.totalTokens, events: ev.join(","), ms: Date.now() - t0 });
  a.dispose();
}
const texts = new Set(rows.map((r) => r.text));
const shas = new Set(rows.map((r) => r.sha));
const usages = new Set(rows.map((r) => r.usage));
const evs = new Set(rows.map((r) => r.events));
console.log(`  text 去重 ${texts.size}/10　sha 去重 ${shas.size}/10　usage 去重 ${usages.size}/10（${[...usages]}）　事件去重 ${evs.size}/10（${[...evs]}）`);

section("E5b 假 provider：10 次「prompt → send」两轮也是否一致");
const rows2: Array<{ i: number; sha1: string; sha2: string; events: string; ms: number }> = [];
for (let i = 0; i < 10; i++) {
  const a = await mk();
  const ev: string[] = [];
  a.on("turn", () => ev.push("turn"));
  const t0 = Date.now();
  const r1 = await a.prompt("第一轮-固定输入");
  await a.send("第二轮-固定输入");
  await a.waitForIdle();
  rows2.push({ i, sha1: h(r1.text), sha2: h(a.lastResult?.text ?? ""), events: ev.join(","), ms: Date.now() - t0 });
  a.dispose();
}
console.log(`  第 1 轮 sha 去重 ${new Set(rows2.map((r) => r.sha1)).size}/10　第 2 轮 sha 去重 ${new Set(rows2.map((r) => r.sha2)).size}/10　事件序列去重 ${new Set(rows2.map((r) => r.events)).size}/10`);

const allOk = texts.size === 1 && shas.size === 1 && usages.size === 1 && evs.size === 1 && new Set(rows2.map((r) => r.sha1)).size === 1 && new Set(rows2.map((r) => r.sha2)).size === 1;

saveSection("e4a-faux-determinism", {
  singleRun: { distinctText: texts.size, distinctSha: shas.size, distinctUsage: usages.size, usages: [...usages], distinctEvents: evs.size, events: [...evs], rows },
  twoTurn: rows2,
  verdict: allOk ? "逐字节确定" : "有方差",
});
console.log(`  判定：${allOk ? "逐字节确定（单轮 + 两轮）" : "有方差"}`);
await env.close();
