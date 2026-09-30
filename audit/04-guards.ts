// 第 4 部分：护栏与预算 —— 三道护栏的触发时机、预算耗尽的真实体验、名额锁死。
// 跑法：node audit/04-guards.ts
import { createAgent, createAgentHost, type ControlledAgent } from "../src/index.ts";
import { createSpawnAgentTool } from "../src/tools/spawn-agent.ts";
import { check, dump, record, section } from "./_harness.ts";
import { makeEnv } from "./_faux.ts";

const env = await makeEnv();
const { agentDir, cwd, runtime, model } = env;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 假服务每次请求固定返回 18 token —— 预算类实验全靠这个已知常数 */
const TOK = 18;

const hostWith = (opts: Record<string, unknown> = {}) =>
  createAgentHost({ modelRuntime: runtime, defaults: { model, cwd, agentDir }, ...opts } as never);
const mk = (host: ReturnType<typeof createAgentHost>, extra: Record<string, unknown> = {}) =>
  createAgent({ model, cwd, agentDir, ...extra }, { host, modelRuntime: runtime });
const textOf = (r: unknown) => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");

// ─────────────────────────────────────────────────────────────
section("4.1 三道护栏的触发时机（误触发 / 漏触发）");

{
  const host = hostWith({ maxAgents: 3, members: { w: {} } });
  const top = await mk(host, { tools: ["spawn_agent"] });
  const spawn = createSpawnAgentTool({ agent: top, host });
  const results: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await spawn.execute("c", { member: "w", task: `第${i}个` } as never, undefined, undefined, undefined as never);
    const t = textOf(r);
    results.push(t.startsWith("已让成员") ? "成功" : t.slice(0, 40));
  }
  record({
    id: "4.1a",
    question: "maxAgents 的计数对象：是当前存活数还是历史创建数",
    observed: `maxAgents=3，连续 spawn 5 次 → ${JSON.stringify(results)}；host.list() = ${host.list().length}`,
    verdict: results.filter((r) => r === "成功").length === 2 ? "INFO" : "GAP",
    conclusion:
      `顶层自己占了 1 个名额，所以只成功 ${results.filter((r) => r === "成功").length} 次 —— 上限计的是**本宿主创建过的分身总数（含顶层，终身累计）**，不是「当前存活」。名字叫 maxAgents 但语义是 maxAgentsEverCreated。`,
    data: { results, alive: host.list().length },
  });
  host.dispose();
}

{
  // 漏触发：并发创建时预检都看到同一个旧计数 → 登记处抛错
  const host = hostWith({ maxAgents: 3, members: { w: {} } });
  const top = await mk(host, { tools: ["spawn_agent"] });
  const spawn = createSpawnAgentTool({ agent: top, host });
  const all = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      spawn
        .execute("c", { member: "w", task: `并发${i}` } as never, undefined, undefined, undefined as never)
        .then((r) => (textOf(r).startsWith("已让成员") ? "成功" : `返文本「${textOf(r).slice(0, 20)}」`))
        .catch((e) => `抛异常「${(e as Error).message.slice(0, 26)}」`),
    ),
  );
  record({
    id: "4.1b",
    question: "并发触发 maxAgents 时，spawn_agent 是否仍遵守「返回错误文本、不抛异常」的契约",
    observed: `maxAgents=3（顶层占 1），并发 6 次 → ${JSON.stringify(all)}；最终 host.list() = ${host.list().length}`,
    verdict: all.some((x) => x.startsWith("抛异常")) ? "GAP" : "OK",
    conclusion: all.some((x) => x.startsWith("抛异常"))
      ? `上限本身没被击穿（最终 ${host.list().length} ≤ 3），但**并发下超限的那几次是抛异常出来的**：预检 checkCanCreate 与真正的 register 之间有时间窗口，预检通过后 register 才拒。` +
        "工具层只对预检结果做文本转换，没有把 createAgent 的异常也转成文本 → 违反规格『护栏触发时返回错误结果文本而非抛异常』的约定。串行调用时看不出来（预检总是先知道），一并发就露出来。"
      : "契约保持。",
    data: { all, alive: host.list().length },
  });
  host.dispose();
}

{
  // 预算耗尽时 spawn_agent 里的 child.prompt() 抛错，工具层同样不接
  const host = hostWith({ budgetTokens: 1 * TOK, members: { w: {} } });
  const top = await mk(host, { tools: ["spawn_agent"] });
  await top.prompt("把预算花光");
  const spawn = createSpawnAgentTool({ agent: top, host });
  let outcome = "";
  let childLeft = 0;
  try {
    const r = await spawn.execute("c", { member: "w", task: "干活" } as never, undefined, undefined, undefined as never);
    outcome = `返文本「${textOf(r).slice(0, 50)}」`;
  } catch (e) {
    outcome = `抛异常「${(e as Error).message.slice(0, 50)}」`;
  }
  childLeft = host.list().filter((x) => x.member === "w").length;
  record({
    id: "4.1d",
    question: "预算耗尽时 spawn_agent 的行为（预检拦得住吗）",
    observed: `预算已耗尽后调用 spawn_agent → ${outcome}；宿主里该成员的分身数 = ${childLeft}`,
    verdict: outcome.includes("返文本") ? "OK" : "GAP",
    conclusion: outcome.includes("返文本")
      ? "预检在预算这一道拦住了，返回错误文本。"
      : "预检没拦住（或拦住了但另一条路径抛错）—— 设计者必须额外 try/catch。",
    data: { outcome, childLeft },
  });
  host.dispose();
}

{
  // maxDepth 会不会被 spawn 工具自己绕过（子分身的 spawn 用的是自己那一层的深度）
  const host = hostWith({ maxDepth: 2, maxAgents: 50, members: { mid: { tools: ["spawn_agent"] }, leaf: {} } });
  const top = await mk(host, { tools: ["spawn_agent"] });
  const spawnTop = createSpawnAgentTool({ agent: top, host });
  const r1 = textOf(await spawnTop.execute("c", { member: "mid", task: "组队" } as never, undefined, undefined, undefined as never));
  const mid = host.list().find((x) => x.member === "mid")!;
  const spawnMid = createSpawnAgentTool({ agent: mid, host });
  const r2 = textOf(await spawnMid.execute("c", { member: "leaf", task: "干活" } as never, undefined, undefined, undefined as never));
  const leaf = host.list().find((x) => x.member === "leaf")!;
  const spawnLeaf = createSpawnAgentTool({ agent: leaf, host });
  const r3 = textOf(await spawnLeaf.execute("c", { member: "leaf", task: "再往下" } as never, undefined, undefined, undefined as never));
  record({
    id: "4.1c",
    question: "maxDepth 在多层 spawn 下的触发点是否精确",
    observed: `深度1（mid）：${r1.startsWith("已让") ? "成功" : r1.slice(0, 30)}；深度2（leaf）：${r2.startsWith("已让") ? "成功" : r2.slice(0, 30)}；深度2 再 spawn：${r3.slice(0, 40)}`,
    verdict: r3.includes("maxDepth") ? "OK" : "GAP",
    conclusion: r3.includes("maxDepth") ? "精确：深度 2 的分身再 spawn 被拒，且错误信息带 maxDepth 数值。" : "触发点不对。",
    data: { r1: r1.slice(0, 40), r2: r2.slice(0, 40), r3: r3.slice(0, 60) },
  });
  host.dispose();
}

{
  // 子分身不继承父的 model → 回落到全局 settings 默认（可能是真实模型）
  const hostNoDefaults = createAgentHost({ modelRuntime: runtime, maxAgents: 10, members: { w: {} } } as never);
  const top = await createAgent({ model, cwd, agentDir, tools: ["spawn_agent"] }, { host: hostNoDefaults, modelRuntime: runtime });
  const spawn = createSpawnAgentTool({ agent: top, host: hostNoDefaults });
  const out = textOf(await spawn.execute("c", { member: "w", task: "干活" } as never, undefined, undefined, undefined as never));
  const childReq = env.calls().length;
  record({
    id: "4.1e",
    question: "host.defaults 与成员都没有 model 时，spawn 出来的子分身用什么模型",
    observed: `父用 model=${model}；子成员未声明 model、host.defaults 也没有 → 子分身的返回：${out.slice(0, 150)}（假服务收到的请求数 ${childReq}，即这一轮根本没走假服务）`,
    verdict: out.includes("402") || out.includes("出错") ? "GAP" : "OK",
    conclusion:
      "父的模型**不继承**。子分身只由【成员定义 + host.defaults】决定配置，model 缺失时回落 pi 的全局 settings 默认（实测直接打了真实 provider，返回 402）。注意此时 host 已经持有 faux 的 modelRuntime 也没用 —— runtime 决定「去哪里找模型」，不能决定「用哪个模型」。设计者必须给每个成员或 defaults 显式写 model。",
    data: { out: out.slice(0, 200), fauxCallsDelta: childReq },
  });
  hostNoDefaults.dispose();
}

// ─────────────────────────────────────────────────────────────
section("4.2 预算的语义与实际强度");

{
  const host = hostWith({ budgetTokens: 3 * TOK }); // 54
  const a = await mk(host);
  const logs: string[] = [];
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await a.prompt(`第${i}轮`);
      logs.push(`${i}:ok(${host.usage.totalTokens})`);
      void r;
    } catch (e) {
      logs.push(`${i}:抛错「${(e as Error).message.slice(0, 40)}」`);
    }
  }
  record({
    id: "4.2a",
    question: "预算耗尽时 prompt 的行为",
    observed: `budgetTokens=54，每轮 18 token → ${JSON.stringify(logs)}`,
    verdict: logs.some((l) => l.includes("抛错")) ? "OK" : "GAP",
    conclusion:
      "耗尽后 prompt() **直接抛错**（不是返回带 error 的 RunResult）。设计者必须用 try/catch，且不能靠 RunResult.error 拿到它 —— 两套错误通道（抛错 vs error 字段）并存。",
    data: { logs, usage: host.usage.totalTokens },
  });
  host.dispose();
}

{
  // 关键：预算耗尽后用 send 会不会谎报 ran
  const host = hostWith({ budgetTokens: 1 * TOK });
  const a = await mk(host);
  await a.prompt("先把预算花光");
  const errs: string[] = [];
  a.on("error", (p) => errs.push(p.message.slice(0, 50)));
  const r = await a.send("预算已经没了，这条应该跑不了");
  await sleep(400);
  record({
    id: "4.2b",
    question: "预算耗尽后 send 的返回值是否诚实",
    observed: `send 返回 ${JSON.stringify(r)}；error 事件 = ${JSON.stringify(errs)}；isStreaming = ${a.isStreaming}`,
    verdict: r.delivered === "ran" && errs.length > 0 ? "GAP" : "OK",
    conclusion:
      r.delivered === "ran" && errs.length > 0
        ? "谎报。send 返回 delivered=\"ran\"（声称『已开始跑』），实际 prompt() 在预算检查处就抛错了、一个字都没跑；错误只通过 error 事件暴露。设计者若只看 send 的返回值会以为消息在处理。"
        : "返回值诚实。",
    data: { r, errs },
  });
  host.dispose();
}

{
  // 并发下的预算击穿：预检都在 usage 还没涨的时候通过
  const host = hostWith({ budgetTokens: 2 * TOK, maxAgents: 64 });
  const kids = await Promise.all(Array.from({ length: 10 }, () => mk(host)));
  const outcomes = await Promise.all(
    kids.map((k) => k.prompt("一起跑").then(() => "ok").catch((e) => `抛错:${(e as Error).message.slice(0, 20)}`)),
  );
  record({
    id: "4.2c",
    question: "并发下预算会不会被击穿（超支多少）",
    observed: `budgetTokens=36，10 个分身同时 prompt → 成功 ${outcomes.filter((o) => o === "ok").length}/10；host.usage = ${host.usage.totalTokens} token（上限 36）`,
    verdict: host.usage.totalTokens > 2 * TOK ? "GAP" : "OK",
    conclusion:
      host.usage.totalTokens > 2 * TOK
        ? `被击穿 ${(host.usage.totalTokens / (2 * TOK)).toFixed(1)} 倍。预检读的是**已完成轮次**的累计用量，同时在飞的轮次都看到同一个偏低的数字。budgetTokens 是「事后护栏」而不是「硬闸门」——并发一高就形同虚设。`
        : "未被击穿。",
    data: { budget: 2 * TOK, usage: host.usage.totalTokens, okCount: outcomes.filter((o) => o === "ok").length, overshoot: Number((host.usage.totalTokens / (2 * TOK)).toFixed(2)) },
  });
  host.dispose();
}

{
  // 预算是全局一个数字：设计者能不能自己按分支记账？
  const host = hostWith({ budgetTokens: 100000, members: { a: {}, b: {} } });
  const perBranch = new Map<string, number>();
  let lines = 0;
  host.on("round_completed", ({ agent, result }) => {
    // 自建「分支 = 沿 parentId 走到顶层的那个孩子」归因
    let cur: ControlledAgent | undefined = agent;
    while (cur?.parentId && host.get(cur.parentId)?.parentId) cur = host.get(cur.parentId);
    const branch = cur?.member ?? cur?.id ?? "?";
    perBranch.set(branch, (perBranch.get(branch) ?? 0) + result.usage.totalTokens);
    lines = 7;
  });
  const top = await mk(host, { tools: ["spawn_agent"] });
  const spawn = createSpawnAgentTool({ agent: top, host });
  const tA = await mk(host, { parent: top, member: "a" });
  const tB = await mk(host, { parent: top, member: "b" });
  await Promise.all([tA.prompt("A 的活"), tB.prompt("B 的活")]);
  record({
    id: "4.2d",
    question: "预算是全局单值时，设计者能否自己按分支记账",
    observed: `用 ${lines} 行钩子（host.on("round_completed") + 沿 parentId 上溯）得到：${JSON.stringify(Object.fromEntries(perBranch))}`,
    verdict: "PARTIAL",
    conclusion:
      "能记账，但要设计者自己写。而且只能是**事后**统计 —— 库没有「这个分支还剩多少预算」的概念，所以做不出「分支 A 超支就掐掉 A」的实时分配，只能全局一刀切。",
    data: { perBranch: Object.fromEntries(perBranch), hookLines: lines },
  });
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("4.3 maxAgents 不回收的实际影响");

{
  const host = hostWith({ maxAgents: 5, members: { worker: {} } });
  const top = await mk(host, { tools: ["spawn_agent"] });
  const spawn = createSpawnAgentTool({ agent: top, host });
  // 模拟「监督者反复派活、用完就回收」的长驻模式
  const rounds: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const r = textOf(await spawn.execute("c", { member: "worker", task: `活${i}` } as never, undefined, undefined, undefined as never));
    if (!r.startsWith("已让成员")) {
      rounds.push(`第${i}轮被拒：${r.slice(0, 36)}`);
      break;
    }
    // 用完立刻回收（长驻集群的正确做法）
    const w = host.list().find((x) => x.member === "worker");
    if (w) w.dispose();
    rounds.push(`第${i}轮 ok（存活 ${host.list().length}）`);
  }
  record({
    id: "4.3a",
    question: "长驻模式（每轮起一个分身、用完立刻回收）能跑多少轮",
    observed: `maxAgents=5：${rounds.join("；")}`,
    verdict: rounds.some((r) => r.includes("被拒")) ? "GAP" : "OK",
    conclusion: rounds.some((r) => r.includes("被拒"))
      ? `只跑了 ${rounds.indexOf(rounds.find((r) => r.includes("被拒"))!)} 轮就被永久拒死 —— 即使每一轮结束时存活分身数都是 0。名额终身不释放，长驻集群（监督者反复派活）在 maxAgents 轮后必然锁死。`
      : "未锁死。",
    data: { rounds, alive: host.list().length, usage: host.usage.totalTokens },
  });
  host.dispose();
}

{
  // 有没有绕法？
  const host = hostWith({ maxAgents: 2 });
  const a = await mk(host);
  a.dispose();
  const b = await mk(host);
  b.dispose();
  let third = "";
  try {
    const c = await mk(host);
    c.dispose();
  } catch (e) {
    third = (e as Error).message;
  }
  record({
    id: "4.3b",
    question: "有没有绕开名额上限的手段",
    observed: `maxAgents=2，建 2 个并回收 → 再建：${third || "成功"}`,
    verdict: third ? "GAP" : "OK",
    conclusion: third
      ? "没有。maxAgents 是构造函数里的闭包常量、只增不减，库没有提供重置或提高的手段。唯一绕法是新建一个 host（那会丢掉全部已有分身与用量）。"
      : "可以绕。",
    data: { third },
  });
  host.dispose();
}

{
  // budgetTokens 设成 undefined / 0 / 负数
  const rows: string[] = [];
  for (const [label, v] of [["undefined", undefined], ["0", 0], ["-1", -1]] as const) {
    const host = hostWith(v === undefined ? {} : { budgetTokens: v });
    let out = "";
    try {
      const a = await mk(host);
      try {
        await a.prompt("hi");
        out = "顶层建得起来且能跑一轮";
      } catch (e) {
        out = `顶层建得起来，prompt 抛错「${(e as Error).message.slice(0, 30)}」`;
      }
    } catch (e) {
      out = `连顶层都建不起来，抛错「${(e as Error).message.slice(0, 30)}」`;
    }
    rows.push(`budgetTokens=${label} → ${out}`);
    host.dispose();
  }
  record({
    id: "4.3c",
    question: "budgetTokens 的边界值语义",
    observed: rows.join("；"),
    verdict: "INFO",
    conclusion: "undefined = 不限制；0 与负数 = 任何一轮都不许跑。三者行为一致且明确。",
    data: rows,
  });
}

// ─────────────────────────────────────────────────────────────
section("4.4 护栏小结");

{
  record({
    id: "4.4a",
    question: "三道护栏各自防住什么、防不住什么",
    observed: "见 4.1–4.3",
    verdict: "PARTIAL",
    conclusion:
      "maxDepth、maxAgents 是**构造期硬约束**（预检+登记双重校验，并发也挡得住）；budgetTokens 是**事后软约束**（只在轮次结束时结算，并发下可被击穿数倍）。三者都只管『创建与放行』，不管『运行中的资源』（并发数、内存、墙钟）。",
  });
  record({
    id: "4.4b",
    question: "有没有并发闸门 / 速率限制",
    observed: "无任何 concurrency / rate limit 选项；第 3.3 部分实测 64 个分身同时打满",
    verdict: "GAP",
    conclusion: "没有。规格 §9 把这条标给阶段 2，实测确认阶段 1 确实完全没有。",
  });
  record({
    id: "4.4c",
    question: "护栏触发时的错误通道是否统一",
    observed: "spawn_agent → 返回错误文本（agent 可读）；createAgent → 抛异常；prompt（预算耗尽）→ 抛异常；send（预算耗尽）→ 走 error 事件 + 返回值谎报 ran",
    verdict: "GAP",
    conclusion: "三条通道并存（文本 / 抛错 / 事件），且 send 那条还会撒谎。设计者要写三套处理逻辑才能可靠地发现『被护栏拦住了』。",
  });
}

dump("04-guards");
await env.close();
