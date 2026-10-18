// 主流程 —— 起 agent、挂事件规则、投一次、等窗口
//
// ★★★ 与本项目的根本约束一致（设计者裁定）：
//   **运行时不能干涉。**
//   · 批准的部分：起常驻 agent、挂事件规则（= 配置集群）
//   · ✗ 不做：在外面盯状态、判断、起 agent
//   ⇒ 所以这里**没有 while 循环看状态** —— 规则挂在 `agent.on(...)` 上，由事件驱动。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../../../src/index.ts";
import { labAt } from "./env.ts";
import { deliverToResearcher } from "./feedback.ts";
import { recordLibState } from "./lib-state.ts";
import { attachGate } from "./guard.ts";
import { ALL_TOOLS, LAB, MODEL } from "./paths.ts";
import { EXPERTS, type ExpertName } from "./prompts/index.ts";
import * as researcherPrompt from "./prompts/researcher.ts";
import { listOutbox, makeRules, newState } from "./topology/rules.ts";
import { makeConsult } from "./tools/consult.ts";
import { makeSpawnLine } from "./tools/spawn-line.ts";

/** 拓扑日志（★ 它会不会用 consult，看这个） */
function log(kind: string, detail: string): void {
  mkdirSync(join(LAB, "work"), { recursive: true });
  appendFileSync(join(LAB, "work", "_topology.log"), `${new Date().toISOString()}  ${kind.padEnd(11)} ${detail}\n`);
  process.stdout.write(`  ${kind.padEnd(11)} ${detail}\n`);
}

export async function runCluster(secs: number, dry = false) {
  mkdirSync(join(LAB, "outbox"), { recursive: true });
  mkdirSync(join(LAB, "work"), { recursive: true });
  writeFileSync(join(LAB, "work", "_topology.log"), "");
  const t0 = Date.now();

  const lab = await labAt(join(LAB, "work"));
  const manual = readFileSync(join(LAB, "inbox/研究手册.md"), "utf8");

  const spawned: Agent[] = [];
  let seq = 1;
  /** ★ fire 定义在 researcher 之前，但它要回流给 researcher → 用这个引用接上 */
  let researcherRef: Agent | null = null;

  // ── 起一个专家：给它处境 + 地盘，等它出结论，落盘 ──
  const fire = async (role: ExpertName, why: string, focus = ""): Promise<string> => {
    const spec = EXPERTS[role];
    const a = await lab.createAgent({
      id: `L3-${role}-${Date.now().toString(36)}`,
      model: MODEL,
      role: spec.role(why, focus), // ★ 提示词工厂（prompts/<role>.ts）
      permissions: { only: [...spec.tools] }, // ★ 只读专家永远只读
    });
    attachGate(a);
    spawned.push(a);
    log("fire", `${role} ← ${why.slice(0, 60)}`);
    const res = await a.io.prompt(spec.prompt());
    const text = res.text ?? "";
    log("result", `${role} · ${text.length} 字${res.error ? " ⚠" + res.error : ""}`);
    // ── 落盘（留档，可复查）─────────────────────────────
    // ★ 放在 work/audits/ 而**不是 outbox/**：outbox 是「研究员的成果」，
    //   审查意见不是它的成果（原设计放 outbox/_audits 会让语义变混）。
    const ad = join(LAB, "work", "audits");
    mkdirSync(ad, { recursive: true });
    writeFileSync(join(ad, `${String(seq++).padStart(2, "0")}-${role}.md`), `# ${role}\n\n为什么叫它来：${why}\n\n${text}\n`);

    // ── ★★★ 回流：投给研究员（设计疏漏修复）──────────────
    // ★ 不 await：回流不该阻塞规则链；但失败必须记下来（不静默）
    if (researcherRef) deliverToResearcher(researcherRef, role, why, text, (m) => log("error", m));
    return text;
  };

  // ── agent 触发的工具（★ 用 `as ExpertName` 前先确认 consult 只放可请的那几个）──
  const consult = makeConsult((r, why, focus) => fire(r as ExpertName, why, focus));
  const spawnLine = makeSpawnLine({ lab, onSpawn: (a) => spawned.push(a) });

  // ── researcher（唯一常驻）──
  const researcher = await lab.createAgent({
    id: `L3-researcher-${Date.now().toString(36)}`,
    model: MODEL,
    role: researcherPrompt.ROLE,
    permissions: { only: [...ALL_TOOLS] },
    tools: { custom: [consult, spawnLine] },
  });
  attachGate(researcher);
  spawned.push(researcher);
  researcherRef = researcher;   // ★ 接上回流的目标

  // ── ★ lib/ 自检：它改了库，得能看见、也得能撤销（防"改坏 → 撞死"）──
  const libState = recordLibState();
  log("lib", libState.hasEdits ? `★ 它改过库：${libState.dirty.length} 处（已记入 work/_lib-state.md）` : "lib/ 未改动");

  // ── ★★★ 事件规则（集群的骨架，配置时挂好 —— 之后不再动它）──
  const state = newState();
  const rules = makeRules({ fire, state });

  researcher.on("agent_settled", () => {
    // ★ 事件回调是同步语义 —— 异步规则 fire-and-forget，但必须自己接住异常
    void (async () => {
      try {
        const n = listOutbox().length;
        if (n > state.auditedOutputs) state.roundsSinceNew = 0;
        else state.roundsSinceNew++;
        await rules.onSettled();
        await rules.onCapabilityGap();
        await rules.onPlateau();
      } catch (e) {
        log("error", `规则跑挂了：${(e as Error).message}`);
      }
    })();
  });

  log("setup", `装置就绪 · 窗口 ${secs}s · 5 个专家（按需起）· researcher 1 个（常驻）`);
  log("setup", `researcher 的自定义工具：consult / spawn_line`);

  if (dry) {
    log("dry", "只搭装置，不投递");
    researcher.dispose();
    return { dry: true };
  }

  // ── 开工：投一次就够 —— 之后全由事件驱动 ──
  const run = researcher.io.prompt(researcherPrompt.KICKOFF).catch((e) => ({
    error: (e as Error).message,
    text: "",
  }));

  // ★ 只等窗口（不做任何"看状态/判断/起 agent"的事 —— 那都在事件规则里）
  await new Promise((r) => setTimeout(r, secs * 1000));
  log("window", `窗口到点（${Math.round((Date.now() - t0) / 1000)}s）`);

  // ── 关灯（不是干涉）：让在跑的收干净 ──
  await Promise.allSettled([run, ...spawned.map((a) => a.io.waitIdle().catch(() => {}))]);
  for (const a of spawned) {
    try {
      a.dispose();
    } catch {
      /* 已释放 */
    }
  }

  const outs = listOutbox();
  console.log(`\n★ 收尾：outbox ${outs.length} 份 · 起过 ${spawned.length - 1} 次专家/支线 · 判停 ${state.verdict ?? "（无）"}`);
  console.log(`★ 日志：${join(LAB, "work", "_topology.log")}`);
  return { outputs: outs.length, fired: spawned.length - 1, verdict: state.verdict };
}
