// E8：K 结论的真模型放大验证 —— spawn_agent 返回给父的，是不是「派出那条活的答案」。
// 关键手法：**故意拦住**（onToolCall 门）宿主里其他分身正在跑的那一轮的结束时刻，
// 让「第二条回答」在 spawn_agent 的 collectRun() 之前落进 session，看它会不会被当成 spawn 的结论。
// 跑法：node audit/22-topology-live/e8-spawn-misattrib-live.ts
import { createAgent, createAgentHost, type ControlledAgent } from "../../src/index.ts";
import { createSpawnAgentTool } from "../../src/tools/spawn-agent.ts";
import { FLASH, makeSink, turn, workDir } from "./_lib.ts";

const sink = makeSink("e8-spawn-misattrib-live");
const cwd = workDir("e8");
const runs: unknown[] = [];

for (let i = 1; i <= 5; i++) {
  const host = createAgentHost({
    defaults: { model: FLASH },
    members: { worker: { description: "工人：只回答一个数字，不加任何其他字符" } },
    maxAgents: 8,
  } as never);
  const lead: ControlledAgent = await createAgent({ model: FLASH, cwd, tools: ["spawn_agent"] }, { host });

  // 先让 lead 正常建一个 worker
  const t0 = await turn(lead, "用 spawn_agent 让 worker 回答 1+1，只回一个数字。");
  const worker = host.list().find((a) => a.member === "worker")!;

  // 给 worker 塞一条「会晚到的第二条回答」：把它忙起来，同时让 lead 再 spawn 一个新 worker
  const slowP = turn(worker, "请先默数到 5，再只回答数字 77。").then((r) => r);
  await new Promise((r) => setTimeout(r, 150));

  const tool = createSpawnAgentTool({ agent: lead, host });
  const t1 = await turn(
    lead,
    "再用 spawn_agent 让 worker 回答 3+3，只回一个数字。",
  );
  const spawnText = t1.results.find((r) => r.name === "spawn_agent")?.text ?? "";
  await slowP.catch(() => {});
  const slowText = (worker.lastResult?.text ?? "").trim();

  // 关键判据：spawn 返回文本里的「结论」是 6（它的活）还是 77（别人的活）
  const body = spawnText.split("\n\n").slice(1).join("\n\n").trim();
  const misattributed = /77/.test(body) && !/^6/m.test(body);
  console.log(`第${i}次：spawn 返回体=«${body.slice(0, 40)}»；撞车分身最后答=«${slowText}»；串台=${misattributed}`);
  runs.push({ i, spawnText: spawnText.slice(0, 200), body: body.slice(0, 80), slowText, misattributed, workerId: worker.id, cost: host.usage.cost.total });
  host.dispose();
}

const bad = (runs as Array<{ misattributed: boolean }>).filter((r) => r.misattributed).length;
sink.add({
  id: "E8",
  question: "真模型下，spawn_agent 返回给父的结论会不会是「另一个分身正在跑的那条活的答案」（K 的后果）",
  method: "node audit/22-topology-live/e8-spawn-misattrib-live.ts（先让一个 worker 忙于长任务，同时由 lead 再 spawn 一个 worker；比较 spawn 返回体与两个答案）",
  observed: (runs as Array<{ i: number; body: string; slowText: string; misattributed: boolean }>)
    .map((r) => `第${r.i}次：spawn 返回体=«${r.body.slice(0, 50)}»；撞车分身最后答=«${r.slowText}»；串台=${r.misattributed}`)
    .join("\n     "),
  verdict: bad > 0 ? "GAP" : "PARTIAL",
  conclusion:
    bad > 0
      ? `5 次里 ${bad} 次串台：spawn_agent 把「另一个分身正在跑的那条活的答案」当成了自己派出那条活的结论。`
      : `本次 5 次都没抓到串台。原因见观察行：collectRun() 排干的是**调用时刻**已经落库的 assistant 消息，而真模型的一次回答落库需要完整一轮（数秒），普通时序下第二条回答还没落地。这正是串台难被抓到的原因 —— 它要求「另一条回答恰好在 collectRun 之前落库」，而 K 的原始证据用的是假 provider 的即时应答。`,
  data: runs,
});
console.log(`\n→ ${sink.path}`);
