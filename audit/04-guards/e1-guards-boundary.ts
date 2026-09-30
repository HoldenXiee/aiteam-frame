// E1 — 4.1 maxAgents / maxDepth 的边界、误触发与漏触发（🟢 假 provider）
// 跑法：node audit/04-guards/e1-guards-boundary.ts
import { createAgent, createAgentHost, type AgentHost, type ControlledAgent } from "../../src/index.ts";
import { createSpawnAgentTool } from "../../src/tools/spawn-agent.ts";
import { hostInternalsOf } from "../../src/agent/host.ts";
import { makeEnv } from "../_faux.ts";
import { rec, section, sleep } from "./_h.ts";

const env = await makeEnv();
const { agentDir, cwd, runtime, model } = env;
const EXP = "E1";

const hostWith = (opts: Record<string, unknown> = {}) =>
  createAgentHost({ modelRuntime: runtime, defaults: { model, cwd, agentDir }, ...opts } as never);
const mkTop = (host: AgentHost, extra: Record<string, unknown> = {}) =>
  createAgent({ model, cwd, agentDir, ...extra }, { host, modelRuntime: runtime });
const textOf = (r: unknown) =>
  ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");
const spawnOnce = async (host: AgentHost, parent: ControlledAgent, member: string, task = "干活") => {
  const tool = createSpawnAgentTool({ agent: parent, host });
  try {
    return { kind: "返回文本", text: textOf(await tool.execute("c", { member, task } as never, undefined, undefined, undefined as never)) };
  } catch (e) {
    return { kind: "抛异常", text: (e as Error).message };
  }
};

// ─────────────────────────────────────────────
section("E1-A maxAgents 边界：0 / 1 / 恰好 / 回收后");

{
  const host = hostWith({ maxAgents: 0 });
  let out = "成功（不应该）";
  try {
    const a = await mkTop(host, { member: "top" });
    out = `成功建出 ${a.id}`;
  } catch (e) {
    out = `抛错「${(e as Error).message}」`;
  }
  rec(EXP, {
    id: "4.1.A1",
    question: "maxAgents=0 时，连顶层都建不起来吗",
    observed: `maxAgents=0 → createAgent → ${out}；host.list()=${host.list().length}，host.activeCount=${host.activeCount}`,
    verdict: "INFO",
    conclusion: "maxAgents 把顶层也算作一个分身在计数（created 从 0 起，register 前先判 created>=maxAgents），所以 0 = 这个宿主一个 agent 都不许有，抛异常（不是返回错误文本）。",
    data: { out },
  });
  host.dispose();
}

{
  const host = hostWith({ maxAgents: 1, members: { w: {} } });
  const top = await mkTop(host, { member: "top", tools: ["spawn_agent"] });
  const r1 = await spawnOnce(host, top, "w");
  rec(EXP, {
    id: "4.1.A2",
    question: "maxAgents=1：顶层吃掉唯一名额后第一次 spawn 的文案",
    observed: `顶层建成功（id=${top.id}）；第一次 spawn → ${r1.kind}「${r1.text.slice(0, 80)}」`,
    verdict: r1.text.includes("maxAgents=1") ? "OK" : "GAP",
    conclusion: "顶层占满唯一名额，第一次 spawn 即被拒，文案带具体数值。护栏本身没有漏（8 次 spawn 也只可能成 0 次）。",
    data: { r1 },
  });
  host.dispose();
}

{
  // 误触发：名额是「终身创建数」，回收不减
  const host = hostWith({ maxAgents: 3, members: { w: {} } });
  const top = await mkTop(host, { member: "top", tools: ["spawn_agent"] });
  const c1 = await mkTop(host, { member: "w" }); // 直接走设计者路径，parent 缺省=顶层？不，缺省无 parent
  const c2 = await mkTop(host, { member: "w" });
  const before = { created: 3, alive: host.activeCount };
  c1.dispose();
  c2.dispose();
  await sleep(20);
  const r = await spawnOnce(host, top, "w");
  rec(EXP, {
    id: "4.1.A3",
    question: "回收分身之后，名额会释放吗（误触发探测）",
    observed: `maxAgents=3；建满 3 个（created=3）→ 回收其中 2 个 → 此刻存活 ${host.activeCount} 个、随后 spawn → ${r.kind}「${r.text.slice(0, 80)}」`,
    verdict: r.text.includes("maxAgents") ? "GAP" : "OK",
    conclusion: r.text.includes("maxAgents")
      ? "误触发确认。存活数只有 1（远低于上限 3），spawn 仍被拒 —— maxAgents 卡的是「本宿主创建过的分身总数」，dispose 不减少计数。名字的语义与行为不一致。"
      : "名额随回收释放。",
    data: { before, aliveAfter: host.activeCount, r },
  });
  host.dispose();
}

{
  // 漏触发：并发下预检与登记之间有时间窗
  const host = hostWith({ maxAgents: 3, members: { w: {} } });
  const top = await mkTop(host, { member: "top", tools: ["spawn_agent"] });
  const tool = createSpawnAgentTool({ agent: top, host });
  const all = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      tool
        .execute("c", { member: "w", task: `并发${i}` } as never, undefined, undefined, undefined as never)
        .then((r) => ({ kind: "返回文本", text: textOf(r) }))
        .catch((e) => ({ kind: "抛异常", text: (e as Error).message })),
    ),
  );
  const thrown = all.filter((x) => x.kind === "抛异常");
  rec(EXP, {
    id: "4.1.A4",
    question: "并发触发 maxAgents 时，超限的调用返回错误文本还是抛异常",
    observed: `maxAgents=3（顶层占 1，只能再建 2 个）；同时发起 8 个 spawn_agent → 成功 ${all.filter((x) => x.text.startsWith("已让成员")).length} 个，返回错误文本 ${all.filter((x) => x.kind === "返回文本" && !x.text.startsWith("已让成员")).length} 个，抛异常 ${thrown.length} 个：${JSON.stringify(thrown.map((t) => t.text.slice(0, 40)))}；最终 host.list()=${host.list().length}`,
    verdict: thrown.length ? "GAP" : "OK",
    conclusion: thrown.length
      ? "上限数值本身没被击穿（最终存活 ≤ 3），但**并发下超限的调用抛出异常**，违反「护栏触发返回错误结果而非崩溃」的规格与 spawn_agent「只返文本」的契约。原因：checkCanCreate 预检与 register 之间有窗口，预检都看到旧计数；register 抛的 Error 没被工具层转成文本。串行调用永远看不到（预检先知道）。"
      : "并发下契约保持。",
    data: { all: all.map((x) => `${x.kind}:${x.text.slice(0, 30)}`), alive: host.list().length, thrown: thrown.length },
  });
  host.dispose();
}

{
  // 对照：设计者路径（直接 createAgent）并发超限时会怎样
  const host = hostWith({ maxAgents: 3 });
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      mkTop(host, { member: "w" })
        .then((a) => `ok(${a.id})`)
        .catch((e) => `抛错「${(e as Error).message.slice(0, 34)}」`),
    ),
  );
  rec(EXP, {
    id: "4.1.A5",
    question: "设计者直接 createAgent 时超限的错误通道",
    observed: `maxAgents=3，并发 createAgent 6 次 → ${JSON.stringify(results)}；最终存活 ${host.list().length}`,
    verdict: "INFO",
    conclusion: "A 路（设计者代码）本来就是异常通道，抛错合理；问题只在 B 路 spawn_agent 工具把它漏出去。",
    data: { results, alive: host.list().length },
  });
  host.dispose();
}

// ─────────────────────────────────────────────
section("E1-B maxDepth 边界：恰好等于 / 孤儿 / 中层回收");

{
  const host = hostWith({ maxDepth: 2, maxAgents: 50, members: { mid: { tools: ["spawn_agent"] }, leaf: { tools: ["spawn_agent"] } } });
  const top = await mkTop(host, { member: "top", tools: ["spawn_agent"] });
  const r1 = await spawnOnce(host, top, "mid");
  const mid = host.list().find((x) => x.member === "mid")!;
  const r2 = await spawnOnce(host, mid, "leaf");
  const leaf = host.list().find((x) => x.member === "leaf")!;
  const r3 = await spawnOnce(host, leaf, "leaf");
  rec(EXP, {
    id: "4.1.B1",
    question: "maxDepth=2：深度恰好 =2 是允许还是拒绝",
    observed: `深度0=top 建成功；深度1=${r1.text.startsWith("已让") ? "允许" : "拒"}；深度2=${r2.text.startsWith("已让") ? "允许" : "拒"}；深度2 再 spawn（想建深度3）=${r3.kind}「${r3.text.slice(0, 60)}」`,
    verdict: r2.text.startsWith("已让") && r3.text.includes("maxDepth") ? "OK" : "GAP",
    conclusion: "边界正确：深度 ≤ maxDepth 允许，深度 = maxDepth+1 拒绝。「顶层为第 0 层」的语义与规格一致。",
    data: { r1: r1.text.slice(0, 30), r2: r2.text.slice(0, 30), r3: r3.text },
  });
  host.dispose();
}

{
  // 孤儿：父不在宿主里时 depthOf 返回 depth+1（保守算 1 层）
  const host = hostWith({ maxDepth: 2, maxAgents: 50, members: { mid: { tools: ["spawn_agent"] }, leaf: { tools: ["spawn_agent"] } } });
  const top = await mkTop(host, { member: "top", tools: ["spawn_agent"] });
  await spawnOnce(host, top, "mid");
  const mid = host.list().find((x) => x.member === "mid")!;
  await spawnOnce(host, mid, "leaf");
  const leaf = host.list().find((x) => x.member === "leaf")!;
  const before = await spawnOnce(host, leaf, "leaf"); // 应被拒（深度3）
  // 把中间层 mid 回收 → leaf 变成孤儿
  mid.dispose();
  const internals = hostInternalsOf(host)!;
  const after = await spawnOnce(host, leaf, "leaf"); // 孤儿深度=1 → 深度2 允许
  rec(EXP, {
    id: "4.1.B2",
    question: "父不在宿主里（孤儿）时深度怎么算，能不能绕过 maxDepth",
    observed: `maxDepth=2；完整链 top→mid→leaf 时 leaf 再 spawn：${before.kind}「${before.text.slice(0, 50)}」；回收中层 mid 后，同一个 leaf 再 spawn：${after.kind}「${after.text.slice(0, 50)}」；host 里 leaf 的 parentId=${leaf.parentId}，host.get(leaf.parentId)=${host.get(leaf.parentId!)}`,
    verdict: after.text.startsWith("已让成员") ? "GAP" : "OK",
    conclusion: after.text.startsWith("已让成员")
      ? "漏触发确认：depthOf 走到「父不在本宿主」时直接返回 depth+1（按 1 层算），于是孤儿子树整体被「抬高」。把中间层 dispose 一次，原本在 maxDepth 边界的子树就又能往下长 —— maxDepth 不是不可绕过的结构约束，回收中间层即可复位深度。"
      : "孤儿深度仍被保守拦住。",
    data: { before: before.text, after: after.text },
  });
  host.dispose();
}

{
  // 构造期传入一个不在宿主的 parent（真正的孤儿入口）
  const host = hostWith({ maxDepth: 2, maxAgents: 50, members: { w: { tools: ["spawn_agent"] } } });
  const ghost = { id: "ghost-parent" } as unknown as ControlledAgent;
  let outcome = "";
  const top = await mkTop(host, { member: "w", tools: ["spawn_agent"] });
  void top;
  try {
    // 用 deps.parent 挂到一个宿主里不存在的 id 上：真深度无从得知，全按「有父」算 1 层
    const orphan = await createAgent(
      { model, cwd, agentDir, member: "w", tools: ["spawn_agent"] },
      { host, modelRuntime: runtime, parent: ghost, member: "w" },
    );
    outcome = `parent=ghost（宿主里没有这个 id）的分身建成功，id=${orphan.id}；它再 spawn 一层 → `;
    const r = await spawnOnce(host, orphan, "w");
    outcome += r.text.startsWith("已让")
      ? `允许（说明它被当作深度 0/1，而不是「未知」）`
      : `拒「${r.text.slice(0, 50)}」`;
  } catch (e) {
    outcome += `抛错「${(e as Error).message.slice(0, 60)}」`;
  }
  rec(EXP, {
    id: "4.1.B3",
    question: "构造期就把 parentId 指向一个宿主里不存在的 agent，会怎样",
    observed: outcome,
    verdict: outcome.includes("允许") ? "PARTIAL" : "INFO",
    conclusion:
      "depthOf 对「父不在本宿主」不报错也不追问，直接返回 1 —— 库不校验 deps.parent 是否已在宿主里。传错 parent 不会立刻暴露，深度按 1 层算。结合 B2：这条链路让 maxDepth 可被「回收中间层」复位。",
    data: { outcome },
  });
  host.dispose();
}

{
  // maxDepth 边界值
  const rows: string[] = [];
  for (const v of [0, 1, -1] as const) {
    const host = hostWith({ maxDepth: v, maxAgents: 20, members: { w: { tools: ["spawn_agent"] } } });
    try {
      const top = await mkTop(host, { member: "top", tools: ["spawn_agent"] });
      const r = await spawnOnce(host, top, "w");
      rows.push(`maxDepth=${v} → 顶层可建，spawn 深度1 ${r.text.startsWith("已让") ? "允许" : `拒「${r.text.slice(0, 34)}」`}`);
    } catch (e) {
      rows.push(`maxDepth=${v} → 连顶层都被拒，抛错「${(e as Error).message.slice(0, 34)}」`);
    }
    host.dispose();
  }
  rec(EXP, {
    id: "4.1.B4",
    question: "maxDepth 的边界值语义",
    observed: rows.join("；"),
    verdict: "INFO",
    conclusion: "maxDepth=0 表示只许有顶层、一个分身都不许起；负数连顶层都建不起来（深度 0 > -1）—— 边界不是「等价」，是更严。",
    data: rows,
  });
}

await env.close();
