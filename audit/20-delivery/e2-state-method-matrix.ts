// E2：send / steer / followUp / prompt 在 idle / running / settle / aborted / disposed 五种状态下的精确语义表。
// 每格都打印：抛错原文 / 返回值 / 是否立刻产生模型请求 / 队列遗留 / 延迟会不会被唤醒 / 唤醒后是否顶替那次 prompt。
import { createAgent } from "../../src/index.ts";
import { sleep } from "../../test/faux-server.ts";
import { makeEnv } from "../_faux.ts";

const env = await makeEnv("echo");
const mk = (extra: any = {}) =>
  createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir, ...extra }, { modelRuntime: env.runtime });

type Probe = { threw?: string; ret?: unknown; extra?: unknown };
const rows: any[] = [];

const PROBE = "探针消息";
const WAKE = "醒一醒";

function flat(c: any): string {
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x.text ?? "").join("") : "";
}

/** 在指定状态下执行一次方法探测，然后（如果没立刻跑）再投一条无关 prompt 看它会不会醒 */
async function cell(state: string, method: string): Promise<any> {
  const a = await mk();
  // 先构造状态
  let settleProbe: (() => void) | null = null;
  if (state === "running") {
    void a.prompt("[[sleep:600]] 占位").catch(() => {});
    await sleep(150);
  } else if (state === "aborted") {
    void a.prompt("[[sleep:400]] 占位").catch(() => {});
    await sleep(100);
    await a.abort().catch(() => {});
  } else if (state === "settle") {
    let fired = 0;
    a.session.subscribe((raw: any) => {
      if (raw.type === "agent_settled" && fired === 0) fired++;
    });
  } else if (state === "disposed") {
    await a.prompt("热身");
    a.dispose();
    await sleep(50);
  }

  const call = (text: string): Promise<any> => {
    switch (method) {
      case "prompt": return a.prompt(text);
      case "send": return a.send(text);
      case "send-interrupt": return a.send(text, { mode: "interrupt" });
      case "steer": return a.steer(text);
      case "followUp": return (a.session as any).followUp(text);
      default: throw new Error(method);
    }
  };
  const normalize = (r: any) => (r && typeof r === "object" ? (r.delivered ? { delivered: r.delivered } : { text: r.text, tokens: r.usage?.totalTokens }) : r === undefined ? "(undefined)" : r);

  const before = env.calls().length;
  const probe: Probe = {};
  if (state === "settle") {
    // 在 settle 窗口里发射；结果异步回收
    const p = new Promise<void>((resolve) => {
      let fired = 0;
      const un = a.session.subscribe((raw: any) => {
        if (raw.type === "agent_settled" && fired === 0) {
          fired++;
          void call(PROBE).then((r) => (probe.ret = normalize(r)), (e: any) => (probe.threw = e.message));
          setTimeout(resolve, 600);
        }
      });
      void un;
    });
    await a.prompt("外层占位");
    await p;
  } else {
    try {
      probe.ret = normalize(await call(PROBE));
    } catch (e: any) {
      probe.threw = e.message;
    }
  }
  const statusAfter = a.status;
  const streamingAfter = a.isStreaming;
  const pending = (() => { try { return (a.session as any).pendingMessageCount; } catch { return "?"; } })();

  await sleep(500);
  const ranAtOnce = env.calls().slice(before).some((c) => c.lastUser.includes(PROBE));
  const requestsAtOnce = env.calls().length - before;

  // wake：只有还没跑、且没被回收时才做
  let wake: any = null;
  if (!ranAtOnce && statusAfter !== "disposed") {
    const b2 = env.calls().length;
    const wr = await a.prompt(WAKE).then((r) => ({ text: r.text, tokens: r.usage.totalTokens }), (e: any) => ({ threw: e.message }));
    await sleep(400);
    const seq = env.calls().slice(b2).map((c) => c.lastUser.slice(0, 24));
    wake = {
      wakePromptRet: wr,
      probeRanOnWake: env.calls().slice(b2).some((c) => c.lastUser.includes(PROBE)),
      seq,
      hijacked: /探针消息/.test(String((wr as any).text ?? "")),
      pendingBeforeWake: pending,
    };
  }

  const row = { state, method, probe, statusAfter, streamingAfter, pending, ranAtOnce, requestsAtOnce, wake, usage: a.usage.totalTokens };
  rows.push(row);
  try { a.dispose(); } catch { /* disposed */ }
  return row;
}

const STATES = ["idle", "running", "settle", "aborted", "disposed"] as const;
const METHODS = ["prompt", "send", "send-interrupt", "steer", "followUp"] as const;

for (const s of STATES) {
  console.log(`\n═══ 状态 = ${s} ═══`);
  for (const m of METHODS) {
    const r = await cell(s, m);
    const head = `${m.padEnd(14)} ${r.probe.threw ? `抛: ${r.probe.threw.slice(0, 62)}` : `返回: ${JSON.stringify(r.probe.ret)}`}`;
    console.log(`  ${head}`);
    console.log(`     status=${r.statusAfter} isStreaming=${r.streamingAfter} pending=${r.pending} 立刻跑=${r.ranAtOnce} 请求=${r.requestsAtOnce} usage=${r.usage}` +
      (r.wake ? ` | 之后 prompt("${WAKE}")←返回 ${JSON.stringify(r.wake.wakePromptRet)} 探针此时跑了=${r.wake.probeRanOnWake} 顶替=${r.wake.hijacked} 序列=${JSON.stringify(r.wake.seq)}` : ""));
  }
}

const fs = await import("node:fs");
fs.writeFileSync(new URL("./data-e2.json", import.meta.url), JSON.stringify({ rows }, null, 2), "utf-8");
console.log("\n→ audit/20-delivery/data-e2.json");
await env.close();
