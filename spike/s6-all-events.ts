// S6：给全部 41 个 on() 事件挂 no-op handler，会不会改变 pi 的行为？
// pi 内部用 hasHandlers() 决定走不走扩展分支（17 处），所以「全注册」不是免费的。
// 判据：与「完全不加扩展」跑同一段脚本，比较模型实际收到的东西。
import { check, head, rig, type Rig } from "./_pi.ts";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

head("S6 全事件注册是否改变行为");

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
      return undefined; // no-op：什么都不改
    });
  }
};

const echo: InlineExtension = (pi) => {
  pi.registerTool(
    defineTool({
      name: "probe_echo",
      label: "Probe Echo",
      description: "回显",
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      execute: async () => ({ content: [{ type: "text" as const, text: "echo-ok" }], details: {} }),
    }),
  );
};

/** 同一段脚本，两个环境各跑一遍 */
async function scenario(factories: InlineExtension[]) {
  const r: Rig = await rig(factories);
  const errors: string[] = [];
  try {
    await r.session.prompt("one");
    await r.session.prompt("[[tool:probe_echo]]");
    await r.session.prompt("three");
  } catch (err) {
    errors.push(String(err));
  }
  const snapshot = {
    errors,
    calls: r.calls.map((c) => ({
      model: c.model,
      tools: c.tools.join(","),
      messageCount: c.messageCount,
      lastUser: c.lastUser,
      systemLen: c.system.length,
    })),
    sessionRoles: (r.session.messages as any[]).map((m) => m.role).join(","),
    sessionTexts: (r.session.messages as any[])
      .filter((m) => m.role === "assistant")
      .map((m) => (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""))
      .join("|"),
  };
  await r.close();
  return snapshot;
}

const baseline = await scenario([echo]);
const withAll = await scenario([echo, allEvents]);

console.log(`\n  基线（只挂 echo 工具）请求 ${baseline.calls.length} 次；全事件组 ${withAll.calls.length} 次`);
console.log(`  全事件组实际被触发的事件：${[...new Set(fired)].sort().join(",") || "(无)"}`);

check("请求次数一致", baseline.calls.length === withAll.calls.length, `${baseline.calls.length} vs ${withAll.calls.length}`);
check(
  "每次请求的 messageCount 一致",
  JSON.stringify(baseline.calls.map((c) => c.messageCount)) === JSON.stringify(withAll.calls.map((c) => c.messageCount)),
  `${baseline.calls.map((c) => c.messageCount).join(",")} vs ${withAll.calls.map((c) => c.messageCount).join(",")}`,
);
check(
  "每次请求的 tools 声明一致",
  JSON.stringify(baseline.calls.map((c) => c.tools)) === JSON.stringify(withAll.calls.map((c) => c.tools)),
  withAll.calls.map((c) => c.tools).join(" / "),
);
check(
  "system 提示词长度一致",
  JSON.stringify(baseline.calls.map((c) => c.systemLen)) === JSON.stringify(withAll.calls.map((c) => c.systemLen)),
  `${baseline.calls.map((c) => c.systemLen).join(",")} vs ${withAll.calls.map((c) => c.systemLen).join(",")}`,
);
check(
  "会话消息序列一致",
  baseline.sessionRoles === withAll.sessionRoles,
  `roles: ${baseline.sessionRoles} vs ${withAll.sessionRoles}`,
);
check("assistant 产出文本一致", baseline.sessionTexts === withAll.sessionTexts, `${baseline.sessionTexts} vs ${withAll.sessionTexts}`);
check("两边都没有报错", baseline.errors.length === 0 && withAll.errors.length === 0, JSON.stringify([...baseline.errors, ...withAll.errors]));