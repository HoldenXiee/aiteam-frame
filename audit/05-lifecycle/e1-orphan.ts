// 5.1 孤儿路径全测：中间层 dispose 之后，后代变成了什么。
// 跑法：cd /d/space/aiteam/test && node audit/05-lifecycle/e1-orphan.ts
import type { AgentHost, ControlledAgent } from "../../src/index.ts";
import {
  alive, callSend, callSpawn, descendantCount, dumpTo, exportTopology, record, section, settle, setup, sleep,
  topoSummary, type TopoRow,
} from "./h.ts";

const ctx = await setup();
const { env } = ctx;
/** 审计侧的真值登记表：所有创建过的分身（含已回收）—— 设计者不会有这个 */
const registry = new Map<string, ControlledAgent>();
const spawn = async (host: AgentHost, parent: ControlledAgent | undefined, member = "w") => {
  const a = parent ? await ctx.mkChild(host, parent, member) : await ctx.mkTop(host);
  registry.set(a.id, a);
  return a;
};
const rows = (host: AgentHost): TopoRow[] => exportTopology(host, registry);
const snap = (a: ControlledAgent, host: AgentHost) => ({
  id: a.id, status: alive(() => a.status), isStreaming: alive(() => a.isStreaming),
  inList: host.list().some((x) => x.id === a.id), parentId: a.parentId,
  hostGetSelf: host.get(a.id)?.id ?? null,
});

section("5.1-1 孤儿是否还活着：prompt / send / steer / 事件 / spawn");
{
  const host = ctx.host({ maxDepth: 2 });
  const top = await spawn(host, undefined);
  const mid = await spawn(host, top);
  const leaf = await spawn(host, mid);
  await Promise.all([top.prompt("t"), mid.prompt("m"), leaf.prompt("l")]);

  const before = { list: host.list().map((a) => a.id), topo: topoSummary(rows(host)), hostUsage: host.usage.totalTokens };
  mid.dispose();

  const after = {
    list: host.list().map((a) => a.id),
    activeCount: host.activeCount,
    midGet: host.get(mid.id)?.id ?? null,
    midStatus: mid.status,
    leafInList: host.list().some((a) => a.id === leaf.id),
    leafGet: host.get(leaf.id)?.id ?? null,
    leafParentId: leaf.parentId,
    leafParentResolves: host.get(leaf.parentId!)?.id ?? null,
    leafStatus: leaf.status,
  };

  // 孤儿还能不能干活
  const work: Record<string, unknown> = {};
  work.prompt = await settle(leaf.prompt("孤儿自己跑一轮").then((r) => ({ text: r.text.slice(0, 30), tokens: r.usage.totalTokens })));
  work.send = await settle(leaf.send("孤儿再投一条"));
  work.steer = await settle(leaf.steer("改个方向").then(() => "no-throw"));
  work.waitForIdle = await settle(leaf.waitForIdle().then(() => "no-throw"));
  work.usageReadable = alive(() => leaf.usage.totalTokens);
  const hostUsageAfter = host.usage.totalTokens;

  // 孤儿还能不能继续 spawn（真实深度 3，maxDepth=2）
  const s = await callSpawn(leaf, host, "w", "再下一层");
  const child = s.agentId ? host.get(s.agentId) : undefined;
  if (child) registry.set(child.id, child);

  record({
    id: "5.1.1",
    question: "mid.dispose() 之后，后代 leaf 是否还活着、还能不能 prompt/send/steer/spawn",
    observed: `建链时 ${JSON.stringify(before.list)}，真实深度 top=0 mid=1 leaf=2；dispose(mid) 后 list=${JSON.stringify(after.list)} activeCount=${after.activeCount} host.get(mid)=${after.midGet} mid.status=${after.midStatus}；leaf 仍在 list=${after.leafInList} host.get(leaf)=${after.leafGet} leaf.parentId=${after.leafParentId} 该 id 在宿主里=${after.leafParentResolves} leaf.status=${after.leafStatus}；孤儿干活 = ${JSON.stringify(work)}；host.usage 从 ${before.hostUsage} 涨到 ${hostUsageAfter}（孤儿跑的一轮照常计入宿主）；孤儿 spawn = ${JSON.stringify({ text: s.text.slice(0, 40), newId: s.agentId, listLen: s.listLen })}`,
    verdict: "GAP",
    conclusion:
      "孤儿完全可用：status 仍是 idle、prompt/send/steer/waitForIdle 全部正常、跑出的用量照常进 host.usage，还能继续 spawn 出下一代。回收父级对子级没有任何可见影响 —— 「已回收」只写在那一个对象上（mid.status='disposed'），宿主里没有任何墓碑/代数记录能让后代知道自己已经失去祖先。",
    data: { before, after, work, hostUsageAfter, spawned: { text: s.text.slice(0, 80), newId: s.agentId, listLen: s.listLen } },
  });

  // ── 深度护栏被静默绕过 ──
  const trueDepth = child ? rows(host).find((r) => r.id === child.id)!.trueDepth : -1;
  record({
    id: "5.1.2",
    question: "孤儿 spawn 时 depthOf() 会算出什么？maxDepth=2 还拦得住吗",
    observed: `孤儿 leaf（真实深度 2）经 spawn_agent 起了 ${child?.id}（真实深度 ${trueDepth}），工具返回 = ${JSON.stringify(s.text.slice(0, 80))}；host.maxDepth=${host.maxDepth}；导出侧深度 = ${JSON.stringify(rows(host).filter((r) => r.id === child?.id).map((r) => ({ exported: r.exportedDepth, true: r.trueDepth })))}`,
    verdict: "GAP",
    conclusion:
      `depthOf() 走到 leaf.parentId=mid 时 host.get(mid)=undefined，直接 return depth+1=1 —— 于是「真实深度 2 的孤儿」被当成深度 1，checkCanCreate 算出 2 并不 > maxDepth=2，放行，真实深度 ${trueDepth} 的分身被建了出来。护栏计算的深度与真实深度永久不同步，maxDepth 在中间层被回收后就不可信。`,
    data: { childId: child?.id, trueDepth, maxDepth: host.maxDepth, toolText: s.text.slice(0, 120) },
  });

  // ── 拓扑导出变形 ──
  const all = rows(host);
  const summary = topoSummary(all);
  record({
    id: "5.1.3",
    question: "孤儿在「list()+parentId」拓扑导出里会变成什么",
    observed: `节点 ${summary.nodes} 个：${JSON.stringify(all.map((r) => ({ id: r.id, parentId: r.parentId, exportedParent: r.exportedParent, isRoot: r.isRoot, exportedDepth: r.exportedDepth, trueDepth: r.trueDepth })))}；汇总 = ${JSON.stringify(summary)}`,
    verdict: "GAP",
    conclusion:
      `${summary.rootsWithParentId} 个节点（mid 的所有后代）在导出里变成「根」——parentId 字段还在，但 host.get(parentId) 返回 undefined，任何走 host.get 的导出器都会把它们当作顶层。导出深度 ${summary.maxExportedDepth} vs 真实深度 ${summary.maxTrueDepth}，${summary.depthMismatch.length} 个节点深度错（${JSON.stringify(summary.depthMismatch)}）。变形不可逆：导出物里既没有 mid 这个节点，也没有它的墓碑，孤儿链断点与「本来就没有父」无法区分。`,
    data: { rows: all, summary },
  });

  // ── 谁能找到孤儿 / 谁找不到 ──
  const topSendLeaf = await callSend(top, host, leaf.id, "顶层投给孙代");
  const topSendChild = await callSend(top, host, child!.id, "顶层投给曾孙代");
  const leafSendChild = await callSend(leaf, host, child!.id, "孤儿投给自己的儿子");
  record({
    id: "5.1.4",
    question: "孤儿还能被谁寻址？祖先的 send_message 还能不能投到它",
    observed: `host.get(leaf.id) = ${host.get(leaf.id)?.id ?? null}；host.get 是唯一还认孤儿的入口。top→leaf：${JSON.stringify(topSendLeaf)}；top→${child!.id}（曾孙）：${JSON.stringify(topSendChild)}；leaf→${child!.id}：${JSON.stringify(leafSendChild)}；02-topology 同款 descendantCount(top)=${descendantCount(host, top)}、descendantCount(leaf)=${descendantCount(host, leaf)}、descendantCount(mid 已回收)=${descendantCount(host, mid)}`,
    verdict: "GAP",
    conclusion:
      "孤儿按 id 直接寻址仍然有效（host.get 命中，list() 里也在），但**祖先视角的整棵子树消失了**：top 给 leaf 投递被拒（报「不是你的后代」，与事实相反），连 leaf 的儿子也投不到；只有孤儿自己还能投给自己的儿子。descendantCount(top) 也只有 0（top 的两个真实位置后代都算不到）。所以「ids 能寻址」≠「拓扑能寻址」：一旦中间层被回收，祖先的寻址范围被永久截断，而这个错误以「不是你的后代」这种**事实错误的报错**呈现 —— 最容易被误诊为「我记错 id 了」。",
    data: { getLeaf: host.get(leaf.id)?.id ?? null, topSendLeaf, topSendChild, leafSendChild, descTop: descendantCount(host, top), descLeaf: descendantCount(host, leaf) },
  });

  // ── 重复循环：每次「dispose 当前孤儿的父级 → 该孤儿 spawn 一层」能否无限加深 ──
  // 前置：a4 的父（leaf）还在，所以 a4 此刻 depthOf=2、spawn 会被拦；先把 leaf dispose 掉，
  // 让 a4 的「直接父」缺失（depthOf 返回 1），循环才能继续。
  leaf.dispose();
  let cur = child!;
  const chain: Array<{ step: number; spawner: string; spawnee: string; trueDepth: number; refused: boolean; disposedAfter: string }> = [];
  for (let i = 0; i < 6; i++) {
    const spawner = cur;
    const res = await callSpawn(spawner, host, "w", `第 ${i + 1} 次越层`);
    const next = res.agentId ? host.get(res.agentId) : undefined;
    if (next) registry.set(next.id, next);
    chain.push({
      step: i + 1,
      spawner: spawner.id,
      spawnee: res.agentId ?? "(未创建)",
      trueDepth: next ? rows(host).find((r) => r.id === next.id)!.trueDepth : -1,
      refused: res.text.includes("不能再起分身"),
      disposedAfter: spawner.id,
    });
    spawner.dispose(); // 让下一环的「直接父」缺失，depthOf 于是返回 1
    cur = next ?? spawner;
  }
  const deepest = rows(host).sort((a, b) => b.trueDepth - a.trueDepth)[0];
  const deepestSpawn = await callSpawn(cur, host, "w", "再试一层");
  record({
    id: "5.1.5",
    question: "「dispose 当前孤儿的直接父 → 该孤儿起一层」循环重复 N 次，maxDepth=2 能挡到第几层",
    observed: `每轮：孤儿 spawner 先经 spawn_agent 起一层（允许），紧接把 spawner 自己 dispose 掉（于是下一环的直接父缺失）：${JSON.stringify(chain)}；最终 ${deepest.trueDepth} 层深的 ${deepest.id} 再 spawn 一次 = ${JSON.stringify(deepestSpawn.text.slice(0, 70))}（新分身 id=${deepestSpawn.agentId}）；host.list() 现有 ${host.list().length} 个、activeCount=${host.activeCount}；6 轮里被护栏拒绝次数 = ${chain.filter((c) => c.refused).length}`,
    verdict: "GAP",
    conclusion:
      `护栏一次都没拦（拒绝 0 次），真实深度从 3 一路涨到 ${deepest.trueDepth}（6 轮循环每轮 +1 层）。原理：depthOf 只在「直接父不在 map」时返回 1，于是只要保证 spawner 的直接父缺失，它的 spawn 就永远算作深度 2（=maxDepth 边界）；spawner 起完一层后自己 dispose，下一环的直接父就又缺失了。代价是每层多付一次 dispose，且每层都留下一个永久孤儿。注意这是有条件的：链条完好时护栏正常（最后一行的深度 3 请求被正确拒绝）—— 失效只在「曾经 dispose 过中间层」之后发生。`,
    data: { chain, deepest: { id: deepest.id, trueDepth: deepest.trueDepth }, deepestSpawn: deepestSpawn.text.slice(0, 80), listLen: host.list().length, refusals: chain.filter((c) => c.refused).length },
  });

  // ── host.dispose() 能否清掉孤儿 ──
  const orphans = host.list().map((a) => a.id);
  host.dispose();
  await sleep(100);
  record({
    id: "5.1.6",
    question: "孤儿会不会被 host.dispose() 清掉（谁唯一能回收它）",
    observed: `host.dispose() 前 list=${JSON.stringify(orphans)}；dispose 后 list.length=${host.list().length} activeCount=${host.activeCount}；各孤儿 status=${JSON.stringify(orphans.map((id) => `${id}:${registry.get(id)?.status}`))}；二次 host.dispose() = ${alive(() => { host.dispose(); return "no-throw"; })}`,
    verdict: "OK",
    conclusion:
      "能。host.dispose() 遍历的是 map（孤儿一直在 map 里），所以孤儿同样被清干净；agent 逐个 status='disposed'，list() 归零，二次调用不抛错。这是唯一能自动回收孤儿的路径 —— 但代价是整宿主一起清，没有「回收某棵子树」的 API。",
    data: { before: orphans, afterList: host.list().length, statuses: orphans.map((id) => registry.get(id)!.status), doubleHostDispose: "no-throw" },
  });

  // 收尾：孤儿 dispose 后的可读性（归因需要提前留引用）
  record({
    id: "5.1.7",
    question: "孤儿被回收后还能读到什么",
    observed: `leaf（孤儿）在 host.dispose 之后：status=${leaf.status} usage=${alive(() => leaf.usage.totalTokens)} parentId=${leaf.parentId} host.get=${host.get(leaf.id)?.id ?? null} session.messages.length=${alive(() => (leaf.session as unknown as { messages: unknown[] }).messages.length)}`,
    verdict: "PARTIAL",
    conclusion:
      "只剩对象引用上的字段（id/status/usage/parentId/member）与仍保留的 session.messages（本例 8 条：dispose 不等于清历史，取决于走的是同步 session.dispose 还是先 abort 的异步路径）；host.get 返回 undefined。孤儿问题一旦发生，事后无法从宿主重建历史 —— 只能在 agent_created/agent_disposed 事件里实时记账。",
    data: { status: leaf.status, usage: leaf.usage.totalTokens, parentId: leaf.parentId, sessionMessages: (leaf.session as unknown as { messages: unknown[] }).messages.length },
  });
}

section("5.1-2 孤儿产生的时机：哪些回收路径会留下孤儿");
{
  // 逐条验证「谁被回收 → 谁变孤儿」
  const out: unknown[] = [];
  {
    const host = ctx.host();
    const top = await spawn(host, undefined);
    const mid = await spawn(host, top);
    const leaf = await spawn(host, mid);
    const before = { list: host.list().map((a) => a.id) };
    mid.dispose();
    out.push({ name: "idle dispose 中间层", before, after: host.list().map((a) => a.id), orphaned: [leaf.id], leafParentId: leaf.parentId, leafStatus: leaf.status });
    host.dispose();
  }
  {
    const host = ctx.host();
    const top = await spawn(host, undefined);
    const mid = await spawn(host, top);
    const leaf = await spawn(host, mid);
    const p = mid.prompt("[[sleep:400]] 忙活");
    await sleep(80);
    mid.dispose(); // 跑着时 dispose 中间层
    await settle(p, 3000);
    await sleep(300);
    out.push({ name: "streaming 中 dispose 中间层", after: host.list().map((a) => a.id), orphaned: [leaf.id], leafParentId: leaf.parentId, midStatus: mid.status, midIsStreaming: mid.isStreaming, leafUsable: (await settle(leaf.prompt("孤儿还行不行"))).state });
    host.dispose();
  }
  {
    const host = ctx.host();
    const top = await spawn(host, undefined);
    const mid = await spawn(host, top);
    const leaf = await spawn(host, mid);
    const p = mid.prompt("[[sleep:400]] 忙活");
    await sleep(80);
    await mid.abort();
    await settle(p, 3000);
    const statusAfterAbort = mid.status;
    mid.dispose();
    out.push({ name: "abort 之后 dispose 中间层", statusAfterAbort, after: host.list().map((a) => a.id), orphaned: [leaf.id], leafParentId: leaf.parentId });
    host.dispose();
  }
  {
    const host = ctx.host();
    const top = await spawn(host, undefined);
    const mid = await spawn(host, top);
    const leaf = await spawn(host, mid);
    top.dispose(); // 回收顶层
    out.push({ name: "dispose 最顶层（不是中间层）", after: host.list().map((a) => a.id), midParentId: mid.parentId, leafParentId: leaf.parentId, note: "mid 与 leaf 都成孤儿，且 mid 仍在列表里" });
    host.dispose();
  }
  record({
    id: "5.1.8",
    question: "每条回收路径各自留下什么（谁被回收 / 谁成孤儿 / 孤儿还能不能用）",
    observed: `四种路径（每例都是 top→mid→leaf 三层）：${JSON.stringify(out, null, 1)}`,
    verdict: "GAP",
    conclusion:
      "任何「非叶子节点」的回收都会留下孤儿，且与它是否正在跑、是否先 abort 无关（dispose 只作用于自己那一个对象）。回收顶层也一样：mid、leaf 双双变孤儿，而 mid 还是「有 parentId 但父已不在」的状态。反向确认了 5.1.1–5.1.5 的结论不是某条路径的特例，而是 dispose 语义本身。",
    data: out,
  });
}

// 收尾核对零成本
record({
  id: "5.1.9",
  question: "本组实验是否真的零 API 花费",
  observed: `假服务收到的请求数 = ${env.calls().length}，模型集合 = ${JSON.stringify([...new Set(env.calls().map((c) => c.model))])}`,
  verdict: "INFO",
  conclusion: "全部走本机假 provider，零真实花费。",
  data: { calls: env.calls().length, models: [...new Set(env.calls().map((c) => c.model))] },
});

const p = dumpTo("e1-orphan", { calls: env.calls().length, models: [...new Set(env.calls().map((c) => c.model))] });
await ctx.close();
console.log(`\n→ ${p}`);
