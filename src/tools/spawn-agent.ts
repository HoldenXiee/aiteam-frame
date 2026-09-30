// spawn_agent：从花名册里挑一个成员 → 起新分身 → 派活 → 拿结果。
// 设计红线：agent 不能设计 agent —— 这个工具没有 tools 参数，也不接受任何配置覆盖（规格 §0/§4.5）。
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent } from "../agent/create-agent.ts";
import { hostInternalsOf, membersOfHost } from "../agent/host.ts";
import type { AgentToolContext, MemberSpec } from "../agent/types.ts";

const TOOL_NAME = "spawn_agent";

function describeMembers(members: Record<string, MemberSpec>): string {
  const entries = Object.entries(members);
  if (!entries.length) return "（花名册是空的）";
  return entries.map(([name, spec]) => `- ${name}：${spec.description ?? "（设计者没写职责说明）"}`).join("\n");
}

export function createSpawnAgentTool(ctx: AgentToolContext): ToolDefinition {
  const members = membersOfHost(ctx.host);
  const names = Object.keys(members);

  return {
    name: TOOL_NAME,
    label: "Spawn Agent",
    description: [
      "从花名册里挑一个成员，为它起一个新的分身，把 task 交给它，等它做完并拿回结论。",
      "你不能修改成员的配置，也不能指定 cwd / 模型 / 工具集 —— 只能挑人、派活。",
      "同一个成员可以起多个分身，互不干扰。",
      "",
      "可挑选的成员：",
      describeMembers(members),
    ].join("\n"),
    parameters: Type.Object({
      member: names.length ? Type.Union(names.map((name) => Type.Literal(name))) : Type.Never(),
      task: Type.String({ description: "交给这个成员的任务" }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const { member, task } = rawParams as { member: string; task: string };
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

      if (!ctx.host) {
        return fail("spawn_agent 需要一个宿主：花名册由 createAgentHost({ members }) 提供。");
      }
      const spec = members[member];
      if (!spec) {
        const known = names.length ? names.join("、") : "（无）";
        return fail(`花名册里没有成员「${member}」。可挑选的成员只有：${known}`);
      }
      // 三道护栏：成员存在 → 深度 → 总数 → 预算；触发时把话说清楚，让父 agent 有机会换策略
      const problem = hostInternalsOf(ctx.host)?.checkCanCreate(ctx.agent);
      if (problem) return fail(`不能再起分身：${problem}`);

      const child = await createAgent({ ...spec, id: undefined }, { host: ctx.host, parent: ctx.agent, member });
      const run = await child.prompt(task);
      const head = `已让成员「${member}」处理，它的分身 id 是 ${child.id}。`;
      const body = run.error ? `它这一轮出错了：${run.error}\n已产出的文本：${run.text}` : run.text;
      return { content: [{ type: "text" as const, text: `${head}\n\n${body}` }], details: { agentId: child.id } };
    },
  };
}
