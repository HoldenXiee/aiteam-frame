// E4：真模型（opencode-go/deepseek-v4.1-flash）并发 ≤2 下的实际表现。
// 不 import test/helpers.ts（它会污染 agentDir）；不传 agentDir / modelRuntime。
import { createAgent } from "../../src/index.ts";
import { sleep } from "../../test/faux-server.ts";

const FLASH = "opencode-go/deepseek-v4.1-flash";
const out: any = { model: FLASH };
const spent = { tokens: 0, cost: 0 };
const addUsage = (u: any) => { spent.tokens += u.totalTokens; spent.cost += u.cost.total; };
const report = () => `累计 ${spent.tokens} token / $${spent.cost.toFixed(5)}`;

/** 简单的并发闸门（cap=2），因为真模型并发上限是本轮的硬约束 */
function gate(cap: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= cap) await new Promise<void>((r) => waiters.push(r));
    active++;
    try { return await fn(); } finally { active--; waiters.shift()?.(); }
  };
}

console.log("═══ E4a：N 个分身同时打 provider（并发闸门 cap=2），记录成功/错误/429 ═══");
const conc: any[] = [];
for (const n of [8, 16]) {
  const run = gate(2);
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      run(async () => {
        const s = Date.now();
        const a = await createAgent({ model: FLASH, cwd: process.cwd() });
        try {
          const r = await a.prompt(`只输出一个数字：${i}。不要任何其它文字。`);
          addUsage(r.usage);
          return { i, ms: Date.now() - s, text: r.text.trim().slice(0, 20), tokens: r.usage.totalTokens, ok: r.text.trim().includes(String(i)) };
        } catch (e: any) {
          return { i, ms: Date.now() - s, err: e.message.slice(0, 120) };
        } finally { a.dispose(); }
      }),
    ),
  );
  const wall = Date.now() - t0;
  const ok = results.filter((r: any) => r.ok).length;
  const errs = results.filter((r: any) => r.err).map((r: any) => r.err);
  const lat = results.map((r: any) => r.ms).sort((x: number, y: number) => x - y);
  const row = { n, wallMs: wall, ok, errors: errs.length, errSamples: errs.slice(0, 3), minMs: lat[0], medMs: lat[Math.floor(lat.length / 2)], maxMs: lat[lat.length - 1], tokens: results.reduce((s: number, r: any) => s + (r.tokens ?? 0), 0), rate429: errs.filter((e: string) => /429|rate|limit/i.test(e)).length, results };
  conc.push(row);
  console.log(`  N=${n}（cap=2）：成功 ${ok}/${n} 错误 ${errs.length} 其中疑似 429 ${row.rate429}；墙钟 ${wall}ms；延迟 min/med/max=${lat[0]}/${lat[Math.floor(lat.length / 2)]}/${lat[lat.length - 1]}ms；tokens=${row.tokens}`);
  if (errs.length) console.log(`     错误样本（可能由本轮并发争用引起）：${JSON.stringify(errs.slice(0, 3))}`);
  console.log(`     逐个：${JSON.stringify(results.map((r: any) => (r.err ? `#${r.i}=ERR` : `#${r.i}=${r.ok ? "ok" : `WRONG(${r.text})`}`)))}`);
}
out.e4a = conc;
console.log(`  ${report()}`);

console.log("\n═══ E4b：单 agent 连续 12 轮「接力」（多轮传送可靠性退化）═══");
{
  const a = await createAgent({ model: FLASH, cwd: process.cwd() });
  const rounds: any[] = [];
  for (let i = 1; i <= 12; i++) {
    const t = Date.now();
    try {
      const r = await a.prompt(`当前数字是 ${i}。规则：把它加 1，然后【只输出结果数字】，不要任何其它文字。`);
      addUsage(r.usage);
      const got = r.text.trim();
      rounds.push({ round: i, got: got.slice(0, 30), expect: i + 1, ok: got === String(i + 1), ms: Date.now() - t, tokens: r.usage.totalTokens, ctxTokens: a.usage.totalTokens });
      console.log(`  第${String(i).padStart(2)}轮 期望=${i + 1} 得到=${JSON.stringify(got)} ${got === String(i + 1) ? "OK" : "**不符**"} 用时${Date.now() - t}ms ctx累计=${a.usage.totalTokens}`);
    } catch (e: any) {
      rounds.push({ round: i, err: e.message.slice(0, 120), ms: Date.now() - t });
      console.log(`  第${i}轮 抛错：${e.message.slice(0, 100)}`);
      break;
    }
  }
  out.e4b = rounds;
  console.log(`  12 轮里格式/数值正确 = ${rounds.filter((r) => r.ok).length}/${rounds.length}；${report()}`);
  a.dispose();
}

console.log("\n═══ E4c：真模型下 settle 窗口重叠 prompt —— 裸并发 vs 消费者侧互斥（配对）═══");
const settleLive: any[] = [];
for (const mode of ["naive", "mutex"] as const) {
  for (let t = 1; t <= 2; t++) {
    const a = await createAgent({ model: FLASH, cwd: process.cwd() });
    let chain: Promise<any> = Promise.resolve();
    const ask = (text: string) => {
      if (mode === "mutex") { const p = chain.then(() => a.prompt(text)); chain = p.catch(() => {}); return p; }
      return a.prompt(text);
    };
    let inner: any = null;
    let fired = 0;
    a.session.subscribe((raw: any) => {
      if (raw.type === "agent_settled" && fired === 0) {
        fired++;
        void ask("任务B：只输出字母 B。").then((r: any) => (inner = r.text.trim()), (e: any) => (inner = `THROW:${e.message.slice(0, 40)}`));
      }
    });
    const outerRes = await ask("任务A：只输出字母 A。");
    const outer = outerRes.text.trim();
    addUsage(outerRes.usage);
    await sleep(4000);
    const rec = { mode, trial: t, outer: outer.slice(0, 20), inner: String(inner).slice(0, 20), outerOk: outer === "A", innerOk: String(inner).trim() === "B" };
    settleLive.push(rec);
    console.log(`  ${mode.padEnd(5)} 第${t}次：外层="${rec.outer}"(正确=${rec.outerOk})  窗口内="${rec.inner}"(正确=${rec.innerOk})`);
    a.dispose();
  }
}
out.e4c = settleLive;
console.log(`  ${report()}`);

const fs = await import("node:fs");
fs.writeFileSync(new URL("./data-e4.json", import.meta.url), JSON.stringify(out, null, 2), "utf-8");
console.log(`\n→ audit/20-delivery/data-e4.json　${report()}`);
