// context 面：历史（只读） / 上下文占用 / 自动压缩开关 / 本轮 override / 手动压缩 / raw 逃生口。
//
// `override` 的语义由 spike/FINDINGS.md S2 实测钉死：改的是「**这一轮**发给模型的」内容，逐轮生效、
// 不动 `session.messages`；pi 传给钩子的是副本，所以历史不会被写坏。
// 钩子拿到的是**不含 system** 的消息 —— 所以 `history` 也用同一视角（system 每轮由 pi 重建，不是历史），
// 这样 `override(history)` 才是恒等变换。
import type { AgentSession, ContextEditableContent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Bridge } from "../agent/bridge.ts";
import type { AgentMessage, ContextSurface } from "../agent/types.ts";

export interface ContextDeps {
  session: AgentSession;
  sessionManager: SessionManager;
  /** override 存进桥接的专属槽位：派发 `context` 时排在监听表之前取用，并与监听表共用同一守卫（R26） */
  bridge: Pick<Bridge, "contextOverride">;
  /** 忙判据（R29）：与 bridge.reload / tools.add 是**同一份**定义（createAgent 注入），compact 的 idle 守卫用 */
  isBusy: () => boolean;
  assertAlive: () => void;
}

/** 一条模型可见消息里的纯文本（content 可能是字符串、也可能是块数组；bashExecution 这类没有 content） */
function textOf(message: AgentMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return (content as readonly { type?: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

export function createContext(deps: ContextDeps): ContextSurface {
  const { session, sessionManager, bridge } = deps;

  // replace / erase 共用的寻址：按 entry.id 在**投影**里找目标。
  // 不带 `messages.length > 0` 过滤：已被抹除的条目仍可寻址（重复 erase 不报错，而不是「找不到」）。
  const findEntry = (entryId: string) =>
    sessionManager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === entryId);

  // 两个写成员共用的落库 + 刷新（控制器裁定）：
  //   `appendContextEdit` 是 append-only entry，不改原 entry、**不**刷新 `session.messages`，
  //   而 `context.history` 读的正是后者 —— 不调 `refreshContext()` 就看不到改动。
  //   这里不调 `deps.isBusy()`：append-only 不走 `reload()`，在飞的那轮不会被静默丢改动。
  const appendEdit = (entryId: string, replacement: { content: ContextEditableContent } | null) => {
    deps.assertAlive();
    if (!findEntry(entryId)) {
      throw new Error(
        `找不到 entry：${entryId} —— id 来自 context.entries()，不存在的 id 不静默 no-op`,
      );
    }
    sessionManager.appendContextEdit(entryId, replacement);
    session.refreshContext();
  };

  return {
    get history() {
      deps.assertAlive();
      return session.messages.filter((m) => m.role !== "system");
    },
    entries() {
      deps.assertAlive();
      // 数据源是 session 的投影：它是**压缩感知 + 上下文编辑后**的模型可见结果，与 `history` 同源同序。
      //
      // 「过滤掉 role === 'system' 之后与 history 一一对应」成立的理由：除压缩 entry 外，每个 entry 恰好投影出一条消息；
      // 压缩 entry 在有 systemMessage 时投影出两条 `[systemMessage, summary]`（pi `sessionEntryToContextMessages`），
      // 多出的那条**恒为 system**，而 `history` 本就不含 system —— 所以两边各少一条，基数是配的。
      // 据此 role 必须取**第一条非 system**：若取 `messages[0]`，压缩 entry 会被贴上 system 标签而在「role !== 'system'」
      // 这类口径下被整条丢掉，但它的 summary 在 history 里是**非 system**、不会被丢 —— 对齐关系就此破掉。
      // 要保留的语义：只有 system 消息的 entry（独立的 system 条目）仍然出现，用 role 区分。
      // `messages` 为空的项是状态型 entry（model 切换 / thinking 档 / context_edit 这类），对模型上下文没有贡献，
      // 所以不在这里出现。
      return sessionManager
        .buildSessionProjection()
        .entries.filter((entry) => entry.messages.length > 0)
        .map((entry) => ({
          id: entry.sourceEntry.id,
          // 第一条非 system；整个 entry 全是 system 时回退到第一条
          role: (entry.messages.find((m) => m.role !== "system") ?? entry.messages[0]).role,
          preview: entry.messages.map(textOf).join("").slice(0, 60),
        }));
    },
    async replace(entryId, content) {
      // `type: "text"` 要收窄成字面量，形状取自 pi 的 ContextEditableContent（不自己发明类型）
      appendEdit(entryId, { content: [{ type: "text" as const, text: content }] });
    },
    async erase(entryId) {
      // replacement 为 null = 把目标从模型上下文里省掉（原 entry 不动）
      appendEdit(entryId, null);
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
      // pi 的 session.compact() **首行就是 await abort()**（dist/core/agent-session.js:2101）：运行中调用会
      // 静默打断在飞的那轮。规格只说「async、真跑一轮」，这道守卫是本库自己加的（R27）。
      // 判据是 createAgent 的唯一一份 `isBusy`（R29）：它是 `io.isRunning || session.pendingMessageCount > 0`。
      // `io.isRunning` 是 `running > 0 || session.isStreaming` —— 那个 running 计数是必需的，因为
      // `session.isStreaming` 要等 `prompt()` 内部几个 await 之后才翻真，而启动窗口里在飞的那轮
      // 恰恰最容易被 compact 的 abort 打掉。
      if (deps.isBusy()) {
        throw new Error(
          "agent 正在运行：compact 会先 abort 在飞的那轮（pi 的 session.compact 首行就是 abort），只能等它跑完再做" +
            " —— 先 io.waitIdle()；要自己承担打断就走 context.raw.session.compact()",
        );
      }
      await session.compact(instructions);
    },
    get raw() {
      deps.assertAlive();
      return { session, sessionManager };
    },
  };
}
