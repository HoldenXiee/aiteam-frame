// ★★★ 派活器测试 —— 守「观察快、派活慢」这条设计
//
// ══════════════════════════════════════════════════════════════════════════
// 这个设计要解决的问题（实测）
//
//   规则表里 9 处 `await fire(...)`，专家每次 3–6 分钟，而 tick 串行跑规则
//   ⇒ 整个 tick 停在那里 ⇒ 180s 窗口只跑 1 次 tick（该 ~6 次）
//   ⇒ 后面规则全被饿死（`onChapterIndex` 从上线起 0 次触发）。
//
// ★★★ 我走过两条错路，这个测试守的是**第三条**特有的东西：
//   ① `await fire`   —— tick 被卡
//   ② `void fire`    —— tick 不卡了，但**一个 tick 里能同时 fire 好几个**
//      实测：一个 tick 里 archivist + inspector 同时开工
//   ③ 派活器（本文件）—— **同一时刻只有一位专家在跑**
//
// ★★ 所以这里最关键的断言是 `peakConcurrent() === 1`。
//   没有它，测试只能证明"tick 快了"，看不出"并发失控"（那正是 ② 的病）。
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { makeDrainer, renderSeatLedger } from "../../research/clusters/forge/topology/dispatch.ts";

/** ★ 可控的慢专家（零模型成本）*/
function mkDoFire(opts: { delayMs?: number; throws?: Record<string, boolean> } = {}) {
  const started: string[] = [];
  const finished: string[] = [];
  const doFire = async (role: string): Promise<string> => {
    started.push(role);
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 40));
    if (opts.throws?.[role]) throw new Error(`${role} 上游挂了`);
    finished.push(role);
    return `${role} 说完了`;
  };
  return { doFire, started, finished };
}

const mkTrace = () => {
  const lines: string[] = [];
  return { lines, trace: (what: string, detail: string) => lines.push(`${what}|${detail}`) };
};

describe("★★★ 派活器：同一时刻只有一位专家在跑", () => {
  it("★★★ 一口气排 3 位 ⇒ 峰值并发仍是 1", async () => {
    const { doFire, started } = mkDoFire({ delayMs: 30 });
    const { trace } = mkTrace();
    const d = makeDrainer({ doFire, trace, closing: () => false });

    d.enqueue({ role: "archivist", why: "a" });
    d.enqueue({ role: "inspirer", why: "b" });
    d.enqueue({ role: "libsmith", why: "c" });

    // ★ 一开始只该跑 1 位
    assert.equal(started.length, 1, "排了 3 位却立刻启了多个 —— 并发失控");
    assert.equal(d.queued(), 2);

    // ★ 等全部跑完
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(d.fired(), 3, "3 位没派完");
    assert.equal(
      d.peakConcurrent(),
      1,
      `峰值并发 ${d.peakConcurrent()} —— 这就是「void fire」那个版本的病`,
    );
  });

  it("★★ 同一专家重复排队 ⇒ 去重（3 个 tick 不该攒 3 个 archivist）", async () => {
    const { doFire } = mkDoFire({ delayMs: 30 });
    const { trace, lines } = mkTrace();
    const d = makeDrainer({ doFire, trace, closing: () => false });

    d.enqueue({ role: "archivist", why: "第一次" });
    d.enqueue({ role: "archivist", why: "第二次" });
    d.enqueue({ role: "archivist", why: "第三次" });

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(d.fired(), 1, "同一位排了 3 次就派了 3 次 —— 成本翻三倍");
    assert.ok(lines.some((l) => l.includes("已在队列里")), "去重了却没记一行");
  });

  it("★★ onDone 拿到专家的原话（onSettled 要读 VERDICT）", async () => {
    const { doFire } = mkDoFire({ delayMs: 20 });
    const { trace } = mkTrace();
    const d = makeDrainer({ doFire, trace, closing: () => false });

    let got = "";
    d.enqueue({ role: "inspector", why: "审", onDone: (t) => (got = t) });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(got, "inspector 说完了", "onDone 没拿到原话");
  });

  it("★★★ 专家挂掉 ⇒ onDone 拿到空串（调用方不会永远等）", async () => {
    const { doFire } = mkDoFire({ delayMs: 20, throws: { inspector: true } });
    const { trace, lines } = mkTrace();
    const d = makeDrainer({ doFire, trace, closing: () => false });

    let called = false;
    let got: string | null = null;
    d.enqueue({
      role: "inspector",
      why: "审",
      onDone: (t) => {
        called = true;
        got = t;
      },
    });
    await new Promise((r) => setTimeout(r, 150));

    assert.ok(called, "专家挂了 onDone 没被调用 —— 调用方会永远等");
    assert.equal(got, "", "挂掉应该给空串，不是别的");
    assert.ok(lines.some((l) => l.includes("⛔")), "挂掉了却没记一行 —— 静默失败");
  });

  it("★★ 收尾态 ⇒ 不再排、不再跑", async () => {
    const { doFire, started } = mkDoFire({ delayMs: 20 });
    let closing = false;
    const d = makeDrainer({ doFire, trace: () => {}, closing: () => closing });

    d.enqueue({ role: "archivist", why: "a" });
    assert.equal(started.length, 1);

    closing = true;
    d.enqueue({ role: "inspirer", why: "b" });
    assert.equal(d.queued(), 0, "收尾态还在排队");
  });

  it("★★ 队列排空后 idle（收尾才能安全 dispose）", async () => {
    const { doFire } = mkDoFire({ delayMs: 20 });
    const d = makeDrainer({ doFire, trace: () => {}, closing: () => false });

    d.enqueue({ role: "archivist", why: "a" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(d.busy(), false, "跑完了还 busy");
    assert.equal(d.queued(), 0);
  });
});

// ★★★★★ 2026-10-21 · 死锁回归测试
//
// ★ 实测病（hunt 2026-10-21）：收尾时日志写着 `等派活器收干净（队列 2 · 在跑 1）`，
//   然后那两个**永远没跑** —— 被 `dispose()` 直接关掉。
// ★★ 根因：`drain` 里 `if (closing()) return;` 与「收尾时等队列跑空」**互成死锁**。
// ★ 正确语义（AGENTS：「收尾态：不再 fire 新专家，**已 fire 的会跑完**」）：
//   `enqueue` 拒新活，`drain` 把**已排的**跑完。
describe("★★★★★ 收尾与队列不能死锁", () => {
  it("★★★★★ 收尾态下，**已排队**的仍然会跑", async () => {
    let closing = false;
    const fired: string[] = [];
    const d = makeDrainer({
      doFire: async (role) => {
        fired.push(role);
        return "ok";
      },
      trace: () => {},
      closing: () => closing,
    });
    d.enqueue({ role: "inspirer", why: "x" });
    d.enqueue({ role: "archivist", why: "y" });

    // ★ 进收尾态后才开始派活
    closing = true;
    d.drain();
    await new Promise((r) => setTimeout(r, 50));
    // ★★★ 两位**都要跑**（它们是收尾前就排进来的 —— 收尾只挡新活，不挡已排的）
    assert.deepEqual(fired, ["inspirer", "archivist"], `已排的没跑完：${JSON.stringify(fired)}`);
  });

  it("★★★★ 收尾态下 **新的**进不来（不能越收越多）", () => {
    let closing = false;
    const d = makeDrainer({
      doFire: async () => "ok",
      trace: () => {},
      closing: () => closing,
    });
    closing = true;
    d.enqueue({ role: "inspirer", why: "x" });
    assert.equal(d.queued(), 0, "收尾后不该再进队");
  });
});

// ★★★★★ 座位派活账（2026-10-21 事故：`hands-on` 0 次派活，而日志里看不见）
describe("★★★★★ 座位派活账：把「谁跑了 0 次」说出来", () => {
  it("★★★★★ 0 次派活的座位必须被点名（否则「没发生」永远静默）", () => {
    const s = renderSeatLedger({ falsifier: 35, "instrument-skeptic": 18 }, ["hands-on", "falsifier", "instrument-skeptic"]);
    assert.ok(s.includes("0 次"), s);
    assert.ok(s.includes("hands-on"), `★ 必须点名 hands-on：${s}`);
  });

  it("★★ 全部动过 ⇒ 明确说「全部动过」", () => {
    const s = renderSeatLedger({ a: 1, b: 2 }, ["a", "b"]);
    assert.ok(s.includes("全部动过"), s);
    assert.ok(!s.includes("0 次"), s);
  });

  it("★★ 每次派活次数都要报出来（★ 才能看出偏没偏）", () => {
    const s = renderSeatLedger({ falsifier: 35, "hands-on": 4 }, ["falsifier", "hands-on"]);
    assert.ok(s.includes("falsifier=35"), s);
    assert.ok(s.includes("hands-on=4"), s);
  });

  it("★★ 名单里有重复/顺序乱 ⇒ 去重且不炸", () => {
    const s = renderSeatLedger({}, ["b", "a", "b"]);
    assert.equal((s.match(/b=0/g) ?? []).length, 1);
  });

  it("★★ 空名单不炸", () => {
    assert.ok(renderSeatLedger({}, []).includes("座位派活账"));
  });
});
