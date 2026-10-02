// io 面：驱动（prompt / queue / steer / abort / waitIdle）与**调用绑定的结算**。
//
// 结算的真相是「一次运行 = agent_start → agent_settled」（规格 §5）。pi 的 `session.prompt()`
// 在 agent_settled 之后才 resolve，所以「prompt 起止之间的消息区间」就是本次运行的产出 ——
// 不再像 v1 那样排干共享消息池取最后一条（重叠投递会串台）。
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Bridge } from "../agent/bridge.ts";
import type { Agent, AgentMessage, ImageContent, IoSurface, RunResult, Usage } from "../agent/types.ts";
import { addUsage, emptyUsage } from "../agent/usage.ts";

/** runId 全局计数器：跨 agent 唯一（`r1, r2, …`），便于把 trace 关联起来 */
let runCounter = 0;
function nextRunId(): string {
  runCounter += 1;
  return `r${runCounter}`;
}

export interface IoDeps {
  session: AgentSession;
  bridge: Pick<Bridge, "setRunId">;
  assertAlive: () => void;
  getStatus: () => Agent["status"];
  setStatus: (status: Agent["status"]) => void;
  /** 把本次用量计入全生命周期累计（调用方持有那个 Usage 对象） */
  accumulate: (usage: Usage) => void;
}

export function createIo(deps: IoDeps): IoSurface {
  const { session, bridge } = deps;
  /** 已计入累计的 assistant 消息**对象身份**（v1 决策 #6）：同一条消息只计一次 */
  const counted = new WeakSet<AgentMessage>();
  /** 库自己发起的在飞运行数。pi 的 isStreaming 要等 prompt() 内部几个 await 之后才翻真，
   *  只看它的话「启动窗口」里的第二次投递会被 pi 拒掉 —— 忙闲判据必须加上这个计数。 */
  let running = 0;
  const inFlight = new Set<Promise<void>>();

  const isRunning = (): boolean => running > 0 || session.isStreaming;

  /** 记一次在飞运行；返回的 end() 在运行彻底结束时调用（promise 只 resolve、不 reject） */
  function beginRun(): () => void {
    running += 1;
    let end!: () => void;
    const done = new Promise<void>((resolve) => {
      end = resolve;
    });
    inFlight.add(done);
    return () => {
      running -= 1;
      inFlight.delete(done);
      end();
    };
  }

  /** 结算 `from` 之后的消息区间：文本、本次用量、错误；顺带把新 assistant 计入累计 */
  function settle(from: number, runId: string): RunResult {
    const all = session.messages;
    // 首轮里 pi 才建出那条 system 消息（它在 from 之前还不存在），所以区间要按角色滤掉它 ——
    // 它既不属于本次运行的对话区间，与「区间 = from 之后的会话消息」也自洽。
    const messages = all.slice(from).filter((m) => m.role !== "system");
    let text = "";
    let error: string | undefined;
    let usage = emptyUsage();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      usage = addUsage(usage, message.usage);
      const chunk = message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (chunk) text = chunk;
      if (message.errorMessage) error = message.errorMessage;   // pi 对「接受后失败」不 reject
    }
    // 累计走全历史 + 对象身份去重：raw 逃生口直接跑的那些轮次也要被记上，且绝不重复计
    for (const message of all) {
      if (message.role !== "assistant" || counted.has(message)) continue;
      counted.add(message);
      deps.accumulate(message.usage);
    }
    return { runId, text, usage, ...(error ? { error } : {}), messages };
  }

  /** 起一次运行并结算。忙 → 抛错（调用者该走 queue）；未接受就失败 → 结算完区间再原样抛出 */
  async function run(text: string, opts?: { images?: ImageContent[] }): Promise<RunResult> {
    deps.assertAlive();
    if (isRunning()) {
      throw new Error("agent 正在运行：请用 io.queue() 投递，或用 io.waitIdle() 等它跑完");
    }
    const end = beginRun();
    const from = session.messages.length;
    const runId = nextRunId();
    deps.setStatus("running");
    bridge.setRunId(runId);
    let failure: unknown;
    try {
      await session.prompt(text, opts?.images ? { images: opts.images } : undefined);
    } catch (err) {
      failure = err;
    } finally {
      bridge.setRunId(undefined);
      end();
      if (deps.getStatus() === "running") deps.setStatus("idle");
    }
    const result = settle(from, runId);
    if (failure) throw failure;
    return result;
  }

  return {
    get pending() {
      return session.pendingMessageCount;
    },
    get isRunning() {
      return isRunning();
    },
    prompt: (text, opts) => run(text, opts),
    async queue(text) {
      deps.assertAlive();
      if (isRunning()) {
        // 忙 → 排进**当前这次运行**（结算区间里包含它，不谎报「另起一轮」）
        await session.followUp(text);
        return { queued: true };
      }
      // 闲 → 起一次运行但**不 await**（await 了 queue 就变成同步 ask）；结果只从事件可见。
      // ponytail: 这条运行失败只吞不抛（brief 定的「queue 永不抛错」）；要拿到失败与结果就用 prompt()
      void run(text).catch(() => {});
      return { queued: true };
    },
    async steer(text) {
      deps.assertAlive();
      await session.steer(text);
    },
    async abort() {
      deps.assertAlive();
      await session.abort();
    },
    async waitIdle() {
      // 已回收的分身永远「已静下来」，不抛错、直接 resolve（v1 决策 #21）
      if (deps.getStatus() === "disposed") return;
      await session.waitForIdle();
      // session 静下来 ≠ 库这边的运行都已收尾（finally 里还要清 runId / 状态）；等它们真的结算完
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    raw: session,
  };
}
