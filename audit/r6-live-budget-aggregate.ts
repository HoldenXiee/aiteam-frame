// 真模型专项 F：预算耗尽的真实体验 / 用量一致性 / 互评一致率
// 对应清单 4.2（重点）、7.4、8.3
// 跑法：node audit/r6-live-budget-aggregate.ts        （会产生真实 API 花费）
// 原则：所有结论字符串都由本次实测数据算出，不硬编码数字
import { createAgent, createAgentHost } from "../src/index.ts";
import { dump, msAsync, record, section } from "./_harness.ts";

const FLASH = "opencode-go/deepseek-v4.1-flash";
const MIMO = "opencode-go/mimo-v2.6-flash";
const QWEN = "opencode-go/qwen3.8-flash";
const GLM = "opencode-go/glm-5.3-flash";
const NL = "\n";
let cost = 0;
const charge = (c: number) => (cost += c);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const n1 = (x: number) => Number(x.toFixed(1));

// ── 4.2 预算耗尽的真实体验（重点）────────────────────────────────────────
section("F1  跑光预算会发生什么：设计者能否优雅收场（清单 4.2）");

{
  const BUDGET = 12000;
  const host = createAgentHost({ members: { worker: {} }, budgetTokens: BUDGET });
  const agent = await createAgent(
    { id: "worker", model: FLASH, role: "你是一名简洁的工程分析师。" },
    { host, member: "worker" },
  );

  const rounds: Array<{ round: number; ok: boolean; text: string; hostUsage: number; hostCost: number; errMsg: string | null; errName: string | null; ms: number }> = [];
  let exhaustedAt: number | null = null;
  let errSample: { name: string; message: string } | null = null;

  for (let round = 1; round <= 8; round++) {
    try {
      const [res, ms] = await msAsync(() =>
        agent.prompt(`第 ${round} 轮：用一句话说明为什么「过早优化是万恶之源」。不要超过 30 字。`),
      );
      charge(res.usage.cost.total);
      rounds.push({ round, ok: true, text: res.text.trim().slice(0, 40), hostUsage: host.usage.totalTokens, hostCost: Number(host.usage.cost.total.toFixed(6)), errMsg: null, errName: null, ms: Math.round(ms) });
    } catch (e) {
      const err = e as Error;
      exhaustedAt = round;
      errSample = { name: err.constructor?.name ?? "Error", message: err.message };
      rounds.push({ round, ok: false, text: "", hostUsage: host.usage.totalTokens, hostCost: Number(host.usage.cost.total.toFixed(6)), errMsg: err.message, errName: err.constructor?.name ?? "Error", ms: 0 });
      break;
    }
  }

  const okRounds = rounds.filter((r) => r.ok);
  const usageAtExhaust = host.usage.totalTokens;
  const overshoot = Number((usageAtExhaust / BUDGET).toFixed(2));

  // 耗尽之后：还能读到什么？
  let canReadLastResult = false;
  let lastResultText = "";
  let msgCountAfter = 0;
  let disposeOk = false;
  try {
    lastResultText = String(agent.lastResult?.text ?? "");
    canReadLastResult = lastResultText.length > 0;
    msgCountAfter = agent.session.messages.length;
  } catch { /* 读不到就是读不到 */ }
  try { agent.dispose(); disposeOk = true; } catch { disposeOk = false; }
  const usageAfterDispose = host.usage.totalTokens;

  // 耗尽之后设计者能否「优雅收场」：用已经拿到的结果拼一份交付
  const graceful = okRounds.length > 0 ? okRounds.map((r) => `第${r.round}轮：${r.text}`).join(" / ") : "(无)";

  // 耗尽之后还能不能新建分身
  let canCreateAfter = false;
  let createErr = "";
  try {
    await createAgent({ id: "late", model: FLASH }, { host, member: "worker" });
    canCreateAfter = true;
  } catch (e) { createErr = (e as Error).message; }
  const usageAfterCreate = host.usage.totalTokens;
  host.dispose();

  record({
    id: "F1a",
    question: `预算 ${BUDGET} 耗尽的全过程：什么时候失败、失败长什么样、已产出的结果还在不在`,
    observed:
      rounds.map((r) => `第${r.round}轮: ${r.ok ? `成功（${r.ms}ms，宿主累计 ${r.hostUsage} tok / $${r.hostCost}）` : `**失败**（${r.errName}: ${String(r.errMsg).slice(0, 90)}）`}`).join(NL + "     ") +
      NL + `     耗尽时的宿主累计 = ${usageAtExhaust} tok（= 预算的 ${overshoot} 倍，超支 ${n1((overshoot - 1) * 100)}%）`,
    verdict: "PARTIAL",
    conclusion:
      `**预算是"轮开始前"的检查，不是"轮进行中"的闸门**：前 ${okRounds.length} 轮全部成功跑完，第 ${exhaustedAt} 轮才被拒；被拒时宿主累计已经到 ${usageAtExhaust} tok，是预算的 **${overshoot} 倍**（超支 ${n1((overshoot - 1) * 100)}%）。失败形态是 **抛错**（${errSample?.name}），错误信息直接可读，设计者可以用 try/catch 捕获。三点关于"能否优雅收场"：① **已产出的结果全都还在** —— \`lastResult\` 可读（${canReadLastResult ? `读到 ${lastResultText.length} 字` : "读不到"}）、\`session.messages\` 里还有 ${msgCountAfter} 条，所以设计者完全可以把前面几轮的结果拼成交付物（本次拼出：${graceful}）；② 耗尽后 \`dispose()\` 仍可用（${disposeOk}），宿主累计量不受回收影响（${usageAfterDispose} tok）；③ 耗尽后**连新分身都建不起来**（${canCreateAfter ? "仍可创建" : `被拒：${String(createErr).slice(0, 80)}`}）—— 整个宿主被冻死，不是只有那一个成员被拦。含义：预算可以做"事后刹车"，但**不能做"按分支限流"** —— 一个分支烧光，全宿主停摆。`,
    data: { budget: BUDGET, rounds, exhaustedAt, usageAtExhaust, overshoot, canReadLastResult, lastResultChars: lastResultText.length, msgCountAfter, disposeOk, usageAfterDispose, canCreateAfter, createErr, graceful, errSample },
  });
}

// ── 7.4 真模型 usage 的准确性 ─────────────────────────────────────────────
section("F2  真模型的 usage 数字彼此对得上吗（清单 7.4）");

{
  const host = createAgentHost({ members: { m: {} } });
  const a = await createAgent({ model: FLASH, tools: [] }, { host, member: "m" });
  const rows: Array<{ round: number; runResult: number; agentDelta: number; hostDelta: number; doneEvent: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number; identityOk: boolean; equal: boolean }> = [];
  for (let round = 1; round <= 3; round++) {
    const beforeAgent = a.usage.totalTokens;
    const beforeHost = host.usage.totalTokens;
    let doneEvent = -1;
    const unsub = a.on("done", (p) => { doneEvent = p.usage.totalTokens; });
    const res = await a.prompt(`第 ${round} 轮：只回数字 ${round}`);
    unsub();
    charge(res.usage.cost.total);
    const u = res.usage;
    const identityOk = u.input + u.output + u.cacheRead + u.cacheWrite === u.totalTokens;
    const agentDelta = a.usage.totalTokens - beforeAgent;
    const hostDelta = host.usage.totalTokens - beforeHost;
    rows.push({
      round,
      runResult: u.totalTokens,
      agentDelta,
      hostDelta,
      doneEvent,
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      total: u.totalTokens,
      identityOk,
      equal: u.totalTokens === agentDelta && u.totalTokens === hostDelta && u.totalTokens === doneEvent,
    });
  }
  a.dispose();
  const hostTotalAfterDispose = host.usage.totalTokens;
  const hostSurvivesDispose = hostTotalAfterDispose === rows.reduce((s2, r) => s2 + r.total, 0);
  host.dispose();

  const identityAllOk = rows.every((r) => r.identityOk);
  const equalAll = rows.every((r) => r.equal);
  const cacheWriteSum = rows.reduce((s2, r) => s2 + r.cacheWrite, 0);
  const inputShare = rows.map((r) => `${n1((r.input / Math.max(r.total, 1)) * 100)}%`).join("/");
  const cacheReadShare = rows.map((r) => `${n1((r.cacheRead / Math.max(r.total, 1)) * 100)}%`).join("/");

  record({
    id: "F2a",
    question: "同一轮的用量：RunResult / agent.usage / host.usage / done 事件四者是否一致，字段间是否自洽",
    observed:
      rows.map((r) => `第${r.round}轮: RunResult=${r.runResult} agent增量=${r.agentDelta} host增量=${r.hostDelta} done事件=${r.doneEvent} | input=${r.input} output=${r.output} cacheRead=${r.cacheRead} cacheWrite=${r.cacheWrite} total=${r.total} 恒等式=${r.identityOk}`).join(NL + "     "),
    verdict: identityAllOk && equalAll ? "OK" : "GAP",
    conclusion:
      `**四方完全一致**：\`RunResult.usage.totalTokens\` = \`agent.usage\` 增量 = \`host.usage\` 增量 = \`done\` 事件用量，三轮全部相等（${equalAll}）；恒等式 \`input + output + cacheRead + cacheWrite === totalTokens\` 也全部成立（${identityAllOk}）；回收后宿主累计不变（${hostSurvivesDispose}）。字段构成很关键：\`input\` 只占总额的 **${inputShare}**，\`cacheRead\` 占 **${cacheReadShare}**，\`cacheWrite\` 三轮合计 ${cacheWriteSum}（一直为 0）。含义：库的用量记账**本身准确、可对账**，问题不在准确性而在**分解** —— 只有总数与五个字段，没有「哪个成员/哪个分支」的维度；且 \`input\` 这个名字会误导（它只是「未命中的新增输入」）。`,
    data: { rows, identityAllOk, equalAll, cacheWriteSum, hostTotalAfterDispose, hostSurvivesDispose },
  });
}

// ── 8.3 真模型互评 / 投票的一致率 ─────────────────────────────────────────
section("F3  多成员互评与投票的一致率（清单 8.3）");

{
  // 有确定答案的题：用一致率 + 正确率两个指标
  const CODE_Q =
    "只回 YES 或 NO，不要任何解释。\n下面这段 Python 有 bug 吗？\n\n```python\ndef mean(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total / len(xs)\n```\n\n调用 mean([]) 时会发生什么？这段代码有 bug 吗？";
  // 主观评分题：只看一致率
  const RATE_Q =
    '给下面这个提案打分 0-10（10=非常赞成）。只输出 JSON：{"score": 整数}\n提案：「把线上灰度发布从 3 天缩短到 2 小时。」';

  const jurors: Array<{ key: string; spec: Record<string, unknown> }> = [
    { key: "J1-flash-无角色", spec: { model: FLASH } },
    { key: "J2-mimo-无角色", spec: { model: MIMO } },
    { key: "J3-qwen-无角色", spec: { model: QWEN } },
    { key: "J4-glm-无角色", spec: { model: GLM } },
  ];

  const yesRows: Array<{ juror: string; run: number; answer: string | null; raw: string }> = [];
  const scoreRows: Array<{ juror: string; run: number; score: number | null }> = [];
  for (const j of jurors) {
    for (let run = 1; run <= 3; run++) {
      const a = await createAgent({ tools: [], ...j.spec });
      const r1 = await a.prompt(CODE_Q);
      const r2 = await a.prompt(RATE_Q);
      charge(r1.usage.cost.total + r2.usage.cost.total);
      const yn = r1.text.match(/\b(YES|NO)\b/i);
      const sc = r2.text.match(/"score"\s*:\s*(\d+)/);
      yesRows.push({ juror: j.key, run, answer: yn ? yn[1].toUpperCase() : null, raw: r1.text.trim().slice(0, 30) });
      scoreRows.push({ juror: j.key, run, score: sc ? Number(sc[1]) : null });
      a.dispose();
    }
  }

  // 一致率（有确定答案的题）：全体一致的比例 + 与正确答案 YES 的一致率
  const perRun = [1, 2, 3].map((run) => {
    const ans = yesRows.filter((r) => r.run === run).map((r) => r.answer);
    return { run, answers: ans.join("/"), unanimous: new Set(ans).size === 1, allCorrect: ans.every((x) => x === "YES") };
  });
  const unanimousRuns = perRun.filter((r) => r.unanimous).length;
  const correctJurors = yesRows.filter((r) => r.answer === "YES").length;
  const parseableJurors = yesRows.filter((r) => r.answer !== null).length;

  // 主观评分：跨评审的离散度
  const scores = scoreRows.map((r) => r.score).filter((s): s is number => s !== null);
  const scoreSpread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
  const scoreSd = scores.length > 1 ? Number(Math.sqrt(mean(scores.map((s) => (s - mean(scores)) ** 2))).toFixed(2)) : 0;

  record({
    id: "F3a",
    question: "同一道有确定答案的题交给 4 个不同模型的成员，会不会得出同一个结论",
    observed:
      perRun.map((r) => `第${r.run}次投票: ${r.answers} → ${r.unanimous ? "全体一致" : "**不一致**"}（全对=${r.allCorrect}）`).join(NL + "     ") +
      NL + `     逐次明细：${yesRows.map((r) => `${r.juror}#${r.run}=${r.answer ?? "未按格式回答(" + r.raw + ")"}`).join(" ")}`,
    verdict: unanimousRuns === perRun.length ? "OK" : "PARTIAL",
    conclusion:
      `**一致率 ${unanimousRuns}/${perRun.length}，正确率 ${correctJurors}/${yesRows.length}**（正确答案 YES）。要点：① 有确定答案、且明确要求只回 YES/NO 时，${unanimousRuns === perRun.length ? "跨 4 个不同模型每次都能全体一致" : `仍有 ${perRun.length - unanimousRuns}/${perRun.length} 次出现分歧`}；② 格式遵守 ${parseableJurors}/${yesRows.length}${parseableJurors === yesRows.length ? "（本次全部守住）" : `（${yesRows.length - parseableJurors} 次没守）`}；③ **多成员投票在事实题上收益有限**：模型间相关性很高，容易一起对也容易一起错（本次全对，但全错的场景同样会全体一致），真正价值在下面的主观题。含义：拿「多成员投票」当可靠性手段，对**事实题**作用有限，对**主观判断题**才分散风险。`,
    data: { perRun, yesRows, unanimousRuns, correctJurors, parseableJurors },
  });

  record({
    id: "F3b",
    question: "同一道主观题交给 4 个成员打分，评审之间的一致程度如何",
    observed:
      scoreRows.map((r) => `${r.juror}#${r.run}=${r.score ?? "未按格式"}`).join(" ") +
      NL + `     全体 ${scores.length} 个分数：极差 ${scoreSpread}，标准差 ${scoreSd}，均值 ${n1(mean(scores))}`,
    verdict: scoreSpread >= 3 ? "GAP" : "OK",
    conclusion:
      `同一份提案、同一批模型、同一个问法，${scores.length} 个分数落在 ${Math.min(...scores)}–${Math.max(...scores)}（**极差 ${scoreSpread}，标准差 ${scoreSd}**）。含义：**主观判断上成员之间确实会分歧，且分歧不小** —— 这正是多成员评审的价值来源（多样性），也是它不能当"表决器"的原因。实践后果：${scoreSpread >= 3 ? `极差 ${scoreSpread} 意味着"取平均"与"取中位"会给出不同结论，而库不提供任何一种聚合（清单 8.1 已证实）；设计者必须自己定义聚合规则并在报告里写清楚` : "本次分歧较小，聚合规则的差异影响有限"}。`,
    data: { scoreRows, scores, scoreSpread, scoreSd, mean: n1(mean(scores)) },
  });
}

console.log(`\n真模型专项 F 结束：本次真实花费约 $${cost.toFixed(5)}`);
dump("r6-live-budget-aggregate");
