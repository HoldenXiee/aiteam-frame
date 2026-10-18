// ★★★ 微实验 A/B/C · 单因素并行（每个臂只拨一个旋钮）
//
// ★ 装置：合成事件序列（零模型成本、秒级、可重复）
//   先证明**规则**对，再花钱测**行为** —— 装置失败 ≠ 能力失败（P24）。
//
// ★★★ 已确认的根因（`micro/a-granularity.ts` 的证据）：
//   「长实验（不 settle）」臂里规则**总共只被调用 1 次**（开头那次交付），
//   之后 6 段长实验过程**规则一次都没机会跑**。
//   ⇒ **旋钮 A（触发粒度）是根因**；B/C 是它的派生。

import { join } from "node:path";
import { LAB } from "../paths.ts";
import { mkdirSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { type Step } from "./harness.ts";
import { makeRules, newState, listOutbox } from "../topology/rules.ts";

// ══════════════════════════════════════════════════════════════
// 事件序列：研究员一头扎进长实验（真实形态）
// ══════════════════════════════════════════════════════════════
const SCRIPT: Step[] = [
  { kind: "produce", name: "P25.md" },
  { kind: "settle" },
  { kind: "work", n: 800 }, { kind: "work", n: 800 }, { kind: "work", n: 800 },
  { kind: "work", n: 800 }, { kind: "work", n: 800 }, { kind: "work", n: 800 },
];

// ══════════════════════════════════════════════════════════════
// ★ 旋钮 A：触发粒度
//   对照 = 只在 `agent_settled` 看（旧）
//   拨动 = 额外在**每次工具调用后**看（节流：每 N 次看一次）
// ══════════════════════════════════════════════════════════════

type Granularity = "settle-only" | "per-tool-throttled";

/** 节流阈值：每 N 次工具调用看一次（★ 我拍的，微实验就是来测这个的） */
const THROTTLE_N = 15;

type ProbeResult = {
  arm: string;
  /** 规则被调用总次数 */
  ruleCalls: number;
  /** 起了哪些专家 */
  fired: string[];
  /** ★ 它"卡住"了多久才被发现（以工具调用计） */
  detectedAfter: number | null;
};

/**
 * 拨动 A：把"看一次"从 settle 挪到"每 N 次工具调用"。
 *
 * ★★ 这**不是干涉**（设计者裁定"运行时不能干涉"）——
 *   它仍然是**集群自身结构**：事件规则挂在 `tool_execution_end` 上，
 *   与 `agent_settled` 是同一类东西，只是**观察点更密**。
 *   ✗ 不是"我在外面盯"（那才是干涉）。
 */
async function probe(granularity: Granularity): Promise<ProbeResult> {
  const fired: string[] = [];
  let ruleCalls = 0;
  const state = newState();
  let toolCalls = 0;
  let detectedAfter: number | null = null;
  let produced = 0;

  const rules = makeRules({
    state,
    fire: async (role) => {
      fired.push(role);
      if (role === "inspirer" || role === "archivist") detectedAfter ??= toolCalls;
      return "VERDICT: CONTINUE";
    },
    trace: () => { ruleCalls++; },
  });

  /** 结算点：两种粒度都收敛到**同一个**动作序列（★ 判据与指令同源，P11） */
  const tick = async () => {
    const n = listOutbox().length;
    if (n > state.auditedOutputs) { state.auditedOutputs = n; state.roundsSinceProgress = 0; }
    else state.roundsSinceProgress++;
    await rules.onSettled();
    await rules.onCapabilityGap();
    await rules.onPlateau();
  };

  for (const s of SCRIPT) {
    if (s.kind === "produce") { writeFileSync(join(LAB, "outbox", s.name), "x"); produced++; }
    else if (s.kind === "work") {
      // ★ 一次"干活"= 多次工具调用（真实形态：一轮里几十次工具调用）
      for (let i = 0; i < 30; i++) {
        toolCalls++;
        if (granularity === "per-tool-throttled" && toolCalls % THROTTLE_N === 0) await tick();
      }
    } else if (s.kind === "settle") {
      await tick();
    }
  }
  void produced;
  return { arm: granularity, ruleCalls, fired, detectedAfter };
}

// ══════════════════════════════════════════════════════════════
// 跑（并行：两个臂同时）
// ══════════════════════════════════════════════════════════════

function reset() {
  const d = join(LAB, "outbox");
  mkdirSync(d, { recursive: true });
  for (const f of existsSync(d) ? readdirSync(d) : []) {
    try { if (statSync(join(d, f)).isFile()) rm0(join(d, f)); } catch { /* */ }
  }
}
function rm0(p: string) { try { require("node:fs").unlinkSync(p); } catch { /* */ } }

console.log("═══ 微实验 A · 触发粒度（单因素）═══");
console.log(`事件序列：交付 1 次 → 6 段长实验（每段 30 次工具调用，共 180 次）\n`);

const A: ProbeResult[] = [];
for (const g of ["settle-only", "per-tool-throttled"] as Granularity[]) {
  reset();
  A.push(await probe(g));
}

for (const r of A) {
  console.log(`【${r.arm}】`);
  console.log(`  规则被调用：${r.ruleCalls} 次`);
  console.log(`  起了专家  ：${r.fired.length ? r.fired.join("、") : "（★ 没有）"}`);
  console.log(`  多久才发现它卡住：${r.detectedAfter === null ? "★ 全程没发现" : `${r.detectedAfter} 次工具调用后`}`);
  console.log();
}

console.log("═══ 判定（微实验就是来看这个的）═══");
const base = A[0]!, tuned = A[1]!;
console.log(`· 旧粒度：${base.fired.length} 个专家 ${base.fired.length === 0 ? "← 长实验里完全失控" : ""}`);
console.log(`· 新粒度：${tuned.fired.length} 个专家`);
console.log(
  tuned.fired.length > base.fired.length
    ? `★ 结论：**观察点更密 ⇒ 长实验里也能被看见**（${base.fired.length}→${tuned.fired.length}）`
    : "★ 结论：拨动没效果 —— 需要重新看判据",
);
void makeRules;
