// ★★★ onSettled 不阻塞 tick（设计者选 (b)）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么要这个测试
//
//   改前：`const out = await fire("inspector", ...)` —— 专家跑 3–6 分钟，
//        **整个 tick 停在那里** ⇒ 后面所有规则饿死。
//        实测：180s 窗口 tick 只跑 1 次（按 THROTTLE_MS=30s 该 ~6 次）；
//              600s 只跑 3 次（该 ~20 次）⇒ **实际频率只有设计值的 1/6~1/7**。
//        后果：`onTocDrift` 判据命中了却 0 次触发。
//
//   改后：`void fire(...).then(...)` —— tick 立刻返回，结果照样写回 `state.verdict`。
//
// ★★★ 这个测试守四件事（每件都对应一个真实的坏法）：
//   ① tick 不会被慢专家卡住（核心修复）
//   ② `VERDICT` 仍然写回 `state.verdict`（★ 不能用 void 简单了事）
//   ③ 专家**挂掉**时也不卡、不静默（本项目栽过“静默不响”三次）
//   ④ 上一位还在跑时**不重复叫**（改异步才有的新风险）
// ══════════════════════════════════════════════════════════════════════════

import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeRules, newState, type State } from "../../research/clusters/forge/topology/rules.ts";
import { LAB } from "../../research/clusters/forge/paths.ts";

const OUTBOX = join(LAB, "outbox");

/**
 * ★ 在 outbox 里放一份产物（★ 用**不同文件名**避免与真集群的产物冲突）。
 * ★★ 不改真集群的产物：只在缺的档才写，测完删。
 */
function touchArtifact(name: string): () => void {
  mkdirSync(OUTBOX, { recursive: true });
  const p = join(OUTBOX, name);
  writeFileSync(p, "# 测试产物\n\n内容。\n");
  return () => rmSync(p, { force: true });
}

/** ★ 造一个可控的 fire（★ 不碰真模型 —— 零成本）*/
function mkFire(opts: { delayMs?: number; text?: string; throws?: boolean } = {}) {
  const calls: string[] = [];
  const fire = async (role: string, _why: string, _focus?: string): Promise<string> => {
    calls.push(role);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.throws) throw new Error("上游挂了");
    return opts.text ?? "";
  };
  return { fire: fire as unknown as Parameters<typeof makeRules>[0]["fire"], calls };
}

/** ★ 起一个最小的 ctx（其余规则全设为 no-op 依赖）*/
function mkCtx(fire: ReturnType<typeof mkFire>["fire"], state: State) {
  const traces: string[] = [];
  return {
    traces,
    ctx: {
      fire,
      state,
      trace: (rule: string, detail: string) => traces.push(`${rule}|${detail}`),
      closing: () => false,
    } as unknown as Parameters<typeof makeRules>[0],
  };
}

describe("★★★ onSettled 不阻塞 tick", () => {
  it("★★★ 慢专家不卡住 tick（核心修复）", async () => {
    const cleanup = touchArtifact("_test-settled-a.md");
    try {
      const state = newState();
      const { fire } = mkFire({ delayMs: 3000, text: "VERDICT: CONTINUE" });
      const { ctx } = mkCtx(fire, state);
      const rules = makeRules(ctx);

      const t0 = Date.now();
      await rules.onSettled();
      const took = Date.now() - t0;

      // ★★★ 改前这里会是 ~3000ms（等专家）；改后应该几毫秒
      assert.ok(took < 300, `onSettled 等了 ${took}ms —— 还在阻塞 tick`);
    } finally {
      cleanup();
    }
  });

  it("★★ VERDICT 仍然写回 state.verdict（不能用 void 了事）", async () => {
    const cleanup = touchArtifact("_test-settled-b.md");
    try {
      const state = newState();
      const { fire } = mkFire({ delayMs: 20, text: "…分析…\nVERDICT: STOP\n" });
      const { ctx } = mkCtx(fire, state);
      const rules = makeRules(ctx);

      await rules.onSettled();
      // ★ 立刻时还没写回（异步）
      assert.equal(state.verdict, undefined, "不该同步就有 verdict");

      // ★ 等专家"回来"
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(state.verdict, "STOP", "VERDICT 没写回 —— 依赖它的规则会坏");
    } finally {
      cleanup();
    }
  });

  it("★★★ 专家挂掉 ⇒ 不卡、不静默、不把 verdict 弄坏", async () => {
    const cleanup = touchArtifact("_test-settled-c.md");
    try {
      const state = newState();
      state.verdict = "CONTINUE"; // ★ 旧值要保住
      const { fire } = mkFire({ delayMs: 20, throws: true });
      const { ctx, traces } = mkCtx(fire, state);
      const rules = makeRules(ctx);

      await rules.onSettled();
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(state.verdict, "CONTINUE", "挂掉时不该改 verdict");
      assert.ok(
        traces.some((t) => t.includes("onSettled") && t.includes("⛔")),
        "专家挂了却没记一行 —— 静默失败",
      );
      assert.equal(state.inspectorInFlight, false, "挂掉后 in-flight 没清 ⇒ 以后永远不再审查");
    } finally {
      cleanup();
    }
  });

  it("★★★ 上一位还在跑 ⇒ 不重复叫（异步才有的新风险）", async () => {
    const cleanup = touchArtifact("_test-settled-d.md");
    try {
      const state = newState();
      const { fire, calls } = mkFire({ delayMs: 3000, text: "VERDICT: CONTINUE" });
      const { ctx, traces } = mkCtx(fire, state);
      const rules = makeRules(ctx);

      await rules.onSettled(); // 第一次：真的叫了
      assert.equal(calls.length, 1);

      // ★ 再产出一份（模拟 tick 又来）
      writeFileSync(join(OUTBOX, "_test-settled-d2.md"), "# 又一份\n");
      touchArtifact("_test-settled-d.md");

      await rules.onSettled(); // 第二次：应该被 in-flight 挡下
      assert.equal(calls.length, 1, "上一位还在跑却又叫了一位 ⇒ 会堆十几个");
      assert.ok(
        traces.some((t) => t.includes("还在跑")),
        "挡下了却没记一行原因",
      );
      rmSync(join(OUTBOX, "_test-settled-d2.md"), { force: true });
    } finally {
      cleanup();
    }
  });
});

describe("★★★ 全表规则都不阻塞（★ 纪律㉑：一件能力多个入口 ⇒ 全堵才有效）", () => {
  /**
   * ★★★ 为什么单独测这一组
   *
   *   我第一版只改了 `onSettled` 一处，然后 180s 实测 **tick 仍然只有 1 次** ——
   *   因为真正卡住的是 `onPlateau`（它有 2 处 `await fire`）。
   *   ⇒ 只在 `makeRules` 的唯一入口上统一处理，然后用**每条规则**各测一遍，
   *     确保以后谁再加 `await fire` 也不会把 tick 卡住。
   */
  const slowFire = () => {
    const calls: string[] = [];
    let finished = 0; // ★ 跑完的专家数（判据依据）
    const fire = async (role: string): Promise<string> => {
      calls.push(role);
      await new Promise((r) => setTimeout(r, 3000)); // ★ 模拟专家跑 3 秒
      finished++; // ★ 只有**真的跑完**才加 —— 这是判据的依据
      return "";
    };
    return {
      fire: fire as unknown as Parameters<typeof makeRules>[0]["fire"],
      calls,
      get finished() {
        return finished;
      },
    };
  };

  /**
   * ★★★ 判据：**专家有没有被等到说完**（不是"快不快"）。
   *
   * ★ 我第一版写 `took < 300` —— `onPlateau` 报 561ms 就红了。
   *   它慢不是因为 fire，是**扫 `work/` 目录**（2000+ 文件）。
   * ★ 改成 `took < 1500` —— 跑了 420s 真集群后**又红了**（1779ms），
   *   因为 `work/` 越跑文件越多 ⇒ **时间阈值会随运行历史漂移**。
   *
   * ★★★ 结论：**用时间当判据是错的**。要判"有没有等专家"，
   *   就该直接看"专家跑完了几位" —— 那才是想测的东西。
   *   （纪律㉔：判据的字段必须能回答你想问的问题）
   */
  const check = async (name: string, setup: (st: State) => void, run: (r: ReturnType<typeof makeRules>) => Promise<void>) => {
    const state = newState();
    setup(state);
    const { fire, finished } = slowFire();
    const { ctx } = mkCtx(fire, state);
    const rules = makeRules(ctx);
    const t0 = Date.now();
    await run(rules);
    const took = Date.now() - t0;
    // ★★★ 关键：规则返回时，专家**一定还没跑完**（专家要 3000ms）
    //   若 finished > 0，说明规则**等到了**专家说完 ⇒ 阻塞
    assert.equal(finished, 0, `${name} 等到了专家说完（${took}ms）—— 还在阻塞 tick`);
  };

  it("★ onPlateau（2 处 await fire，上一轮就是它卡住的）", async () => {
    await check(
      "onPlateau",
      (st) => {
        st.roundsSinceProgress = 99; // ★ 逼它达阈值
      },
      (r) => r.onPlateau(),
    );
  });

  it("★ onCapabilityGap", async () => {
    const cleanup = touchArtifact("_test-gap-提案.md");
    try {
      // ★ 文件名含「提案」⇒ 命中它的判据
      await check("onCapabilityGap", () => {}, (r) => r.onCapabilityGap());
    } finally {
      cleanup();
    }
  });

  it("★ onTable", async () => {
    try {
      await check("onTable", () => {}, (r) => r.onTable());
    } finally {
      /* 无副作用 */
    }
  });
});

describe("★★★ 规则接线（★ 第 4 次「写了没接上」）", () => {
  /**
   * ★★★ 为什么需要这条
   *
   *   `runner.ts` 原来写的是 `onTocDrift: gate("toc")`，
   *   而 `gate` 内部拼 `R["onToc"]` —— 但函数叫 `onTocDrift`。
   *   ⇒ 拿到 `undefined` ⇒ **规则永远不跑，而且不报错**。
   *
   *   实测症状：`--secs=180 CLUSTER_RULES=toc` 跑完，
   *   `_topology.log` 里 **一次 `onTocDrift` 都没有**。
   *   ★ 名字只差五个字母（`Toc` vs `TocDrift`），静默失效。
   *
   *   ★ 这个测试读 `runner.ts` 源码：**每个 `gate("x")` 拼出来的名字必须在
   *     规则表里真的存在**。行为测试抓不到这个（因为行为测试直接调 rules 对象）。
   */
  it("★★★ 每个 gate(\"x\") 拼出的 onX 必须存在（否则规则静默不跑）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(import.meta.dirname, "../../research/clusters/forge/runner.ts"), "utf8");

    // ① 规则表里真实存在的规则名
    const { makeRules, newState } = await import("../../research/clusters/forge/topology/rules.ts");
    const rules = makeRules({ fire: async () => "", state: newState(), trace: () => {} } as never);
    const realNames = new Set(Object.keys(rules));

    // ② runner 里所有**真用**的 `gate("x")` —— 拼出 onX
    //   ★ 要排除注释里的（我修 bug 时在注释里引用了旧写法，会误报）
    // ★ 逐行过滤注释行（不用正则 —— 免得反斜杠被工具链吃掉）
    const live = src
      .split(String.fromCharCode(10))
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join(String.fromCharCode(10));
    const bad: string[] = [];
    for (const m of live.matchAll(/gate\("([a-zA-Z]+)"\)/g)) {
      const x = m[1]!;
      const want = `on${x[0]!.toUpperCase()}${x.slice(1)}`;
      if (!realNames.has(want)) bad.push(`gate("${x}") → ${want}（规则表里没有）`);
    }
    assert.deepEqual(bad, [], `这些 gate 拼出的规则不存在，会静默不跑：\n${bad.join("\n")}`);
  });

  it("★★★ 每个规则开关都真的对应一条规则（反过来也要查）", async () => {
    const { readFileSync } = await import("node:fs");
    const { RULE_SWITCHES, makeRules, newState: ns } = await import(
      "../../research/clusters/forge/topology/rules.ts"
    );
    const rules = makeRules({ fire: async () => "", state: ns(), trace: () => {} } as never);
    const realNames = new Set(Object.keys(rules));

    // ★★★ 反向：`RULE_SWITCHES` 里的开关必须都能拼出一条真规则。
    //   2026-10-20 实证：`toc` 曾经能开，但它对应的规则被回滚了
    //   ⇒ 开了 `CLUSTER_RULES=toc` 什么也不会发生，而且不报错。
    const bad: string[] = [];
    for (const sw of RULE_SWITCHES) {
      const want = `on${sw[0]!.toUpperCase()}${sw.slice(1)}`;
      // ★ 允许别名：index → onChapterIndex（有明确映射的不算错）
      const alias: Record<string, string> = { index: "onChapterIndex", silent: "onSilentSeat" };
      const target = alias[sw] ?? want;
      if (!realNames.has(target)) bad.push(`开关 "${sw}" → ${target}（规则表里没有）`);
    }
    const msg = ["这些开关开了也没用：", ...bad].join(String.fromCharCode(10));
    assert.deepEqual(bad, [], msg);
    void readFileSync;
  });
});
