// E7：已知盲区 1 —— 「同一个 agent 被重叠投递」，用真模型把 K 结论的后果钉一次。
// K（已由假 provider 证实）：RunResult 不跟调用绑定，会串台；spawn_agent 的返回值可能是**后一条**消息的答案。
// 这里做的是它没做的：真模型下，主持人会不会把后一条答案当成自己刚派出去的活的结论？
// 跑法：node audit/22-topology-live/e7-overlap-send-live.ts   （真模型，零并发）
import { createAgent, createAgentHost } from "../../src/index.ts";
import { FLASH, makeSink, turn, workDir } from "./_lib.ts";

const sink = makeSink("e7-overlap-send-live");
const cwd = workDir("e7");

// 场景：主持人 P 有一个后代 W（设计者预先建好，不经 spawn）。
// 然后 P 同时发出两条投递：一条「慢活」（要它数到 5 再答 11），一条「快活」（立刻答 22）。
// 看 P 在哪一条上拿到哪个答案，以及它自己怎么解读。
async function run(i: number) {
  const host = createAgentHost({
    defaults: { model: FLASH },
    members: { w: { description: "工人：严格按指示回答", tools: [] } },
    maxAgents: 8,
  } as never);
  const P = await createAgent({ model: FLASH, cwd, tools: ["send_message"] }, { host });
  const W = await createAgent(
    { model: FLASH, cwd, tools: [], role: "你是一个只会回答数字的工人。任何情况下都只回一个数字。" },
    { host, parent: P, member: "w" },
  );

  // 第 1 步：让 W 忙起来（一轮长任务）
  const slow = turn(W, "请先默数到 5，然后只回答数字 11。");
  // 不等它，立刻让主持人 P 投递一条消息
  const t1 = await turn(P, `用 send_message 给 id 为 ${W.id} 的分身发一条消息，内容正好是「只回答数字 22」。`);
  const sendResult1 = t1.results.find((r) => r.name === "send_message")?.text ?? "";
  await slow;
  await W.waitForIdle();
  const afterOverlap = (W.lastResult?.text ?? "").trim();
  const wUsage = W.usage.totalTokens;

  // 第 2 步：主持人在**自己下一轮**里汇报它认为刚才那次投递得到了什么
  const t2 = await turn(P, "刚才你给那个分身投递了消息。请告诉我：它回了什么？只回你确实看到的内容。");
  const tokens = host.usage.totalTokens;
  const cost = host.usage.cost.total;
  const rec = {
    i,
    wId: W.id,
    slowAnswer: (slow.text ?? "").trim(),
    sendResult1,
    afterOverlap,
    hostReport: (t2.text ?? "").slice(0, 300),
    tokens,
    cost,
    sessionTail: (W.session.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
      .slice(-4)
      .map((m) => ({ role: m.role, text: m.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").slice(0, 40) })),
  };
  host.dispose();
  return { rec, wUsage };
}

sink.section("E7 同一个 agent 被重叠投递（真模型）");
const runs = [];
for (let i = 1; i <= 4; i++) {
  const { rec, wUsage } = await run(i);
  console.log(
    `第${i}次：慢活最终答=${JSON.stringify(rec.afterOverlap)}；send_message 返回=«${rec.sendResult1}»；主持人自述=«${rec.hostReport.slice(0, 100)}»；W 累计 ${wUsage}tok；$${rec.cost.toFixed(6)}`,
  );
  runs.push({ ...rec, wUsage });
}

const confusion = runs.filter((r) => r.afterOverlap && !/11/.test(r.afterOverlap));
const honest = runs.filter((r) => /没有|不知道|看不到|收不到|未|无法/.test(r.hostReport));
sink.add({
  id: "E7.a",
  question: "真模型下，主持人重叠投递一个正忙的后代后，它能不能正确判断「那条消息的答案是什么」",
  method: "node audit/22-topology-live/e7-overlap-send-live.ts（W 忙时 P 投递 send_message，随后追问 P「它回了什么」）",
  observed: runs
    .map(
      (r) =>
        `第${r.i}次：W 忙时被投递；W 最终 lastResult=«${r.afterOverlap}»（慢活应该答 11）；send_message 工具返回=«${r.sendResult1}»；主持人自述=«${r.hostReport.slice(0, 120)}»`,
    )
    .join("\n     "),
  verdict: "PARTIAL",
  conclusion: `${runs.length} 次里 ${honest.length} 次主持人如实说「看不到/没有回执」；${runs.length - honest.length} 次给出了具体回答。工具侧确认：send_message 只回「已投递：xxx 正忙，消息已排队」，**不回内容**，所以主持人本来就拿不到答案 —— 这里测的是它会不会编。`,
  data: runs,
});
sink.add({
  id: "E7.b",
  question: "叠加量：忙时投递 + 紧接一次 prompt，会不会出现 K5（紧随 prompt 直接抛）",
  method: "同一会话里 W 在跑时对它 send()，紧接着再 prompt()",
  observed: "",
  verdict: "INFO",
  conclusion: "见 E7.c（单独构造）。",
  data: {},
});

// E7.c：K5 的真模型复现（send 后紧接 prompt）
sink.section("E7.c K5 真模型复现");
{
  const host = createAgentHost({ defaults: { model: FLASH }, maxAgents: 4 } as never);
  const A = await createAgent({ model: FLASH, cwd, tools: [] }, { host });
  const slow = turn(A, "请先默数到 3，然后只回答数字 7。");
  await new Promise((r) => setTimeout(r, 200)); // 让它进入 streaming
  const busy = A.isStreaming;
  const sr = await A.send("只回答数字 8。").catch((e) => ({ delivered: `THROW: ${(e as Error).message}` }));
  let promptErr = "";
  try {
    const r = await A.prompt("只回答数字 9。");
    promptErr = `返回 text=«${r.text.trim().slice(0, 30)}» error=${r.error ?? "(无)"}`;
  } catch (e) {
    promptErr = `抛错：${(e as Error).message}`;
  }
  await slow.catch(() => {});
  await A.waitForIdle().catch(() => {});
  const usage = A.usage;
  console.log(`isStreaming@投递时=${busy}；send()=${JSON.stringify(sr)}；紧随 prompt → ${promptErr}；累计 ${usage.totalTokens}tok`);
  sink.add({
    id: "E7.c",
    question: "K5 在真模型下是否复现：忙时 send() 之后紧随的 prompt() 会不会抛",
    method: "A 在跑时 send()，紧接着 prompt()",
    observed: `投递时 isStreaming=${busy}；send() 返回=${JSON.stringify(sr)}；紧随其后的 prompt() → ${promptErr}`,
    verdict: /抛错|THROW/.test(promptErr + JSON.stringify(sr)) ? "GAP" : "OK",
    conclusion: /抛错/.test(promptErr)
      ? `真模型下复现 K5：忙时 send() 之后立刻 prompt() 抛错（${promptErr.slice(0, 80)}），而不是排队。假 provider 下的结论在真模型上成立。`
      : `本次未复现（prompt 正常返回）。可能是慢了 200ms 后 A 已不忙；K5 的复现依赖精确的忙闲窗口。`,
    data: { busy, sr, promptErr, usage },
  });
  host.dispose();
}

console.log(`\n→ ${sink.path}`);
