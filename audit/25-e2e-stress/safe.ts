// B 写法的「安全投递纪律」——完全基于基线 K 自己推出来的最小实现。
//
// K 说的三件事：
//   1) RunResult.text 不跟调用绑定，重叠投递时互换（collectRun 排干共享池）
//   2) 同一次代理里 run 严格串行时，RunResult 才等价于「本次运行」
//   3) 忙时 send 排队、send 之后紧跟 prompt 必抛（K5）
// 由此推出的最小纪律（4 条）：
//   D1 同一个 agent 上永不重叠（本地 Promise 链做互斥）
//   D2 投递前必须判别忙闲（status/isStreaming），忙则 waitForIdle 再投 —— 因为
//      spawn_agent 也会起这个 agent 的一轮，本地链看不见它
//   D3 读回不采信 lastResult/RunResult，改用「投递前消息游标 → 新增 assistant 消息」
//   D4 不用 send，统一 prompt（send 的返回语义与 prompt 不兼容）
import type { ControlledAgent } from "../../src/index.ts";

const textOf = (m: any): string => {
  const c = m?.content;
  if (Array.isArray(c)) return c.filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  return typeof c === "string" ? c : "";
};

export interface AskOutcome {
  ok: boolean;
  /** 本次调用真正新增的 assistant 文本（游标切片，唯一可信的归属方式） */
  texts: string[];
  /** 库给的 RunResult.text —— 拿来对照用，不用于归属 */
  runResultText: string;
  usageTokens: number;
  cost: number;
  error: string | null;
  throwMessage: string | null;
  waitedForIdle: boolean;
  ms: number;
}

export class SafeMember {
  private chain: Promise<unknown> = Promise.resolve();
  public serializeWaits = 0;
  public readonly agent: ControlledAgent;

  constructor(agent: ControlledAgent) {
    this.agent = agent;
  }

  private async waitBusyClear(): Promise<boolean> {
    if (this.agent.status === "running" || this.agent.isStreaming) {
      this.serializeWaits += 1;
      await this.agent.waitForIdle();
      return true;
    }
    return false;
  }

  ask(text: string): Promise<AskOutcome> {
    const run = async (): Promise<AskOutcome> => {
      const t0 = Date.now();
      let waited = false;
      try {
        waited = await this.waitBusyClear();
        const cursor = (this.agent.session as any).messages.length as number;
        const res = await this.agent.prompt(text);
        const fresh = ((this.agent.session as any).messages as any[]).slice(cursor);
        const texts = fresh.filter((m) => m.role === "assistant").map(textOf).filter((t) => t.length > 0);
        return {
          ok: !res.error,
          texts,
          runResultText: res.text,
          usageTokens: res.usage.totalTokens,
          cost: res.usage.cost.total,
          error: res.error ?? null,
          throwMessage: null,
          waitedForIdle: waited,
          ms: Date.now() - t0,
        };
      } catch (err) {
        return {
          ok: false, texts: [], runResultText: "", usageTokens: 0, cost: 0, error: null,
          throwMessage: err instanceof Error ? err.message : String(err),
          waitedForIdle: waited, ms: Date.now() - t0,
        };
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
}

