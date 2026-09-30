// 真模型专项 C：真实失败形态、预算耗尽的体验、abort 残局、主持人如何应对成员失败
// 跑法：node audit/r3-live-robustness.ts        （会产生真实 API 花费）
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, createAgentHost, type ControlledAgent } from "../src/index.ts";
import { dump, record, section } from "./_harness.ts";

const FLASH = "opencode-go/deepseek-v4.1-flash";
const REAL_BASE = "https://opencode.ai/zen/go/v1";
let totalCost = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 造一个 models.json，把某个 provider 指向指定 baseUrl */
function dirWithProvider(provider: string, baseUrl: string, modelId: string, apiKey = "bad-key") {
  const dir = mkdtempSync(join(tmpdir(), `aiteam-${provider}-`));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          name: provider,
          baseUrl,
          api: "openai-completions",
          apiKey,
          models: [
            { id: modelId, name: modelId, reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 128000, maxTokens: 1024 },
          ],
        },
      },
    }),
    "utf-8",
  );
  mkdirSync(join(dir, "work"), { recursive: true });
  return { dir, cwd: join(dir, "work") };
}

// ─────────────────────────────────────────────────────────────
section("R11 真实失败形态");

{
  // 1) 网络不可达（死端口）
  const dead = dirWithProvider("dead", "http://127.0.0.1:1/v1", "ghost");
  const t0 = Date.now();
  const a = await createAgent({ model: "dead/ghost", agentDir: dead.dir, cwd: dead.cwd });
  let r: { error?: string; text: string } | undefined;
  let thrown = "";
  try {
    r = await a.prompt("你好");
  } catch (e) {
    thrown = (e as Error).message;
  }
  const ms = Date.now() - t0;
  record({
    id: "R11a",
    question: "provider 网络不可达时的失败形态与耗时",
    observed: `耗时 ${ms}ms；${thrown ? `抛错：「${thrown.slice(0, 140)}」` : `RunResult.error = ${JSON.stringify((r?.error ?? "(无)").slice(0, 140))}，text=${JSON.stringify(r?.text.slice(0, 40))}`}`,
    verdict: "INFO",
    conclusion: `${ms}ms 内失败（pi 内部有重试，不是立即返回）。错误以 ${thrown ? "抛异常" : "RunResult.error"} 形式给出，内容是底层连接错误原文 —— 没有「网络问题」这样的分类，设计者只能字符串匹配。`,
    data: { ms, thrown, error: r?.error },
  });
  a.dispose();
}

{
  // 2) 真实端点 + 错误 API key → 401
  const bad = dirWithProvider("opencode-go", REAL_BASE, "deepseek-v4.1-flash");
  const t0 = Date.now();
  const a = await createAgent({ model: "opencode-go/deepseek-v4.1-flash", agentDir: bad.dir, cwd: bad.cwd });
  let r: { error?: string; text: string } | undefined;
  let thrown = "";
  try {
    r = await a.prompt("你好");
  } catch (e) {
    thrown = (e as Error).message;
  }
  const ms = Date.now() - t0;
  record({
    id: "R11b",
    question: "API key 无效（401）时的失败形态",
    observed: `耗时 ${ms}ms；${thrown ? `抛错：「${thrown.slice(0, 160)}」` : `RunResult.error = ${JSON.stringify((r?.error ?? "(无)").slice(0, 160))}`}`,
    verdict: "INFO",
    conclusion: "错误文本是 HTTP 状态码 + provider 返回的 JSON 原文。设计者要区分「401 认证失败」「402 额度不足」「429 限流」只能解析这串文本。",
    data: { ms, thrown, error: r?.error?.slice(0, 300) },
  });
  a.dispose();
}

{
  // 3) 上下文撑爆（真模型）：喂一段远超声明 contextWindow 的内容
  const dir = dirWithProvider("opencode-go", REAL_BASE, "deepseek-v4.1-flash", "x");
  const a = await createAgent({ model: FLASH }); // 用全局凭据，声明 contextWindow 100 万
  const huge = "请把下面这段文本原样重复一遍，不要省略：\n" + "数据".repeat(120000); // ≈ 24 万字符
  const t0 = Date.now();
  let r: { error?: string; text: string; usage: { totalTokens: number } } | undefined;
  let thrown = "";
  try {
    r = await a.prompt(huge);
    totalCost += (r as unknown as { usage: { cost: { total: number } } }).usage.cost.total;
  } catch (e) {
    thrown = (e as Error).message;
  }
  record({
    id: "R11c",
    question: "超长输入（约 24 万字符）时的真实行为",
    observed: `耗时 ${Date.now() - t0}ms；${thrown ? `抛错「${thrown.slice(0, 120)}」` : `error=${JSON.stringify((r?.error ?? "(无)").slice(0, 120))} text 长度=${r?.text.length} 用量=${r?.usage.totalTokens}`}`,
    verdict: "INFO",
    conclusion:
      "该模型声明 contextWindow = 100 万，24 万字符（约 12 万 token）没有触发超限 —— 库与 pi 都不做本地 token 预算检查，超限只能由 provider 报错。设计者若需要提前拦截，必须自己算 token。",
    data: { thrown, error: r?.error?.slice(0, 200), textLen: r?.text.length, tokens: r?.usage.totalTokens },
  });
  a.dispose();
  void dir;
}

// ─────────────────────────────────────────────────────────────
section("R12 预算耗尽的真实体验");

{
  const BUDGET = 7000; // 约两轮
  const host = createAgentHost({ modelRuntime: undefined, budgetTokens: BUDGET, maxAgents: 8, defaults: { model: FLASH } } as never);
  const a = await createAgent({ model: FLASH, tools: ["spawn_agent"] }, { host });
  const log: string[] = [];
  let graceful = true;
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await a.prompt(`第 ${i} 轮：只回数字 ${i}`);
      log.push(`第${i}轮 ok（本轮 ${r.usage.totalTokens} tok，宿主累计 ${host.usage.totalTokens}）`);
    } catch (e) {
      log.push(`第${i}轮 抛错（宿主累计 ${host.usage.totalTokens}）：「${(e as Error).message.slice(0, 60)}」`);
    }
  }
  totalCost += host.usage.cost.total;
  record({
    id: "R12a",
    question: "真模型下跑到预算耗尽的体验：设计者能优雅收场吗",
    observed: `budgetTokens=${BUDGET}：\n     ${log.join("\n     ")}\n     最终 host.usage=${host.usage.totalTokens}，实际花费 $${host.usage.cost.total.toFixed(4)}`,
    verdict: "PARTIAL",
    conclusion:
      `耗尽时 `+`prompt()`+` 抛错，**已经跑完的轮次结果都还在**（`+`agent.lastResult`+` / `+`agent.session`+` 可读），所以设计者可以在 catch 里用最后的结果收场 —— 不是硬中断。但库**没有任何「预算快到了」的预警**，设计者只能靠 round_completed 自己盯 host.usage 判断，而并发场景下判断必然滞后（见 4.2c）。`,
    data: { budget: BUDGET, used: host.usage.totalTokens, log },
  });
  graceful = !log.some((l) => l.includes("抛错") && !l.includes("累计"));
  void graceful;
  a.dispose();
  host.dispose();
}

// ─────────────────────────────────────────────────────────────
section("R13 abort 之后留下的残局");

{
  const a = await createAgent({ model: FLASH });
  const before = a.session.messages.length;
  void a.prompt("请从 1 数到 500，每个数字之间用逗号分隔，不要省略。").catch(() => {});
  await sleep(1200);
  const streamingAtAbort = a.isStreaming;
  await a.abort();
  await sleep(400);
  const after = a.session.messages;
  const assistantMsgs = after.filter((m) => m.role === "assistant");
  const last = assistantMsgs[assistantMsgs.length - 1] as unknown as { content?: Array<{ type: string; text?: string }>; errorMessage?: string } | undefined;
  const text = (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  // 下一轮还能不能正常跑
  const again = await a.prompt("只回一个数字：9");
  totalCost += a.usage.cost.total;
  record({
    id: "R13a",
    question: "中途 abort 会不会留下坏上下文",
    observed: `abort 时 isStreaming=${streamingAtAbort}；消息数 ${before} → ${after.length}；最后一条 assistant 的文本长度=${text.length}（片段：${JSON.stringify(text.slice(0, 60))}）errorMessage=${JSON.stringify(last?.errorMessage ?? null)}；abort 后再跑一轮 → error=${JSON.stringify(again.error ?? null)} text=${JSON.stringify(again.text.slice(0, 20))}`,
    verdict: again.error ? "GAP" : "OK",
    conclusion:
      again.error
        ? "abort 之后无法继续正常对话。"
        : `可以继续，下一轮正常。残局形态：被中断的那条 assistant 消息**留在了 session.messages 里**，且带上了 \`errorMessage="Request aborted"\`（实测）—— 所以 pi 是标记了中断的，不是默默留个半成品。本次被中断时还没吐任何文本，所以 text 长度为 0；若中断发生在中途，半截文本会随标记一起留着。含义：设计者不需要自己清理，但**下一轮的上下文里会包含这条失败消息**（pi 发的历史里带着 errorMessage）。`,
    data: { streamingAtAbort, before, afterCount: after.length, partialLen: text.length, errorMessage: last?.errorMessage ?? null, nextOk: !again.error },
  });
  a.dispose();
}

// ─────────────────────────────────────────────────────────────
section("R14 成员失败时，主持人会不会诚实汇报");

{
  const dead = dirWithProvider("dead", "http://127.0.0.1:1/v1", "ghost");
  const host = createAgentHost({
    defaults: { model: FLASH },
    members: {
      good: { description: "正常成员：给出简短判断", model: FLASH },
      broken: { description: "总是连不上的成员（网络故障）", model: "dead/ghost", agentDir: dead.dir, cwd: dead.cwd },
    },
    maxAgents: 8,
  } as never);
  const mod = await createAgent({ model: FLASH, tools: ["spawn_agent"] }, { host });
  await mod.prompt(
    "请用 spawn_agent 让 broken 成员判断「这个方案可行吗」。拿到结果后用两句话汇报：① 它说了什么；② 有没有异常。",
  );
  const broken = host.list().find((a) => a.member === "broken");
  totalCost += host.usage.cost.total;
  const report = mod.lastResult?.text ?? "";
  record({
    id: "R14a",
    question: "成员彻底失败时，主持人看到的是什么、会不会编造结果",
    observed: `子分身 lastResult.error = ${JSON.stringify((broken?.lastResult?.error ?? "(无)").slice(0, 90))}\n     主持人汇报：${JSON.stringify(report.slice(0, 400))}`,
    verdict: /失败|错误|异常|连不上|无法|报错|error/i.test(report) ? "OK" : "GAP",
    conclusion:
      /失败|错误|异常|连不上|无法|报错|error/i.test(report)
        ? "主持人如实汇报了异常（错误文本通过 spawn_agent 的返回值传给了它）。链条是可用的：子分身的 error → spawn_agent 的文本 → 父 agent 的上下文。"
        : "主持人没有汇报异常 —— 这需要人工复核它是不是编造了内容。",
    data: { childError: broken?.lastResult?.error?.slice(0, 200), report: report.slice(0, 600) },
  });
  mod.dispose();
  host.dispose();
}

console.log(`\n真模型专项 C 结束：本次会话真实花费约 $${totalCost.toFixed(4)}`);
dump("r3-live-robustness");
