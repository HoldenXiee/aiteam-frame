// E1-live 真实上下文超限（真模型，产生真实花费）
// 跑法：node audit/24-uncovered/e1-live-overflow.ts
// 选小窗口模型逼出真 provider 的超限错误：openrouter/qwen/qwen-2.5-72b-instruct（声明 ctx=32768）
// 纪律：并发 1；每轮记录 token 与花费。
import { createAgent } from "../../src/index.ts";
import { dump, num, record, script, section } from "./_h.ts";

script("e1-live-overflow");
const MODEL = process.env.LIVE_MODEL ?? "openrouter/qwen/qwen-2.5-72b-instruct";
const NL = "\n";
let cost = 0;
const charge = (c: number) => (cost += c);
// 抓真请求体：用来把「本地 chars/4 估算」与「provider 实报 token」对齐
const origFetch = globalThis.fetch;
const sentBodies: string[] = [];
const sent: Array<{ body: string; stream: boolean }> = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init: unknown) => {
  const b = (init as { body?: unknown } | undefined)?.body;
  if (typeof b === "string") {
    sentBodies.push(b);
    let stream = false;
    try {
      stream = (JSON.parse(b) as { stream?: boolean }).stream === true;
    } catch { /* ignore */ }
    sent.push({ body: b, stream });
  }
  return (origFetch as (u: unknown, i: unknown) => Promise<unknown>)(url, init);
};

const filler = (n: number) => {
  let s = "";
  let seed = 20260101;
  while (s.length < n) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    s += seed.toString(36).padStart(6, "0") + " ";
  }
  return s.slice(0, n);
};
type Agent = Awaited<ReturnType<typeof createAgent>>;
const watch = (a: Agent) => {
  const errors: string[] = [];
  const kinds: string[] = [];
  a.on("error", (p) => {
    errors.push((p as { message: string }).message);
    kinds.push("error");
  });
  for (const n of ["text", "turn", "done"] as const) a.on(n, () => kinds.push(n));
  a.session.subscribe((e) => kinds.push(`raw:${(e as { type: string }).type}`));
  return { errors, kinds };
};

// 先确认这个模型跑得起来
section("E1L0 冒烟");
let base = { tokens: 0, cost: 0 };
{
  const a = await createAgent({ model: MODEL, tools: [] });
  const r = await a.prompt("只回数字 1");
  charge(r.usage.cost.total);
  base = { tokens: r.usage.totalTokens, cost: Number(r.usage.cost.total.toFixed(6)) };
  console.log(`${MODEL}: error=${JSON.stringify(r.error ?? null)} text=${JSON.stringify(r.text.trim())} tok=${r.usage.totalTokens} $${base.cost}`);
  a.dispose();
}

// ── A：单条超大消息（最纯的超限形态）──────────────────────────
section("E1L1 单条超大消息（20 万字符 ≈ 50k token，远超 32768 窗口）");
{
  const a = await createAgent({ model: MODEL, tools: [] });
  const { errors, kinds } = watch(a);
  let threw: string | null = null;
  const res = await a
    .prompt(`请只回答两个字：收到。${NL}${filler(200_000)}`)
    .catch((e: Error) => {
      threw = e.message;
      return null;
    });
  const after = {
    threw,
    runError: res?.error ?? null,
    runText: res?.text ?? null,
    usageTokens: res?.usage.totalTokens ?? null,
    usageCost: res ? Number(res.usage.cost.total.toFixed(6)) : null,
    status: a.status,
    messages: a.session.messages.map((m) => `${m.role}${(m as { errorMessage?: string }).errorMessage ? "(err)" : ""}`),
    errors,
    kinds: [...new Set(kinds)],
  };
  if (res) charge(res.usage.cost.total);
  // 超限之后同一分身还能不能用
  let follow: Record<string, unknown>;
  try {
    const r2 = await a.prompt("只回数字 7");
    charge(r2.usage.cost.total);
    follow = { ok: !r2.error && r2.text.trim() !== "", error: r2.error ?? null, text: r2.text.trim().slice(0, 30), tokens: r2.usage.totalTokens };
  } catch (e) {
    follow = { ok: false, error: `THROW: ${(e as Error).message}`, text: "" };
  }
  record({
    id: "E1L1",
    question: "真 provider 下，单条超大消息超限时设计者能观察到什么；之后分身还能不能用",
    observed:
      `RunResult: ${after.threw ? `prompt() 抛错 ${after.threw}` : `error=${JSON.stringify(after.runError)} text=${JSON.stringify(after.runText)} usage=${JSON.stringify({ tokens: after.usageTokens, cost: after.usageCost })}`}` +
      `${NL}     status=${after.status}；session.messages=${JSON.stringify(after.messages)}；` +
      `${NL}     error 事件=${JSON.stringify(after.errors)}；事件种类=${JSON.stringify(after.kinds)}` +
      `${NL}     超限后同一分身再问一句：${JSON.stringify(follow)}`,
    verdict: after.errors.length ? "PARTIAL" : "GAP",
    conclusion:
      after.errors.length === 0
        ? `真 provider 下这次超限**没有留下任何错误信号**：RunResult.error=${JSON.stringify(after.runError)}、text=${JSON.stringify(after.runText)}、status=${after.status}。设计者除了「没产出」看不出差别。`
        : `超限的**唯一信号是 error 事件**（原文：${JSON.stringify((after.errors[0] ?? "").slice(0, 160))}）；而主返回值 RunResult.error=${JSON.stringify(after.runError)}、text=${JSON.stringify(after.runText)}、usage=${JSON.stringify({ tokens: after.usageTokens, cost: after.usageCost })} —— **与「跑成功但没说话」完全一致**。` +
          `session.messages 里连失败的那条 assistant 消息都被剔除了（${JSON.stringify(after.messages)}）。` +
          `超限后同一分身接着问短问题：${follow.ok ? "正常回答" : `仍然失败（${JSON.stringify(follow.error)}）`}。` ,
    data: { model: MODEL, after, follow },
  });
  a.dispose();
}

// ── B：多轮累积（真实的长会话形态）────────────────────────────
section("E1L2 多轮累积到超限（每轮 +30k 字符），看自动压缩是否出现");
{
  const a = await createAgent({ model: MODEL, tools: [] });
  const { errors, kinds } = watch(a);
  const rounds: Array<Record<string, unknown>> = [];
  const ratios: number[] = [];
  for (let i = 0; i < 7; i++) {
    let row: Record<string, unknown>;
    try {
      const r = await a.prompt(`第 ${i} 轮：${filler(30_000)}${NL}请只回两个字：收到。`);
      charge(r.usage.cost.total);
      const conv = [...sent].reverse().find((x) => x.stream)?.body ?? "";
      const body = conv;
      row = {
        round: i,
        error: r.error ?? null,
        text: r.text.trim().slice(0, 20),
        tokens: r.usage.totalTokens,
        inTokens: r.usage.input + r.usage.cacheRead,
        bodyChars: body.length,
        本地估算tok: Math.ceil(body.length / 4),
        对话请求字符: body.length,
        每token字符: r.usage.input + r.usage.cacheRead > 0 ? Number((body.length / (r.usage.input + r.usage.cacheRead)).toFixed(2)) : null,
        估算偏差: Number((Math.ceil(body.length / 4) / Math.max(r.usage.input + r.usage.cacheRead, 1)).toFixed(3)),
        本轮摘要请求数: sent.filter((x) => !x.stream).length,
        // provider 在错误里报的 input length（token 语义），用来反推「每 token 多少字符」
        报错input长度: (() => { const m = /input length (\d+)/.exec(String(r.error ?? "")); return m ? Number(m[1]) : null; })(),
        cost: Number(r.usage.cost.total.toFixed(6)),
        msgs: a.session.messages.length,
      };
    } catch (e) {
      row = { round: i, error: `THROW: ${(e as Error).message}`, text: "", tokens: 0, cost: 0, msgs: a.session.messages.length };
    }
    const rl = row.报错input长度 as number | null;
    if (rl && (row.对话请求字符 as number) > 0) ratios.push((row.对话请求字符 as number) / rl);
    if (row.inTokens) ratios.push((row.对话请求字符 as number) / (row.inTokens as number));
    rounds.push(row);
  }
  const charPerToken = ratios.length ? Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(2)) : null;
  const maxRatio = charPerToken ? Number((4 / charPerToken).toFixed(2)) : 0;
  record({
    id: "E1L2",
    question: "真模型长会话累积到超限：自动压缩会不会出现，失败以什么形式冒出来",
    observed:
      rounds.map((r) => `轮 ${r.round}: error=${JSON.stringify(r.error)} text=${JSON.stringify(r.text)} tokens=${r.tokens} messages=${r.msgs} 请求体${r.bodyChars}字符/本地估算${r.本地估算tok}tok/provider实报${r.inTokens}tok 估算偏差=${r.估算偏差}× 该轮花费=$${r.cost}`).join(NL + "     ") +
      `${NL}     每轮只统计**对话请求**（stream:true）的 body；摘要请求数另列。error 事件逐条=${JSON.stringify(errors)}`,
    verdict: errors.length === 0 ? "OK" : "PARTIAL",
    conclusion:
      `${errors.length === 0 ? "七轮累积下 provider 一次都没真的拒绝" : `累积过程中有 ${errors.length} 次超限真的冒到了设计者面前`}；` +
      `session.messages 的轨迹=${JSON.stringify(rounds.map((r) => r.msgs))} —— ${JSON.stringify(rounds.map((r) => r.msgs)) === JSON.stringify(rounds.map((_, i) => i * 2 + 3)) ? "单调 +2，**从未回落**，说明自动压缩一次都没执行" : "出现过回落（压缩执行了），但随后的请求体仍在增长 —— 压缩没有真的把上下文压到窗口以内"}。` +
      (charPerToken === null
        ? "**本轮因额度耗尽（402）没能测到 token 换算比例** —— 见下一条的说明。"
        : `**本地估算偏差**：实测 provider 的输入计数 ≈ **${charPerToken} 字符/token**（由每轮对话请求体的字符数除 provider 自报的 input length 得到；成功轮的 usage 也一致），` +
          `而 SDK 的本地估算假设 chars/4 = 4 字符/token → **本地低估约 ${num(maxRatio, 2)} 倍**。所以「本地预检」相对真 provider 是**迟到的**：本地以为还没超，provider 已经拒了。`) +
      `（本轮若某轮 error 是 402，说明 openrouter 余额耗尽，该轮没有 provider 计数可算。）`,
    data: { model: MODEL, rounds, errors, kinds: [...new Set(kinds)], charPerToken, localUnderestimate: maxRatio, ratios: ratios.map((x) => Number(x.toFixed(2))) },
  });
  a.dispose();
}

console.log(`${NL}E1-live 结束：真实花费约 $${cost.toFixed(5)}（模型 ${MODEL}）`);
dump();
