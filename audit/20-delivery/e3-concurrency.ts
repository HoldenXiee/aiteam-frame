// E3：并发吞吐曲线、同消息内兄弟工具调用的真实并发度、同 agent 队列积压。
// 假 provider（零成本、无网络抖动），对照两侧都打印。
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent, createAgentHost } from "../../src/index.ts";
import { sleep } from "../../test/faux-server.ts";
import { makeEnv } from "../_faux.ts";

const env = await makeEnv("echo");
const out: any = {};
const mk = (extra: any = {}, deps: any = {}) =>
  createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir, ...extra }, { modelRuntime: env.runtime, ...deps });

console.log("═══ E3a：N 个不同分身各跑 [[sleep:100]]，墙钟 vs 串行预期 ═══");
const curve: any[] = [];
for (const n of [1, 4, 8, 16, 32]) {
  const t0 = process.hrtime.bigint();
  const agents = await Promise.all(Array.from({ length: n }, () => mk()));
  const tCreated = process.hrtime.bigint();
  await Promise.all(agents.map((a) => a.prompt("[[sleep:100]] 并发")));
  const t1 = process.hrtime.bigint();
  const row = {
    n,
    createMs: Number(tCreated - t0) / 1e6,
    runMs: Number(t1 - tCreated) / 1e6,
    totalMs: Number(t1 - t0) / 1e6,
    perAgentMs: Number(t1 - tCreated) / 1e6 / n,
    serialWouldBeMs: n * 100,
    heapMB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
  };
  curve.push(row);
  console.log(`  N=${String(n).padStart(2)} 建 ${row.createMs.toFixed(0)}ms 跑 ${row.runMs.toFixed(0)}ms（串行应为 ${row.serialWouldBeMs}ms）总 ${row.totalMs.toFixed(0)}ms 每个 ${row.perAgentMs.toFixed(1)}ms heap=${row.heapMB}MB`);
  agents.forEach((a) => a.dispose());
}
out.e3a = curve;

console.log("\n═══ E3b：同一条 assistant 消息里的兄弟工具调用，真实并发还是串行 ═══");
const sleepTool = (mode?: "parallel" | "sequential") =>
  defineTool({
    name: `probe_sleep_${mode ?? "default"}`,
    label: "probe_sleep",
    description: "睡眠 ms 毫秒",
    parameters: Type.Object({ ms: Type.Number() }),
    ...(mode ? { executionMode: mode } : {}),
    execute: async (_id: string, params: any) => {
      await sleep(params.ms);
      return { content: [{ type: "text" as const, text: `slept ${params.ms}` }], details: {} };
    },
  });
const sibling: any[] = [];
for (const mode of [undefined, "parallel", "sequential"] as const) {
  const name = `probe_sleep_${mode ?? "default"}`;
  for (const k of [1, 3]) {
    const a = await mk({ tools: [name], customTools: [sleepTool(mode)] });
    const marker = Array.from({ length: k }, () => `[[call:${name} {"ms":300}]]`).join(" ");
    const t0 = process.hrtime.bigint();
    await a.prompt(marker);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    sibling.push({ mode: mode ?? "default", k, ms: Number(ms.toFixed(0)) });
    console.log(`  executionMode=${(mode ?? "default").padEnd(10)} k=${k} → ${ms.toFixed(0)}ms（串行应为 ${k * 300}ms）`);
    a.dispose();
  }
}
out.e3b = sibling;

console.log("\n═══ E3c：同一个 agent 排队 10 条后的表现（vs 10 个独立 agent）═══");
const host = createAgentHost({ maxAgents: 50 });
const rounds: any[] = [];
host.on("round_completed", ({ agent, result }) => rounds.push({ id: agent.id, text: result.text.slice(0, 24), tok: result.usage.totalTokens }));
const a = await mk({}, { host });
const before = env.calls().length;
const main = a.prompt("[[sleep:300]] 主干");
await sleep(120);
const sends: any[] = [];
for (let i = 1; i <= 10; i++) sends.push(await a.send(`积压${i}`));
const mainRet = await main;
const afterMain = Number(process.hrtime.bigint() - 0n) / 1e9; // 仅占位
const t0 = process.hrtime.bigint();
await a.waitForIdle();
await sleep(200);
const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
const seq = env.calls().slice(before).map((c) => c.lastUser.slice(0, 16));
const order = seq.map((s) => (s.match(/积压(\d+)/)?.[1] ?? "主干"));
console.log(`  投递返回：${JSON.stringify(sends.map((s) => s.delivered))}`);
console.log(`  主干 prompt() 返回：${JSON.stringify(mainRet.text.slice(0, 40))} tok=${mainRet.usage.totalTokens}`);
console.log(`  实际请求数=${seq.length}（期望 11）  顺序=${JSON.stringify(seq)}`);
console.log(`  积压顺序是否 FIFO：${JSON.stringify(order.slice(1))} → ${JSON.stringify(order.slice(1)) === JSON.stringify(["1","2","3","4","5","6","7","8","9","10"]) ? "是" : "否"}`);
console.log(`  等队列排完耗时=${totalMs.toFixed(0)}ms  lastResult="${a.lastResult?.text}"  agent.usage=${a.usage.totalTokens}（11×18=198）`);
console.log(`  round_completed 播报 ${rounds.length} 次（期望？）：${JSON.stringify(rounds.map((r) => r.tok))}`);
out.e3c = { sends: sends.map((s) => s.delivered), mainText: mainRet.text, mainTok: mainRet.usage.totalTokens, requests: seq.length, seq, fifo: JSON.stringify(order.slice(1)) === JSON.stringify(["1","2","3","4","5","6","7","8","9","10"]), totalMs: Number(totalMs.toFixed(0)), lastResult: a.lastResult?.text, agentUsage: a.usage.totalTokens, roundCompleted: rounds.length, roundToks: rounds.map((r) => r.tok) };
a.dispose();
host.dispose();

{
  const host2 = createAgentHost({ maxAgents: 50 });
  const rounds2: any[] = [];
  host2.on("round_completed", ({ result }) => rounds2.push(result.usage.totalTokens));
  const agents = await Promise.all(Array.from({ length: 10 }, () => mk({}, { host: host2 })));
  await Promise.all(agents.map((x, i) => x.send(`独立${i}`)));
  await Promise.all(agents.map((x) => x.waitForIdle()));
  await sleep(200);
  console.log(`  对照（10 个独立 agent 各一条）：请求数=${env.calls().length - before - seq.length}，round_completed=${rounds2.length}，各 agent.usage=${JSON.stringify(agents.map((x) => x.usage.totalTokens))}`);
  out.e3d = { roundCompleted: rounds2.length, usages: agents.map((x) => x.usage.totalTokens) };
  agents.forEach((x) => x.dispose());
  host2.dispose();
}

const fs = await import("node:fs");
fs.writeFileSync(new URL("./data-e3.json", import.meta.url), JSON.stringify(out, null, 2), "utf-8");
console.log("\n→ audit/20-delivery/data-e3.json");
await env.close();
