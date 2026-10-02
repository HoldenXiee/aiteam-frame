// context 面：历史（只读） / 上下文占用 / 自动压缩开关 / 本轮 override / 手动压缩 / raw 逃生口。
//
// `override` 的语义由 spike/FINDINGS.md S2 实测钉死：改的是「**这一轮**发给模型的」内容，逐轮生效、
// 不动 `session.messages`；pi 传给钩子的是副本，所以历史不会被写坏。
// 钩子拿到的是**不含 system** 的消息 —— 所以 `history` 也用同一视角（system 每轮由 pi 重建，不是历史），
// 这样 `override(history)` 才是恒等变换。
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Bridge } from "../agent/bridge.ts";
import type { ContextSurface } from "../agent/types.ts";

export interface ContextDeps {
  session: AgentSession;
  sessionManager: SessionManager;
  /** override 存进桥接的专属槽位：派发 `context` 时排在监听表之前取用，并与监听表共用同一守卫（R26） */
  bridge: Pick<Bridge, "contextOverride">;
  assertAlive: () => void;
}

export function createContext(deps: ContextDeps): ContextSurface {
  const { session, sessionManager, bridge } = deps;
  return {
    get history() {
      deps.assertAlive();
      return session.messages.filter((m) => m.role !== "system");
    },
    get usage() {
      deps.assertAlive();
      return session.getContextUsage();
    },
    get autoCompact() {
      deps.assertAlive();
      return session.autoCompactionEnabled;
    },
    set autoCompact(enabled: boolean) {
      deps.assertAlive();
      session.setAutoCompactionEnabled(enabled);
    },
    override(next) {
      deps.assertAlive();
      // 数组形式 = 「不管给进来什么都不管，就发这一组」——忽略入参即可，与函数形式同义
      bridge.contextOverride = next === undefined ? undefined : typeof next === "function" ? next : () => next;
    },
    async compact(instructions) {
      deps.assertAlive();
      await session.compact(instructions);
    },
    get raw() {
      deps.assertAlive();
      return { session, sessionManager };
    },
  };
}
