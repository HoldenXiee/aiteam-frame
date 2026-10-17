// S3b：reload 把旧扩展运行器 invalidate 掉了 —— 桥接的钩子之后还生效吗？
// §3.4「常驻桥接扩展」成立的前提。顺带确认 session_shutdown 会在 running 中发出。
import { check, head, rig, sleep } from "./_pi.ts";
import { defineTool, type InlineExtension, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

head("S3b reload 之后钩子是否还活着");

const gateLog: string[] = [];
const lifecycle: string[] = [];

const slowTool: ToolDefinition = defineTool({
  name: "probe_slow",
  label: "Slow",
  description: "慢工具",
  parameters: Type.Object({}),
  execute: async () => {
    await sleep(900);
    return { content: [{ type: "text" as const, text: "slow done" }], details: {} };
  },
}) as ToolDefinition;

const newTool: ToolDefinition = defineTool({
  name: "probe_added",
  label: "Added",
  description: "reload 之后才加进来的工具",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text" as const, text: "added done" }], details: {} }),
}) as ToolDefinition;

const table = new Map<string, ToolDefinition>([["probe_slow", slowTool]]);

const bridge: InlineExtension = (pi) => {
  // 桥接 = 每次 reload 重跑，把内存表接回 pi；同时挂审批门
  for (const t of table.values()) pi.registerTool(t);
  pi.on("tool_call", (event) => {
    gateLog.push(event.toolName);
    return undefined;
  });
  pi.on("session_shutdown", (event) => {
    lifecycle.push(`shutdown:${(event as any).reason ?? "?"}`);
  });
};

const r = await rig([bridge]);
try {
  // ── 运行中 reload ──
  const p = r.session.prompt("[[tool:probe_slow]]");
  p.catch(() => {});
  await sleep(300);
  await r.session.reload();
  await p;

  check("运行中 reload 期间门被调用过（这轮的工具调用）", gateLog.includes("probe_slow"), gateLog.join(","));
  check("running 中 reload 会发 session_shutdown", lifecycle.some((x) => x.includes("reload")), lifecycle.join(","));

  // ── reload 之后：再加一个工具，再看门是否还生效 ──
  gateLog.length = 0;
  table.set("probe_added", newTool);
  await r.session.reload();
  await r.session.prompt("[[tool:probe_added]]");

  check("reload 之后门仍被调用（桥接没死）", gateLog.includes("probe_added"), gateLog.join(","));
  check(
    "reload 之后新加的工具对模型可见",
    (r.lastCall()?.tools ?? []).includes("probe_added"),
    (r.lastCall()?.tools ?? []).join(","),
  );

  // ── 再来一次，确认不是"只活一次" ──
  gateLog.length = 0;
  await r.session.reload();
  await r.session.prompt("[[tool:probe_added]]");
  check("第二次 reload 后门依然生效（可反复）", gateLog.includes("probe_added"), gateLog.join(","));

  console.log(`  生命周期事件：${lifecycle.join(" | ")}`);
  console.log(`  假服务收到 ${r.calls.length} 次请求`);
} finally {
  await r.close();
}