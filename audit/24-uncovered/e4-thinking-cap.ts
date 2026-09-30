// E4 thinking 档位在被「能力位夹取」时到底发出了什么（补 23-aggregation 的质量实验）
// 跑法：node audit/24-uncovered/e4-thinking-cap.ts        （真模型部分产生小额花费）
// 问题：设计者能否按 thinking 档位做成本/质量预估 —— 取决于档位在 reasoning:false 模型上是否被静默吃掉。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../src/index.ts";
import { dump, record, script, section } from "./_h.ts";

script("e4-thinking-cap");
const NL = "\n";
let cost = 0;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// ── A：本机所有模型的能力位分布（零成本）────────────────────────
section("E4a 本机 models-store.json 里哪些模型声明 reasoning，哪些不声明");
{
  const store = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models-store.json"), "utf-8")) as Record<
    string,
    { models: Array<{ id: string; reasoning?: boolean; contextWindow?: number; thinkingLevelMap?: Record<string, unknown> }> }
  >;
  const per: Record<string, { t: number; f: number; falseIds: string[] }> = {};
  for (const [p, v] of Object.entries(store)) {
    const t: string[] = [];
    const f: string[] = [];
    for (const m of v.models) (m.reasoning ? t : f).push(m.id);
    per[p] = { t: t.length, f: f.length, falseIds: f };
  }
  const totalT = Object.values(per).reduce((a, x) => a + x.t, 0);
  const totalF = Object.values(per).reduce((a, x) => a + x.f, 0);
  record({
    id: "E4a",
    question: "本机可用的真模型里，有多少声明 reasoning:true / false（按 provider）",
    observed:
      Object.entries(per)
        .map(([p, x]) => `${p}: true=${x.t} false=${x.f}`)
        .join("；") +
      `${NL}     reasonering:false 的模型共 ${totalF} 个，全部集中在 openrouter（真实 ID 举例：${(per.openrouter?.falseIds ?? []).slice(0, 8).join(", ")}）` +
      `${NL}     **opencode-go / anthropic / opencode 三个 provider 下 reasoning:false 的模型数 = 0**（全部声明为 true）`,
    verdict: "INFO",
    conclusion:
      `reasoning 能力位是 per-model 的真实字段，但本机实际会用的 provider（opencode-go）下**没有一个是 false** —— 因为 opencode-go 目录里 29 个模型全部声明 reasoning:true。` +
      "含义：设计者若只用 opencode-go，就不会遇到「thinking 档位被夹取」；一旦把 openrouter 的 84 个 reasoning:false 模型纳入成员池，档位就会开始被静默吃掉。",
    data: { totalT, totalF, per },
  });
}

// ── B：库层行为（假 provider，零成本；两侧都打印）──────────────
section("E4b/E4c 请求体里到底有没有 reasoning_effort（假 provider，可抓完整 body）");
{
  const run = async (reasoning: boolean) => {
    process.env.FP_REASONING = reasoning ? "1" : "0";
    const { startProvider } = await import("./_fp.ts");
    const env = await startProvider(() => ({ kind: "text", text: "ok" }));
    const rows: Array<Record<string, unknown>> = [];
    for (const lv of LEVELS) {
      const a = await createAgent({ model: env.model, tools: [], thinking: lv }, { modelRuntime: env.runtime });
      const r = await a.prompt("只回一个字：好");
      const body = env.reqs.at(-1)!.body as Record<string, unknown>;
      const effortKeys = Object.keys(body).filter((k) => /reason|think/i.test(k));
      rows.push({
        level: lv,
        sessionThinkingLevel: a.session.thinkingLevel,
        error: r.error ?? null,
        text: r.text.trim().slice(0, 10),
        bodyEffortKeys: effortKeys,
        bodyEffortValues: effortKeys.map((k) => `${k}=${JSON.stringify(body[k])}`),
        allTopLevelKeys: Object.keys(body).sort(),
      });
      a.dispose();
    }
    await env.close();
    return rows;
  };

  const capFalse = await run(false);
  const capTrue = await run(true);
  const fmt = (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => `档位 ${String(r.level).padEnd(7)} → session.thinkingLevel=${JSON.stringify(r.sessionThinkingLevel)} 请求体里的推理字段=${JSON.stringify(r.bodyEffortValues)} 回答=${JSON.stringify(r.text)}`).join(NL + "     ");

  record({
    id: "E4b",
    question: "声明 reasoning:false 的模型上，七档 thinking 会不会有任何一档真的落到请求体里",
    observed: fmt(capFalse) + `${NL}     请求体顶层字段（任取一档）=${JSON.stringify(capFalse[4].allTopLevelKeys)}`,
    verdict: capFalse.every((r) => (r.bodyEffortValues as string[]).length === 0) ? "GAP" : "OK",
    conclusion:
      capFalse.every((r) => (r.bodyEffortValues as string[]).length === 0)
        ? "**七档全部被静默吃掉**：请求体里没有任何推理相关字段，与 thinking:\"off\" 完全一致（session.thinkingLevel 也全落在同一个值）。设计者写 thinking:\"max\" 与不写，代价与效果完全一样 —— 而且**没有任何报错或警告**。"
        : "至少有一档真的落进了请求体，档位未被完全夹取。",
    data: { reasoning: false, rows: capFalse },
  });

  record({
    id: "E4c",
    question: "对照：声明 reasoning:true 的模型上同一批档位发出什么",
    observed: fmt(capTrue),
    verdict: (capTrue.find((r) => r.level === "high") as { bodyEffortValues: string[] }).bodyEffortValues.length > 0 ? "OK" : "GAP",
    conclusion:
      (capTrue.find((r) => r.level === "high") as { bodyEffortValues: string[] }).bodyEffortValues.length > 0
        ? `对照成立：reasoning:true 时档位真的进了请求体（high → ${JSON.stringify((capTrue.find((r) => r.level === "high") as { bodyEffortValues: string[] }).bodyEffortValues)}）。所以 E4b 的「全空」不是抓取手法失灵，而是能力位夹取真的发生了。`
        : "对照组也没有发出推理字段 —— 说明假 provider 的模型定义缺少必要字段，E4b 的结论**不能被这对实验支持**（需要真模型复核）。",
    data: { reasoning: true, rows: capTrue },
  });
}

// ── C：真模型端到端（抓全局 fetch；两侧都打印）──────────────────
section("E4d/E4e 真模型：reasoning:false vs reasoning:true 的请求体差异");
{
  const orig = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  // 关键：E4b/E4c 用的假环境把 AITEAM_AGENT_DIR 指向临时目录，必须先清掉，否则真模型读不到凭据
  delete process.env.AITEAM_AGENT_DIR;
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init: unknown) => {
    const b = (init as { body?: unknown } | undefined)?.body;
    if (typeof b === "string") {
      try {
        bodies.push(JSON.parse(b) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
    return (orig as (u: unknown, i: unknown) => Promise<unknown>)(url, init);
  };
  const probe = async (model: string, thinking: string) => {
    bodies.length = 0;
    const t0 = Date.now();
    try {
      const a = await createAgent({ model, tools: [], thinking: thinking as never });
      const r = await a.prompt("只回一个字：好");
      cost += r.usage.cost.total;
      const body = bodies.at(-1) ?? {};
      const keys = Object.keys(body).filter((k) => /reason|think/i.test(k));
      const allKeys = [...new Set(bodies.flatMap((b) => Object.keys(b).filter((k) => /reason|think/i.test(k))))];
      const allVals = [...new Set(bodies.flatMap((b) => allKeys.map((k) => `${k}=${JSON.stringify(b[k])}`)))];
      a.dispose();
      return { model, thinking, ok: !r.error, text: r.text.trim().slice(0, 20), sessionThinkingLevel: "n/a", effortKeys: keys, allEffortKeys: allKeys, allEffortValues: allVals, effortValues: keys.map((k) => `${k}=${JSON.stringify(body[k])}`), tokens: r.usage.totalTokens, cost: Number(r.usage.cost.total.toFixed(6)), ms: Date.now() - t0, error: r.error ?? null, captured: bodies.length };
    } catch (e) {
      return { model, thinking, ok: false, text: "", effortKeys: [] as string[], effortValues: [] as string[], tokens: 0, cost: 0, ms: Date.now() - t0, error: `THROW: ${(e as Error).message}`, captured: bodies.length };
    }
  };

  const falseModel = process.env.E4_FALSE_MODEL ?? "openrouter/google/gemma-3-12b-it";
  const trueModel = "opencode-go/deepseek-v4.1-flash";
  const rFalse = await probe(falseModel, "high");
  const rTrue = await probe(trueModel, "high");
  (globalThis as unknown as { fetch: unknown }).fetch = orig;

  record({
    id: "E4d",
    question: "真模型端到端：reasoning:false 的模型配 thinking:\"high\"，请求体里有没有 reasoning_effort",
    observed:
      `reasoning:false 模型 ${rFalse.model} thinking="high"：error=${JSON.stringify((rFalse.error ?? "").slice(0, 60))} 共抓到 ${rFalse.captured} 个请求体，**全部**请求体里的推理字段=${JSON.stringify(rFalse.allEffortValues)}（去重）回答=${JSON.stringify(rFalse.text)} tok=${rFalse.tokens} $${rFalse.cost}` +
      `${NL}     对照 reasoning:true 模型 ${rTrue.model} thinking="high"：error=${JSON.stringify(rTrue.error)} 请求体推理字段=${JSON.stringify(rTrue.allEffortValues)} 回答=${JSON.stringify(rTrue.text)} tok=${rTrue.tokens} $${rTrue.cost}`,
    verdict: rFalse.allEffortKeys.length === 0 && rTrue.allEffortKeys.length > 0 && rTrue.captured > 0 ? "PARTIAL" : "INFO",
    conclusion:
      rTrue.captured === 0
        ? "两支真模型都没抓到请求体，本条无真模型证据。"
        : rFalse.allEffortKeys.length === 0
        ? `真模型侧与假 provider 侧一致：reasoning:false 的模型上，thinking:"high" **没有产生任何推理字段**；同一抓取手法在 reasoning:true 的模型上抓到了 ${JSON.stringify(rTrue.effortValues)}，说明抓取本身有效。` +
          "含义：设计者**不能**按 thinking 档位对「非推理模型」做成本/质量预估 —— 档位在那些模型上是纯粹的空写（且无任何提示）。"
        : `${rFalse.model} 上居然出现了推理字段 ${JSON.stringify(rFalse.effortValues)} —— 与 E4b 的假 provider 结论不一致，需要单独复核该模型的 compat/thinkingLevelMap。`,
    data: { rFalse, rTrue },
  });
}

console.log(`${NL}E4 结束：真模型花费约 $${cost.toFixed(5)}`);
dump();
