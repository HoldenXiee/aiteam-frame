// 24-uncovered 专用：可脚本化的假 provider（比 test/faux-server.ts 多三件事）
//   1) 每次请求可返回「指定的错误」或「指定的文本」，用来复刻 provider 的真实错误体
//   2) usage 按内容长度算（chars/4），让「用量驱动的自动压缩」路径可被真实触发
//   3) 记录完整请求体（比 FauxCall 全），供 thinking/上下文实验核对
// 不改 test/ 与 src/ 任何文件。
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface Req {
  index: number;
  model: string;
  messages: Array<{ role?: string; content?: unknown }>;
  tools: string[];
  system: string;
  lastUser: string;
  body: Record<string, unknown>;
}

export type Reply =
  | { kind: "text"; text: string }
  | { kind: "error"; status: number; body: string };

export interface Env {
  baseUrl: string;
  reqs: Req[];
  agentDir: string;
  cwd: string;
  runtime: ModelRuntime;
  model: string;
  close: () => Promise<void>;
}

const chars = (c: unknown): number => {
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) return c.reduce<number>((a, p) => a + ((p as { text?: string })?.text?.length ?? 0), 0);
  return 0;
};

export async function startProvider(script: (req: Req) => Reply): Promise<Env> {
  const reqs: Req[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      const messages = (payload.messages ?? []) as Req["messages"];
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      const users = messages.filter((m) => m.role === "user");
      const last = users[users.length - 1];
      const lastUser = typeof last?.content === "string" ? last.content : (last?.content as Array<{ text?: string }>)?.map((p) => p?.text ?? "").join("") ?? "";
      const rec: Req = {
        index: reqs.length,
        model: String(payload.model ?? ""),
        messages,
        tools: ((payload.tools ?? []) as Array<{ function?: { name?: string }; name?: string }>).map((t) => t?.function?.name ?? t?.name ?? "").filter(Boolean),
        system,
        lastUser: lastUser ?? "",
        body: payload,
      };
      reqs.push(rec);

      let reply: Reply;
      try {
        reply = script(rec);
      } catch (e) {
        reply = { kind: "error", status: 500, body: JSON.stringify({ error: { message: `script threw: ${String(e)}` } }) };
      }

      if (reply.kind === "error") {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
        return;
      }

      // usage 用内容长度估（chars/4），贴近真实 provider 的 prompt_tokens 语义
      const promptChars = messages.reduce((a, m) => a + chars(m.content), 0) + system.length;
      const usage = { prompt_tokens: Math.max(1, Math.ceil(promptChars / 4)), completion_tokens: Math.max(1, Math.ceil(reply.text.length / 4)) };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = "chatcmpl-fp";
      const chunk = (delta: unknown, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: "assistant", content: "" });
      for (const piece of reply.text.match(/.{1,40}/gs) ?? [""]) chunk({ content: piece });
      chunk({}, "stop");
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: payload.model, choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

  const root = mkdtempSync(join(tmpdir(), "aiteam-24-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const contextWindow = Number(process.env.FP_CTX ?? 200000);
  const maxTokens = Number(process.env.FP_MAXTOK ?? 8192);
  const reasoning = process.env.FP_REASONING !== "0";
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          fplocal: {
            name: "FpLocal",
            baseUrl,
            api: "openai-completions",
            apiKey: "fp-key",
            models: [
              {
                id: "m",
                name: "FpLocal M",
                reasoning,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow,
                maxTokens,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
  process.env.AITEAM_AGENT_DIR = agentDir;
  return { baseUrl, reqs, agentDir, cwd, runtime, model: "fplocal/m", close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** 真实 provider 形状的上下文超限错误体（能命中 pi-ai 的 OVERFLOW_PATTERNS） */
export const overflowBody = (limit: number, requested: number) =>
  JSON.stringify({
    error: {
      message: `This model's maximum context length is ${limit} tokens. However, you requested ${requested} tokens. Please reduce the length of the messages.`,
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  });
