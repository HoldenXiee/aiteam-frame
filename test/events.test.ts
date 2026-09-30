import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent } from "../src/agent/events.ts";

const usage = (totalTokens: number, input = 11, output = 7) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

test("message_update.text_delta → text", () => {
  assert.deepEqual(
    normalizeEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } } as any),
    { type: "text", delta: "a" },
  );
});

test("message_update.thinking_delta → thinking", () => {
  assert.deepEqual(
    normalizeEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "想" } } as any),
    { type: "thinking", delta: "想" },
  );
});

test("tool_execution_start → tool_start", () => {
  assert.deepEqual(
    normalizeEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} } as any),
    { type: "tool_start", toolName: "read", callId: "c1" },
  );
});

test("tool_execution_end → tool_end 带 isError", () => {
  assert.deepEqual(
    normalizeEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: {}, isError: true } as any),
    { type: "tool_end", toolName: "read", callId: "c1", isError: true },
  );
});

test("turn_end → turn 带 message 与 usage", () => {
  const message = { role: "assistant", content: [], usage: usage(18) };
  assert.deepEqual(normalizeEvent({ type: "turn_end", message, toolResults: [] } as any), {
    type: "turn",
    message,
    usage: usage(18),
  });
});

test("agent_end → done 带本次 usage（累加本次运行里的 assistant 消息）", () => {
  const messages = [
    { role: "assistant", content: [], usage: usage(18) },
    { role: "user", content: [] },
    { role: "assistant", content: [], usage: usage(30, 20, 10) },
  ];
  assert.deepEqual(normalizeEvent({ type: "agent_end", messages, willRetry: false } as any), {
    type: "done",
    usage: usage(48, 31, 17),
  });
});

test("assistant 的 message_end 带 errorMessage → error", () => {
  const message = { role: "assistant", content: [], usage: usage(0), errorMessage: "boom" };
  assert.deepEqual(normalizeEvent({ type: "message_end", message } as any), { type: "error", message: "boom" });
});

test("agent_end 但 willRetry → undefined（这一轮还没完）", () => {
  assert.equal(normalizeEvent({ type: "agent_end", messages: [], willRetry: true } as any), undefined);
});

test("无关事件返回 undefined", () => {
  assert.equal(normalizeEvent({ type: "message_start", message: {} } as any), undefined);
  assert.equal(normalizeEvent({ type: "agent_settled" } as any), undefined);
  assert.equal(normalizeEvent({ type: "message_end", message: { role: "user", content: [] } } as any), undefined);
});
