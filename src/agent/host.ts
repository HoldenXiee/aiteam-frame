// AgentHost：花名册、护栏计数、宿主观测事件、级联回收。
// 这里是**唯一**的宿主登记入口，用模块内的 symbol 键挂在 host 对象上 ——
// 刻意不提供 host.createAgent()，否则会出现第二条创建路径（规格「已定」）。
import type {
  AgentHost,
  ControlledAgent,
  HostEventMap,
  HostOptions,
  MemberSpec,
  ModelRuntime,
  RunResult,
  Usage,
} from "./types.ts";
import { addUsage, emptyUsage } from "./usage.ts";

export const HOST_INTERNALS = Symbol("aiteam.hostInternals");

/** createAgent 只认这一组内部钩子，不认 host 的具体实现 */
export interface HostInternals {
  defaults: Partial<MemberSpec>;
  modelRuntime: ModelRuntime | undefined;
  register(agent: ControlledAgent): void;
  /** spawn 之前的预检（不登记）：返回违反的那条护栏说明，没违反返回 undefined */
  checkCanCreate(parent: ControlledAgent | undefined): string | undefined;
  roundCompleted(agent: ControlledAgent, result: RunResult): void;
  agentDisposed(agent: ControlledAgent): void;
}

const DEFAULT_MAX_AGENTS = 16;
const DEFAULT_MAX_DEPTH = 2;

export function createAgentHost(opts: HostOptions = {}): AgentHost {
  const members: Record<string, MemberSpec> = opts.members ?? {};
  const maxAgents = opts.maxAgents ?? DEFAULT_MAX_AGENTS;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const budgetTokens = opts.budgetTokens;
  const agents = new Map<string, ControlledAgent>();
  const listeners = new Map<keyof HostEventMap, Set<(payload: any) => void>>();
  /** 全生命周期分身总数（回收也不减），maxAgents 卡的就是它 */
  let created = 0;
  let usage: Usage = emptyUsage();

  function emit<E extends keyof HostEventMap>(event: E, payload: HostEventMap[E]): void {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  }

  /** 三道护栏的单一出处；顺序固定：深度 → 总数 → 预算 */
  function limitProblem(depth: number): string | undefined {
    if (depth > maxDepth) return `分身深度 ${depth} 超过 maxDepth=${maxDepth}，不能再往下一层`;
    if (created >= maxAgents) return `宿主已达到 maxAgents=${maxAgents} 的分身上限，不能再创建`;
    if (budgetTokens !== undefined && usage.totalTokens >= budgetTokens) {
      return `宿主预算已耗尽（budgetTokens=${budgetTokens}，已用 ${usage.totalTokens}）`;
    }
    return undefined;
  }

  function depthOf(agent: ControlledAgent): number {
    let depth = 0;
    let current: ControlledAgent | undefined = agent;
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      const parent = agents.get(current.parentId);
      if (!parent) return depth + 1; // 父不在本宿主：按「有父」保守算
      depth += 1;
      current = parent;
    }
    return depth;
  }

  const internals: HostInternals = {
    defaults: opts.defaults ?? {},
    modelRuntime: opts.modelRuntime,
    register(agent) {
      if (agents.has(agent.id)) {
        throw new Error(`宿主里已经有 id=${agent.id} 的分身，id 必须唯一`);
      }
      const problem = limitProblem(depthOf(agent));
      if (problem) throw new Error(problem);
      agents.set(agent.id, agent);
      created += 1;
      emit("agent_created", {
        agent,
        member: agent.member,
        parent: agent.parentId ? agents.get(agent.parentId) : undefined,
      });
    },
    checkCanCreate(parent) {
      return limitProblem(parent ? depthOf(parent) + 1 : 0);
    },
    roundCompleted(agent, result) {
      usage = addUsage(usage, result.usage);
      emit("round_completed", { agent, result });
    },
    agentDisposed(agent) {
      // 只删自己：登记失败（重复 id）时被回收的那个不该把同名旧分身删掉
      if (agents.get(agent.id) !== agent) return;
      agents.delete(agent.id);
      emit("agent_disposed", { agent });
    },
  };

  const host = {
    get usage() {
      return usage;
    },
    get activeCount() {
      return agents.size;
    },
    get members() {
      return members;
    },
    maxAgents,
    maxDepth,
    budgetTokens,
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    on: (event: keyof HostEventMap, fn: (payload: any) => void) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return () => set.delete(fn);
    },
    // 先 abort 再回收的时序由 agent.dispose() 自己保证（它知道 session 是否在跑）
    dispose: () => {
      for (const agent of [...agents.values()]) agent.dispose();
    },
    [HOST_INTERNALS]: internals,
  };

  return host as unknown as AgentHost;
}

/** 从 host 上取内部钩子（不是公开接口的一部分） */
export function hostInternalsOf(host: AgentHost | undefined): HostInternals | undefined {
  if (!host) return undefined;
  return (host as unknown as { [HOST_INTERNALS]?: HostInternals })[HOST_INTERNALS];
}

/** 花名册（供 spawn_agent 用）；不是公开接口的一部分 */
export function membersOfHost(host: AgentHost | undefined): Record<string, MemberSpec> {
  return host ? (host as unknown as { members: Record<string, MemberSpec> }).members : {};
}
