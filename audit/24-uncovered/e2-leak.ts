// E2 强制 GC 的泄漏复测（补附录 C 第二条）
// 跑法：node --expose-gc audit/24-uncovered/e2-leak.ts        （零 API 花费，全走假 provider）
// 目标：把「可回收垃圾」与「真实泄漏」分开 —— 每 N 次迭代强制 GC 后读 heapUsed，给斜率（KB/迭代）。
import { createAgent, createAgentHost, type AgentHost } from "../../src/index.ts";
import { dump, median, num, record, script, section, slope } from "./_h.ts";
import { makeEnv } from "../_faux.ts";

script("e2-leak");
const NL = "\n";
const gcFn = (globalThis as { gc?: () => void }).gc;
const gcAvailable = typeof gcFn === "function";
const heapKB = () => process.memoryUsage().heapUsed / 1024;
const resources = () => (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ?? [];
const hist = (xs: string[]) => xs.reduce<Record<string, number>>((a, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {});
const sleep0 = () => new Promise((r) => setTimeout(r, 0));
/** 强制 GC 并让引擎把清扫/终结做完，再读数（否则会读到未清扫的中间态） */
const settleAndRead = async () => {
  gcFn?.();
  await sleep0();
  gcFn?.();
  await new Promise((r) => setTimeout(r, 30));
  gcFn?.();
  await sleep0();
  return heapKB();
};

const env = await makeEnv();
const defaults = { model: env.model, agentDir: env.agentDir, cwd: env.cwd };
const mk = (extra: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) => createAgent({ ...defaults, ...extra }, { modelRuntime: env.runtime, ...deps });
function newHost(maxAgents: number): AgentHost {
  return createAgentHost({ defaults, members: { w: { description: "工人" } }, maxAgents, maxDepth: 0, modelRuntime: env.runtime });
}

if (!gcAvailable) console.log("⚠ 没有 --expose-gc，本次只能给上界。请用：node --expose-gc audit/24-uncovered/e2-leak.ts");

// ─────────────────────────────────────────────────────────────
section("E2a 240 次「起 → 跑 → 回收」，每 10 次强制 GC（三轮 GC + 30ms 等待后读数）");
let phaseA: { sHeapGc: number; sHeapRaw: number; sFirst: number; sSecond: number; heapGc: number[]; N: number } | null = null;
{
  const N = 240;
  const GC_EVERY = 10;
  for (let i = 0; i < 3; i++) {
    const a = await mk();
    await a.prompt("预热");
    a.dispose();
  }
  const baseHeap = await settleAndRead();
  const baseRes = resources();

  const heapRaw: number[] = [];
  const heapGc: number[] = [];
  const resGc: number[] = [];
  const resHist: Array<Record<string, number>> = [];
  const wall: number[] = [];

  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    const a = await mk();
    await a.prompt(`第 ${i} 轮`);
    a.dispose();
    wall.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await sleep0();
    heapRaw.push(heapKB());
    if (i % GC_EVERY === GC_EVERY - 1) {
      heapGc.push(await settleAndRead());
      const r = resources();
      resGc.push(r.length);
      resHist.push(hist(r));
    }
  }

  // slope() 是「KB / 采样点」；采样点间隔 GC_EVERY 次迭代 → 除以 GC_EVERY 才是 KB/迭代
  const perIter = (ys: number[]) => slope(ys) / GC_EVERY;
  const sHeapGc = perIter(heapGc);
  const sHeapRaw = slope(heapRaw); // 每次迭代都有点，就是 KB/迭代
  const sResGc = perIter(resGc);
  const half = Math.floor(heapGc.length / 2);
  const sFirst = perIter(heapGc.slice(0, half));
  const sSecond = perIter(heapGc.slice(half));
  const ym = heapGc.reduce((a, b) => a + b, 0) / heapGc.length;
  const xm = (heapGc.length - 1) / 2;
  const pred = heapGc.map((_, i) => ym + slope(heapGc) * (i - xm));
  const maxResid = Math.max(...heapGc.map((y, i) => Math.abs(y - pred[i])));
  const types = [...new Set(resHist.flatMap((h) => Object.keys(h)))];
  const typeTrend = types.map((t) => ({ type: t, counts: resHist.map((h) => h[t] ?? 0), perIter: num(perIter(resHist.map((h) => h[t] ?? 0)), 4) }));
  phaseA = { sHeapGc, sHeapRaw, sFirst, sSecond, heapGc, N };

  // 收尾：再等 1 秒后强制 GC，看是否有延迟释放的批量落下
  await new Promise((r) => setTimeout(r, 1000));
  const tailHeap = await settleAndRead();

  record({
    id: "E2a",
    question: "反复「起 → 跑 → 回收」N 次，强制 GC 后的堆斜率是多少（KB/迭代），是否线性泄漏",
    observed:
      `--expose-gc=${gcAvailable}；N=${N}，每 ${GC_EVERY} 次一次「gc×3 + 30ms」后读数。基线（预热后 gc）heap=${num(baseHeap, 1)}KB 句柄=${baseRes.length}。` +
      `${NL}     强制 GC 后读数（${heapGc.length} 点，KB）=${JSON.stringify(heapGc.map((x) => num(x, 1)))}` +
      `${NL}     未强制 GC 的原始 heapUsed 斜率=${num(sHeapRaw, 3)}KB/迭代；**强制 GC 后斜率=${num(sHeapGc, 3)}KB/迭代**（前 1/2=${num(sFirst, 3)}，后 1/2=${num(sSecond, 3)}）` +
      `${NL}     首末点差=${num(heapGc.at(-1)! - heapGc[0], 1)}KB / ${N - GC_EVERY} 次迭代 = ${num((heapGc.at(-1)! - heapGc[0]) / (N - GC_EVERY), 3)}KB/迭代（逐点线性拟合残差峰值 ${num(maxResid, 1)}KB）` +
      `${NL}     再等 1s + 强制 GC 后 heap=${num(tailHeap, 1)}KB（相对最后一个采样点 ${num(tailHeap - heapGc.at(-1)!, 1)}KB）` +
      `${NL}     句柄：强制 GC 后读数=${JSON.stringify(resGc)}，斜率=${num(sResGc, 4)}个/迭代；类型趋势=${JSON.stringify(typeTrend)}` +
      `${NL}     单次墙钟中位数=${num(median(wall), 1)}ms（前 5=${num(median(wall.slice(0, 5)), 1)}ms，后 5=${num(median(wall.slice(-5)), 1)}ms）`,
    verdict: !gcAvailable ? "PARTIAL" : sHeapGc > 20 ? "GAP" : sSecond < sFirst * 0.75 ? "OK" : "PARTIAL",
    conclusion:
      !gcAvailable
        ? `本轮没有 --expose-gc，只能给上界 ${num(sHeapRaw, 3)}KB/迭代（含延迟回收的垃圾），结论不可用。`
        : `**强制 GC 后仍有 ${num(sHeapGc, 3)}KB/迭代的净增长**（${N} 次累计 ≈${num((sHeapGc * N) / 1024, 2)}MB）。` +
          `不强制 GC 时是 ${num(sHeapRaw, 3)}KB/迭代 —— ${sHeapGc > sHeapRaw * 0.7 ? "两者接近，说明这笔内存**强制 GC 也收不掉**，不是「延迟回收的垃圾」" : `差 ${num(sHeapRaw / Math.max(sHeapGc, 1e-9), 1)}×，主体是延迟回收的垃圾`}。` +
          `形态：前 1/2 斜率 ${num(sFirst, 2)} → 后 1/2 ${num(sSecond, 2)}KB/迭代，后/前 = ${num(sSecond / Math.max(sFirst, 1e-9), 2)}（衰减 ${num(100 - (100 * sSecond) / Math.max(sFirst, 1e-9), 0)}%）；` +
          `逐点线性拟合残差峰值 ${num(maxResid, 1)}KB 对总变化 ${num(heapGc.at(-1)! - heapGc[0], 1)}KB（占 ${num((100 * maxResid) / Math.max(heapGc.at(-1)! - heapGc[0], 1e-9), 1)}%）→ 曲线**持续衰减但不平坦**。` +
          `句柄（强制 GC 后）${num(sResGc, 4)}个/迭代，读数 ${JSON.stringify(resGc)}；按此斜率外推堆到 1GB 需 ${Math.round(1048576 / Math.max(sHeapGc, 1e-9))} 次迭代。` +
          `**无法仅凭 heapUsed 定案**：要区分「真泄漏」与「V8 内部结构/碎片」必须做 heap snapshot diff，本轮未做。`,
    data: {
      gcAvailable, N, GC_EVERY,
      baseHeap: num(baseHeap, 1),
      heapGc: heapGc.map((x) => num(x, 1)),
      sHeapRaw: num(sHeapRaw, 3), sHeapGc: num(sHeapGc, 3), sFirst: num(sFirst, 3), sSecond: num(sSecond, 3),
      maxResidKB: num(maxResid, 1), tailHeap: num(tailHeap, 1),
      resGc, sResGc: num(sResGc, 4), typeTrend,
      wallMedianMs: num(median(wall), 1), wallFirst5: num(median(wall.slice(0, 5)), 1), wallLast5: num(median(wall.slice(-5)), 1),
    },
  });
}

// ─────────────────────────────────────────────────────────────
section("E2b 更狠的一组：每轮起 50 个分身、各跑一轮、全部回收，重复 20 轮");
{
  const ROUNDS = 20;
  const PER = 50;
  const host = newHost(2000); // maxAgents 是**终身累计**上限（已知结论），这里给足
  {
    const warm = await mk();
    await warm.prompt("预热");
    warm.dispose();
  }
  const baseHeap = await settleAndRead();
  const baseRes = resources().length;
  const heap: number[] = [];
  const res: number[] = [];
  const perRoundWall: number[] = [];
  const hostLeft: string[] = [];

  for (let r = 0; r < ROUNDS; r++) {
    const t0 = process.hrtime.bigint();
    const batch = await Promise.all(
      Array.from({ length: PER }, (_, i) =>
        mk({}, { host, member: "w" }).then(async (a) => {
          await a.prompt(`轮 ${r} 分身 ${i}`);
          return a;
        }),
      ),
    );
    for (const a of batch) a.dispose();
    perRoundWall.push(Number(process.hrtime.bigint() - t0) / 1e6);
    await sleep0();
    heap.push(await settleAndRead());
    res.push(resources().length);
    if (host.activeCount !== 0) hostLeft.push(`轮 ${r}: activeCount=${host.activeCount}`);
  }
  const sHeap = slope(heap); // KB/轮（每轮一个采样点）
  const sRes = slope(res);
  const perAgentKB = sHeap / PER;
  const half = Math.floor(ROUNDS / 2);
  const sSecond = slope(heap.slice(half));
  host.dispose();

  record({
    id: "E2b",
    question: "每轮 50 分身 × 20 轮（共 1000 次起收）的堆与句柄保留量",
    observed:
      `基线 heap=${num(baseHeap, 1)}KB 句柄=${baseRes}。` +
      `${NL}     每轮强制 GC 后 heap（KB）=${JSON.stringify(heap.map((x) => num(x, 1)))}` +
      `${NL}     每轮强制 GC 后句柄数=${JSON.stringify(res)}` +
      `${NL}     堆斜率=${num(sHeap, 2)}KB/轮（= ${num(perAgentKB, 3)}KB/分身；后 1/2 斜率=${num(sSecond, 2)}KB/轮）；句柄斜率=${num(sRes, 3)}个/轮；` +
      `首末点差=${num(heap.at(-1)! - heap[0], 1)}KB` +
      `${NL}     每轮墙钟=${JSON.stringify(perRoundWall.map((x) => Math.round(x)))}ms；host.activeCount 残留=${JSON.stringify(hostLeft)}`,
    verdict: !gcAvailable ? "PARTIAL" : perAgentKB > 10 ? "GAP" : sSecond < sHeap * 0.8 ? "OK" : "PARTIAL",
    conclusion:
      !gcAvailable
        ? "本轮没有 --expose-gc，结论不可用。"
        : `每轮 50 分身，强制 GC 后堆斜率 ${num(sHeap, 2)}KB/轮 = **${num(perAgentKB, 3)}KB/分身**（后 1/2 斜率 ${num(sSecond, 2)}KB/轮，后/前 = ${num(sSecond / Math.max(sHeap, 1e-9), 2)}）；句柄 ${num(sRes, 3)}个/轮。` +
          `${ROUNDS} 轮（${ROUNDS * PER} 次起收）累计保留 ≈${num((sHeap * ROUNDS) / 1024, 2)}MB。` +
          (sSecond < sHeap * 0.8
            ? "后半程明显降温 + 与 E2a 同量级的残余 → **不支持「每分身泄漏固定字节」的假设**；残余更像与并发峰值相关的缓存/碎片。"
            : "后半程仍在增长 → 存在「一次性起 N 个分身」带来的持续保留，阶段 2 的批量扇出必须分批回收并观察。") +
          `host.activeCount 残留=${JSON.stringify(hostLeft)}（为空即占位表被正确清理）。`,
    data: { PER, ROUNDS, baseHeap: num(baseHeap, 1), heap: heap.map((x) => num(x, 1)), res, sHeap: num(sHeap, 2), perAgentKB: num(perAgentKB, 3), sSecond: num(sSecond, 2), sRes: num(sRes, 3), perRoundWall: perRoundWall.map((x) => Math.round(x)), hostLeft },
  });
}

// ─────────────────────────────────────────────────────────────
section("E2c 交叉检查：同时存活 30 个分身的峰值内存");
{
  const before = resources().length;
  const baselineHeap = await settleAndRead();
  const agents = [];
  for (let i = 0; i < 30; i++) agents.push(await mk());
  const during = heapKB();
  for (const a of agents) a.dispose();
  const after = await settleAndRead();
  record({
    id: "E2c",
    question: "30 个分身同时存活再全部回收，峰值与回收后各是多少",
    observed: `开始前 heap=${num(baselineHeap, 1)}KB 句柄=${before} → 同时存活 30 个时 heap=${num(during, 1)}KB 句柄=${resources().length} → 全部回收 + 强制 GC 后 heap=${num(after, 1)}KB 句柄=${resources().length}`,
    verdict: "INFO",
    conclusion: `同时存活 30 个分身的峰值增量 ${num(during - baselineHeap, 1)}KB（约 ${num((during - baselineHeap) / 30, 1)}KB/分身），给阶段 2 估算「一个成员分身占多少常驻内存」。回收后的长期斜率见 E2a/E2b。`,
    data: { before, baselineHeap: num(baselineHeap, 1), during: num(during, 1), after: num(after, 1), peakPerAgentKB: num((during - baselineHeap) / 30, 1) },
  });
}

await env.close();
console.log(`${NL}E2 结束（零真实花费）`);
if (phaseA) console.log(`E2a 一句话：强制 GC 后 ${num(phaseA.sHeapGc, 3)}KB/迭代（原始 ${num(phaseA.sHeapRaw, 3)}），前/后半程 ${num(phaseA.sFirst, 2)} → ${num(phaseA.sSecond, 2)}KB/迭代`);
dump();
