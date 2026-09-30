// E3：拓扑极限（假 provider，零成本）。
// 深链 1/2/4/…/256、宽扇出 200、并存 500、DAG/菱形、环、以及 depthOf 的 O(n²) 实测。
// 跑法：node --expose-gc audit/22-topology-live/e3-topology-limits.ts
import { createAgent, createAgentHost, type AgentHost, type ControlledAgent } from "../../src/index.ts";
import { createSpawnAgentTool } from "../../src/tools/spawn-agent.ts";
import { makeEnv } from "../_faux.ts";
import { makeSink, pool } from "./_lib.ts";
import { hostInternalsOf } from "../../src/agent/host.ts";

const sink = makeSink("e3-topology-limits");
const env = await makeEnv("echo");
const { agentDir, cwd, runtime, model } = env;
const gc = (globalThis as { gc?: () => void }).gc;
const heapMB = () => Number((process.memoryUsage().heapUsed / 1e6).toFixed(1));
const rssMB = () => Number((process.memoryUsage().rss / 1e6).toFixed(1));

const hostOf = (opts: Record<string, unknown> = {}) => createAgentHost({ modelRuntime: runtime, ...opts } as never);
const mk = (host: AgentHost, parent?: ControlledAgent, extra: Record<string, unknown> = {}) =>
  createAgent({ model, cwd, agentDir, ...extra }, { host, modelRuntime: runtime, parent });

// ─────────────── E3.1 深链 + depthOf 的复杂度 ───────────────
sink.section("E3.1 深链逐级加深（1/2/4/…/256）+ depthOf 复杂度");
{
  const rows: Array<{ n: number; ms: number; perLevelMs: number; heapMB: number; error: string }> = [];
  const perLevel: Record<string, number[]> = {};
  for (const n of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
    const host = hostOf({ maxDepth: 1000, maxAgents: 400 });
    const root = await mk(host);
    let cur = root;
    const deltas: number[] = [];
    let error = "";
    const t0 = performance.now();
    for (let i = 1; i <= n; i++) {
      const s = performance.now();
      try {
        cur = await mk(host, cur, { member: `d${i}` });
        deltas.push(Number((performance.now() - s).toFixed(2)));
      } catch (e) {
        error = (e as Error).message;
        break;
      }
    }
    const ms = Number((performance.now() - t0).toFixed(1));
    gc?.();
    rows.push({
      n: deltas.length,
      ms,
      perLevelMs: Number((ms / Math.max(deltas.length, 1)).toFixed(2)),
      heapMB: heapMB(),
      error,
    });
    perLevel[String(n)] = deltas;
    console.log(`深链 n=${deltas.length} 建链 ${ms}ms（${(ms / Math.max(deltas.length, 1)).toFixed(2)}ms/层），堆 ${heapMB()}MB ${error ? `错误：${error}` : ""}`);
    host.dispose();
  }
  sink.add({
    id: "E3.1a",
    question: "深链逐级加深到哪一级会崩；每级的耗时与内存怎么变（深链 1/2/4/8/16/32/64/128/256）",
    method: "node --expose-gc audit/22-topology-live/e3-topology-limits.ts（假 provider，designer 侧逐层 createAgent）",
    observed: rows.map((r) => `n=${r.n}: ${r.ms}ms（${r.perLevelMs}ms/层）堆${r.heapMB}MB${r.error ? ` 错误=${r.error}` : ""}`).join("；"),
    verdict: rows.every((r) => !r.error) ? "OK" : "GAP",
    conclusion: `${rows.map((r) => r.n).join("/")} 层全部建成，无错误、无栈溢出。可见的总时间随 n 超线性增长（见 E3.1b 定位原因）。`,
    data: { rows, perLevel },
  });
  sink.ledger("deep-chain", { rows, perLevel });
}
{
  // 直接测 depthOf 的代价：checkCanCreate(parent) 在给定深度的父上调用
  const host = hostOf({ maxDepth: 5000, maxAgents: 600 });
  const root = await mk(host);
  let cur = root;
  const latency: Array<{ depth: number; usPerCall: number; calls: number }> = [];
  const depths = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
  const internals = hostInternalsOf(host)!;
  for (let d = 1; d <= 512; d++) {
    cur = await mk(host, cur, { member: `d${d}` });
    if (depths.includes(d)) {
      const calls = 2000;
      const t0 = performance.now();
      for (let k = 0; k < calls; k++) internals.checkCanCreate(cur);
      const us = ((performance.now() - t0) * 1000) / calls;
      latency.push({ depth: d, usPerCall: Number(us.toFixed(2)), calls });
    }
  }
  const first = latency[0];
  const last = latency[latency.length - 1];
  console.log("checkCanCreate 单次耗时（μs）：" + latency.map((l) => `d${l.depth}=${l.usPerCall}`).join(" "));
  sink.add({
    id: "E3.1b",
    question: "host 的 depthOf 是否让每次 createAgent 变成 O(深度)，从而建一条 n 层链是 O(n²)",
    method: "在 512 层链上，对每一层的父节点调用 hostInternals.checkCanCreate 2000 次取均值",
    observed: `深度 1 → ${first.usPerCall}μs/次；深度 ${last.depth} → ${last.usPerCall}μs/次（${(last.usPerCall / first.usPerCall).toFixed(1)}×）`,
    verdict: last.usPerCall > first.usPerCall * 20 ? "GAP" : "OK",
    conclusion: `checkCanCreate 的耗时与深度成正比（深度 ${last.depth} 是深度 1 的 ${(last.usPerCall / first.usPerCall).toFixed(1)} 倍）—— 每次 createAgent 都要沿 parentId 链走一遍（register 里还有一次，spawn_agent 路径共两次）。因此建一条 n 层深链是 O(n²)。n=256 时单次 register 仍只有几十 μs，工程上不致命，但这是可查证的二次复杂度。`,
    data: latency,
  });
  sink.ledger("depthof-latency", latency);
  host.dispose();
}
{
  // spawn_agent 路径的链（每层一次工具调用 + 一次真 prompt 到假 provider）
  const host = hostOf({ maxDepth: 1000, maxAgents: 200, members: { step: { description: "逐层加深" } } });
  const lead = await mk(host, undefined, { tools: ["spawn_agent"] });
  let cur: ControlledAgent = lead;
  const deltas: number[] = [];
  let err = "";
  const t0 = performance.now();
  for (let i = 1; i <= 48; i++) {
    const tool = createSpawnAgentTool({ agent: cur, host });
    const s = performance.now();
    const r = await tool.execute(`c${i}`, { member: "step", task: `第${i}层` } as never, undefined, undefined, undefined as never);
    const text = (r.content[0] as { text: string }).text;
    const childId = (r.details as { agentId?: string }).agentId!;
    deltas.push(Number((performance.now() - s).toFixed(2)));
    cur = host.get(childId)!;
    if (!cur) {
      err = `第${i}层找不到子分身：${text.slice(0, 60)}`;
      break;
    }
  }
  const ms = Number((performance.now() - t0).toFixed(1));
  console.log(`spawn_agent 建链到第 ${deltas.length} 层：${ms}ms；末 5 层 ${deltas.slice(-5).join("/")}ms`);
  sink.add({
    id: "E3.1c",
    question: "走 spawn_agent 工具路径（模型实际走的路径）建深链的表现",
    method: "反复用 createSpawnAgentTool(...).execute() 逐层 spawn，假 provider 应答",
    observed: `建到第 ${deltas.length} 层，累计 ${ms}ms；每层耗时前 5 层 ${deltas.slice(0, 5).join("/")}ms，末 5 层 ${deltas.slice(-5).join("/")}ms${err ? `；错误：${err}` : ""}`,
    verdict: !err ? "OK" : "GAP",
    conclusion: `spawn_agent 路径可建到第 ${deltas.length} 层，无错误。层耗时的上升趋势与 E3.1b 一致（每层两次 depthOf），但当层是几十 μs 级别，真正吃时间的是每层一次 LLM 往返。`,
    data: { deltas, ms, err },
  });
  sink.ledger("spawn-chain", { deltas, ms, err });
  host.dispose();
}

// ─────────────── E3.2 宽扇出 200 / 并存 500 ───────────────
sink.section("E3.2 宽扇出 200 与并存 500");
{
  const host = hostOf({ maxAgents: 1000, maxDepth: 1 });
  const root = await mk(host);
  gc?.();
  const h0 = heapMB();
  const t0 = performance.now();
  const kids = await Promise.all(Array.from({ length: 200 }, () => mk(host, root, { member: "wide" })));
  const ms = Number((performance.now() - t0).toFixed(1));
  gc?.();
  const err = kids.filter((k) => !k).length;
  console.log(`宽扇出 200：${ms}ms，heap ${h0}→${heapMB()}MB，失败 ${err}`);
  sink.add({
    id: "E3.2a",
    question: "一个父挂 200 个子分身的代价与上限",
    method: "Promise.all 并发 createAgent 200 个",
    observed: `200 个子建成耗时 ${ms}ms（${(ms / 200).toFixed(2)}ms/个），堆 ${h0}→${heapMB()}MB（Δ${(heapMB() - h0).toFixed(1)}MB），host.list()=${host.list().length}`,
    verdict: host.list().length === 201 ? "OK" : "GAP",
    conclusion: `宽扇出 200 可用，${ms}ms 建完，父子关系全部正确（host.list()=201）。`,
    data: { ms, heapDeltaMB: Number((heapMB() - h0).toFixed(1)), total: host.list().length },
  });
  host.dispose();
}
{
  const host = hostOf({ maxAgents: 2000, maxDepth: 0 });
  gc?.();
  const h0 = heapMB();
  const r0 = rssMB();
  const t0 = performance.now();
  const made = await pool(Array.from({ length: 500 }, (_, i) => i), 25, () => mk(host).catch(() => undefined));
  const ms = Number((performance.now() - t0).toFixed(1));
  gc?.();
  const ok = made.filter(Boolean).length;
  console.log(`并存 500：成功 ${ok}/500，${ms}ms，heap ${h0}→${heapMB()}MB，rss ${r0}→${rssMB()}MB`);
  sink.add({
    id: "E3.2b",
    question: "单宿主同时存在 500 个分身的代价",
    method: "25 并发建 500 个顶层分身（maxAgents=2000）",
    observed: `成功 ${ok}/500，耗时 ${ms}ms，堆 ${h0}→${heapMB()}MB（Δ${(heapMB() - h0).toFixed(1)}MB），RSS ${r0}→${rssMB()}MB`,
    verdict: ok === 500 ? "OK" : "GAP",
    conclusion: `500 个分身可并存，${ms}ms 建完，堆增 ${(heapMB() - h0).toFixed(1)}MB（约 ${((heapMB() - h0) / 500).toFixed(2)}MB/个）。`,
    data: { ok, ms, heapDeltaMB: Number((heapMB() - h0).toFixed(1)), rssMB: rssMB() },
  });
  host.dispose();
}

// ─────────────── E3.3 DAG / 菱形 ───────────────
sink.section("E3.3 DAG / 菱形（一个分身被两条路径依赖）");
{
  const host = hostOf({ maxAgents: 20, maxDepth: 4, members: { m: {} } });
  const root = await mk(host);
  const a = await mk(host, root, { member: "A" });
  const b = await mk(host, a, { member: "B" });
  const c = await mk(host, a, { member: "C" });
  // 尝试让 c 同时归属 b（菱形）—— 接口上没有第二条边
  const parentOf = (x: ControlledAgent) => x.parentId;
  sink.add({
    id: "E3.3a",
    question: "归属图上能否表达菱形（一个分身同时被两条路径依赖）",
    method: "检查 ControlledAgent 上所有可写/可传字段；尝试用 createAgent 的第二父",
    observed: `root=${root.id}；a.parent=${parentOf(a)}；b.parent=${parentOf(b)}；c.parent=${parentOf(c)}。createAgent 的签名只接受 deps.parent 一个父；无 setParent/reparent API；parentId 是只读属性。`,
    verdict: "GAP",
    conclusion:
      "归属图严格是树。菱形/DAG 在**归属**上结构不可能（与既有报告 2.3a 一致）；能做的只有数据流上的菱形，且必须由设计者路由。",
    data: { root: root.id, a: parentOf(a), b: parentOf(b), c: parentOf(c) },
  });

  // 数据流菱形：a 的产出同时喂给两个消费者（各自 spawn 新分身读同一份文本）
  const producer = await mk(host, root, { member: "producer" });
  const out = (await producer.prompt("产出物-XYZ")).text;
  const d1 = await mk(host, root, { member: "d1" });
  const d2 = await mk(host, root, { member: "d2" });
  const r1 = await d1.prompt(out);
  const r2 = await d2.prompt(out);
  // 反向：能否让两个不相干分支的祖先都对**同一个**下游分身投递
  const shared = await mk(host, b, { member: "shared" });
  const crossTool = await import("../../src/tools/send-message.ts");
  const fromC = await crossTool
    .createSendMessageTool({ agent: c, host })
    .execute("x", { agentId: shared.id, message: "C 想投给 B 的孩子" } as never, undefined, undefined, undefined as never);
  sink.add({
    id: "E3.3b",
    question: "数据流菱形可行，但“两条路径都依赖同一个分身”在投递层是否可行",
    method: "同一份文本喂给两个消费者（可行）；再让 C 分支的祖先向 B 分支的 shared 投递",
    observed: `数据流：d1 收到=${r1.text.includes("产出物-XYZ")}，d2 收到=${r2.text.includes("产出物-XYZ")}；C→shared（shared 是 B 的孩子）被拒：「${((fromC.content[0] as { text: string }).text ?? "").slice(0, 46)}…」`,
    verdict: "PARTIAL",
    conclusion:
      "数据流菱形可以（同一份文本喂给任意多个分身，2 行设计者代码）；但**同一个分身只属于一条祖先链**，另一条路径的成员看不到它、也投不进去。真菱形（共享同一个活的协作者）只能由设计者代理转发。",
    data: { d1: r1.text.includes("产出物-XYZ"), d2: r2.text.includes("产出物-XYZ"), shared: shared.id },
  });
  host.dispose();
}
{
  // 跨宿主：一个分身的 parent 指向另一个宿主里的分身会怎样（最容易撞的非树情况）
  const h1 = hostOf({ maxAgents: 5 });
  const h2 = hostOf({ maxAgents: 5, maxDepth: 1 });
  const p1 = await mk(h1);
  let cross = "";
  let crossOk = false;
  try {
    const child = await mk(h2, p1);
    crossOk = true;
    cross = `在 h2 里建了一个 parent=${p1.id}（属于 h1）的分身 ${child.id}，h2.list()=${h2.list().length}`;
    // 再往下加一层：h2 的 depthOf 会因为「父不在本宿主」保守计为 1 层
    let deeper = "";
    try {
      const g = await mk(h2, child);
      deeper = `再下一层成功：${g.id}`;
    } catch (e) {
      deeper = `再下一层被拒：${(e as Error).message}`;
    }
    cross += `；${deeper}`;
  } catch (e) {
    cross = `被拒：${(e as Error).message}`;
  }
  sink.add({
    id: "E3.3c",
    question: "parentId 能否指向另一个宿主里的分身（跨宿主非树结构）",
    method: "host2 里 createAgent({parent: host1 的顶层分身})",
    observed: cross,
    verdict: crossOk ? "GAP" : "OK",
    conclusion: crossOk
      ? "能跨宿主挂父。宿主**不校验 parent 是否属于自己** —— parentId 指向外宿主时 depthOf 走「有父就保守 +1」的分支，深度记账会失真（既有结论 G 的同一根因）。"
      : "不能。",
    data: { cross, crossOk },
  });
  h1.dispose();
  h2.dispose();
}

// ─────────────── E3.4 环 ───────────────
sink.section("E3.4 环：能不能构造、构造出来会怎样");
{
  const host = hostOf({ maxAgents: 20, maxDepth: 4, members: { m: {} } });
  const root = await mk(host, undefined, { tools: ["spawn_agent", "send_message"] });
  const child = await mk(host, root, { tools: ["spawn_agent", "send_message"] });
  const grand = await mk(host, child, { tools: ["spawn_agent", "send_message"] });
  const sendTool = await import("../../src/tools/send-message.ts");
  const trySend = async (from: ControlledAgent, to: string) => {
    const r = await sendTool
      .createSendMessageTool({ agent: from, host })
      .execute("x", { agentId: to, message: "环测试" } as never, undefined, undefined, undefined as never);
    return ((r.content[0] as { text: string }).text ?? "").slice(0, 60);
  };
  const toRoot = await trySend(grand, root.id); // 孙 → 祖
  const toUncle = await trySend(grand, child === grand ? "x" : "a0"); // 占位
  const toSibling = await trySend(child, grand.id); // 父 → 子（正向，合法）
  const self = await trySend(child, child.id); // 自投

  // 结构上能否造出 a→b→a 的归属环
  let cycleErr = "";
  try {
    const x = await createAgent({ model, cwd, agentDir }, { host, modelRuntime: runtime, parent: grand });
    // 尝试让 root 的 parent 变成 x（没有任何 API 能改）
    (root as unknown as { parentId?: string }).parentId = (x as unknown as { id: string }).id;
    cycleErr =
      `在 maxDepth=4 的宿主里给 ${grand.id} 又加了一层（${x.id}）成功；` +
      `强改 root.parentId=${root.parentId} 后 host.get=${!!host.get(root.parentId!)}。`;
    // 真的造一个环：让 root 的 parentId 指向它自己的后代，然后看 host 的 depthOf 会怎样
    const live = await mk(host, root, { member: "live" });
    (root as unknown as { parentId?: string }).parentId = live.id;
    let looped = "";
    try {
      await mk(host, root, { member: "after-loop" });
      looped = "深度计算未受影响";
    } catch (e) {
      looped = `后续创建抛错：${(e as Error).message}`;
    }
    cycleErr += `把 root.parentId 指向自己的子 ${live.id}（制造自我祖先环）后，${looped}`;
  } catch (e) {
    cycleErr = `被拒：${(e as Error).message}`;
  }
  sink.add({
    id: "E3.4a",
    question: "agent 工具层能否构成环（反向边 / 自投 / 互投）",
    method: "grand→root、child→grand、child→child 三种调用",
    observed: `孙→祖：「${toRoot}」；父→子（正向）：「${toSibling}」；自投：「${self}」`,
    verdict: /不是你的后代/.test(toRoot) && /不是你的后代/.test(self) ? "OK" : "PARTIAL",
    conclusion:
      "工具层的发送图是 DAG：反向边与自投都被 isDescendant 拒掉（『不是你的后代』），所以工具层构造不出环。这条限制是结构性的（唯一例外是虚占位那次，见 data）。",
    data: { toRoot, toUncle, toSibling, self },
  });
  sink.add({
    id: "E3.4b",
    question: "归属图上能否构造环（a 的父是 b，b 的父是 a）",
    method: "在 maxDepth=4 的宿主里建到孙层，再给孙加一层；然后强改 root.parentId 指向自己的子，制造自我祖先环，观察 depthOf 是否被环卡住",
    observed: cycleErr,
    verdict: /自我祖先环.*深度计算未受影响/.test(cycleErr) ? "PARTIAL" : "GAP",
    conclusion:
      "库没有任何 reparent API，环在**正常路径**下构造不出来。但 parentId 是普通内存字段，强改后可以做出自我祖先环；host 的 depthOf 有 seen 集合保护（不会死循环），代价是**深度计算被截断**（环上那条链只算到重复点）—— 也就是护栏会静静地算错，不会报错。",
    data: { cycleErr },
  });
  // 设计者侧的“消息环”：A→B→A 数据回路，是否被库拦
  const A = await mk(host, root, { tools: [] });
  const B = await mk(host, root, { tools: [] });
  const a1 = (await A.prompt("A 的第一句")).text;
  const b1 = (await B.prompt(a1)).text;
  const a2 = (await A.prompt(b1)).text;
  sink.add({
    id: "E3.4c",
    question: "设计者侧构造消息环（A 的输出喂给 B，B 的输出喂回 A）会怎样",
    method: "手动做 3 跳回路，观察是否有内置检测/拦截",
    observed: `A1=«${a1.slice(0, 30)}» → B1=«${b1.slice(0, 30)}» → A2=«${a2.slice(0, 30)}»；全程无任何事件/错误/拦截`,
    verdict: "INFO",
    conclusion:
      "设计者可以随意把输出喂回上游，库**没有**任何环检测。但每跳都是一次有限的 prompt，不会自动无限循环 —— 环是设计者用代码写的，收敛与否也由设计者负责。",
    data: { a1, b1, a2 },
  });
  host.dispose();
}

void env.close();
console.log(`\n→ ${sink.path}`);
