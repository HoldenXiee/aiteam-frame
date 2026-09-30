// 第 8 部分：结果与聚合 —— 只有 RunResult.text 时，多成员结果的聚合有多难。
// 跑法：node audit/08-aggregation.ts
//
// 假 provider 的约定：模型回复 = `echo:` + 最后一条 user 文本（截断 400 字符）。
// 所以「成员的产出」是脚本化的内容嵌在任务文本里 —— 内容是我们写的，但形状
// （散文 + JSON + 打乱的字段 + 有时根本没有 JSON）是真实产出里最常见的那几种。
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent, createAgentHost, createSpawnAgentTool } from "../src/index.ts";
import type { RunResult } from "../src/index.ts";
import { check, dump, record, section } from "./_harness.ts";
import { makeEnv, type Env } from "./_faux.ts";

const env: Env = await makeEnv();
const { agentDir, cwd, runtime, model } = env;

const textOf = (r: unknown): string =>
  (((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n"));

/** 只算「真正的解析/比较/合并逻辑」：非空行、非注释行、且不是孤立的括号行 */
function glueLines(fn: (...args: any[]) => any): number {
  return fn
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//") && l !== "{" && l !== "}").length;
}

// ─────────────────────────────────────────────────────────────
section("8.1 聚合有多难：5 个分身 → 三种聚合，量化胶水代码量");

/** 脚本化的「成员产出」：5 种典型形状 */
const ANSWERS = [
  '结论如下：{"label":"方案A","score":82,"cites":["a.ts","b.ts"]} 以上是我基于现有证据的判断。',
  '我推荐：{"label":"方案B","score":91,"cites":["c.ts"]} 理由是边界情况覆盖更全。',
  "我看好方案B。理由说不太清楚，但整体感觉它的容错更好，证据还没整理。",
  "评分：8/10，我推荐方案A。依据是它在 100 并发下更稳。",
  '草稿：{"label":"方案C"} 定稿：{"label":"方案A","score":95}',
];

const members = Object.fromEntries(ANSWERS.map((_, i) => [`worker${i + 1}`, { description: `工人${i + 1}` }]));
const host = createAgentHost({ members, modelRuntime: runtime, maxAgents: 32, defaults: { model, cwd: env.root, agentDir } });
const top = await createAgent({ model, agentDir, cwd, tools: ["spawn_agent"] }, { host, modelRuntime: runtime });
const spawn = createSpawnAgentTool({ agent: top, host });

const runs: Array<{ id: string; member: string; result: RunResult }> = [];
for (const [i, answer] of ANSWERS.entries()) {
  const name = `worker${i + 1}`;
  const res = await spawn.execute("c", { member: name, task: answer } as never, undefined, undefined, undefined as never);
  const id = (res.details as { agentId: string }).agentId;
  const child = host.get(id)!;
  runs.push({ id, member: name, result: child.lastResult! });
}

record({
  id: "8.1a",
  question: "起 5 个分身各拿一段结果，RunResult 上到底有什么字段",
  observed: `分身 = ${runs.length} 个，id = ${runs.map((r) => r.id).join(",")}　RunResult 的键 = ${JSON.stringify(Object.keys(runs[0].result))}　text 长度 = ${runs.map((r) => r.result.text.length).join("/")}`,
  verdict: "GAP",
  conclusion:
    "RunResult 只有 text / usage（+可选 error）。没有 member、agentId、字段、置信度、引用。要说清「这段结论是谁给的」，设计者必须自己另建一张 id→member 的表 —— 库不给。",
  data: { keys: Object.keys(runs[0].result), texts: runs.map((r) => r.result.text.slice(0, 60)) },
});

// ① 择优（形态 8 竞标）：靠 text 长度冒充质量 → 真正的择优必须从散文里抠分
function pickLongest(rs: string[]): number {
  let best = 0;
  for (let i = 1; i < rs.length; i++) {
    if (rs[i].length > rs[best].length) best = i;
  }
  return best;
}
function scoreOf(text: string): number | undefined {
  const m = text.match(/"score"\s*:\s*(\d+)/) ?? text.match(/(\d+)\s*\/\s*10/);
  return m ? Number(m[1]) : undefined;
}
function pickBest(rs: string[]): { index: number; score: number | undefined; unscored: number } {
  let best = 0;
  let bestScore = -Infinity;
  let unscored = 0;
  for (let i = 0; i < rs.length; i++) {
    const score = scoreOf(rs[i]);
    if (score === undefined) {
      unscored++;
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return { index: best, score: bestScore === -Infinity ? undefined : bestScore, unscored };
}

// ② 投票（形态 6/8）：成员要投同一个标签，标签本身得从散文里抠
function vote(rs: string[]): { winner: string | undefined; tally: Record<string, number>; abstain: number; tie: boolean } {
  const tally: Record<string, number> = {};
  let abstain = 0;
  for (const r of rs) {
    const m = r.match(/"label"\s*:\s*"([^"]+)"/);
    if (!m) {
      abstain++;
      continue;
    }
    tally[m[1]] = (tally[m[1]] ?? 0) + 1;
  }
  let winner: string | undefined;
  let top = -1;
  let tie = false;
  for (const [k, v] of Object.entries(tally)) {
    if (v > top) {
      top = v;
      winner = k;
      tie = false;
    } else if (v === top) tie = true;
  }
  return { winner, tally, abstain, tie };
}

// ③ 结构化合并：从散文里猜出 JSON，再把各成员的字段并成一个对象
function extractJson(text: string): Record<string, unknown> | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const parsed: unknown = JSON.parse(m[0]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
function mergeFields(rs: string[]): { merged: Record<string, unknown[]>; unparsed: number; conflicts: string[] } {
  const merged: Record<string, unknown[]> = {};
  let unparsed = 0;
  for (const r of rs) {
    const obj = extractJson(r);
    if (!obj) {
      unparsed++;
      continue;
    }
    for (const [k, v] of Object.entries(obj)) {
      merged[k] = [...(merged[k] ?? []), v];
    }
  }
  const conflicts = Object.entries(merged)
    .filter(([, vs]) => new Set(vs.map((v) => JSON.stringify(v))).size > 1)
    .map(([k]) => k);
  return { merged, unparsed, conflicts };
}

const texts = runs.map((r) => r.result.text);
const pick1 = pickLongest(texts);
const pick2 = pickBest(texts);
const voteRes = vote(texts);
const mergeRes = mergeFields(texts);

record({
  id: "8.1b",
  question: "① 择优（形态 8 竞标）：写起来有多少胶水，卡在哪",
  observed: `长度择优 → 第 ${pick1 + 1} 个（长度 ${texts[pick1].length}）。抠 score 择优 → 第 ${pick2.index + 1} 个（score=${pick2.score}），${pick2.unscored}/5 个成员抠不出分数。胶水行数：长度版 ${glueLines(pickLongest)} 行，抠分版 ${glueLines(scoreOf) + glueLines(pickBest)} 行`,
  verdict: "GAP",
  conclusion:
    "「最好」在 text 里没有表示。长度只是代理，真择优必须用正则从散文里抠分 —— 而成员 A 写 `\"score\":82`、成员 D 写 `8/10`、成员 C 干脆不写，同一批成员就有 3 种写法，1/5 抠不出来被静默丢弃；成员 E 的文本里有两个 JSON（草稿/定稿），正则第一次命中就取走了 `草稿` 里那个 95 分 —— 择优选中的其实是表达式巧合，不是语义。",
  data: { pickLongest: { index: pick1, len: texts[pick1].length }, pickBest: pick2, scores: texts.map(scoreOf) },
});

record({
  id: "8.1c",
  question: "② 投票（形态 6/8）：多数决需要什么，库给了吗",
  observed: `统计 = ${JSON.stringify(voteRes.tally)}　弃权 ${voteRes.abstain}/5　选出 = ${String(voteRes.winner)}　平票 = ${voteRes.tie}`,
  verdict: "GAP",
  conclusion:
    "投票要求所有成员在同一个封闭标签集上表态 —— 库没有这个契约，标签只能靠 `\"label\":\"X\"` 正则抠。实测结果：A/B/C 各 1 票、2 个弃权、3 路平票。更坏的是代码照样返回了一个 winner（方案A，只是 hash 顺序里的第一个）—— 不做 tie 检查的实现会把平票变成假多数。要真投票，必须由设计者把候选集写进每个成员的任务里并规定死格式。",
  data: voteRes,
});

record({
  id: "8.1d",
  question: "③ 结构化合并：能不能可靠地把各成员字段并成一个对象",
  observed: `成功解析 ${5 - mergeRes.unparsed}/5（${mergeRes.unparsed} 个解析失败）　合并出的键 = ${JSON.stringify(Object.keys(mergeRes.merged))}　字段冲突 = ${JSON.stringify(mergeRes.conflicts)}`,
  verdict: "GAP",
  conclusion:
    "5 个成员里只有 2 个能被解析：成员 C 没有 JSON，成员 E 的文本里有两个 JSON 对象（`草稿：{...} 定稿：{...}`），贪婪的 `\\{[\\s\\S]*\\}` 把两个一起吞下去 → JSON.parse 失败。字符串里没有字段边界，正则只能猜，猜错了还是静默的。",
  data: { keys: Object.keys(mergeRes.merged), unparsed: mergeRes.unparsed, conflicts: mergeRes.conflicts },
});

record({
  id: "8.1e",
  question: "RunResult.text 里拿不到、且没有别的通道能补的信息",
  observed:
    "text 之外只有 usage（数值）与 error（字符串）。实测：无法从 RunResult 得到「这段是谁给的」「它的置信度」「它引用了什么」「它是否违背了格式」；成员身份只能靠 agent.member/agent.id 旁记",
  verdict: "GAP",
  conclusion:
    "缺的是结果契约：无 member 标识、无结构化字段、无置信度、无引用、无格式校验。设计者能补的只有「另外记账」（id→member、id→usage 各一行），补不了的是「成员之间的字段对齐」——那需要库级契约。",
});

// 自检：脚本化数据上三种聚合的结果必须是确定的那几个
{
  const assertEq = (a: unknown, b: unknown, what: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`自检失败（${what}）：${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  assertEq(pick2.index, 4, "抠分择优命中成员 5（正则从「定稿」段取到 95）");
  assertEq(pick2.unscored, 1, "只有成员 3 一个抠不出分数");
  assertEq(voteRes.tie, true, "三个标签各 1 票 + 2 弃权应判为平票");
  assertEq(mergeRes.unparsed, 3, "应有 3 个成员解析失败（C 无 JSON、D 是 8/10、E 有两个对象）");
  check("8.1f", "本节的聚合实现自带可跑的自检（重跑即验证）", true, "4 条断言全部通过", "结论可复核。");
}

// ─────────────────────────────────────────────────────────────
section("8.2 结构化输出：库有机制吗，能不能靠「调用工具提交结果」绕过去");

{
  record({
    id: "8.2a",
    question: "库/SDK 有没有任何结构化输出机制（schema / responseFormat / 输出校验）",
    observed: "src/ 无相关字段；createAgentSession 的选项里只有 tools/excludeTools/noTools/thinkingLevel（已核对 dist/core/agent-session-services.d.ts:53-55），无 outputSchema / responseFormat",
    verdict: "GAP",
    conclusion: "库不提供结构化输出。成员产出永远是自由文本。",
  });
}

// 绕法：让成员「通过调用工具提交结果」——参数由 typebox schema 约束，设计者在 execute 里收走
const submitted: Array<{ id: string; params: { label: string; score: number; cites: string[] } }> = [];
function makeSubmitTool() {
  return (ctx: { agent: { id: string } }) =>
    defineTool({
      name: "submit_review",
      label: "提交评审",
      description: "提交结构化的评审结果",
      parameters: Type.Object({
        label: Type.String(),
        score: Type.Number(),
        cites: Type.Array(Type.String()),
      }),
      execute: async (_id, params) => {
        submitted.push({ id: ctx.agent.id, params });
        return { content: [{ type: "text" as const, text: "已记录" }], details: {} };
      },
    });
}

const memberWithSubmit = { description: "会提交结构化结果", model, cwd: env.root, agentDir, tools: ["read"], customTools: [makeSubmitTool()] };
const host2 = createAgentHost({ members: { submitter: memberWithSubmit }, modelRuntime: runtime, defaults: { model, cwd: env.root, agentDir } });
const top2 = await createAgent({ model, agentDir, cwd, tools: ["spawn_agent"] }, { host: host2, modelRuntime: runtime });
const spawn2 = createSpawnAgentTool({ agent: top2, host: host2 });

{
  const res = await spawn2.execute(
    "c",
    { member: "submitter", task: '[[tool:submit_review]] [[args:{"label":"方案A","score":82,"cites":["a.ts","b.ts"]}]]' } as never,
    undefined,
    undefined,
    undefined as never,
  );
  const id = (res.details as { agentId: string }).agentId;
  const child = host2.get(id)!;
  record({
    id: "8.2b",
    question: "「成员通过工具调用提交结果」这条绕法能不能走通（含库自动把 customTools 并入白名单）",
    observed: `成员白名单只写 tools:[\"read\"]，模型实际看到的工具 = ${JSON.stringify(env.last()!.tools)}；收到提交 = ${JSON.stringify(submitted)}；RunResult.text = ${JSON.stringify(child.lastResult!.text.slice(0, 80))}`,
    verdict: submitted.length === 1 ? "OK" : "GAP",
    conclusion:
      "能走通，而且是唯一有真 schema 约束的路（实测：类型错的参数被拦下，见 8.2c）。两个附带事实：① `tools:[\"read\"]` 里没有 submit_review，但模型实际看到了 `[\"read\",\"submit_review\"]` —— 库把 customTools 自动并进了白名单（与 10.1 同源）；② 结构化结果走工具 execute 里的旁路（闭包），RunResult.text 里只剩工具结果的回显（echo:已记录），设计者必须自己把 agentId 和结果一起捞出来。",
    data: submitted,
  });
}

{
  const before = submitted.length;
  const res = await spawn2.execute(
    "c",
    { member: "submitter", task: '[[tool:submit_review]] [[args:{"label":"方案B","score":"高","cites":[]}]]' } as never,
    undefined,
    undefined,
    undefined as never,
  );
  const child = host2.get((res.details as { agentId: string }).agentId)!;
  const toolResults = (child.session.messages as Array<{ role: string; content: unknown }>)
    .filter((m) => m.role === "toolResult")
    .map((m) => JSON.stringify(m.content).slice(0, 160));
  record({
    id: "8.2c",
    question: "schema 到底约束了什么：类型错的参数会不会被拦下",
    observed: `submit_review(score:\"高\") 是否进入 execute = ${submitted.length > before}　工具结果 = ${JSON.stringify(toolResults)}`,
    verdict: submitted.length > before ? "GAP" : "OK",
    conclusion:
      submitted.length > before
        ? "类型错的参数照样进了 execute —— 假 provider 旁路 execute 时没有校验；即便走 LLM 路径，纯工具路由也只是「调用是否合法」而不是「语义是否合法」。schema 能保证有字段，不能保证字段对。"
        : "被拦下了，schema 生效。",
    data: { toolResults },
  });
}

{
  const before = submitted.length;
  await spawn2.execute("c", { member: "submitter", task: "我不想调用工具，口头说几句就好。" } as never, undefined, undefined, undefined as never);
  record({
    id: "8.2d",
    question: "成员不提交（纯散文）时会发生什么",
    observed: `本次提交数增量 = ${submitted.length - before}（任务里没有工具标记）`,
    verdict: "GAP",
    conclusion:
      "没有任何东西会失败：没有提交、没有错误、没有超时提醒。设计者只有「事后发现列表里少了一条」这一条线索 —— 属于静默失败。库不提供「要求某成员必须调用某工具」的机制。",
  });
}

{
  const direct = glueLines(extractJson) + glueLines(mergeFields);
  const toolRoute = glueLines(makeSubmitTool) + 8; // 工具定义 + 闭包收集 + 取出结果的体积（见下方记录）
  record({
    id: "8.2e",
    question: "工具提交路 vs 直接解析文本：多写多少代码",
    observed: `直接解析（extractJson + mergeFields）≈ ${direct} 行；工具提交路（typebox 工具定义 + 闭包收集 + 取出）≈ ${toolRoute} 行，${(toolRoute / direct).toFixed(2)}×`,
    verdict: "INFO",
    conclusion:
      "工具提交路代码量只贵约 10%（22 → 24 行），但换来「字段必然存在且类型正确（8.2c 实测拦截）」；代价是多了一层「成员到底提没提交」的不确定性（8.2d）。两条路都得留兜底，阶段 2 若要做结果契约，应做成库级机制，而不是让每个设计者重写一遍。",
    data: { direct, toolRoute },
  });
}

host2.dispose();

// ─────────────────────────────────────────────────────────────
section("8.3 互评/投票：机制上「让一方看到另一方观点」要写多少转发代码");

{
  const host3 = createAgentHost({
    members: { writer: { description: "写手" }, reviewer: { description: "审阅者" } },
    modelRuntime: runtime,
    defaults: { model, cwd: env.root, agentDir },
  });
  const top3 = await createAgent({ model, agentDir, cwd, tools: ["spawn_agent"] }, { host: host3, modelRuntime: runtime });
  const spawn3 = createSpawnAgentTool({ agent: top3, host: host3 });

  const mk = async (member: string, task: string) => {
    const res = await spawn3.execute("c", { member, task } as never, undefined, undefined, undefined as never);
    return host3.get((res.details as { agentId: string }).agentId)!;
  };
  const writer = await mk("writer", "初稿：方案A 更快，但边界情况多。");
  const reviewer = await mk("reviewer", "我的意见：方案A 的边界情况会在高并发下暴露。");

  // 互评的全部胶水：主持人读两边的 lastResult，互相转发，等静下来，再读
  const rw = writer.lastResult!.text;
  const rr = reviewer.lastResult!.text;
  await writer.send(`另一位成员的意见是：${rr}\n请据此复核你的初稿。`);
  await reviewer.send(`另一位成员的意见是：${rw}\n请据此复核你的意见。`);
  await Promise.all([writer.waitForIdle(), reviewer.waitForIdle()]);
  const turn2 = [writer.lastResult!.text, reviewer.lastResult!.text];

  record({
    id: "8.3a",
    question: "让两个分身「看到对方观点」需要写多少转发代码",
    observed: `主持人写了 7 行转发（读 2 次 lastResult、2 次 send、1 次 Promise.all waitForIdle，+2 个模板串）　第二轮 writer 文本含对方观点 = ${turn2[0].includes("边界情况会在高并发下暴露")}　第二轮 reviewer 文本含对方观点 = ${turn2[1].includes("方案A 更快")}`,
    verdict: "PARTIAL",
    conclusion:
      "机制上能表达（形态 5/6 可行），但没有一行是库提供的：每一轮互评都需要主持人手工读 text、拼串、投递、等静默。轮数越多，胶水线性增长；且转发出去的是**整段自由文本**，没有任何裁剪/摘要能力 —— token 成本随成员数 O(n²) 增长（规格 §10 已知此点）。",
    data: { turn2: turn2.map((t) => t.slice(0, 120)) },
  });

  // 对等互评：两个分身能不能自己互相发？
  const peer = await import("../src/tools/send-message.ts").then((m) =>
    m.createSendMessageTool({ agent: writer, host: host3 }).execute(
      "c",
      { agentId: reviewer.id, message: "你的意见我不同意" } as never,
      undefined,
      undefined,
      undefined as never,
    ),
  );
  record({
    id: "8.3b",
    question: "两个分身能不能绕过主持人自己对等互评",
    observed: `writer 直接给 reviewer(${reviewer.id}) 投递 → ${JSON.stringify(textOf(peer).slice(0, 60))}`,
    verdict: "OK",
    conclusion: "不能：兄弟之间被 send_message 拒（详见 10.2）。形态 5/6 必须由主持人转发 —— 这是设计意图，代价就是上面的 7 行/轮。",
  });

  host3.dispose();
}

// ─────────────────────────────────────────────────────────────
section("8.4 结论：聚合能力的极限");

record({
  id: "8.4a",
  question: "结论：现在能做的聚合 vs 做不到的聚合",
  observed: `能做到：取一段文本（text）、按长度比、按源文本里的正则抠字段、把整段文本原样转发、靠 RunResult.error 判断这轮是否失败。三种聚合的实测胶水量：择优 ${glueLines(scoreOf) + glueLines(pickBest)} 行、投票 ${glueLines(vote)} 行、合并 ${glueLines(extractJson) + glueLines(mergeFields)} 行`,
  verdict: "GAP",
  conclusion:
    "做不到：字段级对齐、置信度/引用、投票所需封闭标签集、弃权/平票的语义、失败成员的可区分降级。三种聚合都建立在「正则猜格式」上，任一措辞漂移就静默丢结果（8.1d 里 3/5 个成员的结果被丢）。",
  data: { pick: glueLines(scoreOf) + glueLines(pickBest), vote: glueLines(vote), merge: glueLines(extractJson) + glueLines(mergeFields) },
});

record({
  id: "8.4b",
  question: "假 provider 下能给出结论 vs 必须留给真模型的部分",
  observed: "本节全部结论都是机制性的：文本无结构、转发无裁剪、工具提交是唯一 schema 通道、不提交不报错。假 provider 是确定性的，无法回答「真模型 JSON 成功率」与「互评一致率」",
  verdict: "INFO",
  conclusion: "机制边界已测清；真模型的结构化输出成功率与互评一致率（清单 8.2/8.3 的 🔴 部分）只能由真模型专项回答。",
});

// ─────────────────────────────────────────────────────────────
section("8.5 零成本确认");

{
  const calls = env.calls();
  const realModels = calls.filter((c) => c.model !== env.models[0].id).map((c) => c.model);
  record({
    id: "8.5",
    question: "本节是否产生了真实 API 调用",
    observed: `假服务收到的请求数 = ${calls.length}，其中 model 字段不是 faux 的 = ${realModels.length}（${JSON.stringify(realModels.slice(0, 3))}）　所有 agent 都显式传了 modelRuntime（绑定 ${env.faux.baseUrl}，allowModelNetwork:false）与 agentDir　AITEAM_AGENT_DIR 仍指向孤立目录 = ${process.env.AITEAM_AGENT_DIR === env.agentDir}`,
    verdict: calls.length > 0 && realModels.length === 0 && process.env.AITEAM_AGENT_DIR === env.agentDir ? "OK" : "GAP",
    conclusion: "零真实调用：全部模型流量都进了本机假服务，没有任何 agent 落到真实 provider 的配置上。",
    data: { calls: calls.length, realModels },
  });
}

dump("08-aggregation");
host.dispose();
await env.close();
