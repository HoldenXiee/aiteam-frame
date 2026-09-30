// B8 采样参数：库没有按成员的旋钮，验证所有绕法（全部走本机记录请求体的假服务，零真实花费）
// 跑法：node audit/23-aggregation/e5-sampling.ts
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { streamSimple as openaiStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createAgent } from "../../src/index.ts";
import { saveSection, section } from "./_rec.ts";

const bodies: Array<Record<string, any>> = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      parsed = { __unparsed: body.slice(0, 200) };
    }
    bodies.push(parsed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ id: "c", object: "chat.completion.chunk", created: 0, model: "t", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
    chunk({ id: "c", object: "chat.completion.chunk", created: 0, model: "t", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    chunk({ id: "c", object: "chat.completion.chunk", created: 0, choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

const root = mkdtempSync(join(tmpdir(), "aiteam-sampling-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });

const mk = (id: string, samplingParams?: Record<string, unknown>, reasoning = false) => ({
  id,
  name: id,
  reasoning,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
  ...(samplingParams ? { samplingParams } : {}),
});
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      samp: {
        name: "Samp",
        baseUrl,
        api: "openai-completions",
        apiKey: "k",
        models: [mk("base"), mk("cold", { temperature: 0.1, top_p: 0.1, seed: 7, top_k: 5, repetition_penalty: 1.1 })],
      },
    },
  }),
  "utf-8",
);
const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });

const pick = (b: Record<string, any> | undefined) =>
  b ? { model: b.model, temperature: b.temperature, top_p: b.top_p, seed: b.seed, top_k: b.top_k, repetition_penalty: b.repetition_penalty } : undefined;

const run = async (model: string, label: string, customTools?: never) => {
  const n = bodies.length;
  const a = await createAgent({ model, cwd, agentDir, ...(customTools ? {} : {}) }, { modelRuntime: runtime });
  await a.prompt("hi");
  a.dispose();
  const b = bodies[bodies.length - 1];
  console.log(`  ${label}: ${JSON.stringify(pick(b))}`);
  void n;
  return b;
};

section("E7 绕法 1：models.json 里每个模型条目自己的 samplingParams（按模型，不按成员）");
const baseBody = await run("samp/base", "samp/base（无 samplingParams）");
const coldBody = await run("samp/cold", "samp/cold（temperature 0.1 / top_p 0.1 / seed 7）");

section("E7b 绕法 2：registerProvider 覆盖式注册一个新模型条目");
runtime.registerProvider("samp", {
  name: "Samp",
  baseUrl,
  apiKey: "k",
  api: "openai-completions",
  models: [mk("warm", { temperature: 0.77 })],
});
const warmBody = await run("samp/warm", "samp/warm（注册进来的 temperature 0.77）");

section("E7c 绕法 3：克隆 provider + streamSimple 包装注入 temperature（按 provider id 区分）");
runtime.registerProvider("inject", {
  name: "Inject",
  baseUrl,
  apiKey: "k",
  api: "openai-completions",
  models: [mk("twin")],
  streamSimple: ((m: any, c: any, o: any) => openaiStreamSimple(m, c, { ...o, temperature: 0.99 })) as never,
});
const injectBody = await run("inject/twin", "inject/twin（streamSimple 包装 temperature 0.99）");

section("E7d 绕法 4：onPayload 钩子改写原始请求体");
runtime.registerProvider("payload", {
  name: "Payload",
  baseUrl,
  apiKey: "k",
  api: "openai-completions",
  models: [mk("twin")],
  streamSimple: ((m: any, c: any, o: any) =>
    openaiStreamSimple(m, c, { ...o, onPayload: (p: any) => ({ ...p, temperature: 0.33, seed: 42 }) })) as never,
});
const payloadBody = await run("payload/twin", "payload/twin（onPayload 注入 temperature 0.33 / seed 42）");

section("E7e 底座能力：直接调 modelRuntime.completeSimple 传 temperature（证明旋钮在 SDK 层存在，只是库没接）");
runtime.registerProvider("plain", { name: "Plain", baseUrl, apiKey: "k", api: "openai-completions", models: [mk("plain")] });
const model = runtime.getModel("plain", "plain");
let directBody: Record<string, any> | undefined;
let directErr = "";
try {
  const mm: any = model;
  await runtime.completeSimple(mm, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never, { temperature: 0.5, samplingParams: { top_k: 5 } } as never);
  directBody = bodies[bodies.length - 1];
  console.log(`  直接 completeSimple(temperature:0.5, samplingParams:{top_k:5}): ${JSON.stringify(pick(directBody))}`);
} catch (e) {
  directErr = (e as Error).message.slice(0, 200);
  console.log(`  直接调用失败：${directErr}`);
}

const deltas = {
  base: pick(baseBody),
  cold: pick(coldBody),
  warm: pick(warmBody),
  inject: pick(injectBody),
  payload: pick(payloadBody),
  direct: pick(directBody),
  directErr,
};
console.log("\n结论数据：", JSON.stringify(deltas, null, 1));

saveSection("e5-sampling", {
  note: "全部流量进本机假服务（记录原始请求体），零真实花费",
  bodies: bodies.map((b) => pick(b)),
  deltas,
});
await new Promise<void>((r) => server.close(() => r()));
