// 本轮专用：带「完整请求正文」记录的假 provider。
// 复用 test/faux-server.ts 的脚本约定，但额外保存原始 messages —— 用来回答
// 「这段文本到底有没有到模型那里」，lastUser 只给最后一条 user。
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface RawCall {
  model: string;
  messages: any[];
  tools: string[];
  system: string;
}
export interface Srv {
  baseUrl: string;
  calls: RawCall[];
  close(): Promise<void>;
  /** 某个文本是否出现在任意一条消息里 */
  contains(text: string, from?: number): boolean;
  /** 从 from 起的请求摘要 */
  digest(from?: number): string[];
  reset(): void;
}

export async function startSrv(): Promise<Srv> {
  const calls: RawCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload: any = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        /* ignore */
      }
      const messages: any[] = payload.messages ?? [];
      calls.push({
        model: payload.model,
        messages,
        tools: (payload.tools ?? []).map((t: any) => t?.function?.name ?? t?.name).filter(Boolean),
        system: messages
          .filter((m) => m.role === "system")
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n"),
      });
      respond(res, payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const port = (server.address() as any).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
    contains: (text: string, from = 0) => calls.slice(from).some((c) => JSON.stringify(c.messages).includes(text)),
    digest: (from = 0) =>
      calls.slice(from).map((c, i) => {
        const parts = c.messages.map((m) => {
          const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return `${m.role}(${t.slice(0, 60)})`;
        });
        return `#${from + i} model=${c.model} msgs=${c.messages.length} [${parts.join(" ")}]`;
      }),
    reset: () => calls.splice(0),
  };
}

function txt(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => p?.text ?? "").join("");
  return "";
}
const pick = (t: string, re: RegExp) => t.match(re)?.[1];

function respond(res: ServerResponse, payload: any): void {
  const messages: any[] = payload.messages ?? [];
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const lastUser = txt(lastUserMsg?.content);
  const lastIsToolResult = messages[messages.length - 1]?.role === "tool";

  if (/\[\[fail\]\]/.test(lastUser) && !lastIsToolResult) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "faux-provider-boom" } }));
    return;
  }
  const slowFail = Number(pick(lastUser, /\[\[slowfail:(\d+)\]\]/) ?? 0);
  if (slowFail > 0) {
    setTimeout(() => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "faux-provider-slow-boom" } }));
    }, slowFail);
    return;
  }
  const sleepMs = Number(pick(lastUser, /\[\[sleep:(\d+)\]\]/) ?? 0);
  const slowText = Number(pick(lastUser, /\[\[slowtext:(\d+)\]\]/) ?? 0);
  const args = [...lastUser.matchAll(/\[\[args:(\{[\s\S]*?\})\]\]/g)].pop()?.[1] ?? "{}";
  const callM = [...lastUser.matchAll(/\[\[call:([a-zA-Z0-9_-]+)(?:\s+(\{[\s\S]*?\}))?\]\]/g)];
  const single = pick(lastUser, /\[\[tool:([a-zA-Z0-9_-]+)\]\]/);
  const toolCalls = lastIsToolResult
    ? []
    : callM.length
      ? callM.map((m) => ({ name: m[1], args: m[2] ?? "{}" }))
      : single
        ? [{ name: single, args }]
        : [];
  const huge = Number(pick(lastUser, /\[\[huge:(\d+)\]\]/) ?? 0);
  const trailing: string[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i]?.role === "tool"; i--) trailing.unshift(txt(messages[i].content));
  const echoSource = lastIsToolResult ? trailing.join(" | ") : lastUser;
  const text = huge > 0 ? "x".repeat(huge) : `echo:${echoSource.slice(0, 400)}`;

  const send = () => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta: any, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: "assistant", content: "" });
    if (toolCalls.length) {
      chunk({ tool_calls: toolCalls.map((c, i) => ({ index: i, id: `call_${i + 1}`, type: "function", function: { name: c.name, arguments: c.args } })) });
      chunk({}, "tool_calls");
      finish();
    } else if (slowText > 0) {
      // 分块慢速吐字：用来在「流到一半」时 abort，看半截消息会不会进历史
      const pieces = Array.from({ length: 10 }, (_, i) => `片${i + 1} `);
      let i = 0;
      const tick = () => {
        if (i >= pieces.length) {
          chunk({}, "stop");
          finish();
          return;
        }
        chunk({ content: pieces[i++] });
        setTimeout(tick, slowText);
      };
      tick();
      return;
    } else {
      for (const p of text.match(/.{1,40}/gs) ?? [""]) chunk({ content: p });
      chunk({}, "stop");
      finish();
    }

    function finish() {
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  };
  if (sleepMs > 0) setTimeout(send, sleepMs);
  else send();
}

export interface Env2 {
  srv: Srv;
  root: string;
  agentDir: string;
  cwd: string;
  runtime: ModelRuntime;
  model: string;
}
/** 孤立环境：自己的 models.json（指向本脚本的假服务）+ cwd + runtime。 */
export async function makeEnv2(modelId = "echo", opts: { reasoning?: boolean } = {}): Promise<Env2> {
  const srv = await startSrv();
  const root = mkdtempSync(join(tmpdir(), "aiteam-21-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        faux: {
          name: "Faux",
          baseUrl: srv.baseUrl,
          api: "openai-completions",
          apiKey: "faux-key",
          models: [{ id: modelId, name: `Faux ${modelId}`, reasoning: opts.reasoning ?? false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
        },
      },
    }),
    "utf-8",
  );
  const runtime = await ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
  process.env.AITEAM_AGENT_DIR = agentDir;
  return { srv, root, agentDir, cwd, runtime, model: `faux/${modelId}` };
}
