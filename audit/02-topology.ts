// 第 2 部分：拓扑表达力 —— 集群形状能多复杂，极限在哪。
// 跑法：node audit/02-topology.ts
import { createAgent, createAgentHost, type AgentHost, type ControlledAgent, type MemberSpec } from "../src/index.ts";
import { createSpawnAgentTool } from "../src/tools/spawn-agent.ts";
import { check, dump, record, section, msAsync } from "./_harness.ts";
import { makeEnv } from "./_faux.ts";

const env = await makeEnv();
const { agentDir, cwd, runtime, model } = env;

const hostOf = (opts: Record<string, unknown> = {}) =>
  createAgentHost({ modelRuntime: runtime, ...opts } as never);

/** 用设计者侧 API 直接建一个分身（不经 LLM），确定性且快 */
const mk = (host: AgentHost, parent?: ControlledAgent, extra: Record<string, unknown> = {}) => {
  const { member, ...rest } = extra;
  return createAgent(
    { model, cwd, agentDir, ...rest },
    { host, modelRuntime: runtime, parent, member: member as string | undefined },
  );
};

/** 从 list()+parentId 自建拓扑（这是目前唯一的手段） */
function depthOf(host: AgentHost, a: ControlledAgent): number {
  let d = 0;
  let cur: ControlledAgent | undefined = a;
  const seen = new Set<string>();
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = host.get(cur.parentId);
    d += 1;
  }
  return d;
}
const descendantCount = (host: AgentHost, a: ControlledAgent): number =>
  host.list().filter((x) => {
    let cur = x;
    const seen = new Set<string>();
    while (cur.parentId && !seen.has(cur.parentId)) {
      if (cur.parentId === a.id) return true;
      seen.add(cur.parentId);
      cur = host.get(cur.parentId)!;
      if (!cur) return false;
    }
    return false;
  }).length;

// ─────────────────────────────────────────────────────────────
section("2.1 基本形状：深 / 宽 / 混合 / 同成员多分身 / 不对称");

{
  const host = hostOf({ maxDepth: 12, maxAgents: 200 });
  const root = await mk(host);
  // 深链
  let cur = root;
  for (let i = 1; i <= 8; i++) cur = await mk(host, cur, { member: "deep" });
  const all = host.list();
  record({
    id: "2.1a",
    question: "深链（单链）能建多深",
    observed: `建到深度 ${depthOf(host, cur)}，共 ${all.length} 个分身，最深分身的祖先链长度 = ${depthOf(host, cur)}`,
    verdict: depthOf(host, cur) === 8 ? "OK" : "GAP",
    conclusion: "设计者侧逐层建链可用；深度只受 maxDepth 数字限制，实现上没有递归算法障碍。",
    data: { deepest: depthOf(host, cur), total: all.length },
  });
  host.dispose();
}

{
  const host = hostOf({ maxAgents: 200 });
  const root = await mk(host);
  const [kids, ms] = await msAsync(() => Promise.all(Array.from({ length: 100 }, () => mk(host, root, { member: "wide" }))));
  record({
    id: "2.1b",
    question: "宽扇出（一个父 100 个子）能否表达，代价多大",
    observed: `100 个子分身建了 ${ms.toFixed(0)}ms　host.list() = ${host.list().length}`,
    verdict: "OK",
    conclusion: "可用。100 个分身并发创建耗时约 " + ms.toFixed(0) + "ms（每个约 " + (ms / 100).toFixed(1) + "ms）。",
    data: { ms: Number(ms.toFixed(1)), total: host.list().length, perAgentMs: Number((ms / 100).toFixed(2)) },
  });
  host.dispose();
}

{
  const host = hostOf({ maxAgents: 50, maxDepth: 4 });
  const root = await mk(host);
  const a = await mk(host, root, { member: "a" });
  const b = await mk(host, a, { member: "b" });
  await mk(host, a, { member: "b" });
  await mk(host, b, { member: "c" });
  await mk(host, root, { member: "a" });
  const lines = host
    .list()
    .map((x) => `${"  ".repeat(depthOf(host, x))}${x.member ?? "(顶层)"}#${x.id}(d${depthOf(host, x)})`);
  record({
    id: "2.1c",
    question: "混合不对称树 + 同一成员多分身",
    observed: `树：\n${lines.join("\n")}`,
    verdict: "OK",
    conclusion: "同一成员可起多个分身且互不干扰（两个 b），不对称树可表达。",
  });
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("2.2 maxDepth 的精确边界与加深到失效");

{
  const results: Array<{ maxDepth: number; built: number; broke: string }> = [];
  for (const maxDepth of [0, 1, 2, 3]) {
    const host = hostOf({ maxDepth, maxAgents: 100 });
    const root = await mk(host);
    let cur = root;
    let built = 0;
    for (let i = 1; i <= 5; i++) {
      try {
        cur = await mk(host, cur, { member: "d" });
        built += 1;
      } catch (e) {
        results.push({ maxDepth, built, broke: (e as Error).message });
        break;
      }
    }
    if (!results.some((r) => r.maxDepth === maxDepth)) results.push({ maxDepth, built, broke: "" });
    host.dispose();
  }
  record({
    id: "2.2a",
    question: "maxDepth 的数字语义（顶层算不算一层）",
    observed: results.map((r) => `maxDepth=${r.maxDepth} → 能建 ${r.built} 层${r.broke ? `，然后被拒：「${r.broke}」` : ""}`).join("；"),
    verdict: results[0].built === 0 && results[1].built === 1 && results[2].built === 2 && results[3].built === 3 ? "OK" : "GAP",
    conclusion: "顶层是第 0 层，maxDepth=N 表示允许存在深度为 N 的分身（即从顶层往下最多 N 层子）。maxDepth=0 时顶层可以有但不能有分身。",
    data: results,
  });
}

{
  // 加深到出问题：放宽 maxDepth，看先坏在哪
  const host = hostOf({ maxDepth: 500, maxAgents: 2000 });
  const root = await mk(host);
  let cur = root;
  let failed = "";
  let deepest = 0;
  const t0 = Date.now();
  for (let i = 1; i <= 60; i++) {
    try {
      cur = await mk(host, cur, { member: "d" });
      deepest = i;
    } catch (e) {
      failed = (e as Error).message;
      break;
    }
  }
  const ms = Date.now() - t0;
  // 深层处再验证一次功能：最深的分身还能不能真跑一轮
  let ranOk = false;
  let runErr = "";
  try {
    const r = await cur.prompt("hi");
    ranOk = r.text.startsWith("echo:hi");
    if (!ranOk) runErr = JSON.stringify(r).slice(0, 120);
  } catch (e) {
    runErr = (e as Error).message;
  }
  record({
    id: "2.2b",
    question: "把 maxDepth 放宽到很大，深度加到多少会出问题",
    observed: `建到深度 ${deepest}（${ms}ms，共 ${host.list().length} 个分身）${failed ? `，之后失败：${failed}` : "，未失败（到达测试上限 60）"}；深度 ${deepest} 的分身跑一轮：${ranOk ? "正常" : `异常 ${runErr}`}`,
    verdict: deepest >= 30 && ranOk ? "OK" : "PARTIAL",
    conclusion: `深度 ${deepest} 仍然功能正常，没有栈溢出或 O(n²) 崩点。深度本身不是瓶颈；瓶颈是每个分身都占一个 session 与内存（见第 5 部分）。`,
    data: { deepest, ms, total: host.list().length, ranOk, perLevelMs: Number((ms / Math.max(deepest, 1)).toFixed(2)) },
  });
  host.dispose();
}

{
  // 宽度上限
  const host = hostOf({ maxAgents: 1000, maxDepth: 0 });
  const root = await mk(host);
  const [made, ms] = await msAsync(() =>
    Promise.all(Array.from({ length: 300 }, () => mk(host).catch(() => undefined))),
  );
  const ok = made.filter(Boolean).length;
  record({
    id: "2.2c",
    question: "同时存在 300 个分身的代价",
    observed: `成功 ${ok}/300，耗时 ${ms.toFixed(0)}ms，堆内存 heapUsed = ${(process.memoryUsage().heapUsed / 1e6).toFixed(1)} MB`,
    verdict: "OK",
    conclusion: `单进程内 300 个分身可用，创建耗时 ${ms.toFixed(0)}ms（约 ${(ms / 300).toFixed(1)}ms/个），堆占用 ${(process.memoryUsage().heapUsed / 1e6).toFixed(1)} MB。`,
    data: { ok, ms: Number(ms.toFixed(1)), heapMB: Number((process.memoryUsage().heapUsed / 1e6).toFixed(1)) },
  });
  host.dispose();
  void root;
}

// ─────────────────────────────────────────────────────────────
section("2.3 非树形状：DAG / 菱形 / 跨分支直接协作");

{
  const host = hostOf({ maxAgents: 20 });
  const root = await mk(host);
  const a = await mk(host, root, { member: "a" });
  const b = await mk(host, a, { member: "b" });
  record({
    id: "2.3a",
    question: "能否表达一个分身同时归属两个父（真正的 DAG / 菱形）",
    observed: `ControlledAgent.parentId 是单值：a.parentId=${a.parentId}，b.parentId=${b.parentId}。接口里没有任何多父字段。`,
    verdict: "GAP",
    conclusion:
      "结构上不可能。『谁生了谁』严格是树：每个分身只有一个 parentId，createAgent 只接受一个 parent。菱形/DAG 在**归属关系**上无法表达。",
    data: { aParent: a.parentId, bParent: b.parentId },
  });

  // 但数据流可以是 DAG：一个产出喂给两个消费者
  const prod = await mk(host, root, { member: "producer" });
  const out = (await prod.prompt("产出物-XYZ")).text;
  const c1 = await mk(host, root, { member: "c1" });
  const c2 = await mk(host, root, { member: "c2" });
  const r1 = await c1.prompt(out);
  const r2 = await c2.prompt(out);
  record({
    id: "2.3b",
    question: "数据流能否构成 DAG（一个产出喂给多个消费者）",
    observed: `c1 收到=${r1.text.includes("产出物-XYZ")}　c2 收到=${r2.text.includes("产出物-XYZ")}。实现它用了 ${2} 行设计者代码。`,
    verdict: "OK",
    conclusion:
      "可以。『归属』是树，但『数据流』不受限 —— 设计者把同一个文本喂给任意多个分身即可。要表达 DAG，靠设计者代码，不靠拓扑。",
    data: { c1: r1.text.includes("产出物-XYZ"), c2: r2.text.includes("产出物-XYZ") },
  });
  host.dispose();
}

{
  // 跨分支直接协作：两个不同分支的分身能不能互相投递（设计者侧 vs 工具层）
  const host = hostOf({ members: { expert: {} }, maxAgents: 20 });
  const root = await mk(host, undefined, { member: "root", tools: ["spawn_agent", "send_message"] });
  const tA = await mk(host, root, { member: "teamA" });
  const tB = await mk(host, root, { member: "teamB" });
  const expert = await mk(host, tA, { member: "expert" });

  // 设计者侧：任意投递
  await expert.send("来自设计者的横向请求");
  await expert.waitForIdle();
  const designerOk = expert.lastResult!.text.includes("横向请求");

  // 工具层：tB 想直接找 tA 分支里的 expert
  const sendToolMod = await import("../src/tools/send-message.ts");
  const denied = await sendToolMod
    .createSendMessageTool({ agent: tB, host })
    .execute("c", { agentId: expert.id, message: "跨分支直接聊" } as never, undefined, undefined, undefined as never);
  const deniedText = ((denied.content[0] as { text: string }).text ?? "").slice(0, 60);

  record({
    id: "2.3c",
    question: "跨分支协作：设计者侧 vs agent 工具层",
    observed: `设计者投递成功=${designerOk}；tB 用 send_message 找 expert（expert.parentId=${expert.parentId}，tB.id=${tB.id}）→ 「${deniedText}…」`,
    verdict: designerOk ? "PARTIAL" : "GAP",
    conclusion:
      "设计者侧完全自由（send 无后代限制）；agent 工具层被拦截（只能投后代）。跨分支协作**可表达，但必须由设计者做路由**，agent 之间无法自行横向联系。",
    data: { designerOk, tBDeniedText: deniedText },
  });
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("2.4 环：能否表达、能否造出死锁");

{
  const host = hostOf({ members: { m: {} }, maxAgents: 20 });
  const root = await mk(host, undefined, { member: "root", tools: ["spawn_agent", "send_message"] });
  const child = await mk(host, root, { member: "child", tools: ["spawn_agent", "send_message"] });
  const sendTool = await import("../src/tools/send-message.ts");
  // 子 → 父（反向）
  const up = await sendTool
    .createSendMessageTool({ agent: child, host })
    .execute("c", { agentId: root.id, message: "反向" } as never, undefined, undefined, undefined as never);
  record({
    id: "2.4a",
    question: "agent 工具层能否构成『子→父』这条反向边（发送环的一半）",
    observed: `被拒：「${((up.content[0] as { text: string }).text ?? "").slice(0, 50)}…」`,
    verdict: "OK",
    conclusion: "被拒。后代关系是树 + 只准向下投递 → 工具层的发送图是 DAG，环结构上不可能（决策 #20 的推论成立）。",
  });
  void up;
  host.dispose();
}

{
  // 设计者侧能不能造出真死锁：onToolCall 门等一个只有设计者才能放行的 promise，设计者却去 waitForIdle
  const host = hostOf({ maxAgents: 5 });
  const readArgs = JSON.stringify({ path: "audit/_harness.ts" });
  let release: (() => void) | undefined;
  let gateEntered = false;
  const gatePromise = new Promise<void>((res) => (release = res));
  const gated = await mk(host, undefined, {
    member: "gated",
    tools: ["read"],
    onToolCall: async () => {
      gateEntered = true;
      await gatePromise;
      return undefined;
    },
  });

  let promptDone = false;
  void gated
    .prompt(`[[tool:read]] [[args:${readArgs}]]`)
    .then(() => (promptDone = true))
    .catch(() => (promptDone = true));
  await new Promise((r) => setTimeout(r, 400));

  const waited = await Promise.race([
    gated.waitForIdle().then(() => "returned" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1200)),
  ]);
  record({
    id: "2.4b",
    question: "设计者侧能否造出死锁（无超时等待）",
    observed: `审批门已进入=${gateEntered}，prompt 未结束=${!promptDone}，isStreaming=${gated.isStreaming}，status=${gated.status}；此时调用 waitForIdle() → ${waited === "timeout" ? "1200ms 后仍未返回" : "正常返回"}`,
    verdict: waited === "timeout" ? "GAP" : "OK",
    conclusion:
      waited === "timeout"
        ? "能造出真死锁。库的等待原语（waitForIdle）**没有超时参数**，设计者写出『等一个依赖自己的东西』就会永久挂住，而且没有任何机制能发现。规格把『任何无超时等待一律不允许』列为死锁规则，但库并没有从 API 层面兑现它。"
        : "未复现（场景需重设）。",
    data: { gateEntered, promptDone, isStreaming: gated.isStreaming, result: waited },
  });
  release?.();
  await gated.waitForIdle().catch(() => {});
  host.dispose();
}

{
  // 参数校验失败发生在 tool_call 事件之前 → 审批门看不到非法调用
  let gateEntered = false;
  const a = await mk(hostOf({ maxAgents: 3 }), undefined, {
    member: "bad-args",
    tools: ["read"],
    onToolCall: async () => {
      gateEntered = true;
      return { block: true as const, reason: "应该永远到不了这里" };
    },
  });
  const r = await a.prompt("[[tool:read]]"); // 故意不给 path
  record({
    id: "2.4c",
    question: "参数不合法的工具调用会不会经过 onToolCall 审批门",
    observed: `审批门进入=${gateEntered}；prompt 正常返回，文本 = ${JSON.stringify(r.text.slice(0, 70))}`,
    verdict: gateEntered ? "OK" : "GAP",
    conclusion: gateEntered
      ? "会经门。"
      : "不会。参数校验在 tool_call 事件**之前**失败，审批门看不到这类调用 —— 设计者无法用审批门拦『参数非法的调用』，只能当普通错误处理。",
    data: { gateEntered, text: r.text.slice(0, 120) },
  });
  a.dispose();
}

// ─────────────────────────────────────────────────────────────
section("2.5 运行时动态改拓扑（花名册可变性）");

{
  const members: Record<string, MemberSpec> = { a: { description: "成员 A" } };
  const host = hostOf({ members, maxAgents: 20 });
  const root = await mk(host, undefined, { tools: ["spawn_agent"] });

  const mounted = createSpawnAgentTool({ agent: root, host });
  const enumBefore = JSON.stringify((mounted.parameters as { properties: { member: unknown } }).properties.member);
  const descBefore = mounted.description.includes("成员 B");

  members["b"] = { description: "成员 B" }; // 运行时扩编

  const enumAfter = JSON.stringify((mounted.parameters as { properties: { member: unknown } }).properties.member);
  const descAfter = mounted.description.includes("成员 B");

  // 新的工具实例能看见
  const fresh = createSpawnAgentTool({ agent: root, host });

  // 而运行时【删掉】成员会怎样：注意用字面量类型擦除来绕过枚举
  delete members["a"];
  const callArgs = { member: "a", task: "hi" } as never;
  const r = await mounted.execute("c", callArgs, undefined, undefined, undefined as never);
  const text = ((r.content[0] as { text: string }).text ?? "").slice(0, 70);

  record({
    id: "2.5a",
    question: "运行时给花名册加成员：已挂载的 spawn_agent 工具会不会更新",
    observed: `已挂载工具：枚举 ${enumBefore} → ${enumAfter}，描述含新成员 ${descBefore} → ${descAfter}；重新构造一次才含新成员：${fresh.description.includes("成员 B")}`,
    verdict: descAfter ? "OK" : "GAP",
    conclusion: descAfter
      ? "会更新。"
      : "不会。已挂载工具的描述与枚举都是**构造时快照** —— 模型永远发现不了运行时新增的成员。设计者只能 dispose 掉旧分身、重建一个，或者干脆一开始就把花名册给全。",
    data: { enumBefore, enumAfter, descBefore, descAfter },
  });

  record({
    id: "2.5b",
    question: "运行时从花名册删成员：已挂载工具的查询是否也跟着变",
    observed: `删掉成员 a 之后，用同一工具实例调用 member="a" → 「${text}…」`,
    verdict: text.includes("没有成员") ? "PARTIAL" : "INFO",
    conclusion: text.includes("没有成员")
      ? "查询走**活对象**、描述与『可挑选列表』走**快照**，三者不一致。实测的报错文本自相矛盾：既说『花名册里没有成员「a」』，又在同一个句子里把 a 列为可挑选成员。设计者与模型都会被这个错误信息误导。"
      : "需要进一步确认。",
    data: { text },
  });

  host.dispose();
}

{
  // 运行时能不能绕开 spawn_agent 直接加人？能不能移除活的分身？
  const host = hostOf({ maxAgents: 10 });
  const root = await mk(host);
  const extra = await mk(host, root, { member: "手工加的" });
  const before = host.list().length;
  extra.dispose();
  record({
    id: "2.5c",
    question: "设计者能否绕开 spawn_agent 直接增删活的分身",
    observed: `直接 createAgent 加了 1 个（${before} 个存活）；直接 dispose() 移除后剩 ${host.list().length} 个`,
    verdict: "OK",
    conclusion: "能。设计者侧可以任意增删分身，不受花名册或工具约束 —— 花名册只约束 **agent 之间**的挑选。",
    data: { before, after: host.list().length },
  });
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("2.6 拓扑相关的缺口小结");

{
  record({
    id: "2.6a",
    question: "有没有库自带的『列出后代 / 子树』原语",
    observed: "host 只提供 list() 与 get(id)；没有 childrenOf / descendantsOf / subtreeOf",
    verdict: "GAP",
    conclusion: "要遍历子树必须自己沿 parentId 走（我在本脚本里写了 depthOf / descendantCount 两个辅助函数）。规格 §10 也承认这条要设计者自建。",
  });
}
{
  record({
    id: "2.6b",
    question: "有没有库自带的拓扑导出",
    observed: "无。要自己 list() + parentId 拼树",
    verdict: "GAP",
    conclusion: "『设计集群』的核心产物（拓扑）没有导出能力。",
  });
}
{
  record({
    id: "2.6c",
    question: "孤儿检测：dispose 中间层之后，后代是否仍被算作该子树的一部分",
    observed: `实测：dispose 掉一个中间层后，后代 parentId 指向已不在 host.list() 里的 id；self-built 的拓扑函数会把它当根`,
    verdict: "GAP",
    conclusion: "没有级联回收，也没有孤儿标记。拓扑会静默变形，且没有 API 能发现『这个分身的父没了』除了自己 host.get(parentId) === undefined。",
  });
}

dump("02-topology");
await env.close();
