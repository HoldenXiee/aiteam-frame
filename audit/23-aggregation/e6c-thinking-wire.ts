// B9 补充：thinking 档位到底有没有翻译成请求参数（本机假服务记录原始请求体，零真实花费）
// 跑法：node audit/23-aggregation/e6c-thinking-wire.ts
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgent } from "../../src/index.ts";
import { saveSection, section } from "./_rec.ts";

const bodies: Array<Record<string, unknown>> = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const j = JSON.parse(body);
      const { messages, tools, ...rest } = j;
      void messages;
      void tools;
      bodies.push(rest);
    } catch {
      bodies.push({ __unparsed: body.slice(0, 120) });
    }
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
const root = mkdtempSync(join(tmpdir(), "aiteam-think-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      th: {
        name: "Th",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "k",
        models: [
          { id: "can-think", name: "会思考", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 },
          { id: "cannot", name: "不会思考", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 },
        ],
      },
    },
  }),
  "utf-8",
);
const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });

section("E10 thinking 档位的线上表现：请求体里到底多/少了什么");
const rows: Array<{ model: string; requested: string; effective: string; body: Record<string, unknown> }> = [];
for (const model of ["th/can-think", "th/cannot"]) {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const a = await createAgent({ model, cwd, agentDir, thinking: level as never }, { modelRuntime: runtime });
    const eff = a.session.thinkingLevel;
    await a.prompt("hi");
    a.dispose();
    const body = bodies[bodies.length - 1];
    rows.push({ model, requested: level, effective: eff, body });
    console.log(`  ${model} 请求=${level.padEnd(7)} → 实际=${eff.padEnd(6)} 请求体=${JSON.stringify(body)}`);
  }
}

saveSection("e6c-thinking-wire", { rows });
await new Promise<void>((r) => server.close(() => r()));
