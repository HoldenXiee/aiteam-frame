// 主流程 —— 起 agent、挂事件规则、投一次、等窗口
//
// ★★★ 与本项目的根本约束一致（设计者裁定）：
//   **运行时不能干涉。**
//   · 批准的部分：起常驻 agent、挂事件规则（= 配置集群）
//   · ✗ 不做：在外面盯状态、判断、起 agent
//   ⇒ 所以这里**没有 while 循环看状态** —— 规则挂在 `agent.on(...)` 上，由事件驱动。

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../../../src/index.ts";
import { acquireLock } from "./lock.ts";
import { labAt } from "./env.ts";
import { deliverToResearcher, NOTE_CONSULT_ALREADY_FLOWS } from "./feedback.ts";
import { recordLibState } from "./lib-state.ts";
import { attachGate } from "./guard.ts";
import { ALL_TOOLS, LAB, MODEL } from "./paths.ts";
import { EXPERTS, type ExpertName } from "./prompts/index.ts";
import * as researcherPrompt from "./prompts/researcher.ts";
import { listOutbox, makeRules, newState, tick, THROTTLE_N, THROTTLE_MS } from "./topology/rules.ts";
import { makeConsult } from "./tools/consult.ts";
import { makeSpawnLine } from "./tools/spawn-line.ts";

/** 拓扑日志（★ 它会不会用 consult，看这个） */
function log(kind: string, detail: string): void {
  mkdirSync(join(LAB, "work"), { recursive: true });
  appendFileSync(join(LAB, "work", "_topology.log"), `${new Date().toISOString()}  ${kind.padEnd(11)} ${detail}\n`);
  process.stdout.write(`  ${kind.padEnd(11)} ${detail}\n`);
}

export async function runCluster(secs: number, dry = false) {
  // ★★★ 单实例锁：**先抢锁再动任何东西**（2026-10-19 并发会话事故后加）
  //   ★ 必须在 mkdir/writeFile 之前 —— 否则并发者已经把 _topology.log 清空了才被拦住
  const lock = acquireLock();
  if (!lock.ok) {
    console.error(`\n${lock.reason}\n`);
    process.exit(2);
  }
  const releaseOnExit = () => lock.release();
  process.on("exit", releaseOnExit);
  process.on("SIGINT", () => { releaseOnExit(); process.exit(130); });
  process.on("SIGTERM", () => { releaseOnExit(); process.exit(143); });

  mkdirSync(join(LAB, "outbox"), { recursive: true });
  mkdirSync(join(LAB, "work"), { recursive: true });
  writeFileSync(join(LAB, "work", "_topology.log"), "");
  const t0 = Date.now();

  const lab = await labAt(join(LAB, "work"));
  // ★★ 手册不再只是"告诉它路径去读" —— 它是**定义材料**，直接注入（`P21`：给清单 = 替它做完研究第一步）。
  //   （原来这里读了 `manual` 却**从没用过** —— 变量一直在那儿挂着。）
  const role = researcherPrompt.definitionWithManual();

  const spawned: Agent[] = [];
  /** ★ 集群自己的定时器（微实验 E 的时间节流）—— 收尾时必须清掉，否则进程不退出 */
  const timers: NodeJS.Timeout[] = [];
  let seq = 1;
  /** ★ fire 定义在 researcher 之前，但它要回流给 researcher → 用这个引用接上 */
  let researcherRef: Agent | null = null;
  /** ★ 回流审计：每一条投给研究员的意见（via=fire 是真投了，via=consult 是它自己回的）——
   *  这是 inspector 要的那个验收量具：「调一次 consult，那条意见出现了几次」现在数得出来。 */
  const deliveries: { at: string; role: string; why: string; chars: number; via: string }[] = [];

  // ── 起一个专家：给它处境 + 地盘，等它出结论，落盘 ──
  //
  // ★★★ `echoed`（2026-10-18 由研究员集群指出并修正）：
  //   两条触发路的回流机制不同，**不能一股脑都投**：
  //     · agent 触发（consuit）→ `defineTool.execute` 的返回值**自动进父上下文** ⇒ echoed=true，**别再投**
  //     · 代码触发（规则）  → 没有这个机制 ⇒ echoed=false，**必须投**
  //   ★ 原来无条件投 ⇒ 研究员同一份意见收到**两份**（浪费 token，且会误以为「两位专家说得一样」）。
  //   ★★ 更讽刺的是：`feedback.ts` 里那个 `NOTE_CONSULT_ALREADY_FLOWS` 常量
  //      早就写明了这条，但**全仓库没有任何引用** —— 只写了警告、没有落地。
  const fire = async (role: ExpertName, why: string, focus = "", opts?: { echoed?: boolean }): Promise<string> => {
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
    // ★★ echoed=true 表示「这条已经由 consult 的返回值自己送回去了」⇒ 跳过，免得不投两份
    if (researcherRef && !opts?.echoed) {
      // ★ 投递计数：让「同一份意见到底收到几次」可核（inspector 指出验收步骤以前做不了 ——
      //   因为根本没任何地方存这个数）。现在写进 work/deliveries.jsonl，可离线复核。
      deliveries.push({ at: new Date().toISOString(), role, why: why.slice(0, 80), chars: text.length, via: "fire" });
      deliverToResearcher(researcherRef, role, why, text, (m) => log("error", m));
    }
    return text;
  };

  // ── agent 触发的工具（★ 用 `as ExpertName` 前先确认 consult 只放可请的那几个）──
  //   ★★ `echoed: true`：consult 的返回值自己就回到研究员的上下文了，别重复投。
  //   ★ 这个约定以前只是 feedback.ts 里一个**零引用**的常量（"只写警告、没有落地"）——
  //     研究员集群抓到了它的代价（同一份意见收到两份）。现在它是**活的**：
  //     下面这行引用它，少了它类型就不对。
  const consultEchoed: typeof NOTE_CONSULT_ALREADY_FLOWS = NOTE_CONSULT_ALREADY_FLOWS;
  void consultEchoed;
  const consult = makeConsult((r, why, focus) => {
    // ★ 记一笔 via=consult（它**不**走 deliverToResearcher —— 返回值自己回流）
    deliveries.push({ at: new Date().toISOString(), role: r, why: why.slice(0, 80), chars: 0, via: "consult" });
    return fire(r as ExpertName, why, focus, { echoed: true });
  });
  const spawnLine = makeSpawnLine({ lab, onSpawn: (a) => spawned.push(a) });

  // ── researcher（唯一常驻）──
  const researcher = await lab.createAgent({
    id: `L3-researcher-${Date.now().toString(36)}`,
    model: MODEL,
    role,
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
  // ★★★ 规则级 trace（微实验的前提量具）：每条规则每次被调用都记一笔，
  //   **哪怕它决定不动** —— 否则分不清「规则没跑」与「跑了但没触发」。
  const rules = makeRules({ fire, state, trace: (rule, detail) => log(`rule:${rule}`, detail) });

  // ★★★ 观察点①：一次运行结束（v1 只有这一个）
  researcher.on("agent_settled", () => {
    // ★ 事件回调是同步语义 —— 异步规则 fire-and-forget，但必须自己接住异常
    void (async () => {
      try {
        await tick({ fire, state, trace: (r, d) => log(`rule:${r}`, d), rules });
      } catch (e) {
        log("error", `规则跑挂了：${(e as Error).message}`);
      }
    })();
  });

  // ★★★ 观察点②：每 THROTTLE_N 次工具调用（微实验 A/B 的落地）
  //
  //   ★ 为什么需要：研究员**一头扎进长实验**（实测：112 轮 0 次 settle）
  //     ⇒ 只有观察点①的话，规则**连被调用的机会都没有**。
  //     微实验 A：同一个事件序列，只拨观察点密度 ⇒ **0 → 2 个专家**。
  //
  //   ★★ 阈值 15 是微实验 B 实测的（180 次工具调用、6 段长实验）：
  //     阈值  规则调用  fire  隔多久一次  发现卡住
  //       5    111     2     90 次      15 次
  //      15     39     2     90 次      45 次  ← ★ 合格区内最省
  //      30     21     2     90 次      90 次  ✗ 太晚
  //     120      6     0     —         ★ 看不见
  //
  //   ★★★ 这不是干涉（设计者裁定「运行时不能干涉」）：
  //     它仍是**集群自身结构** —— 与观察点① 同一类事件、同一个动作序列（`tick`），
  //     只是**看的时间点更密**。✗ 不是"我在外面盯"（那才是干涉）。
  let toolCallsSinceTick = 0;
  let tickBusy = false; // ★ 上一次还没跑完就不叠加（否则卡住时会把规则堆成队列）
  /** ★★ 两路节流都调**同一个** tick（判据与指令必须同源，P11） */
  const throttledTick = (src: string) => {
    if (tickBusy) return;
    tickBusy = true;
    void (async () => {
      try {
        await tick({ fire, state, trace: (r, d) => log(`rule:${r}`, d), rules });
      } catch (e) {
        log("error", `规则（${src}）跑挂了：${(e as Error).message}`);
      } finally {
        tickBusy = false;
      }
    })();
  };

  // ── 节流路①：每 N 次工具调用（覆盖"频繁调工具"的对话形态）──
  researcher.on("tool_execution_end", () => {
    toolCallsSinceTick++;
    if (toolCallsSinceTick < THROTTLE_N) return;
    toolCallsSinceTick = 0;
    throttledTick("工具节流");
  });

  // ── 节流路②：每 T 秒（★ 覆盖"一次调用跑几小时"的实验形态）──
  //
  // ★★★ 为什么必需（微实验 E，长跑实测）：它跑实验是 `bash` 里执行 `npx tsx exp-*.ts`，
  //   **一次调用内部跑 20+ 轮、平均每轮 273 秒、最长 602 秒** ⇒ 一次调用 1~3 小时。
  //   实测：长跑 25 分钟，`rule:tick` 只 1 次，而 `work/` 里改了 1589 个文件。
  //   ⇒ 只靠路①的话，实验形态下规则**仍被饥死**。
  //
  // ★★ 它**不是干涉**：仍是集群自身结构（一个挂在集群里的定时器），
  //   调的是同一个 `tick()`，做的判断与路①**逐字一致**。
  //   ✗ 不是"我在外面盯" —— 没有判断、没有循环、没有人。
  const timer = setInterval(() => throttledTick("时间节流"), THROTTLE_MS);
  // 别让定时器把进程吊住（收尾时要 clear）—— 挂到 spawned 清理那一步
  timers.push(timer);

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

  for (const t of timers) clearInterval(t);   // ★ 清掉时间节流，否则进程不退出
  // ★★ 回流的审计账（写盘，可离线复核 —— 验收「同一份意见到了几次」就靠它）
  writeFileSync(
    join(LAB, "work", "deliveries.jsonl"),
    deliveries.map((d) => JSON.stringify(d)).join("\n") + (deliveries.length ? "\n" : ""),
  );
  const viaFire = deliveries.filter((d) => d.via === "fire").length;
  const viaConsult = deliveries.filter((d) => d.via === "consult").length;
  log("flow", `回流：fire 投了 ${viaFire} 条 · consult 自回 ${viaConsult} 次（★ consult 不该出现在 fire 里）`);

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
