// B8 收尾：把「克隆 provider + streamSimple 注入 temperature」的绕法对**真 provider** 实测一次。
// 本机起一个记录请求体的转发代理，把 baseUrl 指到代理，代理再转发到 https://opencode.ai/zen/go/v1。
// 跑法：node audit/23-aggregation/e5b-real-sampling.ts        （真实花费：2 次极短调用）
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { streamSimple as openaiStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createAgent } from "../../src/index.ts";
import { saveSection, section, type Spending } from "./_rec.ts";

const spend: Spending = { cost: 0, tokens: 0, calls: 0 };
const seen: Array<{ model?: string; temperature?: number }> = [];

const proxy = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const j = JSON.parse(body);
      seen.push({ model: j.model, temperature: j.temperature });
    } catch {
      seen.push({});
    }
    const headers: Record<string, any> = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    delete headers["accept-encoding"];
    const up = httpsRequest(
      { hostname: "opencode.ai", path: `/zen/go${req.url}`, method: "POST", headers },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      },
    );
    up.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    up.end(body);
  });
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const port = (proxy.address() as { port: number }).port;

const real = await ModelRuntime.create();
const auth = (await real.getAuth("opencode-go")) as { auth?: { apiKey?: string }; source?: string } | undefined;
const apiKey = auth?.auth?.apiKey ?? "";
console.log(`凭证来源：${auth?.source}`);
console.log(`opencode-go 凭证：${apiKey ? `拿到（${apiKey.length} 字符）` : "没拿到"}`);

const modelEntry = (temperature: number) => ({
  id: "deepseek-v4.1-flash",
  name: `flash@${temperature}`,
  reasoning: true,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 8192,
});

section("E8 真 provider 上的按成员温度（克隆两个 provider id，各自的 streamSimple 注入不同 temperature）");
for (const [pid, temp] of [
  ["og-cold", 0.05],
  ["og-hot", 0.95],
] as const) {
  real.registerProvider(pid, {
    name: pid,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    apiKey,
    // 克隆 provider 会掉 opencode 的会话归属头（built-in 只在 provider===opencode-go 或 host 是 opencode.ai 时补），必须自己补
    headers: { "x-opencode-session": randomUUID(), "x-opencode-client": "pi" },
    models: [modelEntry(temp)],
    streamSimple: ((m: any, c: any, o: any) => openaiStreamSimple(m, c, { ...o, temperature: temp })) as never,
  });

  await real.setRuntimeApiKey(pid, apiKey);
  const a = await createAgent({ model: `${pid}/deepseek-v4.1-flash` }, { modelRuntime: real });
  const r = await a.prompt("只回一个词：好");
  a.dispose();
  spend.cost += r.usage.cost.total;
  spend.tokens += r.usage.totalTokens;
  spend.calls += 1;
  const last = seen[seen.length - 1];
  console.log(`  ${pid}: 代理看到的请求体 temperature=${last?.temperature} model=${last?.model}　回复=${JSON.stringify(r.text.slice(0, 20))}${r.error ? ` 错误=${r.error.slice(0, 120)}` : ""}`);
}

console.log(`\n代理捕获 ${seen.length} 次请求：${JSON.stringify(seen)}`);
saveSection("e5b-real-sampling", { credentialFound: !!apiKey, captured: seen }, spend);
await new Promise<void>((r) => proxy.close(() => r()));
