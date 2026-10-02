// demo/cluster.ts —— 一个最小但要紧的 agent 集群：主持人 + 三个工人 + 一块共享黑板。
//
// 这里演示这个库最核心的一件事：**花名册只有设计者能写**。
//   · 设计者声明成员：职责 / 模型 / 工具集 / 角色 —— 见下面的 members
//   · agent 只能「从花名册里挑一个成员 + 告诉它干什么」—— lead 手上的 spawn_agent / send_message
//   · 它挑不出花名册以外的人，也改不了上面任何一个字（spawn_agent 没有 tools 参数）
//   · 「共享上下文」不需要框架支持：全队同一个 cwd，读写同一个文件就是黑板
import { join } from "node:path";
import {
  createAgent,
  createAgentHost,
  type AgentHost,
  type ControlledAgent,
  type MemberSpec,
  type RunResult,
} from "../src/index.ts";
import { MODEL, envSpec, WORK_DIR } from "./env.ts";
import { oneLine, say } from "./log.ts";

export const TOPIC = "aiteam 这个库能拿来做 agent 集群吗";
export const BOARD = join(WORK_DIR, "blackboard.md");
export const REPORT = join(WORK_DIR, "report.md");

/** 花名册：agent 只能从这里面挑人；每个成员的模型 / 工具集 / 角色都由设计者定死 */
export const members: Record<string, MemberSpec> = {
  lead: {
    description: "主持人：挑人、派活、把结论汇总",
    role: "你是主持人。只从花名册里挑人，一次只派一件活；派活时把要用到的绝对路径原样写进任务里。回答尽量短。",
    tools: ["spawn_agent", "send_message"],
  },
  scout: {
    description: "侦察员：把要点写进黑板文件",
    role: "你只写文件，写完回一行确认，不解释。",
    tools: ["read", "write", "env_probe"],
  },
  checker: {
    description: "核对员：读黑板，回一行结论",
    role: "你只读文件，回一行不超过 30 字的结论。",
    tools: ["read"],
  },
  scribe: {
    description: "书记员：把交给它的结论写成 md 文件",
    role: "你只写文件，写完回一行确认，不解释。",
    tools: ["read", "write"],
  },
};

export interface ClusterRun {
  host: AgentHost;
  lead: ControlledAgent;
  /** lead 每一轮的结果 —— 用来核对 agent.usage 是不是各轮之和 */
  leadRuns: RunResult[];
  rounds: Map<string, number>;
  /** 归一化的 7 个 agent 事件里，集群里真出现过的那几个 */
  events: { text: number; tool_start: number; tool_end: number; turn: number; done: number };
  /** 集群里所有分身调用过的工具名 */
  toolCalls: string[];
}

/**
 * 起一个宿主、跑三轮派活。
 * 三道护栏都开着：最多 8 个分身、最多 2 层、全宿主 20 万 token。
 */
export async function runCluster(): Promise<ClusterRun> {
  const rounds = new Map<string, number>();
  const events = { text: 0, tool_start: 0, tool_end: 0, turn: 0, done: 0 };
  const toolCalls: string[] = [];

  const host = createAgentHost({
    // defaults 是所有成员的基线，被成员定义覆盖（defaults ← members[x] ← 顶层 spec）
    defaults: { ...envSpec, model: MODEL },
    members,
    maxAgents: 8,
    maxDepth: 2,
    budgetTokens: 200_000,
  });

  // 库只发事件，不内置任何监控策略 —— 想看什么就自己挂
  const watch = (agent: ControlledAgent): void => {
    agent.on("text", ({ delta }) => (events.text += delta.length));
    agent.on("tool_start", ({ toolName }) => {
      events.tool_start += 1;
      toolCalls.push(toolName);
    });
    agent.on("tool_end", () => (events.tool_end += 1));
    agent.on("turn", () => (events.turn += 1));
    agent.on("done", () => (events.done += 1));
  };

  host.on("agent_created", ({ agent, member }) => {
    watch(agent);
    say(`  · 分身就位 ${member ?? "(顶层)"} ${agent.id}`);
  });
  host.on("round_completed", ({ agent, result }) => {
    rounds.set(agent.id, (rounds.get(agent.id) ?? 0) + 1);
    say(`  · ${agent.member}(${agent.id}) 跑完一轮 +${result.usage.totalTokens} tokens`);
  });
  host.on("agent_disposed", ({ agent }) => say(`  · 分身回收 ${agent.id}`));

  // 顶层也是从花名册里挑出来的一个成员
  const lead = await createAgent({ ...members.lead, id: "lead" }, { host, member: "lead" });
  const leadRuns: RunResult[] = [];

  leadRuns.push(
    await lead.prompt(
      `第一件事，只做这一件：用 spawn_agent 挑成员 scout，让它把「${TOPIC}」的三条要点写进 ${BOARD}。\n` +
        `要求：每条一行、以「- 」开头；写完后再调用一次 env_probe，把 env_probe 的返回也追加成一行。`,
    ),
  );

  leadRuns.push(
    await lead.prompt(
      `第二件事，只做这一件：用 spawn_agent 挑成员 checker，让它读 ${BOARD}，回一行不超过 30 字的结论。`,
    ),
  );

  const verdict = host.list().find((a) => a.member === "checker")?.lastResult?.text ?? "";
  leadRuns.push(
    await lead.prompt(
      `第三件事，只做这一件：用 spawn_agent 挑成员 scribe，让它把下面这句结论原样写进 ${REPORT}：\n「${oneLine(verdict, 120)}」`,
    ),
  );

  // 派活是同步等结果的，这里只是兜底
  await Promise.all(host.list().map((a) => a.waitForIdle()));

  return { host, lead, leadRuns, rounds, events, toolCalls };
}
