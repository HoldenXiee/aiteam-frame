// 本机假 LLM 服务（零成本、按脚本响应）。搬自 probe/_support.ts 的假服务部分。
// 同时记录「模型实际收到了什么」——这是测试的 ground truth。
import { createServer, type ServerResponse } from "node:http";

export interface FauxCall {
  model: string;
  tools: string[];
  system: string;
  lastUser: string;
  messageCount: number;
}

export interface Faux {
  /** 形如 http://127.0.0.1:PORT/v1 */
  baseUrl: string;
  calls: FauxCall[];
  close(): Promise<void>;
}

/**
 * 脚本约定（写在最后一条 user 消息里，且最后一条不是 tool 结果时生效）：
 *   [[tool:NAME]]   让模型发起一次 NAME 的工具调用
 *   [[sleep:MS]]    延迟 MS 毫秒再回包（用于制造「正忙」窗口）
 *   [[fail]]        回 HTTP 400，用于验证错误路径
 *   [[huge:BYTES]]  回一段超大文本（用于验证上下文/用量）
 * 其余情况回 `echo:<原文截断>`
 */
export async function startFaux(): Promise<Faux> {
  const calls: FauxCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload: any = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        /* 忽略 */
      }
      const messages: any[] = payload.messages ?? [];
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      const users = messages.filter((m) => m.role === "user");
      const last = users[users.length - 1];
      const lastUser =
        typeof last?.content === "string"
          ? last.content
          : Array.isArray(last?.content)
            ? last.content.map((p: any) => p?.text ?? "").join("")
            : "";

      calls.push({
        model: payload.model,
        tools: (payload.tools ?? []).map((t: any) => t?.function?.name ?? t?.name).filter(Boolean),
        system,
        lastUser,
        messageCount: messages.length,
      });

      respond(res, payload, lastUser);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // 不占住事件循环：测试进程在断言跑完后能自然退出，无需逐个 close()
  server.unref();
  const address = server.address() as { port: number };

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function pick(text: string, re: RegExp): string | undefined {
  const m = text.match(re);
  return m?.[1];
}

function respond(res: ServerResponse, payload: any, lastUser: string): void {
  const lastMessage = payload.messages?.[payload.messages.length - 1];
  const lastIsToolResult = lastMessage?.role === "tool";

  if (/\[\[fail\]\]/.test(lastUser) && !lastIsToolResult) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "faux-provider-boom" } }));
    return;
  }

  const sleepMs = Number(pick(lastUser, /\[\[sleep:(\d+)\]\]/) ?? 0);
  const toolName = lastIsToolResult ? undefined : pick(lastUser, /\[\[tool:([a-zA-Z0-9_-]+)\]\]/);
  const huge = Number(pick(lastUser, /\[\[huge:(\d+)\]\]/) ?? 0);
  const text = huge > 0 ? "x".repeat(huge) : `echo:${lastUser.slice(0, 80)}`;

  const send = () => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const id = "chatcmpl-faux";
    const chunk = (delta: any, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 0,
          model: payload.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );

    chunk({ role: "assistant", content: "" });

    if (toolName) {
      chunk({
        tool_calls: [
          { index: 0, id: "call_faux_1", type: "function", function: { name: toolName, arguments: "{}" } },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      for (const piece of text.match(/.{1,40}/gs) ?? [""]) chunk({ content: piece });
      chunk({}, "stop");
    }

    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 0,
        model: payload.model,
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  };

  if (sleepMs > 0) setTimeout(send, sleepMs);
  else send();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
