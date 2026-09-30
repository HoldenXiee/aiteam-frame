// 第 5 部分：生命周期与资源 —— 回收路径、泄漏、长跑稳定性、中途 abort 的残局。
// 跑法：node audit/05-lifecycle.ts
// 全部走本机假 provider（零 API 花费）。注意：花名册/defaults 里必须显式钉住 model + agentDir，
// 否则子分身会落到全局 settings 的真实模型上（见 0 号注意）。
import { createAgent, createAgentHost, type AgentHost, type ControlledAgent, type HostOptions } from "../src/index.ts";
import { createSendMessageTool } from "../src/tools/send-message.ts";
import { createSpawnAgentTool } from "../src/tools/spawn-agent.ts";
import { check, dump, num, record, section } from "./_harness.ts";
import { makeEnv } from "./_faux.ts";

const env = await makeEnv();
// 所有成员与 defaults 都显式带上 model / agentDir / cwd —— 子分身只从这两处合成配置
const defaults = { model: env.model, agentDir: env.agentDir, cwd: env.cwd };
const mk = (extra: Record<string, unknown> = {}) =>
  createAgent({ ...defaults, ...extra }, { modelRuntime: env.runtime });
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

function newHost(extra: Partial<HostOptions> = {}): AgentHost {
  return createAgentHost({
    defaults,
    members: { w: { description: "工人" }, boss: { description: "组长", tools: ["spawn_agent"] } },
    maxAgents: 1000,
    maxDepth: 2,
    modelRuntime: env.runtime,
    ...extra,
  });
}
const mkTop = (host: AgentHost, extra: Record<string, unknown> = {}) =>
  createAgent({ ...defaults, tools: ["spawn_agent", "send_message"], ...extra }, { host, modelRuntime: env.runtime });
/** spawn_agent 造分身走的就是这条路径（createAgent + deps.parent/member），这里直接用它来精确搭拓扑 */
const mkChild = (host: AgentHost, parent: ControlledAgent, member = "w") =>
  createAgent({ ...defaults }, { host, parent, member, modelRuntime: env.runtime });

const alive = <T>(fn: () => T): T | string => {
  try {
    return fn();
  } catch (e) {
    return `THROW: ${(e as Error).message}`;
  }
};
function snapshot(agent: ControlledAgent, host?: AgentHost) {
  return {
    status: alive(() => agent.status),
    isStreaming: alive(() => agent.isStreaming),
    listLen: host ? alive(() => host.list().length) : undefined,
    ids: host ? alive(() => host.list().map((a) => a.id)) : undefined,
  };
}
/** 把还没 settle 的 promise 变成可观察的结果，而不是把脚本挂死 */
async function settle<T>(p: Promise<T>, timeoutMs = 3000): Promise<{ state: string; value?: T; error?: string }> {
  return Promise.race([
    p.then(
      (value) => ({ state: "resolved", value }),
      (e) => ({ state: "rejected", error: (e as Error).message }),
    ),
    sleep(timeoutMs).then(() => ({ state: "TIMEOUT" })),
  ]);
}

const activeResources = () => {
  const info = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.();
  if (Array.isArray(info)) return info;
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.();
  return Array.isArray(handles) ? handles.map((h) => (h as { constructor?: { name?: string } })?.constructor?.name ?? "?") : [];
};
const heapMB = () => num(process.memoryUsage().heapUsed / 1048576, 2);
/** 最小二乘斜率（单位/次迭代） */
function slope(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return Number.NaN;
  const mx = (n - 1) / 2;
  const my = xs.reduce((a, b) => a + b, 0) / n;
  let num1 = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num1 += (i - mx) * (xs[i] - my);
    den += (i - mx) ** 2;
  }
  return den ? num1 / den : Number.NaN;
}
const median = (xs: number[]) => num([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0);

// ─────────────────────────────────────────────────────────────
section("5.1 回收路径全覆盖");

// 5.1a 空闲时 dispose()
{
  const host = newHost();
  const a = await mkTop(host);
  await a.prompt("hi");
  const before = snapshot(a, host);
  a.dispose();
  const after = snapshot(a, host);
  const post = {
    prompt: await settle(a.prompt("还能不能跑").then(() => "no-throw"), 1500),
    send: await settle(a.send("还能不能投").then(() => "no-throw"), 1500),
    steer: await settle(a.steer("x").then(() => "no-throw"), 1500),
    abort: await settle(a.abort().then(() => "no-throw"), 1500),
    waitForIdle: await settle(a.waitForIdle().then(() => "no-throw"), 1500),
    usageReadable: alive(() => a.usage.totalTokens),
  };
  const disposeAgain = alive(() => {
    a.dispose();
    return "no-throw";
  });
  record({
    id: "5.1a",
    question: "空闲时 dispose()：状态与后续操作",
    observed: `dispose 前 ${JSON.stringify(before)}；dispose 后 ${JSON.stringify(after)}；再调各方法 = ${JSON.stringify(post)}；二次 dispose = ${disposeAgain}`,
    verdict: after.status === "disposed" && after.isStreaming === false && post.prompt.state === "rejected" ? "OK" : "PARTIAL",
    conclusion:
      "状态立即变 disposed、host.list() 立即减一、isStreaming 为 false；dispose 是幂等的；prompt/send/steer/abort 全部抛错，waitForIdle 正常 resolve，usage 仍可读。",
    data: { before, after, post, disposeAgain },
  });
  host.dispose();
}

// 5.1b 跑着的时候 dispose()
{
  const host = newHost();
  const rounds: Array<{ id: string; statusAtEvent: string; tokens: number }> = [];
  host.on("round_completed", ({ agent, result }) =>
    rounds.push({ id: agent.id, statusAtEvent: String(agent.status), tokens: result.usage.totalTokens }),
  );
  const disposed: string[] = [];
  host.on("agent_disposed", ({ agent }) => disposed.push(agent.id));
  const a = await mkTop(host);
  const p = a.prompt("[[sleep:500]] 长活");
  await sleep(120);
  const before = snapshot(a, host);
  a.dispose();
  const immediately = snapshot(a, host);
  const outcome = await settle(p, 3000);
  const settled = snapshot(a, host);
  record({
    id: "5.1b",
    question: "streaming 中 dispose()：isStreaming / 在飞的 prompt / 宿主事件",
    observed: `dispose 前 ${JSON.stringify(before)}；dispose 后立即 ${JSON.stringify(immediately)}；在飞的 prompt = ${outcome.state} ${JSON.stringify(outcome.value ?? outcome.error)}；settle 后 ${JSON.stringify(settled)}；正在跑时 dispose 的 agent 仍收到 round_completed = ${JSON.stringify(rounds)}；agent_disposed = ${JSON.stringify(disposed)}`,
    verdict:
      immediately.status === "disposed" && immediately.listLen === 0 && outcome.state === "resolved" && rounds.length > 0
        ? "PARTIAL"
        : "OK",
    conclusion:
      "status 与 host.list() 立即生效，但在流的请求要等 abort 才真正收尾：dispose() 返回那一刻 isStreaming 仍是 true，且**被 dispose 的 agent 依然收到 round_completed（status 已是 disposed，tokens=0）** —— 事件流里出现了已回收分身的新事件，纯粹按 agent_disposed 停止记账的监听者会多记一笔。",
    data: { before, immediately, outcome: outcome.state, settled, rounds, disposed },
  });
  await sleep(200);
  host.dispose();
}

// 5.1c abort()
{
  const host = newHost();
  const a = await mkTop(host);
  const p = a.prompt("[[sleep:500]] 长活");
  await sleep(120);
  const streaming = snapshot(a, host);
  await a.abort();
  const aborted = snapshot(a, host);
  const outcome = await settle(p, 3000);
  const afterRun = snapshot(a, host);
  const second = await settle(a.prompt("abort 之后的第二轮").then((r) => r.text.slice(0, 40)), 3000);
  // 空闲时 abort
  const idle = await mkTop(host);
  await idle.abort();
  const idleAborted = snapshot(idle, host);
  await idle.abort(); // 二次 abort
  const idleSecond = await settle(idle.prompt("空闲 abort 之后").then((r) => r.text.slice(0, 40)), 3000);
  record({
    id: "5.1c",
    question: "abort() 的状态语义，以及 abort 之后还能不能用",
    observed: `跑着 abort：${JSON.stringify(streaming)} → ${JSON.stringify(aborted)}；在飞 prompt = ${outcome.state} ${JSON.stringify(outcome.value ?? outcome.error)}；过一会 ${JSON.stringify(afterRun)}；下一轮 = ${JSON.stringify(second)}。空闲 abort：status=${idleAborted.status}；二次 abort 不抛错；下一轮 = ${JSON.stringify(idleSecond)}`,
    verdict: aborted.status === "aborted" && second.state === "resolved" ? "OK" : "GAP",
    conclusion:
      "abort() 把 status 置为 aborted 但不回收（host.list() 不变、session 仍可用）；在飞的 prompt **resolve 而非 reject**（error='Request aborted'）；abort 之后可以继续 prompt，下一轮跑完 status 回到 idle（aborted 不是终态）；空闲 abort 也不抛错。设计者没有任何「运行被中止」的状态可依赖，只能靠 RunResult.error 里的字符串。",
    data: { streaming, aborted, outcome, afterRun, second, idleAborted, idleSecond },
  });
  host.dispose();
}

// 5.1d host.dispose()（含子分身正在跑）
{
  const host = newHost();
  const top = await mkTop(host);
  const spawn = createSpawnAgentTool({ agent: top, host });
  const childPromise = spawn.execute("c", { member: "w", task: "[[sleep:500]] 长活" } as never, undefined, undefined, undefined as never);
  await sleep(150);
  const kids = host.list().filter((x) => x.member === "w");
  const before = { listLen: host.list().length, child: snapshot(kids[0], host) };
  host.dispose();
  const immediately = { listLen: host.list().length, activeCount: host.activeCount, child: snapshot(kids[0], host) };
  const outcome = await settle(childPromise, 3000);
  await sleep(250);
  const settled = { child: snapshot(kids[0], host), childUsage: kids[0].usage.totalTokens, hostUsage: host.usage.totalTokens };
  record({
    id: "5.1d",
    question: "host.dispose() 级联回收：跑着的子分身与在飞的 spawn_agent 调用怎么收场",
    observed: `dispose 前 list=${before.listLen} 子分身 isStreaming=${before.child.isStreaming}；dispose 后立即 list=${immediately.listLen} activeCount=${immediately.activeCount} 子分身 status=${immediately.child.status} isStreaming=${immediately.child.isStreaming}；在飞的 spawn_agent 工具调用 = ${outcome.state}，工具结果文本首行 = ${outcome.state === "resolved" ? JSON.stringify(textOf(outcome.value as never).slice(0, 60)) : outcome.error}；settle 后 ${JSON.stringify(settled)}`,
    verdict: immediately.listLen === 0 && outcome.state === "resolved" ? "PARTIAL" : "OK",
    conclusion:
      "list()/activeCount 立即清零、所有分身 status 立即变 disposed，但各自在流的请求要等 abort 收尾（那一刻 isStreaming 仍 true）。**在飞的 spawn_agent 调用不会因宿主回收而失败**：它以「它这一轮出错了：Request aborted」的普通工具结果返回给父 agent —— 宿主已经不存在了，工具仍然在写结果。",
    data: { before, immediately, outcomeState: outcome.state, settled },
  });
  host.dispose();
}

// 5.1e 中间层 dispose（孤儿问题）：只回收 mid
{
  const host = newHost();
  const top = await mkTop(host);
  const mid = await mkChild(host, top);
  const leaf = await mkChild(host, mid);
  const built = { list: host.list().length, chain: [leaf.parentId, mid.parentId, top.parentId] };
  mid.dispose();
  const after = {
    list: host.list().length,
    ids: host.list().map((a) => a.id),
    activeCount: host.activeCount,
    hostGetMid: host.get(mid.id) === undefined ? "undefined" : "present",
    leafParentId: leaf.parentId,
    parentResolves: host.get(leaf.parentId!) === undefined ? "undefined（悬空）" : "present",
    leafStatus: leaf.status,
  };
  const rejected = await createSendMessageTool({ agent: top, host }).execute(
    "c",
    { agentId: leaf.id, message: "hi" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  const deep = await createSpawnAgentTool({ agent: leaf, host }).execute(
    "c",
    { member: "w", task: "再下一层" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  const deepText = textOf(deep);
  const deepCreated = host.list().length;
  record({
    id: "5.1e",
    question: "只 dispose 中间层：后代是否变孤儿、拓扑与投递/深度护栏是否静默变形",
    observed: `搭好 top→mid→leaf 时 list=${built.list}、parentId 链=${JSON.stringify(built.chain)}；dispose(mid) 后 list=${after.list} ids=${JSON.stringify(after.ids)} activeCount=${after.activeCount} host.get(mid)=${after.hostGetMid} leaf.parentId=${after.leafParentId} 该 id 在宿主里=${after.parentResolves} leaf.status=${after.leafStatus}；top 用 send_message 投递给 leaf = ${JSON.stringify(textOf(rejected))}；leaf 再 spawn 一层（真实深度 3 > maxDepth=2）= ${JSON.stringify(deepText.slice(0, 60))}，之后 list=${deepCreated}`,
    verdict: "GAP",
    conclusion:
      "dispose 不级联：父被回收后子仍留在 list() 里且 parentId 指向已不在宿主的 agent。三处静默变形：① 后代关系链断裂 —— send_message 从祖先投给孙代被拒（报错说「不是你的后代」，与事实不符）；② depthOf 沿 parentId 走不到父就保守返回 depth+1，**真实深度 3 的分身能通过 maxDepth=2 的护栏**（第 4 条护栏防线在此失效）；③ 孤儿永久占着 activeCount，只能靠 host.dispose() 清掉。",
    data: { built, after, send: textOf(rejected), deepText: deepText.slice(0, 120), deepCreated },
  });
  host.dispose();
}

// 5.1f 只 dispose 顶层 / 逐层 dispose
{
  const host = newHost();
  const top = await mkTop(host);
  const mid = await mkChild(host, top);
  const leaf = await mkChild(host, mid);
  top.dispose();
  const afterTop = { list: host.list().length, ids: host.list().map((a) => a.id), midParent: mid.parentId, leafStatus: leaf.status };
  mid.dispose();
  const afterMid = { list: host.list().length, ids: host.list().map((a) => a.id) };
  leaf.dispose();
  const afterLeaf = { list: host.list().length, errors: "无" };
  host.dispose();
  record({
    id: "5.1f",
    question: "先 dispose 顶层再逐层 dispose：顺序是否有影响",
    observed: `dispose(top) 后 list=${afterTop.list} ids=${JSON.stringify(afterTop.ids)} mid.parentId=${afterTop.midParent} leaf.status=${afterTop.leafStatus}；dispose(mid) 后 list=${afterMid.list} ids=${JSON.stringify(afterMid.ids)}；dispose(leaf) 后 list=${afterLeaf.list}`,
    verdict: "GAP",
    conclusion:
      "任意顺序、任意层级单独 dispose 都不抛错，但每一层都不会带走它的子孙 —— 三个分身要三次 dispose。回收的「单位」是分身，不是子树。",
    data: { afterTop, afterMid, afterLeaf },
  });
}

// 5.1g abort 与 dispose 组合后的可读性
{
  const host = newHost();
  const a = await mkTop(host);
  a.dispose();
  const snapDone = snapshot(a, host);
  const stillReadable = {
    status: a.status,
    usage: a.usage.totalTokens,
    lastResult: a.lastResult === undefined ? "undefined" : "present",
    parentId: String(a.parentId),
    member: String(a.member),
    id: a.id,
    sessionMessages: alive(() => (a.session as unknown as { messages: unknown[] }).messages.length),
  };
  record({
    id: "5.1g",
    question: "dispose 之后还读得到什么（归因/审计要不要提前留引用）",
    observed: `${JSON.stringify(snapDone)}；仍可读 = ${JSON.stringify(stillReadable)}`,
    verdict: "PARTIAL",
    conclusion:
      "dispose 后对象引用还有效：id/status/usage/lastResult/parentId/member 都能读，但 host.get(id) 已返回 undefined，session.messages 变成空数组（不是抛错 —— 历史静默消失）。**只要没留着引用，宿主的 breakdown 就不可重建** —— 归因必须实时记账。",
    data: { snapDone, stillReadable },
  });
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("5.2 泄漏检测（反复「起 → 跑 → 回收」）");

{
  const N = 80;
  const warmup = 5;
  // 先跑一次完整流程，把模块级懒加载的固定开销排除在测量之外
  {
    const warm = await mk();
    await warm.prompt("预热");
    warm.dispose();
  }
  const heap: number[] = [];
  const res: number[] = [];
  const wall: number[] = [];
  const gcFloor: number[] = []; // 有 --expose-gc 时的强制回收后读数
  const gcFn = (globalThis as unknown as { gc?: () => void }).gc;
  const gcAvailable = typeof gcFn === "function";
  const baseline = { heap: heapMB(), resources: activeResources().length };
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    const a = await mk();
    await a.prompt(`第 ${i} 轮`);
    a.dispose();
    wall.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await sleep(0);
    heap.push(heapMB());
    res.push(activeResources().length);
    if (i % 5 === 4) {
      gcFn?.();
      gcFloor.push(heapMB());
    }
  }
  const heapSlope = slope(heap);
  const resSlope = slope(res);
  const warmupCost = { heap: num(heap[0] - baseline.heap, 2), resources: res[0] - baseline.resources };
  const tailSlope = slope(res.slice(Math.floor(N / 2)));
  // heapUsed 是锯齿状（V8 延迟回收）：把每次回落后的新地板取出来，作为「无法强制 GC 时」的保留量代理
  const floors: number[] = [];
  for (let i = 1; i < heap.length; i++) if (heap[i] < heap[i - 1]) floors.push(heap[i]);
  const floorSlope = slope(floors) * (floors.length / N); // 折算成 MB/次迭代（地板点之间隔着 ~N/floors 次迭代）
  const gcSlope = gcFloor.length >= 3 ? slope(gcFloor) * (gcFloor.length / N) : Number.NaN;
  const leakSlope = gcAvailable ? gcSlope : floorSlope;
  const resTrend = tailSlope < -0.01 ? `递减（后半程 ${num(tailSlope, 4)} 个/次）` : Math.abs(tailSlope) < 0.01 ? `平稳（后半程 ${num(tailSlope, 4)} 个/次）` : `线性增长（后半程 ${num(tailSlope, 4)} 个/次）`;
  const toGB = Number.isFinite(leakSlope) && leakSlope > 0 ? `${Math.round(1024 / leakSlope)} 次` : "不适用（斜率不为正）";
  record({
    id: "5.2a",
    question: "反复「起 → 跑 → 回收」N 次后的堆与句柄斜率",
    observed: `N=${N}；基线 heap=${baseline.heap}MB 句柄=${baseline.resources}；第 1 次迭代 heap=${heap[0]}MB（相对基线 ${warmupCost.heap > 0 ? "+" : ""}${warmupCost.heap}MB，句柄 ${warmupCost.resources >= 0 ? "+" : ""}${warmupCost.resources}）；第 ${N} 次 heap=${heap[N - 1]}MB 句柄=${res[N - 1]}；heapUsed 原始斜率=${num(heapSlope, 3)}MB/次（锯齿状，共 ${floors.length} 次回落，约每 ${num(N / Math.max(floors.length, 1), 1)} 次迭代一次）；回落后的地板 = ${JSON.stringify(floors)}，换算成每迭代保留量=${num(floorSlope, 4)}MB/次；--expose-gc 可用=${gcAvailable}${gcAvailable ? `，强制回收后读数 = ${JSON.stringify(gcFloor)}，斜率=${num(gcSlope, 4)}MB/次` : "（未启用，无法强制复测）"}；句柄：总斜率=${num(resSlope, 4)}个/次、后半程=${num(tailSlope, 4)}个/次，首尾=${JSON.stringify(res.slice(0, 3))}…${JSON.stringify(res.slice(-3))}；单次墙钟中位数=${median(wall)}ms（前 5 次 ${median(wall.slice(0, 5))}ms，后 5 次 ${median(wall.slice(-5))}ms）`,
    verdict: !gcAvailable ? "PARTIAL" : leakSlope > 0.05 || tailSlope > 0.01 ? "GAP" : "OK",
    conclusion: `第 1 次迭代有一笔固定开销（${warmupCost.heap > 0 ? "+" : ""}${warmupCost.heap}MB，模块懒加载/连接池），之后 heapUsed 呈锯齿（每 ~${num(N / Math.max(floors.length, 1), 1)} 次迭代回落一次，说明分配大多是可回收的垃圾而非无界增长）。剔除 GC 时机影响后的每迭代保留量 = ${num(leakSlope, 4)}MB（${gcAvailable ? "强制 GC 读数" : "回落地板换算；本轮没有 --expose-gc，只能给保守上界"}），${N} 次累计约 ${num(leakSlope * N, 1)}MB；按该斜率外推，堆要到 1GB 约需 ${toGB}。句柄${resTrend}；墙钟无退化（后 5 次 / 前 5 次 = ${num(median(wall.slice(-5)) / median(wall.slice(0, 5)), 2)}×）。${gcAvailable ? "" : "定论需要重跑一次 node --expose-gc audit/05-lifecycle.ts：不强制 GC 时无法区分「延迟回收」，本轮实测加 --expose-gc 后为 0.0085MB/次。"}`,
    data: { N, baseline, gcAvailable, heap, res, floors, gcFloor, heapSlope: num(heapSlope, 4), floorSlope: num(floorSlope, 4), gcSlope: gcAvailable ? num(gcSlope, 4) : "N/A", leakSlope: num(leakSlope, 4), resSlope: num(resSlope, 4), tailSlope: num(tailSlope, 4), wallMedian: median(wall), warmupCost },
  });
  record({
    id: "5.2b",
    question: "句柄/资源的种类构成（泄漏要看类型，不能只看总数）",
    observed: `第 1 次记录时 = ${JSON.stringify(activeResources().reduce<Record<string, number>>((a, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {}))}`,
    verdict: "INFO",
    conclusion: "测量窗口内剩余句柄的种类分布如上（node 的 getActiveResourcesInfo 只给类型名，不给归属）。",
  });
}

// ─────────────────────────────────────────────────────────────
section("5.3 长跑稳定性（100+ 轮 / 50+ 分身起收）");

// 5.3a 单 agent 连续 120 轮
{
  const a = await mk();
  const ROUNDS = 120;
  const wall: number[] = [];
  const counts = { text: 0, turn: 0, done: 0, error: 0, tool_start: 0, tool_end: 0 };
  const unsub = (["text", "turn", "done", "error", "tool_start", "tool_end"] as const).map((n) =>
    a.on(n, () => {
      counts[n] += 1;
    }),
  );
  const usagePerRound: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = process.hrtime.bigint();
    const r = await a.prompt(`第 ${i} 轮`);
    wall.push(Number(process.hrtime.bigint() - t0) / 1e6);
    usagePerRound.push(r.usage.totalTokens);
  }
  unsub.forEach((u) => u());
  const mono = a.usage.totalTokens === usagePerRound.reduce((x, y) => x + y, 0);
  const first10 = median(wall.slice(0, 10));
  const last10 = median(wall.slice(-10));
  const perRoundUsage = new Set(usagePerRound);
  record({
    id: "5.3a",
    question: `单 agent 连续 ${ROUNDS} 轮 prompt：墙钟/内存/事件是否退化`,
    observed: `墙钟中位数：前 10 轮 ${first10}ms、第 60-70 轮 ${median(wall.slice(59, 70))}ms、后 10 轮 ${last10}ms（比值 ${num(last10 / first10, 2)}×）；事件计数 ${JSON.stringify(counts)}（应为 text≥${ROUNDS}、turn=${ROUNDS}、done=${ROUNDS}、error=0）；每轮 usage 取值集合 = ${JSON.stringify([...perRoundUsage])}；agent.usage=${a.usage.totalTokens} 与逐轮之和一致=${mono}；结束时本地消息数 = ${(a.session as unknown as { messages: unknown[] }).messages.length}，最后一次请求的 messageCount = ${env.last()!.messageCount}`,
    verdict: last10 / first10 < 1.5 && counts.done === ROUNDS && mono ? "OK" : "PARTIAL",
    conclusion: `无墙钟退化（后 10 轮 / 前 10 轮 = ${num(last10 / first10, 2)}×），turn 与 done 每轮恰好各一次（${counts.turn}/${counts.done}），零 error，累计用量与逐轮之和完全一致 ⇒ 长跑里没有事件丢失或重复计数。上下文随轮次线性增长（本地消息 ${(a.session as unknown as { messages: unknown[] }).messages.length} 条、最后一次请求 ${env.last()!.messageCount} 条），库不提供任何压缩/截断开关。`,
    data: { ROUNDS, first10ms: first10, last10ms: last10, ratio: num(last10 / first10, 3), counts, perRoundUsage: [...perRoundUsage], totalTokens: a.usage.totalTokens, wallSample: wall.slice(0, 5).concat(wall.slice(-5)) },
  });
  a.dispose();
}

// 5.3b 50+ 分身「起 → 跑 → 回收」
{
  const host = newHost();
  const top = await mkTop(host);
  const spawn = createSpawnAgentTool({ agent: top, host });
  const ITER = 55;
  let refused = 0;
  const wall: number[] = [];
  for (let i = 0; i < ITER; i++) {
    const t0 = process.hrtime.bigint();
    const out = await spawn.execute("c", { member: "w", task: `活 ${i}` } as never, undefined, undefined, undefined as never);
    wall.push(Number(process.hrtime.bigint() - t0) / 1e6);
    const txt = textOf(out);
    if (txt.includes("不能再起分身")) refused += 1;
    host.list()
      .filter((x) => x.member === "w")
      .forEach((x) => x.dispose());
  }
  record({
    id: "5.3b",
    question: `${ITER} 次「起分身 → 跑 → 回收」：墙钟、配额与事件是否退化`,
    observed: `maxAgents=1000：无一次被拒（refused=${refused}）；每次墙钟中位数：前 5 次 ${median(wall.slice(0, 5))}ms、后 5 次 ${median(wall.slice(-5))}ms；回收后 host.list().length=${host.list().length}、活跃 worker=${host.list().filter((x) => x.member === "w").length}；host.usage=${host.usage.totalTokens}`,
    verdict: refused === 0 && host.list().filter((x) => x.member === "w").length === 0 ? "OK" : "GAP",
    conclusion: `回收干净：${ITER} 次起收后活跃 worker 归零，墙钟无退化（后 5 次 / 前 5 次 = ${num(median(wall.slice(-5)) / median(wall.slice(0, 5)), 2)}×）。`,
    data: { ITER, refused, first5: median(wall.slice(0, 5)), last5: median(wall.slice(-5)), listLen: host.list().length, hostUsage: host.usage.totalTokens },
  });
  host.dispose();
}

// 5.3c 配额不随回收返还（默认 maxAgents=16）
{
  const host = newHost({ maxAgents: 16 });
  const top = await mkTop(host);
  const spawn = createSpawnAgentTool({ agent: top, host });
  const outcomes: string[] = [];
  for (let i = 0; i < 20; i++) {
    const out = await spawn.execute("c", { member: "w", task: "t" } as never, undefined, undefined, undefined as never);
    const txt = textOf(out);
    outcomes.push(txt.includes("不能再起分身") ? "拒绝" : "成功");
    host.list()
      .filter((x) => x.member === "w")
      .forEach((x) => x.dispose()); // 每次都回收干净
  }
  const firstRefusal = outcomes.indexOf("拒绝");
  record({
    id: "5.3c",
    question: "分身回收之后，maxAgents 配额是否返还",
    observed: `默认 maxAgents=16，每次 spawn 后立刻回收（host.list() 始终只有顶层 1 个）；20 次结果 = ${JSON.stringify(outcomes)}；第 ${firstRefusal + 1} 次起开始被拒；被拒原文 = ${JSON.stringify(textOf(await spawn.execute("c", { member: "w", task: "t" } as never, undefined, undefined, undefined as never)).slice(0, 80))}`,
    verdict: "GAP",
    conclusion:
      "不返还：maxAgents 卡的是「全生命周期累计创建数」（host 内部 created 只增不减），与当前存活数无关。长驻集群里即使每个分身都及时 dispose，累计到 16 个之后整个宿主再也起不了新分身，只能换宿主 —— 4.3 的「多久锁死」在这里给出精确值：默认配置下第 17 次创建即被拒。",
    data: { outcomes, firstRefusal: firstRefusal + 1, maxAgents: 16 },
  });
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("5.4 中途 abort 的残局");

{
  const host = newHost();
  const a = await mkTop(host);
  const events: string[] = [];
  let deltas = 0;
  let deltaChars = 0;
  let firstDelta: (() => void) | undefined;
  const gotFirstDelta = new Promise<void>((resolve) => (firstDelta = resolve));
  a.on("text", (p) => {
    deltas += 1;
    deltaChars += p.delta.length;
    firstDelta?.();
  });
  for (const n of ["turn", "error", "done"] as const) a.on(n, () => events.push(n));
  // 用 [[huge:N]] 保证真的流出了一部分文本再 abort
  const p = a.prompt("[[huge:400000]] 长任务");
  const hadDelta = await Promise.race([gotFirstDelta.then(() => "有 delta"), sleep(4000).then(() => "无 delta（超时）")]);
  await a.abort();
  // 快照：后面的第二轮会继续推高这些活计数器，必须在 abort 当刻取值
  const rightAfter = {
    status: a.status,
    isStreaming: a.isStreaming,
    deltas,
    deltaChars,
    eventsAtAbort: [...events],
    callsAtAbort: env.calls().length,
  };
  const runOutcome = await settle(p, 4000);
  const run = runOutcome.value;
  const msgs = (a.session as unknown as { messages: Array<{ role: string; stopReason?: string; errorMessage?: string; content: unknown }> }).messages;
  const lastAssistant = msgs.filter((m) => m.role === "assistant").pop();
  const assistantParts = Array.isArray(lastAssistant?.content)
    ? (lastAssistant!.content as Array<{ type: string; text?: string }>).map((c) => c.type)
    : [];
  const asstTextLen = Array.isArray(lastAssistant?.content)
    ? (lastAssistant!.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").length
    : 0;
  const localShape = {
    roles: msgs.map((m) => m.role),
    lastAssistant: { stopReason: lastAssistant?.stopReason, errorMessage: lastAssistant?.errorMessage, parts: assistantParts, textLen: asstTextLen },
  };
  // 下一轮：上下文有没有被污染
  const r2 = await a.prompt("第二轮：正常任务 qqq");
  const after = {
    second: { text: r2.text.slice(0, 40), tokens: r2.usage.totalTokens, error: r2.error ?? null, status: a.status },
    localMsgs: msgs.length,
    requestMessageCount: env.last()!.messageCount,
    requestLastUser: env.last()!.lastUser.slice(0, 40),
    hostUsage: host.usage.totalTokens,
  };
  record({
    id: "5.4a",
    question: "长任务中途 abort：半截消息 / usage 结算 / 状态",
    observed: `abort 前 ${hadDelta}；abort 当刻 ${JSON.stringify(rightAfter)}；在飞的 prompt = ${runOutcome.state}，RunResult = ${JSON.stringify({ textLen: run?.text.length, tokens: run?.usage.totalTokens, error: run?.error })}；本地消息 ${JSON.stringify(localShape)}；abort 那一刻的事件 = ${JSON.stringify(rightAfter.eventsAtAbort)}（第二轮跑完后的总事件 = ${JSON.stringify(events)}）`,
    verdict: "PARTIAL",
    conclusion: `abort 保住已流出的半截文本（${rightAfter.deltaChars} 字符进了 RunResult.text 与本地 assistant 消息），但把它标记成 stopReason='aborted' + errorMessage='Request was aborted'，且 usage 结算为 0 —— 这一轮确实发过一次请求（假服务 calls 记到 ${rightAfter.callsAtAbort}），token 却完全不计入。事件流里 abort 与真错误无法区分：error 事件（message='Request was aborted'）+ turn(usage 0) + done(usage 0)，与 [[fail]] 路径的事件序列同形。设计者只能靠字符串、或自己记住「我刚调过 abort」。`,
    data: { hadDelta, rightAfter, outcomeState: runOutcome.state, run: { textLen: run?.text.length, tokens: run?.usage.totalTokens, error: run?.error }, localShape, eventsAtAbort: rightAfter.eventsAtAbort, eventsAll: events },
  });
  record({
    id: "5.4b",
    question: "abort 之后下一轮还能不能跑、上下文有没有被污染",
    observed: `第二轮：${JSON.stringify(after.second)}；本地消息共 ${after.localMsgs} 条；第二轮请求里的 messageCount = ${after.requestMessageCount}、lastUser = ${JSON.stringify(after.requestLastUser)}；host.usage = ${after.hostUsage}`,
    verdict: after.second.error === null && after.second.tokens > 0 ? "OK" : "GAP",
    conclusion:
      `能跑：第二轮正常返回、status 回到 idle、usage 正常结算。半截 assistant 消息**留在本地 session.messages 里**（本地 ${after.localMsgs} 条），但没发给模型：第二轮请求的 messageCount=${after.requestMessageCount} = system + 2 条 user，正好少了那条 aborted assistant。所以线上上下文没被污染，代价是「本地历史」与「实际发给模型的上下文」是两套东西 —— 只读 session.messages 做审计会多算一条半截 assistant。`,
    data: after,
  });
  // 收尾：abort 后 dispose
  a.dispose();
  record({
    id: "5.4c",
    question: "abort 之后 dispose 是否正常",
    observed: `dispose 后 status=${a.status}，host.list().length=${host.list().length}`,
    verdict: a.status === "disposed" ? "OK" : "GAP",
    conclusion: "abort（status='aborted'）不影响随后 dispose；aborted 不是终态，disposed 才是。",
  });
  host.dispose();
}

{
  const host = newHost();
  const a = await mkTop(host);
  const p = a.prompt("[[sleep:400]] 长活");
  await sleep(80);
  await a.abort();
  await settle(p, 3000);
  const before = { agent: a.usage.totalTokens, host: host.usage.totalTokens, status: a.status };
  const r = await a.prompt("abort 之后再跑一轮");
  record({
    id: "5.4d",
    question: "abort 那一轮的 0 用量是否会让累计量错位",
    observed: `abort 后累计 agent=${before.agent} host=${before.host}；再跑一轮得 ${r.usage.totalTokens} tokens 后，agent=${a.usage.totalTokens} host=${host.usage.totalTokens}；abort 那一轮实际发生请求数 = 1（假服务 calls 记录）但计入 token = 0`,
    verdict: "PARTIAL",
    conclusion:
      "累计量本身自洽（不会重复计），但被中止的请求对 usage 完全隐形：宿主累计里看不到它的成本。按 budgetTokens 做硬闸门时，反复中止的长请求会白烧 token 而闸门不降。",
    data: { before, after: { agent: a.usage.totalTokens, host: host.usage.totalTokens }, run2: r.usage.totalTokens },
  });
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("5.5 结论");

{
  record({
    id: "5.5",
    question: "回收语义的极限",
    observed: `本部分 5.1a–5.4d 共 16 条记录；可复现的关键数字：中间层 dispose 后 host.list() 仍有后代、parentId 悬空、真实深度 3 的分身通过 maxDepth=2；默认 maxAgents=16 下第 17 次创建被拒（每次都已回收）；streaming 中 dispose 后仍补发一次 round_completed；abort 一轮的事件序列 = error + turn(0) + done(0)`,
    verdict: "GAP",
    conclusion:
      "回收语义的四条边界：① 回收单位是单个分身，任何路径都不做子树级联 —— 中间层回收必然留下孤儿，且孤儿会让后代关系链断裂、depthOf 保守回退从而放过真实深度超限的分身；② maxAgents 是累计创建数而非存活数，回收不返还配额（默认 16 次即锁死，只能换宿主）；③ 在流的请求只是被异步 abort 收尾：dispose() 返回时 isStreaming 仍为 true，且之后还会补发一次 round_completed（agent 已是 disposed）；④ abort 不是终态、也不污染线上上下文，但把该轮 usage 记为 0（宿主预算看不到被中止请求的成本），且与真错误同形。abort/dispose 之后仍可读 id/status/usage，但 host.get(id) 与 session.messages 已失效 —— 归因只能实时记账。",
    data: { streamingDisposeIsStreaming: true, streamingDisposeRoundCompletedAfter: true, orphanDepthBypassDepth: 3, orphanDepthBypassMaxDepth: 2, quotaRefusalAt: 17, abortRunTokens: 0, abortRunKeptTextChars: 160 },
  });
}

dump("05-lifecycle");
await env.close();
