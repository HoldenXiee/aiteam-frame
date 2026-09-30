// E3：onToolCall 返回 {block:true} 之后，模型到底看到什么？
// ground truth = session.messages 里的 toolResult 正文 + 后续请求的完整 payload + RunResult.text。
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent } from "../../src/index.ts";
import { makeEnv2 } from "./_srv.ts";
import { sleep } from "../../test/faux-server.ts";
import { save } from "./_data.ts";

const env = await makeEnv2();
const rows: any[] = [];
const rec = (k: string, v: any) => {
  rows.push({ case: k, ...v });
  console.log(`  ▶ ${k}: ${JSON.stringify(v)}`);
};

const echoTool = defineTool({
  name: "probe_echo",
  label: "Probe Echo",
  description: "回显参数里的 text",
  parameters: Type.Object({ text: Type.Optional(Type.String()) }),
  execute: async (_id: string, params: any) => ({ content: [{ type: "text" as const, text: `probe-echo-ran:${params.text ?? ""}` }], details: {} }),
});

/** 把 session 里的 toolResult 与事件都摊开 */
function toolResultsOf(a: any) {
  return (a.session.messages as any[])
    .filter((m) => m.role === "toolResult" || m.role === "tool")
    .map((m) => ({
      role: m.role,
      isError: m.isError ?? null,
      toolName: m.toolName ?? null,
      text: (m.content ?? []).map((c: any) => c?.text ?? "").join("").slice(0, 300),
    }));
}
const runCase = async (name: string, onToolCall: any, prompt = '[[tool:probe_echo]] [[args:{"text":"hi"}]]') => {
  const from = env.srv.calls.length;
  const events: string[] = [];
  const gateCalls: any[] = [];
  const gateIn = onToolCall
    ? async (call: any) => {
        gateCalls.push(call);
        return onToolCall(call);
      }
    : undefined;
  const a = await createAgent(
    { model: env.model, cwd: env.cwd, agentDir: env.agentDir, tools: ["probe_echo"], customTools: [echoTool], ...(gateIn ? { onToolCall: gateIn } : {}) },
    { modelRuntime: env.runtime },
  );
  for (const ev of ["tool_start", "tool_end", "error", "done"] as const) a.on(ev, (p: any) => events.push(`${ev}:${JSON.stringify(p)}`));
  const outcome = await a.prompt(prompt).then((r) => ({ ok: true, text: r.text, error: r.error ?? null }), (e: any) => ({ ok: false, throw: e.message }));
  await sleep(200);
  rec(name, {
    门被调用次数与入参: gateCalls,
    结果: outcome,
    模型看到的消息: toolResultsOf(a),
    事件: events,
    库可观察量: { status: a.status, lastResultError: a.lastResult?.error ?? null, usage: a.usage.totalTokens, pending: a.session.pendingMessageCount },
    请求次数: env.srv.calls.length - from,
    请求正文: env.srv.digest(from),
  });
  a.dispose();
  return gateCalls;
};

console.log("═══ E3-0 对照：没有审批门 ═══");
await runCase("ctl/no-gate", undefined);

console.log("\n═══ E3-1 门返回 {block:true, reason} ═══");
{
  const gate = async (call: any) => {
    console.log(`     门收到：${JSON.stringify(call)}`);
    return { block: true as const, reason: "审计拦截理由：BLOCK-REASON-7F3A" };
  };
  await runCase("gate/block-with-reason", gate);
}

console.log("\n═══ E3-2 门返回 {block:true}（不带 reason）═══");
await runCase("gate/block-no-reason", async () => ({ block: true as const }));

console.log("\n═══ E3-3 门自己抛错 ═══");
await runCase("gate/throws", async () => {
  throw new Error("审计：门内部炸了 GATE-BOOM");
});

console.log("\n═══ E3-4 门返回错形状（true，而不是 {block:true}）═══");
await runCase("gate/wrong-shape-true", (async () => true) as any);

console.log("\n═══ E3-5 门返回 undefined（放行）═══");
await runCase("gate/allow", async () => undefined);

console.log("\n═══ E3-6 门返回 {block:false}（设计者以为这是「放行」）═══");
await runCase("gate/block-false", (async () => ({ block: false })) as any);

console.log("\n═══ E3-7 门返回 false（真值判断下的放行）═══");
await runCase("gate/literal-false", (async () => false) as any);

console.log("\n═══ E3-8 门返回 {} ═══");
await runCase("gate/empty-object", (async () => ({})) as any);

save("e3", rows);
await env.srv.close();
