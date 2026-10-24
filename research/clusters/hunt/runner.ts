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
import { AUTH_SOURCE, labAt } from "./env.ts";
import { deliverToResearcher, NOTE_CONSULT_ALREADY_FLOWS } from "./feedback.ts";
import { recordLibState, recordLibRevision } from "./lib-state.ts";
import { attachGate } from "./guard.ts";
import { ALL_TOOLS, LAB, MODEL, REPO } from "./paths.ts";
import { EXPERTS, type ExpertName } from "./prompts/index.ts";
import { renderSeatLedger } from "./topology/dispatch.ts";
import * as researcherPrompt from "./prompts/researcher.ts";
// ★★★ 同一身份多员工：角度的定义（设计者交办 2026-10-19）
import { ANGLES, renderAngle } from "./prompts/angles.ts";
// ★★★ 2026-10-20 拆分：hunt 的"多员工" = 三个**角度**（同一种活=探索的三种偏好）。
//   ★ forge 的"团队 × 成员"那套（lines.ts）**不在这个目录里**了。
import { listOutbox, makeRules, newState, tick, THROTTLE_N, THROTTLE_MS } from "./topology/rules.ts";
import { readPreregTraceability, renderPrereg } from "./topology/prereg-trace.ts";
import { readAbsorption, renderAbsorption, shortCode } from "./topology/absorption.ts";
import { readClosure, renderClosure } from "./topology/closure.ts";
import { readExperiments, renderExperiments } from "./topology/experiments.ts";
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

/**
 * ★★★★★ 起哪几个角度 —— **按角色选，不按序号**
 *
 * ★★★ 为什么必须有这个函数（2026-10-21 事故）：
 *   原来是 `ANGLES.slice(0, employees)`，而 `ANGLES` 顺序是
 *     [falsifier(先证伪), instrument-skeptic(先怀疑量具), **hands-on(先动手做)**]
 *   ⇒ **任何截断都先切掉唯一建设性的那个**。
 *   ★★ 后果可数：最近 80 条提交 = falsifier 35 · instrument-skeptic 18 · **hands-on 0**。
 *   ★★★ 而我当时把它诊断成「集群变成了审计员」—— 它只是**只拿到了审计员**。
 *
 * ★ 规则：**`hands-on` 永远在名单里**，其余按原顺序补。
 *   ★ 理由：三个角度里只有它承载「**把想法做出来**」；
 *     另两个（先证伪 / 先怀疑）都是对抗性的，缺了它就没有任何东西被推进。
 *
 * @param n 想要几个角度（≥1，超出上限就全给）
 */
export function pickAnglesN<T extends { key: string }>(n: number, angles: readonly T[]): T[] {
  const constructive = angles.filter((a) => a.key === "hands-on");
  const others = angles.filter((a) => a.key !== "hands-on");
  return [...constructive, ...others].slice(0, Math.max(1, Math.min(n, angles.length)));
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
  // ★★★ 2026-10-20 拆分：这里原来有 `const isForge = CLUSTER !== SOURCE_CLUSTER`
  //   和一对 `?:` 三元。★ 现在**只剩 hunt 这一侧** ——
  //   forge 的团队/观众分支在 `research/clusters/forge/runner.ts`，这里不再有它们的影子。
  //
  // ★ hunt 的多员工 = **几个探索角度**（不是团队 × 成员）。
  //   ★ `--employees=N` = 起几个角度（最多 3，见 `ANGLES`）。
  // ★★★★★ 2026-10-21 · 「广探索」= 起了几个角度，这必须是**可见读数**
  //
  //   ★★★ 实测事故：我连续很多轮用 `--employees=2`，而 `ANGLES` 的顺序是
  //     [falsifier(先证伪), instrument-skeptic(先怀疑量具), hands-on(先动手做)]
  //     ⇒ `slice(0,2)` **把唯一建设性的角度切掉了**。
  //   ★★ 后果可数：最近 80 条提交 = falsifier 35 + instrument-skeptic 18 + hands-on **0**。
  //     而我当时把这个现象诊断成「集群变成了审计员」—— ★ 它只是**只拿到了审计员**。
  //   ★ 教训（纪律㉖）：**没有名字 = 没发生** —— 起几个角度不进日志，这个错就永远静默。
  // ★★★★★ 2026-10-21 · **选中按角色，不按序号**
  //
  //   ★★★ 原来的写法是 `ANGLES.slice(0, employees)`，而 `ANGLES` 的顺序是
  //     [falsifier(先证伪), instrument-skeptic(先怀疑量具), hands-on(先动手做)]
  //     ⇒ **任何截断都先切掉唯一建设性的那个**。
  //   ★★ 后果可数：最近 80 条提交 = falsifier 35 · instrument-skeptic 18 · hands-on **0**；
  //     而我当时把它诊断成「集群变成了审计员」。
  //   ★★★ 我此前写的「不要规定形态，要立要求」在这里同样成立：
  //     **`hands-on` 是「有没有人把想法做出来」的唯一承载者，它不能被省掉。**
  const pickAngles = (n: number) => pickAnglesN(n, ANGLES);

  log(
    "seat",
    `★ 广探索度：起 ${employees} 个角度 = ${pickAngles(employees).map((a) => a.key).join(" + ")}` +
      (employees < ANGLES.length
        ? ` · ★★ 未起：${ANGLES.filter((a) => !pickAngles(employees).some((p2) => p2.key === a.key)).map((a) => a.key).join("/")}（${ANGLES.length} 个才是广探索）`
        : " · ✔ 三种角度齐全"),
  );

  const seats = pickAngles(employees).map((a) => ({
    key: a.key,
    stance: a.stance,
    render: () => renderAngle(a),
  }));
  /** ★ 真正要起的座位（hunt = 角度） */
  const usedAngles: { key: string; stance: string; render: () => string }[] = seats;
  /**
   * ★★ 「全体」的口径。
   *
   * ★ hunt **没有共识门**（它不出书，见设计者裁定：hunt 的产物是原料，book 只归 forge 管）
   *   ⇒ 这个名单在 hunt 里**没有门用它**，只作为"当前有哪些座位"的读数。
   */
  const ALL_TEAMS: string[] = usedAngles.map((s2) => s2.key);
  /** ★ 统一的渲染入口 */
  const renderSeat = (seat: { render: () => string }) => seat.render();
  const researcherByKey = new Map<string, Agent>();

  // ★ 挑战的投递路由：把文本作为消息送到目标员工
  //
  // ★★★ 用 `steer` 而不是 `queue`（2026-10-19 实测教训）：
  //   `queue` 在忙时是 **followUp**——排在**这一次运行**里。
  //   而三个员工是**不间断干活**的（几十个工具调用）⇒
  //   ★★ 实测：`hands-on` 整个窗口只收到 **5 次**挑战（另两位 24/25 次），
  //      因为它几乎从不空闲 ⇒ **挑战被排在它自己的工具输出后面**。
  //   ⇒ 改用 `steer`：**当场注入** —— 挑战必须能被看见。
  //   ★ 与 `interrupt` 不同：`steer` 不打断当前那轮，只把话插进去。
  const deliverTo = (toKey: string, text: string): { ok: boolean; reason?: string } => {
    // ★★★ 2026-10-19 夜间实测 bug：座位 key 是 `theory/architect`，
    //   但共识门/观众规则送的是**团队名** `theory` ⇒ `get("theory")` 落空
    //   ⇒ 投递**静默失败**（规则不看返回值）⇒ 三条规则触发了，agent 一次没收到。
    //   ★★ 修法：团队名 → 该队的**全部座位**；同时下面让失败**必须响亮**。
    let targets = [researcherByKey.get(toKey)].filter((x): x is Agent => !!x);
    if (targets.length === 0) {
      targets = [...researcherByKey.entries()]
        .filter(([k]) => k === toKey || k.startsWith(`${toKey}/`))
        .map(([, a]) => a);
    }
    if (targets.length === 0)
      return { ok: false, reason: `没有这位员工/团队：${toKey}（有：${[...researcherByKey.keys()].join("、")}）` };
    for (const target of targets) {
      void target.io.steer(text).catch((e: unknown) => log("error", `投递失败：${(e as Error).message}`));
    }
    // ★★ 上面的循环已经投给全部座位，这里不再重复投第一个
    // ★★★ 2026-10-19 实测缺陷：原来只存 `chars` —— **"争辩"只剩字数，内容丢了**。
    //   ★ 后果：事后**无法判断它是在争辩，还是在各说各的**（上一轮 21 次挑战，
    //     翻开看全是 `{at,to,chars}` ⇒ 只能数次数，不能读论点）。
    //   ★★ 教训（量具纪律）：**量具记的字段，必须能回答你想问的问题**。
    //     我要问"它们辩了什么"，却只记了"说了几个字"。
    const rec = {
      at: new Date().toISOString(),
      to: toKey,
      // ★ 全文（争辩必须可复核 —— 教科书里的共识要能被追出来）
      text,
      chars: text.length,
    };
    debateLog.push(rec);
    // ★★★ 同时**落盘**（2026-10-19 读数错误）：
    //   原来只在**收尾**写 `debate.jsonl` ⇒ 中途查永远是 0 ⇒
    //   ★ 我据此差点误判「挑战没发生」（实际发生了 54 次）。
    //   ★★ 教训：**量具的采样时机必须与要观测的过程匹配** ——
    //      拿一个"收尾才落盘"的量具查中途状态，得到的是假阴性。
    try {
      appendFileSync(join(LAB, "work", "debate.jsonl"), JSON.stringify(rec) + "\n");
    } catch { /* 落盘失败不影响投递 */ }
    return { ok: true };
  };

  const researchers: Agent[] = [];
  // ★★★ 2026-10-20 拆分：hunt **没有**共识门 / 联合实验 / 观众。
  //   ★ 设计者裁定（2026-10-20）：「hunt 的 97 份产物**不进 book**（它是原料，给 forge 用），
  //     **book 只交给 forge 来管**」⇒ 不出书 ⇒ 不需要出书的门与观众。
  //   ★★ 这三个机制（`sign_off` / `joint_experiment` / `judge`）的代码
  //      现在只在 `research/clusters/forge/` 里。
  for (const ang of usedAngles) {
    const myKey = ang.key; // ★ hunt 的座位 key = 角度名
    // ★ 每位员工都拿 `challenge`，但**只能挑战别人**（自己那条在工具里拦）
    const challenge = makeChallenge({
      deliver: deliverTo,
      selfKey: myKey,
      peers: () =>
        usedAngles
          .filter((x) => x.key !== myKey)
          .map((x) => ({ key: x.key, stance: x.stance })),
    });
    const a = await lab.createAgent({
      id: `L3-researcher-${myKey.replace("/", "-")}-${Date.now().toString(36)}`,
      model: MODEL,
      role: role + renderSeat(ang),
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
    `★ 研究席位 ${researchers.length} 个：${usedAngles.map((a) => a.key).join(" / ")}` +
      (researchers.length > 1 ? ` · ★ 辩证机制已开（challenge / consult / spawn_line）` : ""),
  );

  // ── ★ lib/ 自检：它改了库，得能看见、也得能撤销（防"改坏 → 撞死"）──
  const libState = recordLibState();
  log("lib", libState.hasEdits ? `★ 它改过库：${libState.dirty.length} 处（已记入 work/_lib-state.md）` : "lib/ 未改动");
  // ★★★ 记下**此刻的 lib/ 修订号**（2026-10-19 研究员请求，我采纳）：
  //   ★ 它实测到：3 人共用一个 lib/ ⇒ 改动静默合流 ⇒ 一次 run 的结果归因不到某个修订。
  //   ★★ 用内容哈希（`git hash-object`），不是 commit —— 因为改动往往**没提交**。
  const libRev = recordLibRevision("集群开工");
  log("lib", `修订指纹 ${libRev.fingerprint}（work/_lib-rev.jsonl）`);
  // ★★★ 凭证来源必须打进日志（2026-10-20）：
  //   换 key 后若还跑失败，第一件事是确认"它到底读了哪个来源"。
  //   ★ 只记来源名，**不记 key 本身** —— 日志会进 git，key 不会。
  log("auth", `凭证来源：${AUTH_SOURCE}（不记录 key 值）`);

  // ── ★★★ 事件规则（集群的骨架，配置时挂好 —— 之后不再动它）──
  const state = newState();
  // ★★★ 规则级 trace（微实验的前提量具）：每条规则每次被调用都记一笔，
  //   **哪怕它决定不动** —— 否则分不清「规则没跑」与「跑了但没触发」。
  // ★★★ 收尾态（2026-10-19 实测：多员工时才暴露的缺口）
  //
  //   现象：窗口到点 15:23，16:07 仍在跑（超 44 分钟），outbox 还在涨。
  //   机制：窗口到点 → 等收尾 → 但**员工还在产出** → 新产物触发 onSettled
  //         → fire inspector（它要跑 6 分钟）→ 期间又有新产物 → 又触发
  //         ⇒ **收尾期变成「边收边产」的自激循环**。
  //   ★ N=1 时不存在（一个员工收尾就是收尾）；
  //   ★★ N=3 时"收尾"本身又产生三倍新事件 ⇒ **永不收敛**。
  //
  //   ★ 这不是 bug（规则对、员工对），是**设计缺口**：缺一个"收尾态"。
  //   ★★ 它**不违反「运行时不能干涉」** —— 它是**集群的收尾形态**（配置的一部分），
  //      不是"我在外面判断该不该停"。
  let closing = false;

  const rules = makeRules({
    fireNow: fire,
    state,
    trace: (rule, detail) => log(`rule:${rule}`, detail),
    // ★★★ 辩证（2026-10-19）：把“去挑战同事”的**处境**送到员工面前。
    //   ★ 为什么不是给工具（实测）：第一版给了 `challenge` 工具 ⇒ **一次都没用过**。
    //   ★★ 只有多员工时才接（单员工不接 ⇒ 行为与旧版完全一致）。
    challenge: researchers.length > 1 ? deliverTo : undefined,
    peerKeys: researchers.length > 1 ? () => usedAngles.map((a) => a.key) : undefined,
    // ★★★ 2026-10-20 拆分：hunt **不接**观众/共识门/联合实验
    //   （它们都是出书的机制，book 只归 forge 管）。
    // ★ 收尾态：窗口到点后不再 fire 新专家、不再送新挑战（只等现有的做完）
    closing: () => closing,
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
    // ★★★★★ 2026-10-21 · **收尾后不再 tick**
    //
    //   ★★★ 实测（`--secs=30 --employees=3`，收尾读数打完之后）：
    //     日志继续刷 `rule:tick outbox=151 audited=0 …`，**永远不停**，
    //     进程一直不退出，`rule:done` 打不出来。
    //   ★ 根因：`clearInterval` 只停了"时间节流"（路②），
    //     但**路①（工具调用触发）还在**：研究者 agent 收尾后仍在跑，
    //     每次工具调用都走一遍 `throttledTick` ⇒ 收尾后还在 tick。
    //   ★★ 后果不只是浪费：`await waitIdle()` 永远等不到空闲 ⇒
    //     **`rule:done` 永不打出来** ⇒ 按 AGENTS「没这行 = 中途被 kill」，
    //     一轮正常收尾的 run 会被**误判成崩了**。
    if (closing) return;
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
        await tick({ fireNow: fire, state, trace: (r, d) => log(`rule:${r}`, d), rules });
      } catch (e) {
        log("error", `规则（${src}）跑挂了：${(e as Error).message}`);
      } finally {
        // ★★★ tick 跑完就**派活**（00: 派活器一次只跑一位，所以这行几微秒返回）
        //   ★ 这一行是整套修复的关键：**观察**（tick）与**派活**（drain）分开，
        //     所以 tick 不再被专家卡住 —— 下一个 tick 照常跑。
        const dr = (rules as unknown as { drainer?: { drain: () => void; busy: () => boolean; queued: () => number } }).drainer;
        dr?.drain();
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

  log("setup", `装置就绪 · 窗口 ${secs}s · 5 个专家（按需起）· 研究员 ${researchers.length} 个（常驻）`);
  log("setup", `researcher 的自定义工具：consult / spawn_line`);

  if (dry) {
    log("dry", "只搭装置，不投递");
    researcher.dispose();
    return { dry: true };
  }

  // ★★★★★ 2026-10-21 · 把「判据 → 数据」的断链摆到它面前（**集群自己发现的缺陷**）
  //
  //   ★ 来源：`onInstrumentReview` 第一次真跑，`inspirer` 挑了「判据冻结」这件
  //     它反复用了 72 次的东西，查出 **0/1750 行能反查回判据**。
  //   ★★ 它自己的措辞（比我可能给的任何说法都准）：
  //     「不是「没有链接」，是「**链接看起来有、实际只有 43% 能恢复**」」
  //
  //   ★★★ 我只做两件事：① 把它做成**可复算的读数**；② 递给它一个必须回答的问题。
  //     怎么修（hash 写进行里 / 换一种记录方式 / 说清为什么不需要）**是它的设计**。
  const preregTodo = (() => {
    try {
      const r = readPreregTraceability(join(LAB, "work"));
      if (!r.batches) return "";
      log("todo", `★ PREREG 可追溯性已递给研究员：${renderPrereg(r)}`);
      const L: string[] = [];
      L.push("### ★★★★★ 判据冻结了，但数据反查不回判据");
      L.push("");
      L.push(renderPrereg(r));
      L.push("");
      L.push("★★★ 为什么这一条比「某个结论错了」严重得多：");
      L.push("  PREREG 是**整个实验方法的地基** —— 跑之前把「怎么算成功」写死，跑完不许改。");
      L.push("  它是这个项目**唯一**防「事后挑判据」的办法。");
      L.push("  如果数据和那份冻结的判据之间**没有可恢复的链接**，那么：");
      L.push("    · 你无法证明「这些行是按那份判据算的」");
      L.push("    · 你也无法证明「判据没被改过」");
      L.push("  ⇒ **「跑前冻结」这件事，只在纸面上成立。**");
      L.push("");
      // ★★★ 修法已经有了（集群自己设计的 seal）⇒ 要求要跟着走，不能还停在"有没有链接"
      if (r.sealedBatches > 0) {
        // ★★★★★ 分母必须是「机制出生之后」——★ 集群纠正过我两次，这是第二个
        const pct = Math.round((r.sinceBirth.sealed / Math.max(r.sinceBirth.batches, 1)) * 100);
        L.push(
          `★★★ **你已经解决了这个问题的一半**：机制出生后新增 ${r.sinceBirth.batches} 批，` +
            `已封口 **${r.sinceBirth.sealed}**（${pct}%）。`,
        );
        L.push(
          `   ★ 旧的 \`全库 ${r.sealedBatches}/${r.batches}\` **不要单独引用** —— ` +
            `分母里有 ${r.batches - r.sinceBirth.batches} 批出生早于机制本身。`,
        );
        L.push("");
        L.push("★ 那么现在的问题变成：**剩下的那些批，为什么还没走 seal？**");
        L.push("★★ 这是你必须回答的（三选一都算）：");
        L.push("  (a) 更便宜的做法存在 ⇒ 说清是什么，并**用一次实验**证明");
        L.push("  (b) 它们不该走 seal ⇒ 说清是哪一类、为什么（例：一次性探针，没有判据可冻）");
        L.push("  (c) 该走但没走 ⇒ 让它走，并给出**跑完之后**这个读数该变成多少");
        L.push("");
        L.push("★★ 允许答 (b) —— 但**不许不答**：现在这个状态等于");
        L.push(`  「修法证明了能咬，但出生后仍有 ${r.sinceBirth.batches - r.sinceBirth.sealed} 批没走它」。`);
        L.push("");
        L.push("★ 不许做的：");
        L.push("  · 事后给旧批补 seal —— 那不是封口，是**补签**（封口的价值全在「跑之前就定了」）");
        L.push("  · 说「以后会走」—— 那没有判据，下一轮会一样");
        return L.join(String.fromCharCode(10));
      }

      L.push("★★ **你必须回答，三选一都算**：");
      L.push("  (a) 这是病 ⇒ 说清哪一种修法最便宜（例：让 run 记录自动带 `preregSha`），");
      L.push("      并**用一次实验**证明修法有效（跑前冻结，跑完能反查）。");
      L.push("  (b) 不算病 ⇒ 说清为什么不需要（例：判据住在 driver 里，driver 本身带 hash）。");
      L.push("  (c) 只对**新数据**要求 ⇒ 说清旧数据怎么处理（保留但标注不可追溯？作废？）");
      L.push("");
      L.push("★★ 允许答 (b)/(c) —— 但**不许不答**：现在这个状态等于");
      L.push("  「我们冻结了 72 次判据，但没人能证明哪份判据算出了哪批数」。");
      L.push("");
      L.push("★ 不许做的：");
      L.push("  · 事后补 hash 到旧行里 —— 那不是恢复链接，是**伪造链接**");
      L.push("  · 说「以后注意」—— 那没有判据，下一轮会一样");
      return L.join(String.fromCharCode(10));
    } catch (e) {
      log("error", `PREREG 读数失败：${(e as Error).message}`);
      return "";
    }
  })();

  // ★★★★★ 2026-10-21 · 「发现」有没有进状态表（知识吸收率）
  //
  //   ★ 实测：11 份手段审查，只有 6 份进了 `CONVERGED.md`；
  //     ★★ 未进的 5 份里 **3 份是最新的纠正**（手段VI / 手段VII / 手段续）。
  //   ★★★ 后果可数：`O27` 写着「装置已证」，而 `手段VII` 已证明 seal 有洞。
  //
  //   ★ 这是 hunt 的核心问题：它的价值不是"产出多少份"，是**它维护的那张状态表**。
  //     新发现不进表 ⇒ 表越来越像真的、实际越来越旧 —— 比没有表更危险。
  const absorptionTodo = (() => {
    try {
      const a = readAbsorption(join(LAB, "outbox"));
      if (!a.total) return "";
      log("todo", `★ 状态表吸收率已递给研究员：${renderAbsorption(a)}`);
      const L: string[] = [];
      L.push("### ★★★★★ 你做出的发现，有多少进了你自己的状态表");
      L.push("");
      L.push(renderAbsorption(a));
      L.push("");
      if (!a.missing.length) {
        L.push("★ 全部已进 —— 没有问题。");
        return L.join(String.fromCharCode(10));
      }
      L.push("★ 未进的名单（★ 长的在前，它们通常是主产物）：");
      for (const m of a.missing.slice(0, 10)) {
        L.push(`   · \`${shortCode(m.name)}\`（${m.chars} 字）${m.name.slice(0, 46)}`);
      }
      L.push("");
      L.push("★★★ 为什么这一条对 hunt 特别要紧：");
      L.push("  你的价值**不是**「产出多少份」，是**你维护的那张状态表**");
      L.push("  （哪些 claim 还成立 / 被取代 / 降级）。");
      L.push("  ★ 如果新发现不进表，那张表就会**越来越像真的、实际越来越旧** ——");
      L.push("    **比没有表更危险**（没有表时人会去查原始产物；有表时会信表）。");
      L.push("");
      L.push("★★ **你必须回答，三选一都算**：");
      L.push("  (a) 该进 ⇒ 进表，并说清它们**改变了哪一条**（改状态 / 新增 O 号 / 降级）");
      L.push("  (b) 不该进 ⇒ 说清为什么（例：它是实验装置的过程记录，不是 claim）");
      L.push("  (c) 进表但需要合并 ⇒ 说清哪几条是同一条");
      L.push("");
      L.push("★★ 允许答 (b) —— 但**不许不答**。");
      L.push("★ 不许做的：为了「全部已进」把文件名塞进表里 —— 那是刷指标，不是吸收。");
      L.push("  （判据：进表的那一条必须说清**它改变了什么**。）");
      return L.join(String.fromCharCode(10));
    } catch (e) {
      log("error", `吸收率读数失败：${(e as Error).message}`);
      return "";
    }
  })();

  // ★★★★★ 2026-10-21 · **缺陷欠账**（这一轮唯一的主任务）
  //
  //   ★★★ 为什么它排在所有投递之前：实测「产出是被**我递进去的东西**驱动的」——
  //     最近 24h 的 57 份产物里 **42% 明写「回答上级 / 回应上级」**。
  //     而我递的 5 件里 3 件是"你的装置有缺陷" ⇒ 产出 63% 是自审、**P* 研究 0 份**。
  //
  //   ★★ 真读数：状态表 53 条缺陷 —— 可核已结 **1**、我核不了 5、**未结 47**。
  //     ⇒ **53 开 / 1 关**。这不是"审得太多"，是"**从来没结账**"。
  //     每审一条开 2–3 条关 0–1 条 ⇒ 存量本身就是工作来源。
  //
  //   ★ 所以我停掉配额那套（治"开工"），改递这一件：**先把存量结账**。
  //     判据可数（结账率）、可离线重判、而且它自己能算。
  const closureTodo = (() => {
    try {
      const c = readClosure(join(LAB, "outbox"));
      if (!c.total) return "";
      log("todo", `★ 缺陷欠账已递给研究员：${renderClosure(c).split(String.fromCharCode(10))[0]}`);
      const L: string[] = [];
      L.push("### ★★★★★ 这一轮只有一件事：把你自己登记的缺陷**结账**");
      L.push("");
      L.push(renderClosure(c));
      L.push("");
      L.push("★★★ 为什么这件事排在最前：");
      L.push("  你的状态表里有 **" + c.total + " 条你自己登记的缺陷**，可核结账的只有 **" + c.closed + " 条**。");
      L.push("  这不是「审得太多」，是「**从来没结账**」—— 每审一条开 2–3 条、关 0–1 条，");
      L.push("  于是**存量本身变成了工作来源**：你只能一直审下去，因为它一直欠着。");
      L.push("");
      L.push("★ 每一行 O 号都必须落到**三种处置之一**（★ 三种都算结账）：");
      L.push("  · **修了** ⇒ 必须带一个**可核的路径**（`work/…` / `lib/…` / `outbox/…`，我会去查它存不存在）");
      L.push("  · **这是边界，不是缺陷** ⇒ 说清那条边界在哪（★ 这条我认：装置有边界，不是所有偏差都是缺陷）");
      L.push("  · **修不了** ⇒ 说清卡在哪（等谁 / 等什么）");
      L.push("");
      L.push("★★ **不许做的**：");
      L.push("  · 不许把一行改成「已修」了事 —— 我会去核你引的那个路径在不在盘上；");
      L.push("    核不了的我只能记成「已声明但我核不了」，**不算结账**。");
      L.push("  · 不许为了结账把两条合并成一条（那是改分母）。");
      L.push("");
      L.push("★★ 结账之后你**可以**继续开新的审查（存量闸会自动放开）。");
      L.push("★ 允许答「这批我一条都不想结」—— 但要写清为什么。");
      L.push("");
      const openIds = c.rows
        .filter((r) => r.kind === "open" || r.kind === "unsaid")
        .slice(0, 12)
        .map((r) => r.id);
      if (openIds.length) {
        L.push("★ 先结这 " + openIds.length + " 条（最老的）：" + openIds.join(" "));
      }
      return L.join(String.fromCharCode(10));
    } catch (e) {
      log("error", `缺陷欠账读数失败：${(e as Error).message}`);
      return "";
    }
  })();

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
          `★ 不要附和 —— 你的角度就是你的价值。三人都同意的东西才叫站住。` +
          closureTodo +
          preregTodo +
          absorptionTodo
        : researcherPrompt.KICKOFF,
    ).catch((e) => ({ error: (e as Error).message, text: "" })),
  );

  // ★★★ 2026-10-20 拆分：hunt 没有观众（观众是 forge 的验收机制）。
  //   ★ 原代码在这里 `io.prompt` 启动 4 位观众 —— 那一段搬去了 `forge/runner.ts`。

  // ★ 只等窗口（不做任何"看状态/判断/起 agent"的事 —— 那都在事件规则里）
  await new Promise((r) => setTimeout(r, secs * 1000));
  log("window", `窗口到点（${Math.round((Date.now() - t0) / 1000)}s）`);
  // ★★★ 进入收尾态（多个员工时必需 —— 否则"收尾"会自激，永不收敛）
  closing = true;
  log("window", "进入收尾态：不再 fire 新专家 / 不再送新挑战，只等已在跑的做完");

  for (const t of timers) clearInterval(t);   // ★ 清掉时间节流，否则进程不退出

  // ★★ 回流的审计账（写盘，可离线复核 —— 验收「同一份意见到了几次」就靠它）
  writeFileSync(
    join(LAB, "work", "deliveries.jsonl"),
    deliveries.map((d) => JSON.stringify(d)).join("\n") + (deliveries.length ? "\n" : ""),
  );
  const viaFire = deliveries.filter((d) => d.via === "fire").length;
  const viaConsult = deliveries.filter((d) => d.via === "consult").length;
  log("flow", `回流：fire 投了 ${viaFire} 条 · consult 自回 ${viaConsult} 次（★ consult 不该出现在 fire 里）`);
  // ★★★ 收尾时再记一次 lib 修订 —— **与开工时不同就说明中途有人改了库**（可归因）
  const libRevEnd = recordLibRevision("集群收尾");
  if (libRevEnd.fingerprint !== libRev.fingerprint) {
    log("lib", `★ 本轮 lib/ 被改过：开工 ${libRev.fingerprint} → 收尾 ${libRevEnd.fingerprint}`);
  }
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

  // ★★★ 收尾前**先等派活器的队列跑空**（2026-10-21）
  //
  //   ★ 为什么（这是 forge 栽过的那个坑）：`dispose()` 会**截断正在跑的专家**。
  //     没有这一步，收尾时队列里排着的那几位会被粗暴关掉 ⇒ 它们的工作白做、成本白花。
  //   ★★ 而且日志里会显示"跑了"（fire 记过），但**没有 result** —— 与"专家挂了"无法区分。
  {
    const dr = (
      rules as unknown as {
        drainer?: { busy: () => boolean; queued: () => number; drain: () => void; byRole?: () => Record<string, number> };
      }
    ).drainer;
    if (dr) {
      const t0 = Date.now();
      log("flow", `等派活器收干净（队列 ${dr.queued()} · 在跑 ${dr.busy() ? 1 : 0}）`);
      while (dr.busy() || dr.queued() > 0) {
        dr.drain();
        await new Promise((r) => setTimeout(r, 2000));
        if (Date.now() - t0 > 20 * 60_000) {
          log("flow", `⛔ 等派活器超 20 分钟 ⇒ 放弃（队列 ${dr.queued()} · 在跑 ${dr.busy() ? 1 : 0}）`);
          break;
        }
      }
      log("flow", `派活器已收干净（等了 ${Math.round((Date.now() - t0) / 1000)}s）`);
      // ★★★★★ 每个座位被派了几次（2026-10-21）
      //
      //   ★ 为什么要专门打这一行：实测事故是「`hands-on` 从头到尾 0 次」——
      //     而那件事**在日志里完全看不见**（它只是没出现）。
      //   ★★ 纪律㉖：没有名字 = 没发生。所以这一行把"谁跑了 0 次"也说清。
      //   ★ 与 git log 数前缀不同：那个数的是**提交**，不是**派活**（0 次 ≠ 没干活）。
      try {
        const counts = dr.byRole?.() ?? {};
        const all = [...usedAngles.map((a) => a.key), "inspector", "archivist", "inspirer", "watchdog", "libsmith"];
        log("flow", renderSeatLedger(counts, all));

  // ★★★★★ 2026-10-21 · **实验账**（DESIGN §9 的主判据）
  //
  //   ★★★ 为什么必须每轮报：在这之前我手上只有"产物份数"这种与探索无关的数。
  //     而 hunt 的失败长在「实验开得够不够宽」上 —— 不报它，我就分不清
  //     「没发生」和「发生了但我没看见」（纪律㉖）。
  //   ★ 模式自报家门：`inferred` = 从文件名推断（有偏差）；`ledger` = 它自己登记的账。
  try {
    const x = readExperiments(LAB);
    for (const line of renderExperiments(x.stats, x.att, x.mix).split(String.fromCharCode(10))) {
      log("readout", line);
    }
  } catch (e) {
    log("error", `实验账读数失败：${(e as Error).message}`);
  }
      } catch (e) {
        log("flow", `座位派活账打不出来：${(e as Error).message}`);
      }
    }
  }


  // ── 关灯（不是干涉）：让在跑的收干净 ──
  //
  // ★★★ 2026-10-21：原来这里是**无限等** `waitIdle()` —— 而研究者是
  //   "一直干活"的常驻 agent，收尾后它还在跑实验（一次 bash 可跑 20+ 分钟），
  //   ⇒ `waitIdle()` **永不返回** ⇒ `rule:done` 打不出来、进程不退出。
  // ★ 修法：给等一个**上限**（收尾态本来就"不再派新活"，跑着的让它跑完这点时间），
  //   到点就 dispose —— 已落盘的产物不受影响。
  // ★ 收尾态下"已 fire 的专家"给 **12 分钟**跑完（★ 原来写 3 分钟太短：
  //   实测队列里有排队 1193s 的 inspector ⇒ 3 分钟等于把它砍掉）。
  //   ★★ 到点会打一行 `⛔ 收尾超出上限` —— **截断必须响**（纪律㉖），否则
  //     "专家没结论"与"我没等"分不开。
  //   ★ 不设上限 ⇒ 一次 bash 20 分钟的实验能把整个 run 吊死（实测）。
  // ★ 测试/短跑用：`HUNT_CLOSE_CAP_MS=20000` 把上限压短（★ 不改判据本身）
  const CAP_MS = Number(process.env.HUNT_CLOSE_CAP_MS) > 0 ? Number(process.env.HUNT_CLOSE_CAP_MS) : 12 * 60_000;
  let capHit = false;
  // ★★★ 2026-10-21 修：**整组**都要被上限管。
  //   ★ 我第一版只把 `spawned` 的等待放进 race，而 `allSettled` 外面还挂着 `runs`
  //     ⇒ 只要研究者的首轮 prompt 没结束，`allSettled` 就一直等 —— 上限形同虚设。
  //     实测：`--secs=20`（没有任何专家）照样卡死在收尾。
  await Promise.race([
    Promise.allSettled([
      ...runs.map((r) => r.catch(() => {})),
      ...spawned.map((a) => a.io.waitIdle().catch(() => {})),
    ]),
    new Promise((res) => {
      const t = setTimeout(() => {
        capHit = true;
        res(null);
      }, CAP_MS);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
  for (const a of spawned) {
    try {
      a.dispose();
    } catch {
      /* 已释放 */
    }
  }

  // ★★★★★ 2026-10-21 · **收尾最后才停研究者**
  //
  //   ★★★ 我第一版把它放在收尾**开头** —— 结果把回流打断了：
  //     实测 `error 回流 libsmith 失败：agent L3-researcher-hands-on-… 已 dispose，不能再操作`
  //     ⇒ libsmith 写了 2514 字，**一个字都没送到**。
  //   ★★ 正确顺序：**先让已 fire 的专家跑完、把话送回去，再停人**。
  //
  //   ★ 那为什么还要停？因为研究者是"一直干活"的常驻 agent（一次 `bash` 20+ 分钟），
  //     `io.waitIdle()` 对它**永不返回** ⇒ 进程不退出、`rule:done` 打不出来。
  //     ⇒ 它们是"该被停"，不是"该被等"；但**必须排在回流之后**。
  try {
    researcher.dispose();
  } catch {
    /* 已释放 */
  }
  for (const r of researchers) {
    try {
      r.dispose();
    } catch {
      /* 已释放 */
    }
  }
  if (capHit) {
    log("flow", `⛔ 收尾超 ${CAP_MS >= 60_000 ? Math.round(CAP_MS / 60_000) + " 分钟" : Math.round(CAP_MS / 1000) + " 秒"}上限 ⇒ 截断还在跑的专家（★ 它们的结论没送到）`);
  }
  log("flow", "研究者已停（它们不 fire，是常驻的 ⇒ 收尾是「停」，不是「等」；★ 排在回流之后）");

  const outs = listOutbox();
  // ★★★ 收尾账**必须同时落进 `_topology.log`**（2026-10-20 实测发现）
  //   ★ 原来只 `console.log` 到 stdout ⇒ 一个只看 `_topology.log` 的新会话
  //     会以为「这轮没跑完」（其实跑完了）。
  //   ★★ 这是我自己的纪律㉖ 的反面教材：「接上了的唯一证据是日志里出现」——
  //      而我把**唯一的证据**留在了 stdout，脚本日志一删就没了。
  const closingLine = `★ 收尾：outbox ${outs.length} 份 · 起过 ${spawned.length - 1} 次专家/支线 · 判停 ${state.verdict ?? "（无）"}`;
  // ★★★ 2026-10-21：标签从 `done` 改成 `rule:done` ——
  //   AGENTS.md §三之三 教大家 `grep "rule:done"` 判「有没有正常收尾」，
  //   而实际打的是 `done` ⇒ **照文档做会得出「中途被 kill」**（实测：这轮正常收尾，
  //   grep rule:done 却是 0 行）。★ 文档与代码必须同源（纪律⑪）。
  log("rule:done", closingLine);
  console.log(`\n${closingLine}`);
  console.log(`★ 日志：${join(LAB, "work", "_topology.log")}`);
  return { outputs: outs.length, fired: spawned.length - 1, verdict: state.verdict };
}
