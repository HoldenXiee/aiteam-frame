// E2 — 4.1 budgetTokens 的边界、超支幅度、send() 的预算旁路与错误通道（🟢 假 provider）
// 假服务每次 HTTP 请求固定回 18 token（prompt_tokens 11 + completion_tokens 7）。
// 跑法：node audit/04-guards/e2-budget-boundary.ts
import { createAgent, createAgentHost, type AgentHost, type ControlledAgent } from "../../src/index.ts";
import { createSpawnAgentTool } from "../../src/tools/spawn-agent.ts";
import { hostInternalsOf } from "../../src/agent/host.ts";
import { makeEnv } from "../_faux.ts";
import { rec, section, sleep } from "./_h.ts";

const env = await makeEnv();
const { agentDir, cwd, runtime, model } = env;
const EXP = "E2";
const TOK = 18;

const hostWith = (opts: Record<string, unknown> = {}) =>
  createAgentHost({ modelRuntime: runtime, defaults: { model, cwd, agentDir }, ...opts } as never);
const mkTop = (host: AgentHost, extra: Record<string, unknown> = {}) =>
  createAgent({ model, cwd, agentDir, ...extra }, { host, modelRuntime: runtime });
const textOf = (r: unknown) =>
  ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
const tryPrompt = async (a: ControlledAgent, t: string) => {
  try {
    const r = await a.prompt(t);
    return `ok(usage=${r.usage.totalTokens})`;
  } catch (e) {
    return `抛错「${(e as Error).message.slice(0, 46)}」`;
  }
};

// ─────────────────────────────────────────────
section("E2-A budgetTokens 边界值（每轮固定 18 token）");

{
  const rows: { budget: number | undefined; rounds: string; usage: number }[] = [];
  for (const b of [undefined, -1, 0, 17, TOK, TOK + 1] as const) {
    const host = hostWith(b === undefined ? {} : { budgetTokens: b });
    let a: ControlledAgent | undefined;
    try {
      a = await mkTop(host);
    } catch (e) {
      rows.push({ budget: b, rounds: `连顶层都建不起来，抛错「${(e as Error).message.slice(0, 40)}」`, usage: host.usage.totalTokens });
      host.dispose();
      continue;
    }
    const rounds: string[] = [];
    for (let i = 1; i <= 3; i++) rounds.push(`${i}:${await tryPrompt(a, `第${i}轮`)}`);
    rows.push({ budget: b, rounds: rounds.join(" "), usage: host.usage.totalTokens });
    host.dispose();
  }
  rec(EXP, {
    id: "4.1.F1",
    question: "budgetTokens 在 0 / 负数 / 恰好等于一轮 / 略低于一轮 时的语义",
    observed: rows
      .map((r) => `budget=${r.budget === undefined ? "undefined" : r.budget} → ${r.rounds}（host.usage=${r.usage}）`)
      .join("；"),
    verdict: "INFO",
    conclusion:
      "判据是「开跑前 usage.totalTokens >= budgetTokens」：undefined=不限；0 与负数时**连顶层 agent 都建不起来**（register 的 limitProblem 直接抛错，不是「一轮都不许跑」那么温和）；budget=18=恰好一轮，跑完 usage 到 18 后第二轮被拒；budget=17=**放行整轮**，跑完 usage=18 > 17。预算不是「花到就停」，而是「开跑前检查」，所以单轮超支幅度 = 一整轮的 token 数（上不封顶，见 F2）。",
    data: rows,
  });
}

{
  // 超支幅度：一轮里带工具往返时会花多个 18。budget=1 能建出顶层（0 < 1）
  const host = hostWith({ budgetTokens: 1 });
  const a = await mkTop(host, { tools: ["probe_echo"] });
  const callsBefore = env.calls().length;
  const r = await tryPrompt(a, "[[tool:probe_echo]][[args:{}]]");
  const callsAfter = env.calls().length;
  rec(EXP, {
    id: "4.1.F2",
    question: "单轮超支的上界：一轮里多次模型往返能超出预算多少",
    observed: `budgetTokens=1；一轮「带一次工具调用」的 prompt → ${r}；这一轮假服务收到 ${callsAfter - callsBefore} 次请求；host.usage=${host.usage.totalTokens}（预算 1）`,
    verdict: "GAP",
    conclusion:
      `一轮 prompt 可以包含任意多次模型往返（工具循环），每一次都计费但**中途不检查预算**。所以预算只能保证「不会开始新一轮」，不能限制任何单轮的花费：超支倍数 = 该轮实际往返次数，与 budgetTokens 无关。${
        callsAfter - callsBefore > 1 ? "实测一轮 2 次往返 → 花了 36 token（预算 1，超支 36 倍）。" : ""
      }`,
    data: { rounds: r, calls: callsAfter - callsBefore, usage: host.usage.totalTokens, budget: 1 },
  });
  host.dispose();
}

// ─────────────────────────────────────────────
section("E2-B 预算耗尽时 send() 的行为（本部分重点）");

{
  const host = hostWith({ budgetTokens: TOK });
  const a = await mkTop(host);
  await a.prompt("先把预算花光");
  const errs: string[] = [];
  a.on("error", (p) => errs.push(p.message));
  const callsBefore = env.calls().length;
  const r = await a.send("这条应该跑不了");
  const lastBefore = a.lastResult?.text;
  await sleep(400);
  const callsAfter = env.calls().length;
  rec(EXP, {
    id: "4.1.F3",
    question: "预算耗尽后 send() 的返回值、模型是否收到、消息去哪了",
    observed: `budget=18，已跑满一轮 → send() 返回 ${JSON.stringify(r)}；error 事件=${JSON.stringify(errs)}；假服务新增请求=${callsAfter - callsBefore}；send 后 isStreaming=${a.isStreaming}，status=${a.status}；lastResult 文本仍是上一轮「${String(lastBefore).slice(0, 20)}」`,
    verdict: r.delivered === "ran" && callsAfter - callsBefore === 0 ? "GAP" : "INFO",
    conclusion:
      "消息被**静默吞掉**，只走 error 事件：send() 返回 delivered=\"ran\"（谎报已开始处理），实际 0 次模型请求；prompt() 在预算检查处就抛错，被 send 的 .catch 转成 error 事件。若设计者没订阅 error 事件，则**完全无感**（返回值说 ran）。lastResult 也不变，仍指向上一轮结果 —— 设计者读 lastResult 会拿到旧答案。",
    data: { r, errs, newCalls: callsAfter - callsBefore, status: a.status, isStreaming: a.isStreaming },
  });
  host.dispose();
}

{
  // 无 error 监听者时是否彻底无感
  const host = hostWith({ budgetTokens: TOK });
  const a = await mkTop(host);
  await a.prompt("花光预算");
  const callsBefore = env.calls().length;
  const r = await a.send("没人听 error 事件");
  await sleep(400);
  rec(EXP, {
    id: "4.1.F4",
    question: "预算耗尽 + 无 error 监听者：设计者能察觉到失败吗",
    observed: `send() → ${JSON.stringify(r)}；无 error 监听者；假服务新增请求=${env.calls().length - callsBefore}；status=${a.status}`,
    verdict: r.delivered === "ran" ? "GAP" : "OK",
    conclusion: "察觉不到。send 只承诺「投递」，返回值 ran 是唯一可见信号，而它是错的。status 也回落到 idle（prompt 的 catch 把 status 复原）。这是「不报错但不按预期工作」的典型静默失败。",
    data: { r, status: a.status },
  });
  host.dispose();
}

{
  // 忙时 send 走 followUp —— 完全不经过 prompt() 的预算检查
  const host = hostWith({ budgetTokens: TOK, maxAgents: 20 });
  const a = await mkTop(host);
  const p = a.prompt("[[sleep:1200]]先跑着"); // 不 await，制造正忙窗口
  await sleep(150);
  const busy = a.isStreaming;
  const callsBefore = env.calls().length;
  const r = await a.send("忙时追加的一条（本该因预算耗尽被拦）");
  const usageAtSend = host.usage.totalTokens;
  await p;
  await sleep(500);
  const usageAfter = host.usage.totalTokens;
  rec(EXP, {
    id: "4.1.F5",
    question: "目标忙时 send() 走 followUp 队列，这条排队消息受预算检查吗",
    observed: `budgetTokens=18；第一轮还在跑（isStreaming=${busy}）时 send() → ${JSON.stringify(r)}；投递时 host.usage=${usageAtSend}；两轮都跑完后 host.usage=${usageAfter}（预算 18）；假服务这一窗口新增请求=${env.calls().length - callsBefore}`,
    verdict: usageAfter > TOK ? "GAP" : "OK",
    conclusion:
      usageAfter > TOK
        ? `旁路确认：忙时 send() 走 session.followUp()，**不经过 prompt() 的预算检查**，排队的消息照跑，跑完 host.usage=${usageAfter} 已超出预算 ${TOK}。预算护栏只覆盖「新一轮 prompt」和「spawn 预检」，漏了 followUp/steer 这条队列通道。`
        : "排队消息也被预算拦住。",
    data: { r, usageAtSend, usageAfter, budget: TOK, busy },
  });
  host.dispose();
}

{
  // 对照：idle 时同一个 send 会被拦（走 prompt 的检查）
  const host = hostWith({ budgetTokens: TOK });
  const a = await mkTop(host);
  await a.prompt("花光");
  const errs: string[] = [];
  a.on("error", (p) => errs.push(p.message));
  const r = await a.send("空闲时投递");
  await sleep(250);
  rec(EXP, {
    id: "4.1.F6",
    question: "同一份预算下，idle 与 busy 两种 send 的结果对比",
    observed: `idle 时 send → ${JSON.stringify(r)}，error=${JSON.stringify(errs.map((e) => e.slice(0, 40)))}；对比 F5 的 busy 时 send → 实际跑掉`,
    verdict: "GAP",
    conclusion: "同一个 API 在 idle/busy 两种路径下对预算护栏的反应完全相反：idle 被拦（但谎报 ran），busy 直接绕过预算跑掉。设计者无法从 API 语义预测。",
    data: { r, errs },
  });
  host.dispose();
}

{
  // steer() 直调也不检查预算
  const host = hostWith({ budgetTokens: TOK });
  const a = await mkTop(host);
  const p = a.prompt("[[sleep:1000]]跑着");
  await sleep(120);
  await a.steer("直接 steer 一条");
  await p;
  await sleep(400);
  rec(EXP, {
    id: "4.1.F7",
    question: "直接调 steer() 时预算护栏在场吗",
    observed: `budget=18；第一轮进行中直接 await a.steer(...) → 未抛错；结束后 host.usage=${host.usage.totalTokens}`,
    verdict: host.usage.totalTokens > TOK ? "GAP" : "OK",
    conclusion: "不在场。steer() 是逃生口语义（直接包 session.steer），预算检查只写在 prompt() 与 spawn 预检里。所有「向已存在会话追加内容」的路径都不受预算约束。",
    data: { usage: host.usage.totalTokens },
  });
  host.dispose();
}

// ─────────────────────────────────────────────
section("E2-C 三道护栏的检查顺序与报错理由");

{
  // 同时违反多条时，报哪一条
  const mkSpawn = async (host: AgentHost, parent: ControlledAgent, member: string) => {
    const tool = createSpawnAgentTool({ agent: parent, host });
    try {
      return textOf(await tool.execute("c", { member, task: "x" } as never, undefined, undefined, undefined as never));
    } catch (e) {
      return `抛异常「${(e as Error).message}」`;
    }
  };

  // (a) 深度超 + 预算耗尽
  const h1 = hostWith({ maxDepth: 1, budgetTokens: TOK, maxAgents: 50, members: { w: { tools: ["spawn_agent"] } } });
  const t1 = await mkTop(h1, { member: "top", tools: ["spawn_agent"] });
  await mkSpawn(h1, t1, "w"); // 深度1
  const child1 = h1.list().find((x) => x.member === "w")!;
  try {
    await t1.prompt("花光预算"); // spawn 已经花了一轮，这里可能已耗尽
  } catch {
    /* 已耗尽 */
  }
  const depthVsBudget = await mkSpawn(h1, child1, "w"); // 深度2超 + 预算耗尽
  h1.dispose();

  // (b) 名额超 + 预算耗尽
  const h2 = hostWith({ maxDepth: 5, budgetTokens: TOK, maxAgents: 2, members: { w: {} } });
  const t2 = await mkTop(h2, { member: "top", tools: ["spawn_agent"] });
  const c2 = await mkTop(h2, { member: "w" }); // created=2 → 名额已满
  void c2;
  await t2.prompt("花光预算");
  const quotaVsBudget = await mkSpawn(h2, t2, "w");
  h2.dispose();

  // (c) 三者都超：budget=1 能建出顶层与跑一轮，跑完后 usage=18 三条全破
  const h3 = hostWith({ maxDepth: 0, budgetTokens: 1, maxAgents: 1, members: { w: {} } });
  const t3 = await mkTop(h3, { member: "top", tools: ["spawn_agent"] });
  await t3.prompt("花光预算");
  const allThree = await mkSpawn(h3, t3, "w");
  h3.dispose();

  rec(EXP, {
    id: "4.1.F8",
    question: "同时违反多条护栏时，spawn_agent 报哪一条（理由是否准确）",
    observed: `(a) 深度超+预算耗尽 → ${depthVsBudget}；(b) 名额超+预算耗尽 → ${quotaVsBudget}；(c) 深度+名额+预算全超 → ${allThree}`,
    verdict: "PARTIAL",
    conclusion:
      "固定顺序：深度 → 名额 → 预算，只报**第一条**被违反的。所以理由永远是「检查顺序里靠前的那条」，不一定是设计者真正需要处理的那条：当预算已耗尽、名额也满了、深度也超了，模型只会看到深度那条。单条信息不含「你还违反了另外 N 条」，设计者要逐条修才能看到全貌。不过每条文案都带具体数值，单条本身是准确的。",
    data: { a: depthVsBudget, b: quotaVsBudget, c: allThree },
  });
}

{
  // 预检与登记对同一事实的判断是否一致（深度算法在 checkCanCreate 与 register 里重复了一份）
  const host = hostWith({ maxDepth: 2, maxAgents: 50, members: { w: { tools: ["spawn_agent"] } } });
  const top = await mkTop(host, { member: "top", tools: ["spawn_agent"] });
  const internals = hostInternalsOf(host)!;
  const child = await mkTop(host, { member: "w" });
  // 手动把 child 的 parentId 指到 top（模拟真实 spawn 的结构），再比较两个入口
  (child as unknown as { parentId: string }).parentId = top.id;
  const pre = internals.checkCanCreate(child);
  let reg = "通过";
  try {
    internals.register(child);
  } catch (e) {
    reg = `抛错「${(e as Error).message}」`;
  }
  rec(EXP, {
    id: "4.1.F9",
    question: "checkCanCreate 与 register 对同一 agent 的判断是否会不一致",
    observed: `把 child.parentId 设为顶层 id 后：checkCanCreate(child) → ${pre ?? "undefined（放行）"}；register(child) → ${typeof reg === "string" ? reg : reg}`,
    verdict: typeof reg === "string" && reg.startsWith("抛") ? "GAP" : "INFO",
    conclusion:
      typeof reg === "string" && reg.startsWith("抛")
        ? "会。register 先判「id 已存在」再判护栏，而 checkCanCreate 不判 id。两者还对同一 depth 各算一次（checkCanCreate 传 depthOf(parent)+1，register 内部再算 depthOf(agent)）。预检与登记的双份实现在并发下必然产生 A4 那种「预检放行、登记抛错」的窗口。"
        : "两者一致（本次被测项触发的是其它分支）。",
    data: { pre, reg },
  });
  host.dispose();
}

await env.close();
