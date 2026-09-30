// E6：并发时的 429 / 限流 —— 记录并标注「是否可能由本轮并发争用引起」。
// 两段：
//   (a) 真模型并发压力：1 / 2 / 4 三档各跑一小批，记录 429 与错误分布（真实服务，会产生花费）
//   (b) 本地假服务同形压力：把真模型名指向本地假 baseUrl，验证「并发代码路径」在无网络抖动时的表现（零成本）
// 跑法：node audit/22-topology-live/e6-concurrency-429.ts [--local-only]
import { createAgent, createAgentHost } from "../../src/index.ts";
import { startFaux } from "../../test/faux-server.ts";
import { FLASH, fakeAgentDir, makeSink, pool, workDir } from "./_lib.ts";

const sink = makeSink("e6-concurrency-429");
const LOCAL_ONLY = process.argv.includes("--local-only");
const cwd = workDir("e6");

const is429 = (s: string) => /429|rate ?limit|too many requests/i.test(s);

// ─────────────── (b) 本地假服务的同形并发（零成本，先跑，验证机制） ───────────────
sink.section("E6.b 本地假服务同形并发（零成本对照）");
{
  const faux = await startFaux();
  const agentDir = fakeAgentDir("e6", faux.baseUrl);
  const rows: Array<{ conc: number; n: number; ok: number; errors: string[]; ms: number; calls: number }> = [];
  for (const conc of [1, 2, 4]) {
    const host = createAgentHost({ defaults: { model: FLASH }, maxAgents: 40 } as never);
    const before = faux.calls.length;
    const t0 = Date.now();
    const agents = await Promise.all(
      Array.from({ length: 12 }, () => createAgent({ model: FLASH, cwd, agentDir, tools: [] }, { host })),
    );
    const results = await pool(agents, conc, async (a) => {
      try {
        const r = await a.prompt("ping");
        return { ok: true, text: r.text, err: undefined as string | undefined };
      } catch (e) {
        return { ok: false, text: "", err: (e as Error).message };
      }
    });
    const errors = results.filter((r) => !r.ok).map((r) => r.err!);
    rows.push({
      conc,
      n: results.length,
      ok: results.filter((r) => r.ok).length,
      errors,
      ms: Date.now() - t0,
      calls: faux.calls.length - before,
    });
    console.log(`并发 ${conc}：${results.filter((r) => r.ok).length}/${results.length} 成功，${Date.now() - t0}ms，假服务收到 ${faux.calls.length - before} 个请求，429=${errors.filter(is429).length}`);
    host.dispose();
  }
  sink.add({
    id: "E6.b",
    question: "把真模型名指向本地假服务时，并发 1/2/4 的请求数与错误分布（无网络因素的对照）",
    method: "node audit/22-topology-live/e6-concurrency-429.ts（假 baseUrl + 真模型名，12 个分身 × 3 档并发）",
    observed: rows.map((r) => `并发${r.conc}: ${r.ok}/${r.n} 成功，${r.ms}ms，假服务收 ${r.calls} 个请求，429=${r.errors.filter(is429).length}，其他错误=${r.errors.filter((e) => !is429(e)).length}${r.errors.length ? `（${r.errors.slice(0, 2).map((e) => e.slice(0, 50)).join(" / ")}）` : ""}`).join("；"),
    verdict: rows.every((r) => r.ok === r.n) ? "OK" : "GAP",
    conclusion: rows.every((r) => r.ok === r.n)
      ? "本地假服务下 1/2/4 三档并发全部成功、零错误、零 429 —— 并发代码路径本身没问题，真模型侧出现的错误只能来自真实网络/provider。"
      : `本地假服务下就出现了 ${rows.reduce((a, r) => a + r.errors.length, 0)} 个错误，说明问题在库/超时层，不只是 provider 限流。`,
    data: rows,
  });
  sink.ledger("local", rows);
  await faux.close();
}

// ─────────────── (a) 真模型并发压力 ───────────────
if (!LOCAL_ONLY) {
  sink.section("E6.a 真模型并发压力（真实服务）");
  const rows: Array<{ conc: number; n: number; ok: number; errors: Array<{ msg: string; is429: boolean }>; ms: number; cost: number }> = [];
  for (const conc of [1, 2, 4]) {
    const host = createAgentHost({ defaults: { model: FLASH }, maxAgents: 40 } as never);
    const n = conc * 3;
    const agents = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        typeof 1 === "number"
          ? createAgent({ model: FLASH, cwd, tools: [], role: `编号 ${i + 1}` }, { host })
          : Promise.reject(new Error("unreachable")),
      ),
    );
    const t0 = Date.now();
    const results = await pool(agents, conc, async (a) => {
      try {
        const r = await a.prompt("只回答数字 1，不要其他字符。");
        return { ok: true, err: undefined as string | undefined, cost: r.usage.cost.total, tok: r.usage.totalTokens };
      } catch (e) {
        return { ok: false, err: (e as Error).message, cost: 0, tok: 0 };
      }
    });
    const ms = Date.now() - t0;
    const errors = results.filter((r) => !r.ok).map((r) => ({ msg: r.err!, is429: is429(r.err!) }));
    const cost = host.usage.cost.total;
    rows.push({ conc, n, ok: results.filter((r) => r.ok).length, errors, ms, cost });
    console.log(`真模型并发 ${conc}：${results.filter((r) => r.ok).length}/${n} 成功，${ms}ms，429=${errors.filter((e) => e.is429).length}，$${cost.toFixed(5)}${errors.length ? `\n   错误样本：${errors.slice(0, 3).map((e) => e.msg.slice(0, 90)).join("\n             ")}` : ""}`);
    host.dispose();
  }
  const total429 = rows.reduce((a, r) => a + r.errors.filter((e) => e.is429).length, 0);
  const totalErr = rows.reduce((a, r) => a + r.errors.length, 0);
  sink.add({
    id: "E6.a",
    question: "真模型在并发 1/2/4 下的错误率与 429 次数",
    method: "node audit/22-topology-live/e6-concurrency-429.ts（并发 1/2/4 各 3–12 次调用）",
    observed: rows.map((r) => `并发${r.conc}: ${r.ok}/${r.n} 成功，${r.ms}ms，429=${r.errors.filter((e) => e.is429).length}，共 ${r.errors.length} 个错误，$${r.cost.toFixed(5)}${r.errors.length ? `；样本=${JSON.stringify(r.errors.slice(0, 2).map((e) => e.msg.slice(0, 120)))}` : ""}`).join("；"),
    verdict: totalErr === 0 ? "OK" : total429 > 0 ? "PARTIAL" : "GAP",
    conclusion:
      totalErr === 0
        ? `并发 1/2/4 共 ${rows.reduce((a, r) => a + r.n, 0)} 次真模型调用，零错误、零 429。`
        : `并发 1/2/4 共 ${rows.reduce((a, r) => a + r.n, 0)} 次调用里出现 ${totalErr} 个错误，其中 ${total429} 个是 429。`
          + `\n注意：本轮同时还有别的脚本在跑（E2/E5，并发各 2），**429 有可能由本轮并发争用引起**，不能单独归因于库。`,
    data: rows,
  });
  sink.ledger("live", rows);
  console.log(`\nE6 真模型合计 $${rows.reduce((a, r) => a + r.cost, 0).toFixed(5)}`);
}

console.log(`\n→ ${sink.path}`);
