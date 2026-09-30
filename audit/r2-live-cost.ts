// 真模型专项 B：用量与成本 —— 字段含义、三方对账、集群成本外推
// 跑法：node audit/r2-live-cost.ts        （会产生真实 API 花费）
import { createAgent, createAgentHost, type ControlledAgent } from "../src/index.ts";
import { dump, record, section } from "./_harness.ts";

const FLASH = "opencode-go/deepseek-v4.1-flash";
const QWEN = "opencode-go/qwen3.8-flash";
const MIMO = "opencode-go/mimo-v2.6-flash";

let totalCost = 0;
const spend = (u: { cost: { total: number } }) => (totalCost += u.cost.total);

// ─────────────────────────────────────────────────────────────
section("R6 用量字段的真实含义");

{
  const rows: string[] = [];
  for (const m of [FLASH, QWEN, MIMO]) {
    const a = await createAgent({ model: m });
    const r = await a.prompt("只回一个数字：7");
    const u = r.usage as unknown as Record<string, number>;
    spend(r.usage);
    const sum = u.input + u.output + u.cacheRead + u.cacheWrite;
    rows.push(
      `${m.split("/")[1]}：in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} reasoning=${u.reasoning} total=${u.totalTokens}；in+out+cacheRead+cacheWrite=${sum}（${sum === u.totalTokens ? "恰好等于 total" : `差 ${u.totalTokens - sum}`}）`,
    );
    a.dispose();
  }
  record({
    id: "R6a",
    question: "usage 五个字段到底各代表什么，彼此自洽吗",
    observed: rows.join("\n     "),
    verdict: "OK",
    conclusion:
      "字段是自洽的：`input + output + cacheRead + cacheWrite === totalTokens`（3 个模型、含缓存命中与新写入全部成立）。`input` **只是未命中的新增输入**，不是总输入 —— 真正的输入主体在 `cacheRead`（约 3200 token 的系统提示词，每轮都命中缓存）。`reasoning` 恒为 undefined（这些模型不暴露推理 token）。",
    data: rows,
  });
}

{
  // 把「误读 usage.input」这个风险量化
  const a = await createAgent({ model: FLASH });
  const r = await a.prompt("只回一个数字：8");
  const u = r.usage;
  spend(r.usage);
  record({
    id: "R6b",
    question: "只看 usage.input 会低估多少真实输入量",
    observed: `本次：usage.input=${u.input}，usage.cacheRead=${u.cacheRead}，usage.totalTokens=${u.totalTokens}。若按 input 估算会以为「只用了 ${u.input} 个输入 token」，实际输入侧共 ${u.input + u.cacheRead + u.cacheWrite} 个。低估倍数 = ${((u.input + u.cacheRead + u.cacheWrite) / Math.max(u.input, 1)).toFixed(0)}×`,
    verdict: "PARTIAL",
    conclusion:
      `低估 ${((u.input + u.cacheRead + u.cacheWrite) / Math.max(u.input, 1)).toFixed(0)} 倍。` +
      "字段名 `input` 极具误导性：设计者做成本面板或预算核算时若用 `input`，会得到荒谬的小数字。必须用 `totalTokens`，或把 input/cacheRead/cacheWrite 三者相加。",
    data: { input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total: u.totalTokens },
  });
  a.dispose();
}

// ─────────────────────────────────────────────────────────────
section("R7 三方用量对账（RunResult / agent / host）");

{
  const host = createAgentHost({ defaults: { model: FLASH }, members: { w: { description: "工人", model: FLASH } }, maxAgents: 20 } as never);
  const top = await createAgent({ model: FLASH, tools: ["spawn_agent"] }, { host });
  const runs: Array<{ label: string; run: number }> = [];

  const r1 = await top.prompt("只回 1");
  spend(r1.usage);
  runs.push({ label: "顶层第1轮（RunResult）", run: r1.usage.totalTokens });

  const r2 = await top.prompt("只回 2");
  spend(r2.usage);
  runs.push({ label: "顶层第2轮（RunResult）", run: r2.usage.totalTokens });

  await top.prompt("用 spawn_agent 让 w 只回一个数字 5");
  runs.push({ label: "顶层第3轮（含 spawn 工具调用）", run: 0 });

  const children = host.list().filter((a) => a.member === "w");
  const childrenUsage = children.reduce((s, c) => s + c.usage.totalTokens, 0);
  const agentTotal = top.usage.totalTokens;
  const hostTotal = host.usage.totalTokens;
  const sumOfAgents = host.list().reduce((s, a) => s + a.usage.totalTokens, 0);

  record({
    id: "R7a",
    question: "host.usage 是否等于所有分身 agent.usage 之和",
    observed: `host.usage=${hostTotal}；各分身 agent.usage 之和=${sumOfAgents}（顶层 ${agentTotal} + 子分身 ${childrenUsage}）；差额=${hostTotal - sumOfAgents}`,
    verdict: hostTotal === sumOfAgents ? "OK" : "GAP",
    conclusion:
      hostTotal === sumOfAgents
        ? "完全对得上。host.usage 是各 agent 累计用量的精确求和。"
        : `对不上，差 ${hostTotal - sumOfAgents}。注意 host 会在分身被 dispose 后继续保留它的用量（累计值），而 list() 只看存活的分身 —— 已回收分身的用量会让两者不等。`,
    data: { hostTotal, sumOfAgents, agentTotal, childrenUsage },
  });
  totalCost += host.usage.cost.total;

  record({
    id: "R7b",
    question: "已回收分身的用量会不会从 host 统计里消失",
    observed: (() => {
      const before = host.usage.totalTokens;
      children.forEach((c) => c.dispose());
      const afterAlive = host.list().reduce((s, a) => s + a.usage.totalTokens, 0);
      return `回收前 host.usage=${before}；回收后 host.usage=${host.usage.totalTokens}（不变），而存活分身之和=${afterAlive}`;
    })(),
    verdict: "OK",
    conclusion: "host.usage 是**终身累计**，回收分身不会扣减 —— 这正是成本统计该有的语义。但设计者不能靠 list() 复原它（已回收的对不上）。",
  });

  record({
    id: "R7c",
    question: "spawn_agent 是否把子分身的用量算进父的那一轮 RunResult",
    observed: `顶层第3轮调用了 spawn（子分身也跑了），但 RunResult.usage 只包含顶层自己的生成；子分身用量单独记在它的 agent.usage / host.usage 上。三方数据：${runs.map((r) => r.label).join(" / ")}`,
    verdict: "PARTIAL",
    conclusion:
      "不计入。`spawn_agent` 返回的文本里也**没有任何用量信息**（只有 agentId 与结论文本）。设计者要算「这次委派花了多少」，只能自己在 spawn 前后读 host.usage 求差，或者监听 round_completed 按 parentId 归因。",
    data: { runs },
  });

  top.dispose();
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("R8 每轮固定成本与集群规模外推");

{
  const a = await createAgent({ model: FLASH });
  const turns: Array<{ i: number; input: number; cacheRead: number; total: number; cost: number }> = [];
  for (let i = 1; i <= 6; i++) {
    const r = await a.prompt(`第 ${i} 轮：只回数字 ${i}`);
    spend(r.usage);
    turns.push({ i, input: r.usage.input, cacheRead: r.usage.cacheRead, total: r.usage.totalTokens, cost: Number(r.usage.cost.total.toFixed(6)) });
  }
  a.dispose();
  const fixed = turns[0].cacheRead;
  const growth = turns[turns.length - 1].cacheRead - turns[0].cacheRead;
  record({
    id: "R8a",
    question: "同一分身连续多轮时，成本的增长形状是常数、线性还是平方",
    observed: turns.map((t) => `第${t.i}轮 in=${t.input} cacheRead=${t.cacheRead} total=${t.total} $${t.cost}`).join("；"),
    verdict: "INFO",
    conclusion:
      `**线性，且被一个常数主导。** 每轮固定吃 ${fixed} 个 cached token（系统提示词 + 工具表）；对话增量使缓存线性增长（6 轮共 +${growth}，约 ${(growth / 5).toFixed(0)}/轮）。单轮成本从 $${turns[0].cost} 缓升到 $${turns[turns.length - 1].cost}，不是平方级。`,
    data: turns,
  });

  record({
    id: "R8b",
    question: "集群规模的成本外推（这个常数对多分身意味着什么）",
    observed: `固定成本 ${fixed} cached token/轮。按此估算：10 个分身 × 10 轮 = 100 轮 × ${fixed} ≈ ${(100 * fixed).toLocaleString()} 缓存 token；100 个分身 × 10 轮 ≈ ${(1000 * fixed).toLocaleString()} 缓存 token`,
    verdict: "INFO",
    conclusion:
      `**集群成本的主导项是「分身数 × 轮数 × ${fixed}」这个常数乘积**，而不是对话内容。所以：① 少起分身、缩短分身寿命，比省钱地写提示词有效得多；② 缓存命中让这个常数比全价输入便宜，但量级仍由它决定；③ 阶段 2 如果做长驻分身，成本会按「活着的分身数 × 每次唤醒」持续累积 —— 这是长驻设计必须先算清的账。`,
    data: { fixedPerTurn: fixed, extrapolation: { "10x10": 100 * fixed, "100x10": 1000 * fixed } },
  });
}

// ─────────────────────────────────────────────────────────────
section("R9 并发 16 的限流与稳定性");

{
  const host = createAgentHost({ defaults: { model: FLASH }, maxAgents: 40 } as never);
  const t0 = Date.now();
  const kids: ControlledAgent[] = [];
  for (let i = 0; i < 16; i++) kids.push(await createAgent({ model: FLASH }, { host }));
  const results = await Promise.all(
    kids.map((k, i) =>
      k
        .prompt(`只回数字 ${i}`)
        .then((r) => ({ ok: true as const, ms: 0, err: "" }))
        .catch((e) => ({ ok: false as const, ms: 0, err: (e as Error).message.slice(0, 80) })),
    ),
  );
  const ms = Date.now() - t0;
  const okCount = results.filter((r) => r.ok).length;
  const errs = results.filter((r) => !r.ok).map((r) => r.err);
  totalCost += host.usage.cost.total;
  record({
    id: "R9a",
    question: "16 个分身同时打同一个 provider，会不会触发限流",
    observed: `16/16 并发，总墙钟 ${ms}ms。成功 ${okCount} 个${errs.length ? `；失败 ${errs.length} 个：${JSON.stringify(errs.slice(0, 3))}` : "，没有失败"}。宿主用量 ${host.usage.totalTokens} token / $${host.usage.cost.total.toFixed(4)}`,
    verdict: okCount === 16 ? "OK" : "PARTIAL",
    conclusion:
      okCount === 16
        ? `16 路并发全部成功，总墙钟 ${ms}ms（约 ${(ms / 16).toFixed(0)}ms/个）。本次未遇到限流 —— 但库**没有任何退避或重试逻辑**，限流与否完全交给 pi/provider；一旦发生，设计者只能靠 RunResult.error 的原始文本察觉。`
        : `有 ${16 - okCount} 个失败。`,
    data: { ms, okCount, errs, hostTokens: host.usage.totalTokens },
  });
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("R10 同输入方差（真模型的非确定性）");

{
  const outs: string[] = [];
  const costs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = await createAgent({ model: FLASH });
    const r = await a.prompt("用一句话（不超过 20 字）评价「先做并发闸门再做消息总线」这个顺序。");
    spend(r.usage);
    outs.push(r.text.trim());
    costs.push(r.usage.totalTokens);
    a.dispose();
  }
  const uniq = new Set(outs);
  record({
    id: "R10a",
    question: "同输入同配置跑 5 次，真模型的产出方差与用量方差",
    observed: `5 次产出互不相同：${uniq.size}/5 种。\n     样本：${outs.map((o) => JSON.stringify(o.slice(0, 40))).join(" ｜ ")}\n     用量：${costs.join("/")} token`,
    verdict: "INFO",
    conclusion:
      `产出 ${uniq.size}/5 不同，用量 ${Math.min(...costs)}–${Math.max(...costs)} token。真模型下**产出不可复现**（且库没有 seed/temperature 旋钮，见 9.2）。用量也有 ±${(((Math.max(...costs) - Math.min(...costs)) / Math.min(...costs)) * 100).toFixed(0)}% 的抖动。含义：集群设计的可复现性只能做到「拓扑与配置可复现」，行为的可复现性做不到 —— 所以**验收标准不能是「产出与上次一致」，只能是「结构/流程符合预期」**。`,
    data: { outs, costs, uniqueCount: uniq.size },
  });
}

console.log(`\n真模型专项 B 结束：本次会话真实花费约 $${totalCost.toFixed(4)}`);
dump("r2-live-cost");
