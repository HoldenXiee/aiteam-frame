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
// ★★★ 同一身份多员工：角度的定义（设计者交办 2026-10-19）
import { ANGLES, renderAngle } from "./prompts/angles.ts";
import { listOutbox, makeRules, newState, tick, THROTTLE_N, THROTTLE_MS } from "./topology/rules.ts";
import { makeConsult } from "./tools/consult.ts";
// ★★★ 辩证机制：一个员工挑战另一个员工的产物（设计者提示 2026-10-19）
import { makeChallenge } from "./tools/challenge.ts";
import { makeSpawnLine } from "./tools/spawn-line.ts";

/** 拓扑日志（★ 它会不会用 consult，看这个） */
function log(kind: string, detail: string): void {
  mkdirSync(join(LAB, "work"), { recursive: true });
  appendFileSync(join(LAB, "work", "_topology.log"), `${new Date().toISOString()}  ${kind.padEnd(11)} ${detail}\n`);
  process.stdout.write(`  ${kind.padEnd(11)} ${detail}\n`);
}

export async function runCluster(secs: number, dry = false, employees = 1) {
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
  /** ★★ 辩证账：每一条挑战（可离线复核"他们真的在辩吗"） */
  const debateLog: { at: string; to: string; chars: number }[] = [];
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

  // ── researcher ──
  //
  // ★★★ 同一身份、多个员工（设计者交办 2026-10-19）
  //
  //   ★ 他们**职责完全相同**（都是研究员），只有**看问题的角度**不同
  //     （角度的定义在 `prompts/angles.ts`）。
  //   ★★ 为什么角度进 `role` 而不是投递的消息：
  //      角度是**它是谁的一部分**（一贯怎么看问题）⇒ 会话级，不随轮次变。
  //      处境是**这一轮遇到什么** ⇒ 进指示。
  //      ★ 若把角度写成指示 ⇒ 每轮都要重复说，且**会被处境冲掉**。
  //   ★ 为什么这不算"运行时干涉"：这是**集群的形态**（起几个 agent、各自是谁），
  //      属于"配置集群"那一类，不是"在外面盯状态"那一类。
  //
  // ★★★ 辩证机制（设计者提示 2026-10-19：「让他们探讨，通过辩论把研究辩证清楚」）：
  //   ★ 我原来的做法（已被推翻）：3 个员工 ∥ 并行干活、**不要求交流** ——
  //     3 份产物并列躺在 outbox 里，**无人合并**。那是**回避设计**。
  //   ★★ 现在：他们**互相看得到彼此的产品**，且能用 `challenge` 质疑 ——
  //     要么给反例/缺陷，要么**明确说"我同意"**（逼它表态，`P7`/`B8`）。
  //   ★ 为什么不能是"你们去讨论吧"（`P3`）：不要指望模型自己分工 ——
  //     所以给的是**工具**（能挑战谁、要写什么），不是一句"请辩论"。
  const usedAngles = ANGLES.slice(0, employees);
  const researcherByKey = new Map<string, Agent>();

  // ★ 挑战的投递路由：把文本作为消息送到目标员工的队列（它在跑也收得到）
  const deliverTo = (toKey: string, text: string): { ok: boolean; reason?: string } => {
    const target = researcherByKey.get(toKey);
    if (!target) return { ok: false, reason: `没有这位员工：${toKey}（有：${[...researcherByKey.keys()].join("、")}）` };
    void target.io.queue(text).catch((e: unknown) => log("error", `挑战投递失败：${(e as Error).message}`));
    debateLog.push({ at: new Date().toISOString(), to: toKey, chars: text.length });
    return { ok: true };
  };

  const researchers: Agent[] = [];
  for (const ang of usedAngles) {
    // ★ 每位员工都拿 `challenge`，但**只能挑战别人**（自己那条在工具里拦）
    const challenge = makeChallenge({
      deliver: deliverTo,
      selfKey: ang.key,
      peers: () => usedAngles.filter((x) => x.key !== ang.key).map((x) => ({ key: x.key, stance: x.stance })),
    });
    const a = await lab.createAgent({
      id: `L3-researcher-${ang.key}-${Date.now().toString(36)}`,
      model: MODEL,
      role: role + renderAngle(ang),
      permissions: { only: [...ALL_TOOLS] },
      tools: { custom: [consult, spawnLine, challenge] },
    });
    attachGate(a);
    spawned.push(a);
    researchers.push(a);
    researcherByKey.set(ang.key, a);
  }
  const researcher = researchers[0];
  researcherRef = researcher;   // ★ 接上回流的目标（第一条意见回流给 0 号）
  log(
    "setup",
    `研究员 ${researchers.length} 个：${usedAngles.map((a) => a.key).join(" / ")}` +
      (researchers.length > 1 ? ` · ★ 辩证机制已开（challenge 工具）` : ""),
  );

  // ── ★ lib/ 自检：它改了库，得能看见、也得能撤销（防"改坏 → 撞死"）──
  const libState = recordLibState();
  log("lib", libState.hasEdits ? `★ 它改过库：${libState.dirty.length} 处（已记入 work/_lib-state.md）` : "lib/ 未改动");

  // ── ★★★ 事件规则（集群的骨架，配置时挂好 —— 之后不再动它）──
  const state = newState();
  // ★★★ 规则级 trace（微实验的前提量具）：每条规则每次被调用都记一笔，
  //   **哪怕它决定不动** —— 否则分不清「规则没跑」与「跑了但没触发」。
  const rules = makeRules({
    fire,
    state,
    trace: (rule, detail) => log(`rule:${rule}`, detail),
    // ★★★ 辩证（2026-10-19）：把“去挑战同事”的**处境**送到员工面前。
    //   ★ 为什么不是给工具（实测）：第一版给了 `challenge` 工具 ⇒ **一次都没用过**。
    //   ★★ 只有多员工时才接（单员工不接 ⇒ 行为与旧版完全一致）。
    challenge: researchers.length > 1 ? deliverTo : undefined,
    peerKeys: researchers.length > 1 ? () => usedAngles.map((a) => a.key) : undefined,
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
    if (tickBusy) {
      // ★★★ 记一笔被挡下的（2026-10-19 长跑实测）：
      //   `tick()` 里的 `await rules.onSettled()` 会 `fire` 一个审查员，
      //   而那个专家要跑 **几分钟**（实测 6 分钟）—— 期间 `tickBusy` 一直是 true，
      //   ⇒ **后续 tick 全被丢掉**。实测症状：tick 停在 1 次、8 分钟没动静。
      //   ★ 这是设计权衡，不是 bug：宁可"少看几次"，也不要"两个 tick 并发写同一个状态"。
      //   ★★ 但要**看得见** —— 否则下次又会把它当成"节流坏了"去查。
      log("rule:skip", `${src} 被跳过（上一次 tick 还在跑——它在等专家）`);
      return;
    }
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

  /** ★★★ 两个观察点**共用**这一个入口（单一写者） */
  const timedTick = throttledTick;

  // ★★★ 观察点①：一次运行结束（v1 只有这一个）
  //
  // ★★ 它必须与观察点② 共用同一个 `throttledTick` 与 `tickBusy`（2026-10-19 长跑实测）：
  //   原来这两个观察点**各写一遍**、而且①没有 `tickBusy` 守卫
  //   ⇒ 两个 tick 可以**并发跑** ⇒ ★ 破坏「同一状态单一写者」（微实验 F 的病）。
  researcher.on("agent_settled", () => timedTick("settle"));


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

  // ── 开工：每个员工各投一次 —— 之后全由事件驱动 ──
  //   ★ 三个员工**同时开跑**（不是串行）—— 这才叫"多员工"。
  const runs = researchers.map((a, i) =>
    a.io.prompt(
      // ★ 告诉他们彼此存在（他们共享 outbox 与 work）——
      //   但**不要求**他们协作：会不会看别人、要不要分工，是**要观察的行为**（`P3`：不要指望模型自己分工）。
      researchers.length > 1
        ? researcherPrompt.KICKOFF +
          `\n\n★ 这个集群有 **${researchers.length} 位研究员**（职责相同，角度不同），共用 \`outbox/\` 与 \`work/\`。` +
          `你是 \`${usedAngles[i].key}\` 那位。\n\n` +
          `## ⚔️ 辩证机制（★ 这是这个集群的核心）\n` +
          `你和同事**互相看得到彼此的产物**（都在 \`outbox/\`）。\n` +
          `★ 看到同事的产物时，用 \`challenge\` 工具**必须表一个态**：\n` +
          `  要么给出**反例/缺陷**（指到文件/数字），要么**明确说「我同意」**。\n` +
          `★ 若只写"看起来还行"，那既没推进也没纠正 —— 不算。\n` +
          `★★ 同事会挑战你的产物；**收到挑战必须回应**：接受→修订 / 反驳→给证据 / 悬而未决→说清缺什么。\n` +
          `★ 不要附和 —— 你的角度就是你的价值。三人都同意的东西才叫站住。`
        : researcherPrompt.KICKOFF,
    ).catch((e) => ({ error: (e as Error).message, text: "" })),
  );

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
  // ★★ 辩证账：他们真的在互相挑战吗（离线可复核）
  writeFileSync(
    join(LAB, "work", "debate.jsonl"),
    debateLog.map((d) => JSON.stringify(d)).join("\n") + (debateLog.length ? "\n" : ""),
  );
  if (researchers.length > 1) {
    const byTo = new Map<string, number>();
    for (const d of debateLog) byTo.set(d.to, (byTo.get(d.to) ?? 0) + 1);
    log(
      "flow",
      `辩证：共 ${debateLog.length} 次挑战` +
        (debateLog.length
          ? `（${[...byTo.entries()].map(([k, n]) => `${k}←${n}`).join(" ")}）`
          : " ★ 一次都没有 —— 要么他们没看彼此，要么没找到可挑战的"),
    );
  }

  // ── 关灯（不是干涉）：让在跑的收干净 ──
  await Promise.allSettled([...runs, ...spawned.map((a) => a.io.waitIdle().catch(() => {}))]);
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
