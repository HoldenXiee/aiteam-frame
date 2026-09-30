// E4d：真模型下「spawn_agent 等待期间给子分身投一条」—— 主力委派原语是否真的报错结果（配对：投 / 不投）
import { createAgent, createAgentHost } from "../../src/index.ts";
import { sleep } from "../../test/faux-server.ts";
import { runLibTool, textOf } from "./_lib.ts";

const FLASH = "opencode-go/deepseek-v4.1-flash";
const spent = { tokens: 0, cost: 0 };

async function trial(inject: boolean) {
  const host = createAgentHost({ members: { w: {} }, defaults: { model: FLASH }, maxAgents: 10, maxDepth: 3 });
  const lead = await createAgent({ model: FLASH, tools: ["spawn_agent", "send_message"] }, { host });
  let child: any = null;
  host.on("agent_created", ({ agent, member }) => { if (member === "w") child = agent; });
  const spawnP = runLibTool(
    "spawn_agent",
    { member: "w", task: "请把 1 到 120 的数字逐个写出来，每行一个，不要其它文字。写完后最后一行写「完」。" },
    { agent: lead, host },
  );
  let sent: any = null;
  let waitedMs = 0;
  if (inject) {
    for (let i = 0; i < 60 && !child; i++) { await sleep(50); waitedMs += 50; }
    for (let i = 0; i < 60 && child && !child.isStreaming; i++) { await sleep(50); waitedMs += 50; }
    sent = await child.send("另外回答一个问题：日本的货币叫什么？只写两个字的答案，不要其它文字。");
  }
  const r = await spawnP;
  const text = textOf(r);
  spent.tokens += host.usage.totalTokens;
  spent.cost += host.usage.cost.total;
  const rec = {
    inject,
    waitedMs,
    sent,
    spawnTextHead: text.slice(0, 80).replace(/\n/g, "⏎"),
    spawnTextTail: text.slice(-120).replace(/\n/g, "⏎"),
    hasJapaneseYen: /日元/.test(text),
    hasNumberRun: /(^|\n)1(\n|$)/.test(text),
    childLast: child?.lastResult?.text?.slice(-60).replace(/\n/g, "⏎"),
    tokens: host.usage.totalTokens,
  };
  lead.dispose();
  host.dispose();
  return rec;
}

const rows: any[] = [];
for (const inject of [true, false]) {
  for (let t = 1; t <= 2; t++) {
    const r = await trial(inject);
    rows.push(r);
    console.log(`${inject ? "【投递组】" : "【对照组】"}第${t}次 等子分身忙等了 ${r.waitedMs}ms 投递返回=${JSON.stringify(r.sent)}`);
    console.log(`   spawn_agent 返回给父的开头=${JSON.stringify(r.spawnTextHead)}`);
    console.log(`   ...结尾=${JSON.stringify(r.spawnTextTail)}`);
    console.log(`   含「日元」(=后投那题的答案)=${r.hasJapaneseYen}   含数字接力(=原子任务)=${r.hasNumberRun}`);
  }
}
const fs = await import("node:fs");
fs.writeFileSync(new URL("./data-e4d.json", import.meta.url), JSON.stringify({ rows }, null, 2), "utf-8");
console.log(`\n→ audit/20-delivery/data-e4d.json　累计 ${spent.tokens} token / $${spent.cost.toFixed(5)}`);
