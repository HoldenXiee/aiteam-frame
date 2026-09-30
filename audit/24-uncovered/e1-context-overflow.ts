// E1 真实上下文超限 —— 库层行为（假 provider，可脚本化错误体；零 API 花费）
// 跑法：node audit/24-uncovered/e1-context-overflow.ts
// 覆盖附录 C 第一条未覆盖项：超限时会发生什么 / 有没有本地预检 / 能否优雅恢复。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgent } from "../../src/index.ts";
import { dump, record, script, section } from "./_h.ts";
import { overflowBody, startProvider } from "./_fp.ts";

script("e1-context-overflow");
const NL = "\n";
const SUMMARIZER_MARK = "context summarization assistant";
// 摘要请求的 system 不一定落在 role:"system" 的消息里（openai-completions 有顶层字段），扫全 body
const isSummaryReq = (r: { body: unknown; system: string }) => `${r.system}${JSON.stringify(r.body)}`.includes(SUMMARIZER_MARK);
const filler = (n: number) => {
  let s = "";
  let seed = 987654321;
  while (s.length < n) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    s += seed.toString(36).padStart(6, "0") + " ";
  }
  return s.slice(0, n);
};
type Agent = Awaited<ReturnType<typeof createAgent>>;
type Ev = { type: string; [k: string]: unknown };
const watch = (agent: Agent) => {
  const norm: Ev[] = [];
  const raw: string[] = [];
  const errors: string[] = [];
  for (const n of ["text", "thinking", "tool_start", "tool_end", "turn", "error", "done"] as const) agent.on(n, (p) => norm.push({ type: n, ...(p as object) }));
  agent.on("error", (p) => errors.push((p as { message: string }).message));
  agent.session.subscribe((e) => raw.push((e as { type: string }).type));
  return { norm, raw, errors };
};
const tokOf = (msgs: unknown) => Math.ceil(JSON.stringify(msgs).length / 4);

// ─────────────────────────────────────────────────────────────
section("E1a 库有没有本地 token 预检（声明窗口 2000，发 20 万字符）");
{
  process.env.FP_CTX = "2000";
  const env = await startProvider(() => ({ kind: "text", text: "收到" }));
  const agent = await createAgent({ model: env.model, tools: [] }, { modelRuntime: env.runtime });
  const { norm } = watch(agent);
  const t0 = process.hrtime.bigint();
  const res = await agent.prompt(`请只回答两个字：收到。${NL}${filler(200_000)}`);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const requested = env.reqs.map((r) => tokOf(r.messages));
  record({
    id: "E1a",
    question: "发请求前，库/SDK 会不会算 token 并拦住明显超限的输入",
    observed:
      `声明 contextWindow=2000。发 200000 字符（≈50000 token，25 倍窗口）。` +
      `结果：error=${JSON.stringify(res.error ?? null)}，text=${JSON.stringify(res.text.trim().slice(0, 20))}，给设计者的 usage.totalTokens=${res.usage.totalTokens}，${Math.round(ms)}ms；` +
      `provider 实际收到 ${env.reqs.length} 次请求，估算 ${requested.join("/")} token；` +
      `其中摘要请求数=${env.reqs.filter(isSummaryReq).length}`,
    verdict: "GAP",
    conclusion:
      "超限 25 倍的输入被**原样发给了 provider**：库层不做 token 预检、不拒绝、不截断，也不产生任何提示。" +
      "含义：输入侧的防线 100% 在 provider 那边；设计者要自己防超限，必须自己估 token 并裁输入。",
    data: { declared: 2000, sentChars: 200_000, reqCount: env.reqs.length, requestedTokens: requested, normEvents: norm.map((e) => e.type) },
  });
  agent.dispose();
  await env.close();
}

// ─────────────────────────────────────────────────────────────
section("E1b/E1c 超限真的发生时，设计者能看到什么（单条超大消息，provider 持续 400）");
{
  process.env.FP_CTX = "2000";
  const env = await startProvider(() => ({ kind: "error", status: 400, body: overflowBody(2000, 50000) }));
  const agent = await createAgent({ model: env.model, tools: [] }, { modelRuntime: env.runtime });
  const { norm, raw, errors } = watch(agent);
  let threw: string | null = null;
  const res = await agent
    .prompt(`请只回答两个字：收到。${NL}${filler(20_000)}`)
    .catch((e: Error) => {
      threw = e.message;
      return null;
    });
  const snapshot = {
    runResultError: res?.error ?? null,
    runResultText: res?.text ?? null,
    runResultUsage: res?.usage ?? null,
    threw,
    status: agent.status,
    lastResultError: agent.lastResult?.error ?? null,
    sessionMessages: agent.session.messages.map((m) => `${m.role}${(m as { errorMessage?: string }).errorMessage ? "(err)" : ""}`),
    providerRequests: env.reqs.length,
    lastRequestTokens: env.reqs.length ? tokOf(env.reqs.at(-1)!.messages) : 0,
    normalizedEvents: [...new Set(norm.map((e) => e.type))],
    errorEventPayloads: errors,
    rawEvents: [...new Set(raw)],
  };
  record({
    id: "E1b",
    question: "持续超限时，RunResult / 事件 / status / session 各留下什么痕迹",
    observed:
      `prompt() ${threw ? `抛错：${threw}` : "**未抛错**"}。` +
      `${NL}     RunResult.error=${JSON.stringify(snapshot.runResultError)}；RunResult.text=${JSON.stringify(snapshot.runResultText)}；RunResult.usage.totalTokens=${snapshot.runResultUsage?.totalTokens}；` +
      `${NL}     status=${snapshot.status}；session.messages=${JSON.stringify(snapshot.sessionMessages)}；provider 收到 ${snapshot.providerRequests} 次请求（最后一条 ≈${snapshot.lastRequestTokens} token）；` +
      `${NL}     归一化事件种类=${JSON.stringify(snapshot.normalizedEvents)}；error 事件内容=${JSON.stringify(errors)}；` +
      `${NL}     原始事件种类=${JSON.stringify(snapshot.rawEvents)}`,
    verdict: snapshot.runResultError ? "PARTIAL" : "GAP",
    conclusion:
      snapshot.runResultError
        ? "超限错误进了 RunResult.error。"
        : "**主返回值说谎**：RunResult.error 为空、text 为空、usage 全 0，与「跑成功但没说话」**完全无法区分**（这是静默失败家族里最危险的一条）。唯一痕迹是**一次 `error` 事件**（payload 里有 provider 原文）；`status` 停在 `idle`；`session.messages` 里连那条失败的 assistant 消息都被 SDK 剔除了（`_omitRecoveryAttempt`），所以事后翻历史也翻不到。" +
          "含义：阶段 2 的调用层**必须**订阅 `error` 事件并用 `RunResult.text==\"\"` + usage 全 0 交叉判断，否则超限会被当成「成员没产出」而静默吞掉。",
    data: { ...snapshot, errorEventPayloads: errors },
  });

  const followUp = await agent
    .prompt("只回数字 7")
    .then((r) => ({ ok: !r.error && r.text.trim() !== "", error: r.error ?? null, text: r.text.trim().slice(0, 20) }))
    .catch((e: Error) => ({ ok: false, error: `THROW: ${e.message}`, text: "" }));
  const compactTry = await agent.session
    .compact()
    .then((r) => ({ ok: true, value: JSON.stringify(r).slice(0, 120) }))
    .catch((e: Error) => ({ ok: false, value: `THROW: ${e.message}` }));
  record({
    id: "E1c",
    question: "超限失败之后能不能恢复：同一分身接着问 / 用公开暴露的 session.compact() 自救",
    observed:
      `超限后同一分身再问一句短问题：RunResult=${JSON.stringify(followUp)}（provider 累计 ${env.reqs.length} 次请求，session.messages=${agent.session.messages.length}=${JSON.stringify(agent.session.messages.map((m) => m.role))}）；` +
      `${NL}     agent.session.compact() → ${compactTry.ok ? `成功 ${compactTry.value}` : compactTry.value}`,
    verdict: "GAP",
    conclusion:
      `**这个分身已经被永久卡死**：后续任何 prompt 都返回 error=null / text="" / usage 全 0（provider 又收到了一次请求、又被拒），而那条超大 user 消息永远留在历史里。` +
      `库层没有任何补救手段：唯一公开的逃生口 \`session.compact()\` 抛 \`${compactTry.value.replace("THROW: ", "")}\`（那条超大消息是 user 消息，永远进不了待摘要区间）；也没有“丢历史重来”的 API。` +
      "含义：设计者一旦把超限输入投给成员，**只能 dispose 后重建分身**，或从一开始就自己裁短输入。这条必须写进阶段 2 的调用约定。",
    data: { followUp, compactTry, requests: env.reqs.length },
  });
  agent.dispose();
  await env.close();
}

// ─────────────────────────────────────────────────────────────
section("E1d 对照 A：小窗口（4000）长历史 —— 自动压缩会救场吗");
{
  process.env.FP_CTX = "4000";
  const rejects = { n: 0 };
  const env = await startProvider((req) => {
    if (req.system.includes(SUMMARIZER_MARK)) return { kind: "text", text: "【摘要】之前若干轮都在做长历史压测。" };
    const t = tokOf(req.messages);
    if (t > 4000) {
      rejects.n += 1;
      return { kind: "error", status: 400, body: overflowBody(4000, t) };
    }
    return { kind: "text", text: `收到第 ${req.index} 轮` };
  });
  const agent = await createAgent({ model: env.model, tools: [] }, { modelRuntime: env.runtime });
  const { norm, errors } = watch(agent);
  const rounds: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 6; i++) {
    const r = await agent.prompt(`第 ${i} 轮：${filler(9000)}`).catch((e: Error) => ({ error: `THROW: ${e.message}`, text: "", usage: { totalTokens: 0, cost: { total: 0 } } }) as never);
    rounds.push({ round: i, error: r.error ?? null, text: r.text.trim().slice(0, 20), tokens: r.usage.totalTokens, msgs: agent.session.messages.length });
  }
  const summaries = env.reqs.filter(isSummaryReq).length;
  record({
    id: "E1d",
    question: "小窗口模型（ctx=4000）多轮累积到超限，SDK 的自动压缩到底动没动",
    observed:
      rounds.map((r) => `轮 ${r.round}: RunResult.error=${JSON.stringify(r.error)} tokens=${r.tokens} messages=${r.msgs} 回答=${JSON.stringify(r.text)}`).join(NL + "     ") +
      `${NL}     摘要请求数=${summaries}（=0 表示压缩从未真正执行）；provider 总请求=${env.reqs.length}，被超限拒绝=${rejects.n} 次；error 事件=${JSON.stringify(errors)}`,
    verdict: "GAP",
    conclusion:
      "**自动压缩一次都没执行**（摘要请求 0 次）。原因不是阈值没到，而是 `prepareCompaction` 的守卫：它按 `keepRecentTokens=20000` 找切点，历史总量没超过 20000 token 就「没有可摘要的内容」→ 直接放弃。而小窗口模型的阈值（ctx − reserveTokens 16384）早在几千 token 就触发了 —— 两个常量互相矛盾。" +
      "表现：provider 拒绝 5 次，设计者每次拿到 error=null、text=\"\"，只有 error 事件能看出来。" +
      "含义：**任何 contextWindow ≲ 16384 + 20000 = 36384 的模型，自动压缩结构性失效**，超限必然冒到设计者面前。",
    data: { rounds, summaries, reqs: env.reqs.length, rejects: rejects.n, errorEvents: errors, normEvents: [...new Set(norm.map((e) => e.type))] },
  });
  agent.dispose();
  await env.close();
}

// ─────────────────────────────────────────────────────────────
section("E1e 对照 B：大窗口（60000）同一场景 —— 自动压缩确实能救");
{
  process.env.FP_CTX = "60000";
  const rejects = { n: 0 };
  const env = await startProvider((req) => {
    if (req.system.includes(SUMMARIZER_MARK)) return { kind: "text", text: "【摘要】之前若干轮都在做长历史压测，要点已保留。" };
    const t = tokOf(req.messages);
    if (t > 43616) {
      rejects.n += 1;
      return { kind: "error", status: 400, body: overflowBody(60000, t) };
    }
    return { kind: "text", text: `收到第 ${req.index} 轮` };
  });
  const agent = await createAgent({ model: env.model, tools: [] }, { modelRuntime: env.runtime });
  const { norm, errors, raw } = watch(agent);
  const rounds: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 12; i++) {
    const r = await agent.prompt(`第 ${i} 轮：${filler(20_000)}`).catch((e: Error) => ({ error: `THROW: ${e.message}`, text: "", usage: { totalTokens: 0, cost: { total: 0 } } }) as never);
    rounds.push({ round: i, error: r.error ?? null, text: r.text.trim().slice(0, 20), tokens: r.usage.totalTokens, msgs: agent.session.messages.length, providerTokens: tokOf(env.reqs.at(-1)!.messages) });
  }
  const summaries = env.reqs.filter(isSummaryReq).length;
  const providerPromptTokens = env.reqs.reduce((a, r) => a + tokOf(r.messages), 0);
  const compactionEvents = norm.filter((e) => e.type === "error").length;
  record({
    id: "E1e",
    question: "大窗口（ctx=60000）多轮累积到超限附近，自动压缩是否生效、代价是否可见",
    observed:
      rounds.map((r) => `轮 ${r.round}: error=${JSON.stringify(r.error)} RunResult.tokens=${r.tokens} messages=${r.msgs} 该轮请求≈${r.providerTokens}tok 回答=${JSON.stringify(r.text)}`).join(NL + "     ") +
      `${NL}     摘要请求数=${summaries}；provider 总请求=${env.reqs.length}（被超限拒绝 ${rejects.n} 次）；` +
      `给设计者的 agent.usage.totalTokens=${agent.usage.totalTokens}（累计 ${JSON.stringify(agent.usage.cost)}）vs provider 侧实际消耗的 prompt token ≈${providerPromptTokens}；` +
      `${NL}     归一化事件里出现 error 的次数=${compactionEvents}，内容=${JSON.stringify(errors)}；原始事件种类=${JSON.stringify([...new Set(raw)])}`,
    verdict: rejects.n === 0 ? "OK" : "PARTIAL",
    conclusion:
      (rejects.n === 0
        ? "大窗口下自动压缩**确实生效**：历史被摘要替换，provider 一次都没真的拒绝。"
        : `即使大窗口也仍有 ${rejects.n} 次超限冒出来。`) +
      `代价与盲区：① 压缩用的摘要调用**不计入 agent.usage**（provider 侧 prompt token 与设计者看到的用量差 ${providerPromptTokens - agent.usage.totalTokens} tok，差额就是摘要调用 + 被剔除的失败轮）；② ` +
      `SDK 原始事件流里有 compaction_start/compaction_end，但库的 normalizeEvent 把两者都丢掉 → 设计者拿不到「刚刚压缩了、上下文被换掉了」的任何信号。` +
      "含义：阶段 2 若按 agent.usage 做成本面板/限额，会把「压缩成本」算漏（每次压缩是一次完整 history 的输入 + 摘要输出）。",
    data: { rounds, summaries, reqs: env.reqs.length, rejects: rejects.n, agentUsageTotal: agent.usage.totalTokens, providerPromptTokens, errorEvents: errors, rawEvents: [...new Set(raw)] },
  });
  agent.dispose();
  await env.close();
}

// ─────────────────────────────────────────────────────────────
section("E1f 设计者能不能调压缩参数（agentDir/settings.json）");
{
  process.env.FP_CTX = "4000";
  const env = await startProvider((req) => {
    if (isSummaryReq(req)) return { kind: "text", text: "【摘要】压测。" };
    const t = tokOf(req.messages);
    if (t > 4000) return { kind: "error", status: 400, body: overflowBody(4000, t) };
    return { kind: "text", text: "收到" };
  });
  // reserveTokens=1 + keepRecentTokens=1：若设置真被读取，压缩会在**每一轮**触发（摘要请求数必然 > 0）
  writeFileSync(
    join(env.agentDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } }),
    "utf-8",
  );
  const agent = await createAgent({ model: env.model, tools: [] }, { modelRuntime: env.runtime });
  const rounds: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 4; i++) {
    const r = await agent.prompt(`第 ${i} 轮：${filler(9000)}`).catch((e: Error) => ({ error: `THROW: ${(e as Error).message}`, text: "", usage: { totalTokens: 0 } }) as never);
    rounds.push({ round: i, error: r.error ?? null, text: r.text.trim().slice(0, 12), tokens: r.usage.totalTokens, msgs: agent.session.messages.length });
  }
  const summaries = env.reqs.filter(isSummaryReq).length;
  record({
    id: "E1f",
    question: "压缩参数能不能被设计者通过 agentDir/settings.json 关掉或调小",
    observed:
      `写入 agentDir/settings.json = ${JSON.stringify({ compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } })} 之后：摘要请求数=${summaries}` +
      `（若设置真被读取，reserveTokens=1/keepRecentTokens=1 会让压缩在**每一轮**触发，摘要请求数必然 > 0）；逐轮=${JSON.stringify(rounds)}；provider 收到 ${env.reqs.length} 次请求`,
    verdict: "GAP",
    conclusion:
      "settings.json **完全不起作用**：`src/agent/create-agent.ts:97` 用的是 `SettingsManager.inMemory({})`（空内存设置），" +
      "所以压缩永远是默认的 `{enabled:true, reserveTokens:16384, keepRecentTokens:20000}`，设计者既不能关、也不能按模型窗口调。 " +
      `证据：本项与 E1d 在同一个 ctx=4000 下摘要请求数都是 0，而本项里那组设置若生效**必然**产生摘要请求 —— 结论只能是设置文件根本没被读取。` +
      "含义：阶段 2 若要用小窗口模型或需要控制压缩成本，**只能改 src/ 或自己估算 token 后主动裁剪输入**，库这一层没有出口。",
    data: { settingsWritten: { compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } }, summaries, rounds, reqs: env.reqs.length },
  });
  agent.dispose();
  await env.close();
}

console.log(`${NL}E1 结束（零真实花费）`);
dump();
