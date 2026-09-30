// 捕获「模型实际收到的原始请求体」——比 test/faux-server.ts 的 calls 更全
// （calls 只记 model/tools/system/lastUser，这里拿到完整 body，才能看 reasoning_effort / temperature 等）。
// 手法：包一层 globalThis.fetch（pi-ai 走全局 fetch），不改任何 test/ 与 src/ 文件。
export interface RawCall {
  model: string;
  tools: string[];
  system: string;
  /** SSE 请求会分多条；用 -1 之外的下标对齐 */
  messages: unknown[];
  body: Record<string, unknown>;
}

export interface Capture {
  calls: RawCall[];
  /** 逐条请求体里出现过的顶层字段名（用于回答「库到底发了什么参数」） */
  topLevelKeys(): string[];
  stop(): void;
}

export function startCapture(): Capture {
  const calls: RawCall[] = [];
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init: unknown) => {
    const body = (init as { body?: unknown } | undefined)?.body;
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const messages = (parsed.messages ?? []) as Array<{ role?: string; content?: unknown }>;
        calls.push({
          model: String(parsed.model ?? ""),
          tools: ((parsed.tools ?? []) as Array<{ function?: { name?: string }; name?: string }>)
            .map((t) => t?.function?.name ?? t?.name ?? "")
            .filter(Boolean),
          system: messages
            .filter((m) => m.role === "system")
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
            .join("\n"),
          messages,
          body: parsed,
        });
      } catch {
        /* 不是 JSON 就不记 */
      }
    }
    return (orig as (u: unknown, i: unknown) => Promise<unknown>)(url, init);
  };
  return {
    calls,
    topLevelKeys: () => [...new Set(calls.flatMap((c) => Object.keys(c.body)))].sort(),
    stop: () => {
      (globalThis as unknown as { fetch: unknown }).fetch = orig;
    },
  };
}

export function lastRaw(calls: RawCall[]): RawCall | undefined {
  return calls[calls.length - 1];
}

/** 把某条请求的全部消息摊平成文本，用于「工具结果真的回来了吗」的核对 */
export function messagesText(call: RawCall | undefined): string {
  return call ? JSON.stringify(call.messages) : "";
}
