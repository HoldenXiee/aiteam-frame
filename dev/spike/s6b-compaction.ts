// S6b：补 S6 没覆盖到的守卫路径 —— 尤其 session_before_compact（自动压缩）。
// 只要挂了 handler，pi 就会走扩展分支；压缩走错分支的代价是「上下文被错误处理」。
import { check, head, rig, type Rig } from "./_pi.ts";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

head("S6b 压缩路径是否被 no-op handler 改变");

const EVENT_NAMES = [
  "after_provider_response", "agent_before_settle", "agent_end", "agent_settled", "agent_start",
  "before_agent_start", "before_provider_headers", "before_provider_request", "cache_warming_decision",
  "context", "context_with_system", "input", "mcp_servers_change", "message_end", "message_start",
  "message_update", "model_select", "project_trust", "provider_stream_event", "resources_discover",
  "session_before_compact", "session_before_fork", "session_before_switch", "session_before_tree",
  "session_compact", "session_compact_failed", "session_info_changed", "session_shutdown",
  "session_start", "session_tree", "thinking_level_select", "tool_call", "tool_execution_end",
  "tool_execution_start", "tool_execution_update", "tool_result", "turn_end", "turn_start",
  "ui_prompt_end", "ui_prompt_start", "user_bash",
];

const fired: string[] = [];
const allEvents: InlineExtension = (pi) => {
  for (const name of EVENT_NAMES) {
    (pi as any).on(name, () => {
      fired.push(name);
      return undefined;
    });
  }
};

async function overflow(factories: InlineExtension[]) {
  const r: Rig = await rig(factories);
  const errors: string[] = [];
  let compactResult = "未尝试";
  try {
    await r.session.prompt("[[huge:900000]] 撑爆上下文");
    await r.session.prompt("overflow 之后还能不能干活");
  } catch (err) {
    errors.push(String(err).slice(0, 200));
  }
  // 直接打 session_before_compact / session_compact 这两个守卫路径（上一步没触发它们）
  try {
    await r.session.compact("把对话压成一句");
    compactResult = "成功";
  } catch (err) {
    compactResult = `抛错：${String(err).slice(0, 200)}`;
  }
  const out = {
    errors,
    compactResult,
    compactFired: fired.filter((f) => f.includes("compact")),
    messageCounts: r.calls.map((c) => c.messageCount),
    requests: r.calls.length,
    sessionMessages: r.session.messages.length,
    lastText: (r.session.messages as any[])
      .filter((m) => m.role === "assistant")
      .map((m) => (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").slice(0, 40))
      .join(" | "),
  };
  await r.close();
  return out;
}

const baseline = await overflow([]);
const withAll = await overflow([allEvents]);

console.log(`\n  基线：请求 ${baseline.requests} 次，会话消息 ${baseline.sessionMessages} 条，compact=${baseline.compactResult}`);
console.log(`  全事件：请求 ${withAll.requests} 次，会话消息 ${withAll.sessionMessages} 条，compact=${withAll.compactResult}`);
console.log(`  压缩相关事件触发：${withAll.compactFired.join(",") || "(未触发)"}`);
console.log(`  基线错误：${baseline.errors.join("；") || "无"}`);
console.log(`  全事件错误：${withAll.errors.join("；") || "无"}`);

check("compact() 真的跑到了扩展分支（session_before_compact 被触发）", withAll.compactFired.includes("session_before_compact"), withAll.compactFired.join(","));
check("两边 compact 结局一致", baseline.compactResult === withAll.compactResult, `${baseline.compactResult} vs ${withAll.compactResult}`);

check("两边都没有报错", baseline.errors.length === 0 && withAll.errors.length === 0);
check("请求次数一致", baseline.requests === withAll.requests, `${baseline.requests} vs ${withAll.requests}`);
check(
  "每次请求的消息数一致",
  JSON.stringify(baseline.messageCounts) === JSON.stringify(withAll.messageCounts),
  `${baseline.messageCounts.join(",")} vs ${withAll.messageCounts.join(",")}`,
);
check("会话最终消息数一致", baseline.sessionMessages === withAll.sessionMessages, `${baseline.sessionMessages} vs ${withAll.sessionMessages}`);
check("最终产出一致", baseline.lastText === withAll.lastText, `${baseline.lastText} vs ${withAll.lastText}`);