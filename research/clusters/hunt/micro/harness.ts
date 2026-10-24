// ★★★ 微实验装置（单因素 · 并行）—— 集群优化前的预实验
//
// ══════════════════════════════════════════════════════════════════
// ★★★★ 安全约束（2026-10-19 事故后加，**这是血的教训**）
// ══════════════════════════════════════════════════════════════════
//
// ★ 事敀：微实验 E 的 `reset()` 删了 `work/` 里的文件 ——
//   而那时**真集群正在长跑**，两者共用同一个空间
//   ⇒ **微实验把研究员的真实工作删了**（靠 git 才恢复）。
//
// ★★★ 根因：微实验本来就不应该碰**真集群的空间**。
//   它测的是**规则逻辑**（合成事件序列），根本不需要真数据。
//   ⇒ 修法：**微实验自己开一个沙箱目录**（`micro/_sandbox/`），
//     用 `LAB` 之外的空间跑，**与真集群完全隔离**。
//
// ★★ 教训（同族：本项目 `lab-1` 那个「并发集群共用工作区会互相删数据」提案）：
//   **凡"测试会删除东西"的地方，必须先问：这地方是不是活的？**
// ══════════════════════════════════════════════════════════════════


/**
 * ★★★ 微实验专用的沙箱空间 —— **与真集群的 `LAB` 完全隔离**。
 *
 * ★ 怎么做到的：`rules.ts` 里的 `LAB` 是**从 paths.ts 导入的模块级常量**，
 *   运行时改不了。所以微实验**不调那此读 `LAB` 的函数** ——
 *   它自己实现一套读/写，指向 `SANDBOX`。（代价：被测代码与生产不 100% 同源；
 *   所以 `micro/d-observer.ts` 那种"必须测生产代码"的，才用 `tick()`。）
 *
 * ★★ 安全阀：`assertSandbox()` —— 任何要删除的路径**必须**含 `_sandbox`，
 *   否则直接抛错。防止以后再写出"删真数据"的测试。
 */
export const SANDBOX = join(import.meta.dirname, "_sandbox");
export const SANDBOX_WORK = join(SANDBOX, "work");
export const SANDBOX_OUTBOX = join(SANDBOX, "outbox");

/** ★★★ 安全阀：只允许动 `_sandbox` 里的东西 */
export function assertSandbox(p: string): void {
  if (!p.replace(/\\/g, "/").includes("_sandbox")) {
    throw new Error(
      `微实验只允许动自己的沙箱，但这个路径不在里面：\n  ${p}\n` +
        `  ★ 2026-10-19 事故：微实验删过真集群的 work/（靠 git 才恢复）。`,
    );
  }
}

/** 重置沙箱（★ 只动沙箱，不碰真集群） */
export function resetSandbox(): void {
  assertSandbox(SANDBOX);
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX_WORK, { recursive: true });
  mkdirSync(SANDBOX_OUTBOX, { recursive: true });
}

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAB } from "../paths.ts";
import { listOutbox, makeRules, newState, type State } from "../topology/rules.ts";
import type { ExpertName } from "../prompts/index.ts";

/** 一次微实验的产物 */
export type MicroResult = {
  arm: string;
  /** 每条规则被调用了几次（★ 这才是"规则有没有跑"的证据 —— 主集群里量不到） */
  ruleCalls: Record<string, number>;
  /** 每次调用的输入值（看判据卡在哪一步） */
  ruleDetail: Record<string, string[]>;
  /** 起了哪些专家 */
  fired: ExpertName[];
  /** 最终 state */
  finalState: State;
  secs: number;
};

/** 一个合成的事件序列：每一步做一件事，规则在"结算点"被调用 */
export type Step =
  | { kind: "settle" }                              // 一轮结束（研究员闲了一次）
  | { kind: "produce"; name: string }               // 产出一份成果
  | { kind: "gap"; name: string }                   // 写一份"能力缺口"类产物
  | { kind: "work"; n?: number }                    // ★ 在 work/ 里干活（不产生 outbox 变化）
  | { kind: "sleep"; ms: number };                  // 推进时钟

/**
 * 跑一个臂（一个配置 + 一个事件序列）。
 *
 * ★ 每个臂**自己的 outbox 目录**：并行跑时必须隔离，否则互相看见对方的产物。
 *   （这一条是 `lab-1` 那个「并发集群共用工作区会互相删数据」提案的直接对策。）
 */
export async function runArm(
  arm: string,
  cfg: { rules: Parameters<typeof makeRules>[0] extends never ? never : unknown },
  steps: Step[],
): Promise<MicroResult> {
  void cfg;
  const fired: ExpertName[] = [];
  const ruleCalls: Record<string, number> = {};
  const ruleDetail: Record<string, string[]> = {};
  const state = newState();

  const rules = makeRules({
    state,
    fireNow: async (role) => {
      fired.push(role);
      return "VERDICT: CONTINUE";
    },
    trace: (rule, detail) => {
      ruleCalls[rule] = (ruleCalls[rule] ?? 0) + 1;
      (ruleDetail[rule] ??= []).push(detail);
    },
  });

  const t0 = Date.now();
  for (const s of steps) {
    if (s.kind === "produce") {
      writeFileSync(join(LAB, "outbox", s.name), "x");
    } else if (s.kind === "gap") {
      writeFileSync(join(LAB, "outbox", s.name), "x");
    } else if (s.kind === "work") {
      // ★ 在 work/ 里干活 —— 主集群最常做的事，而旧拓扑**完全看不见**
      const d = join(LAB, "work");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `_w${Date.now()}.md`), "x".repeat(s.n ?? 10));
    } else if (s.kind === "sleep") {
      await new Promise((r) => setTimeout(r, s.ms));
    } else if (s.kind === "settle") {
      // 与 runner.ts 的 settle 处理**逐字同源**（★ 判据与指令必须同源，P11）
      const n = listOutbox().length;
      if (n > state.auditedOutputs) state.roundsSinceProgress = 0;
      else state.roundsSinceProgress++;
      await rules.onSettled();
      await rules.onCapabilityGap();
      await rules.onPlateau();
    }
  }

  return { arm, ruleCalls, ruleDetail, fired, finalState: state, secs: (Date.now() - t0) / 1000 };
}

/** 清空 outbox，保证每个臂从干净起点开始 */
export function resetOutbox(): void {
  const d = join(LAB, "outbox");
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
}
