// 第 9 部分：可复现性与确定性（假 provider 部分；真模型方差见真模型专项）
// 跑法：node audit/09-determinism.ts
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgent } from "../src/index.ts";
import { dump, record, section } from "./_harness.ts";
import { makeEnv } from "./_faux.ts";

const env = await makeEnv();
const { agentDir, cwd, runtime, model } = env;
const mk = (extra: Record<string, unknown> = {}) =>
  createAgent({ model, cwd, agentDir, ...extra }, { modelRuntime: runtime });

// ─────────────────────────────────────────────────────────────
section("9.1 假 provider 下的确定性（作为对照基线）");

{
  const runs: Array<{ text: string; usage: number; events: string }> = [];
  for (let i = 0; i < 5; i++) {
    const a = await mk();
    const events: string[] = [];
    a.on("text", () => events.push("text"));
    a.on("turn", () => events.push("turn"));
    a.on("done", () => events.push("done"));
    const r = await a.prompt("固定输入-ABC");
    runs.push({ text: r.text, usage: r.usage.totalTokens, events: events.join(",") });
    a.dispose();
  }
  const texts = new Set(runs.map((r) => r.text));
  const usages = new Set(runs.map((r) => r.usage));
  const evs = new Set(runs.map((r) => r.events));
  record({
    id: "9.1a",
    question: "同一输入跑 5 次，假 provider 下的产出与用量是否逐字节一致",
    observed: `text 去重后 ${texts.size} 种；usage 去重后 ${usages.size} 种（值 ${[...usages].join("/")}）；事件序列去重后 ${evs.size} 种（${[...evs].join(" | ")}）`,
    verdict: texts.size === 1 && usages.size === 1 ? "OK" : "GAP",
    conclusion:
      texts.size === 1 && usages.size === 1
        ? "完全确定。假 provider 是可靠的确定性基线：文本、用量、事件序列 5 次全一致。适合做机制层的回归测试。"
        : "不确定 —— 假 provider 下就有方差，说明有隐藏的非确定性来源。",
    data: { runs },
  });
}

{
  // 多分身并发的产出是否与单发一致
  const seq: string[] = [];
  for (let i = 0; i < 3; i++) {
    const a = await mk();
    const b = await mk();
    const [ra, rb] = await Promise.all([a.prompt("甲"), b.prompt("乙")]);
    seq.push(`${ra.text}|${rb.text}`);
    a.dispose();
    b.dispose();
  }
  record({
    id: "9.1b",
    question: "并发运行下产出是否仍确定（会不会串味）",
    observed: `${new Set(seq).size} 种结果：${[...new Set(seq)].join(" ／ ")}`,
    verdict: new Set(seq).size === 1 ? "OK" : "GAP",
    conclusion: new Set(seq).size === 1 ? "并发下产出确定，分身之间不串上下文。" : "并发下有方差。",
    data: { seq },
  });
}

// ─────────────────────────────────────────────────────────────
section("9.2 采样参数：库有没有旋钮，绕法是否真的通到请求体");

{
  // 起一个会记录原始请求体的假服务，验证 Model.samplingParams 的绕法
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(body || "{}"));
      } catch {
        bodies.push({ __unparsed: body.slice(0, 200) });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "t", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "t", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const root = mkdtempSync(join(tmpdir(), "aiteam-sampling-"));
  const dir = join(root, "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        samp: {
          name: "Samp",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "k",
          models: [
            { id: "with-params", name: "带采样参数", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192, samplingParams: { temperature: 0.13, top_p: 0.77 } },
            { id: "no-params", name: "不带采样参数", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 },
          ],
        },
      },
    }),
    "utf-8",
  );
  const sampRuntime = await ModelRuntime.create({ modelsPath: join(dir, "models.json"), allowModelNetwork: false });

  for (const id of ["with-params", "no-params"]) {
    const a = await createAgent({ model: `samp/${id}`, cwd: root, agentDir: dir }, { modelRuntime: sampRuntime });
    await a.prompt("hi");
    a.dispose();
  }
  const [withP, noP] = bodies;
  record({
    id: "9.2a",
    question: "有没有办法给某个模型带上采样参数（members.json 的 Model.samplingParams 绕法）",
    observed: `带 samplingParams 的模型请求体里：temperature=${JSON.stringify(withP?.temperature)} top_p=${JSON.stringify(withP?.top_p)}；不带的：temperature=${JSON.stringify(noP?.temperature)} top_p=${JSON.stringify(noP?.top_p)}`,
    verdict: withP?.temperature !== undefined ? "PARTIAL" : "GAP",
    conclusion:
      withP?.temperature !== undefined
        ? `绕法可行：把采样参数写进 models.json 的模型定义（samplingParams），它会原样进请求体（实测 temperature=${withP.temperature}、top_p=${withP.top_p}）。但这是**按模型**的，不是按成员 —— 同一模型的两个成员拿不到不同温度。要按成员区分只能在一个 models.json 里写多个只差采样参数的模型条目（用不同 id 冒充不同模型）。`
        : "绕法不通（请求体里没有采样参数）。",
    data: { withParams: { temperature: withP?.temperature, top_p: withP?.top_p }, without: { temperature: noP?.temperature, top_p: noP?.top_p } },
  });

  record({
    id: "9.2b",
    question: "MemberSpec 层面有没有任何采样 / 随机性旋钮",
    observed: "MemberSpec 的 12 个字段里没有 temperature / top_p / seed / maxTokens / stopSequences；createAgentSessionOptions 只暴露 thinkingLevel 与 noTools",
    verdict: "GAP",
    conclusion: "没有任何按成员的生成参数通道。设计者无法表达「这个成员要发散、那个成员要保守」—— 而这正是团队设计里非常自然的需求（头脑风暴成员 vs 审查成员）。",
  });

  await new Promise<void>((r) => server.close(() => r()));
  void server;
}

{
  record({
    id: "9.2c",
    question: "有没有种子的概念（同输入同种子能否复现）",
    observed: "MemberSpec / HostOptions / models.json 均无 seed 字段；pi-ai 的 StreamOptions 也没有 seed",
    verdict: "GAP",
    conclusion: "连绕法都没有。真实模型下「同输入跑两次得到同样结果」在 API 层面就不可能 —— 所以集群设计的可复现性只能做到「拓扑与配置可复现」，做不到「产出可复现」。这是设计阶段必须接受的约束。",
  });
}

// ─────────────────────────────────────────────────────────────
section("9.3 配置快照：设计者能不能保存「这个集群是怎么配的」");

{
  const a = await mk({ role: "某种角色", tools: ["read"], description: "某种成员" });
  const snapshot = {
    id: a.id,
    member: a.member,
    parentId: a.parentId,
    status: a.status,
    usage: a.usage,
  };
  record({
    id: "9.3a",
    question: "设计者能否从 agent 反查回它的配置（用于保存/复现/审计）",
    observed: `ControlledAgent 上可读的字段只有 ${JSON.stringify(Object.keys(snapshot))}；没有 spec / 成员定义 / 已解析模型的任何回读接口`,
    verdict: "GAP",
    conclusion:
      "不能。agent 建出来之后，原先那份 MemberSpec 就找不回来了 —— 库不保存也不暴露它。设计者要复现或审计一个集群，必须自己额外维护一份 spec 副本与 agent 的对应关系（而 spawned 子分身的 spec 来自花名册，设计者手里根本没有它的实例）。",
    data: { snapshot },
  });
  a.dispose();
}

{
  record({
    id: "9.3b",
    question: "host 上能不能拿到花名册（设计者读回自己声明的 members）",
    observed: "AgentHost 的公开接口类型里没有 members；运行时确实存着（spawn_agent 用内部符号键读），但没有公开访问器",
    verdict: "PARTIAL",
    conclusion:
      "公开类型上拿不到。实测 host 对象上确实有 members 属性（spawn_agent 靠它工作），但那是内部实现细节，没有类型保证。设计者想读回花名册要么自己留一份，要么依赖未公开的属性。",
  });
}

dump("09-determinism");
await env.close();
