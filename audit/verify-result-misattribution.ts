// 测「RunResult 归属错位」能否被正常代码触发：send() 与 prompt() 紧邻调用（设计者常用写法）
import { createAgent, createAgentHost } from "../src/index.ts";
import { startFaux, sleep } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";
import { runTool } from "../test/helpers.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);
const mk = () => createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { modelRuntime: made.runtime });

console.log("═══ 触发路径 A：空闲时 send(A) 紧接 prompt(B) ═══");
for (let i = 1; i <= 3; i++) {
  const a = await mk();
  const sent = await a.send("任务A");
  const b = await a.prompt("任务B").catch((e) => ({ text: `THROW:${(e as Error).message.slice(0, 40)}`, usage: { totalTokens: -1 } } as never));
  await a.waitForIdle(); await sleep(300);
  console.log(`  第${i}次：send→${JSON.stringify(sent)}  prompt("任务B")→${JSON.stringify(b.text)}  ${/任务B/.test(b.text) ? "✅ 正确" : "❌ 串台"}`);
  a.dispose();
}

console.log("\n═══ 触发路径 B：spawn_agent 等待期间，父给子再投一条（send_message）═══");
{
  const host = createAgentHost({ members: { w: {} } });
  const lead = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir, tools: ["spawn_agent", "send_message"] }, { host, modelRuntime: made.runtime });
  // 直接调 spawn_agent，task 带 sleep 制造窗口；同时刻给同一个子分身投第二条
  const spawnP = runTool("spawn_agent", { member: "w", task: "[[sleep:700]] 子任务原文" }, { agent: lead, host } as never);
  await sleep(350);
  const child = host.list().find((x) => x.member === "w");
  if (child) {
    const s = await child.send("追加的第二条");
    await child.waitForIdle();
    const r = await spawnP;
    const text = (r.content[0] as any).text as string;
    console.log(`  spawn_agent 返回给父的文本：${JSON.stringify(text.slice(0, 150))}`);
    console.log(`  → 里面是${/子任务原文/.test(text) ? "子任务原文 ✅" : "**追加的第二条（串台）❌**"}`);
    console.log(`  追加投递返回：${JSON.stringify(s)}`);
  } else console.log("  没抓到子分身");
  host.dispose();
}
await faux.close();
