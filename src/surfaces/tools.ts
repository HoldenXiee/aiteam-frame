// tools 面：运行期增删工具 / 列出注册与活跃状态 / tool_result 拦截。
//
// 机制：工具表活在桥接里（`bridge.tools`），往表里改完调 `session.reload()` —— pi 重跑扩展工厂，
// 桥接把整张表重新注册给 pi（agent-session.js:2867-2880）。
//
// 两个**不能省**的细节（都在下面标了原因）：
//   1. `add` 时就把工厂调成成品再入表 —— 否则 reload 时工厂被调第二次；
//   2. `add` 时把新名字并进 pi 的 `allowedToolNames` —— 白名单是**硬过滤**，不并进去的新工具会在
//      reload 时被默默丢掉（`only: ["read"]` 下就是这条路）。
// 活跃集**不用碰**：reload 自己会把新工具激活、把去掉的工具落下（见 `add` 里的长注释）。
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Bridge } from "../agent/bridge.ts";
import type { Agent, AgentTool, ToolsSurface } from "../agent/types.ts";

export interface ToolsDeps {
  session: AgentSession;
  /** 工具表与事件监听表都住在桥接里：reload 会把它们整体接回 pi */
  bridge: Pick<Bridge, "tools" | "listeners" | "reload">;
  /** 工厂式工具的 ctx.agent —— 惰性取，agent 对象在本函数返回之后才拼好 */
  agent: () => Agent;
  /** 忙判据（R29）：与 bridge.reload / context.compact 是同一份定义 */
  isBusy: () => boolean;
  assertAlive: () => void;
}

export function createTools(deps: ToolsDeps): ToolsSurface {
  const { session, bridge } = deps;

  /** 把名字加进 pi 的 `allowedToolNames`（未设白名单时是 no-op）。
   *  只有一份真相：白名单非空就代表「运行期新登记的也要能注册」，所以 add 加、remove 减。 */
  function registerAllowed(name: string): void {
    const allowed = (session as unknown as { _allowedToolNames?: Set<string> })._allowedToolNames;
    allowed?.add(name);
  }

  function unregisterAllowed(name: string): void {
    const allowed = (session as unknown as { _allowedToolNames?: Set<string> })._allowedToolNames;
    allowed?.delete(name);
  }

  return {
    list() {
      deps.assertAlive();
      const active = new Set(session.getActiveToolNames());
      return [...bridge.tools.keys()].map((name) => ({ name, active: active.has(name) }));
    },

    async add(tool: AgentTool): Promise<void> {
      deps.assertAlive();
      // 工厂式**在这里**就调成成品（R30b）：`bridge.factory` 每次 reload 都会对表里的每个元素判一次
      // `typeof tool === "function"`；存工厂进去的话 reload 时会被调第二次（同一个 ctx 会跑两遍、
      // 工厂里的副作用也跟着跑两遍）。存成品之后那条函数分支对 add 进来的工具永不命中。
      const def = typeof tool === "function" ? tool({ agent: deps.agent() }) : tool;
      const previous = bridge.tools.get(def.name);
      if (deps.isBusy()) {
        throw new Error(
          "agent 正在运行：工具声明面的改动要走 reload，只有在空闲时才能改 —— 先 io.waitIdle()",
        );
      }
      bridge.tools.set(def.name, def);
      try {
        // 登记「可注册」：pi 的 `allowedToolNames` 是**硬过滤**（agent-session.js:2747 的
        // `_refreshToolRegistry` 里，白名单外的工具连注册表都进不去 —— 不管它是内置的、扩展的还是这里
        // 新加的）。所以白名单必须跟着长，否则 `only: ["read"]` 下 add 进去的工具会在 reload 时被
        // 默默丢掉（会话照常跑、什么都没发生 —— 正是 v2 要根除的那种静默失效）。
        registerAllowed(def.name);
        await bridge.reload();
      } catch (err) {
        if (previous === undefined) bridge.tools.delete(def.name);
        else bridge.tools.set(def.name, previous);
        unregisterAllowed(def.name);
        throw err;
      }
      // 活跃集不用手动并：reload 的 `_buildRuntime({ activeToolNames: [当前], includeAll: true })`
      // 足以让新工具落进活跃集 —— `allowedToolNames` 非空时由 2800-2806 那段补进去，为空时由
      // 2811-2816 的隐式激活补进去。实测（本任务）两条路都真的生效，所以这里不再画蛇添足：
      // 多一行 `setActiveToolsByName` 会变成没有任何用例能判别的死代码。
    },

    async remove(name: string): Promise<void> {
      deps.assertAlive();
      const previous = bridge.tools.get(name);
      if (previous === undefined) return;   // 没登记过的名字：无声明面变化，不该白跑一次 reload
      if (deps.isBusy()) {
        throw new Error(
          "agent 正在运行：工具声明面的改动要走 reload，只有在空闲时才能改 —— 先 io.waitIdle()",
        );
      }
      bridge.tools.delete(name);
      try {
        unregisterAllowed(name);
        await bridge.reload();
      } catch (err) {
        bridge.tools.set(name, previous);
        registerAllowed(name);
        throw err;
      }
      // 同理不用手动摘活跃集：reload 重建出的 registry 里已经没有这个名字了。
    },

    onResult(fn) {
      deps.assertAlive();
      let set = bridge.listeners.get("tool_result");
      if (!set) {
        set = new Set();
        bridge.listeners.set("tool_result", set);
      }
      const handler = (result: unknown, ctx: Parameters<typeof fn>[1]) => fn(result as never, ctx);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },

    get raw() {
      deps.assertAlive();
      return { getToolDefinition: (name: string) => session.getToolDefinition(name) };
    },
  };
}
