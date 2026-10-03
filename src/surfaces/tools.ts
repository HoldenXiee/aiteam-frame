// tools 面：运行期增删工具 / 列出注册与活跃状态 / tool_result 拦截。
// permissions 面：审批门 + 运行期工具集三档语义（only / allow / deny）—— 两者共用同一份
// 「pi 私有硬过滤集合」访问器，所以放在一个文件里。
//
// 机制：工具表活在桥接里（`bridge.tools`），往表里改完调 `session.reload()` —— pi 重跑扩展工厂，
// 桥接把整张表重新注册给 pi（agent-session.js:2867-2880）。
//
// 三个**不能省**的细节（都在下面标了原因）：
//   1. `add` 时就把工厂调成成品再入表 —— 否则 reload 时工厂被调第二次；
//   2. `add` 时把新名字并进 pi 的 `allowedToolNames` —— 白名单是**硬过滤**，不并进去的新工具会在
//      reload 时被默默丢掉（`only: ["read"]` 下就是这条路）；
//   3. `add` 之后**显式激活** —— reload 的隐式激活带 `defaultActive !== false` 过滤，
//      `defaultActive: false` 的工具不并就永远收不到。
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Bridge } from "../agent/bridge.ts";
import type { Agent, AgentTool, PermissionsSurface, ToolsSurface } from "../agent/types.ts";

/**
 * pi 的两张硬过滤集合都是**私有字段**（agent-session.js:135-136），pi 没有公开的增删 API：
 *   - `_allowedToolNames`：白名单（创建期为 `tools` 选项）。非空时，注册表与活跃集都只认白名单里的名字；
 *   - `_excludedToolNames`：排除集（创建期为 `excludeTools`），被排的名字连注册表都进不去。
 * 它们是**唯一扛得过 `reload()` 的一层**：`setActiveToolsByName` 只改活跃集，reload 会拿
 * `activeToolNames + includeAllExtensionTools` 重算（agent-session.js:2741-2816）—— 只改活跃集的收紧
 * 会被静默抹掉（无白名单时扩展工具还会被 `defaultActive !== false` 那条分支推回来）。
 * 导出给 `resources.ts` 用（R41：运行期加的扩展注册的工具名也要进白名单）。
 */
export function toolFilters(session: AgentSession): {
  _allowedToolNames?: Set<string>;
  _excludedToolNames?: Set<string>;
} {
  return session as unknown as {
    _allowedToolNames?: Set<string>;
    _excludedToolNames?: Set<string>;
  };
}

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
    toolFilters(session)._allowedToolNames?.add(name);
  }

  function unregisterAllowed(name: string): void {
    toolFilters(session)._allowedToolNames?.delete(name);
  }

  /** 显式 add 一定让它生效（R37）：同名 deny 必须一起解除，否则工具在 reload 时被硬过滤掉、
   *  停在 `active:false`，模型静默收不到 —— 设计者调了 add 却没生效。返回是否真的摘掉过。 */
  function unexclude(name: string): boolean {
    return toolFilters(session)._excludedToolNames?.delete(name) ?? false;
  }

  return {
    list() {
      deps.assertAlive();
      const active = new Set(session.getActiveToolNames());
      return [...bridge.tools.keys()].map((name) => ({ name, active: active.has(name) }));
    },

    async add(tool: AgentTool): Promise<void> {
      deps.assertAlive();
      // 守卫排在工厂调用**之前**：一次注定被拒绝的 add 不该让设计者工厂的副作用先跑一遍。
      if (deps.isBusy()) {
        throw new Error(
          "agent 正在运行：工具声明面的改动要走 reload，只有在空闲时才能改 —— 先 io.waitIdle()",
        );
      }
      // 工厂式**在这里**就调成成品（R30b）：`bridge.factory` 每次 reload 都会对表里的每个元素判一次
      // `typeof tool === "function"`；存工厂进去的话 reload 时会被调第二次（同一个 ctx 会跑两遍、
      // 工厂里的副作用也跟着跑两遍）。存成品之后那条函数分支对 add 进来的工具永不命中。
      const def = typeof tool === "function" ? tool({ agent: deps.agent() }) : tool;
      const previous = bridge.tools.get(def.name);
      bridge.tools.set(def.name, def);
      // 排在 reload 之前：这次 reload 必须看得到「排除集里已经没有它」
      const wasExcluded = unexclude(def.name);
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
        // 白名单只在「这个名字原先没登记过」时才该摘回去：重加同名工具时，此前那次成功的 add 已
        // 合法把它写进白名单，无条件摘掉会留下「表里有、白名单没」→ 模型静默收不到。
        if (previous === undefined) unregisterAllowed(def.name);
        if (wasExcluded) toolFilters(session)._excludedToolNames?.add(def.name);
        throw err;
      }
      // add 是设计者「我要它」的显式动作，必须真的 active。reload 的隐式激活那条路带
      // `_isActivatedOnRegistration` 过滤（`defaultActive !== false`，agent-session.js:2829-2831）；
      // 无白名单 + `defaultActive: false` 的工具因此 reload 后仍是 active:false、模型静默收不到。
      // 这里显式并入 active set：`_applyToolLoadout`（:1098-1102）只做去重 + 注册表查找 + 非 hidden，
      // 没有 defaultActive 过滤。
      session.setActiveToolsByName([...session.getActiveToolNames(), def.name]);
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

export interface PermissionsDeps {
  session: AgentSession;
  /** 审批门槽位（与 context.override 并列的专属槽位）+ 声明面重载。`onResult` **不是**槽位：它是在
   *  `tool_result` 事件上注册的普通监听器（`bridge.listeners` 的同一个 Set），可多次注册、按注册顺序派发 */
  bridge: Pick<Bridge, "gate" | "reload">;
  /** 忙判据（R29）：与 bridge.reload / tools 面共用同一份定义 */
  isBusy: () => boolean;
  assertAlive: () => void;
}

/**
 * 运行期工具集三档语义（R38）。主机制是**一层**：改 pi 的两张硬过滤集合（白名单 / 排除集）
 * + 一次 `reload()`（reload 同时决定注册表过滤与活跃集）。只有 `allow` 额外补一步活跃集
 * `setActiveToolsByName`（原因见那里的注释：无白名单时 reload 不把非扩展工具推回活跃集）。
 * 与 `tools.add` / `remove` 同形：async、碰声明面、要求 idle。
 */
export function createPermissions(deps: PermissionsDeps): PermissionsSurface {
  const { session } = deps;
  const filters = () => toolFilters(session);

  // 与 tools 面的 add/remove 同一条守卫、同一个判据（R29）。必须排在改集合**之前**：
  // 否则改完集合才在 reload 里撞忙，会留下「集合改了、注册表没重建」的半应用状态。
  function assertIdle(): void {
    if (deps.isBusy()) {
      throw new Error(
        "agent 正在运行：工具声明面的改动要走 reload，只有在空闲时才能改 —— 先 io.waitIdle()",
      );
    }
  }

  return {
    gate(fn) {
      deps.assertAlive();
      deps.bridge.gate = fn;    // 单槽位：后一次覆盖前一次
    },

    async only(names) {
      deps.assertAlive();
      assertIdle();
      // 「精确就是这些」只有白名单表达得出来：无白名单时 reload 会把扩展工具按 `defaultActive` 推回活跃集。
      const f = filters();
      f._allowedToolNames = new Set(names);
      // 被排除集点过名的名字永远进不了注册表 —— 与 only 的语义冲突（后一次覆盖前一次）
      if (f._excludedToolNames) for (const name of names) f._excludedToolNames.delete(name);
      await deps.bridge.reload();
    },

    async allow(names) {
      deps.assertAlive();
      assertIdle();
      const f = filters();
      // 有白名单才需要并进去：没有白名单时 reload 不会筛掉任何名字，硬造一份「当前允许的名字」当白名单
      // 反而会把 pi 扩展后来注册的工具一起静默关掉。
      if (f._allowedToolNames) for (const name of names) f._allowedToolNames.add(name);
      if (f._excludedToolNames) for (const name of names) f._excludedToolNames.delete(name);   // allow 覆盖之前的 deny
      await deps.bridge.reload();
      // reload **不够**这一档（这是 `setActiveToolsByName` 唯一幸存的地方）：无白名单时
      // `_refreshToolRegistry` 只把**扩展工具**按 `defaultActive` 推回活跃集（agent-session.js:2808-2816），
      // 内置工具里没被点名过的不会自己回来 —— 创建期被 `deny` 筛掉的 `bash` 就是这种：从排除集摘掉 + reload
      // 后它进了注册表，但仍然不在活跃集里（用例「allow 能推翻创建期的 deny」判别到这一点）。
      // 所以必须显式并入；且这一步是**稳定**的：下一次 reload 拿它当 `activeToolNames` 原样带去。
      session.setActiveToolsByName([...session.getActiveToolNames(), ...names]);
    },

    async deny(names) {
      deps.assertAlive();
      assertIdle();
      const f = filters();
      if (f._allowedToolNames) {
        // 白名单层删掉就够；**不**顺手记进排除集 —— 排除集是硬过滤，会让后续的 allow 永远进不来
        for (const name of names) f._allowedToolNames.delete(name);
      } else {
        // 无白名单：只把点名的这几个记进排除集，**不**把当前允许的名字物化成白名单
        // （那会连带关掉 pi 扩展事后注册的工具）。与创建期 `permissions.deny` 走同一个字段。
        f._excludedToolNames ??= new Set();
        for (const name of names) f._excludedToolNames.add(name);
      }
      await deps.bridge.reload();
    },
  };
}
