// 主流程 —— 起 agent、挂事件规则、投一次、等窗口
//
// ★★★ 与本项目的根本约束一致（设计者裁定）：
//   **运行时不能干涉。**
//   · 批准的部分：起常驻 agent、挂事件规则（= 配置集群）
//   · ✗ 不做：在外面盯状态、判断、起 agent
//   ⇒ 所以这里**没有 while 循环看状态** —— 规则挂在 `agent.on(...)` 上，由事件驱动。

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../../../src/index.ts";
import { acquireLock } from "./lock.ts";
import { AUTH_SOURCE, labAt, AGENT_DIR } from "./env.ts";
import { deliverToResearcher, NOTE_CONSULT_ALREADY_FLOWS } from "./feedback.ts";
import { recordLibState, recordLibRevision } from "./lib-state.ts";
import { attachGate } from "./guard.ts";
import { ALL_TOOLS, LAB, MODEL, REPO } from "./paths.ts";
import { EXPERTS, type ExpertName } from "./prompts/index.ts";
import * as researcherPrompt from "./prompts/researcher.ts";
// ★★★ 2026-10-20 拆分：forge 的"多员工" = **团队 × 队内成员**（三条工作线，三种不同的活）。
//   ★ hunt 的"三个角度"那套（angles.ts）**不在这个目录里**了。
import { DEFAULT_TEAMS, TEAMS, renderTeam, AUDIENCES, renderAudience, BOOK_THRESHOLD } from "./prompts/lines.ts";
import {
  makeJudge,
  loadVotes,
  normQuestion,
  usabilityGate,
  usabilitySummary,
  writeVerdicts,
  type Vote,
} from "./tools/judge.ts";
import { CLUSTER } from "./paths.ts";
import { SOURCE_CLUSTER } from "./prompts/missions.ts";
import { enabledRules, listOutbox, makeRules, newState, readArtifactSafe, tick, THROTTLE_N, THROTTLE_MS } from "./topology/rules.ts";
import { makeConsult } from "./tools/consult.ts";
// ★★★ 辩证机制：一个员工挑战另一个员工的产物（设计者提示 2026-10-19）
import { makeChallenge } from "./tools/challenge.ts";
import { makeSignOff, loadSignOffs, unresolvedDislodges, writeAgreedIndex, gateVerdict, renderSignOff, freeFlips, type SignOffTable } from "./tools/signoff.ts";
import { makeJointExperiment, type JointProposal } from "./tools/joint.ts";
import { makeWriteSkillTool } from "./tools/write-skill.ts";
import { makeEnforceTool, type EnforceRecord } from "./tools/enforce.ts";
import { makeCorrectTool } from "./tools/correct.ts";
import { makeGrantTool } from "./tools/grant.ts";
import { readBehavior, renderBehavior } from "./tools/behavior.ts";
import { publishAndReport } from "./tools/publish.ts";
import { bookReport, renderBookReport } from "./tools/bookreport.ts";
import { classifyForward, readingOrder, renderOrder, undefinedTerms } from "./tools/reading-order.ts";
import { pendingMarks, renderSelf, selfConsistency, staleBySource } from "./tools/progressive.ts";
import { citationQuality, findIsolated, renderIsolation } from "./tools/isolation.ts";
import { makeSpawnLine } from "./tools/spawn-line.ts";
import { grownSeatRole, GROWN_SEAT_MODEL, GROWN_SEAT_TOOLS, makeSpawnSeat, type GrownSeat } from "./tools/spawn-seat.ts";

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
  /**
   * ★★★ 本轮开跑时刻（2026-10-20，纪律⑩：**旧数据不与新数据混用**）。
   *
   * ★ 为什么要它：`votes.jsonl` / `signoffs.jsonl` 是**跨轮累积**的（实测跨度 3 天）。
   *   而我之前把"起点 33%"和"现在 34%"放在一张表里对比 ——
   *   ★★ 那两个数**口径不同**（旧机制下的票 vs 新机制下的票）。
   *
   * ⇒ 收尾读数里**同时报两个口径**：
   *     · 全库（历史）
   *     · ★ 本轮（`at >= runStartedAt`）
   *   只有后者可以用来做"改前/改后"的比较。
   */
  const runStartedAt = new Date(t0).toISOString();

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

  /**
   * ★★★ 2026-10-20 · fire 的**异步版**（设计者选 (b)）
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么需要它（实测代价，不是设想）
   *
   *   `onSettled` 里 `await fire("inspector", ...)` 会**等专家跑完（3–6 分钟）**，
   *   而 `tick()` 是**串行**的 ⇒ 整个 tick 停在那里 ⇒ 后面所有规则饿死。
   *
   *   实测：
   *     窗口 180s ⇒ tick 只跑 **1** 次（按 THROTTLE_MS=30s 该有 ~6 次）
   *     窗口 600s ⇒ tick 只跑 **3** 次（该有 ~20 次）
   *   ⇒ **实际频率只有设计值的 1/6 ~ 1/7**。
   *   后果：排在 `onSettled` 之后的规则判据命中了却 **0 次触发**（被饿死）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么不改成 `void fire(...)`
   *
   *   ★★ `onSettled` 要读 `VERDICT: STOP|CONTINUE` 来更新 `state.verdict`。
   *   `void` 掉就**永远拿不到那行** ⇒ `state.verdict` 停在旧值 ⇒
   *   依赖它的 `onPlateau` 等规则跟着坏。**那等于修一个坏两个。**
   *
   * ══════════════════════════════════════════════════════════════════
   * 所以：**tick 不等，但结果照样回到该去的地方**
   *
   *   `fireLater(...)` 立刻返回，专家在后台跑完时调用 `onDone(text)`。
   *   ★ `onDone` 在**专家真的说完之后**才跑 —— 语义与 `await` 完全一致，
   *     只是**不占住 tick**。
   *
   *   ★★★ 纪律⑧：`fireLater` 失败必须响。专家 503 也要调 `onDone("")`
   *      —— 否则调用方会**永远等不到回调**（那比拿到空串坏得多）。
   */
  const fireLater = (
    role: ExpertName,
    why: string,
    onDone: (text: string) => void,
    focus = "",
  ): void => {
    // ★ 不 await：这就是整个修复
    void fire(role, why, focus)
      .then((text) => onDone(text))
      .catch((e: unknown) => {
        // ★★★ 专家挂了也要回调 —— 否则调用方永远等（本项目栽过“静默不响”三次）
        log("error", `fireLater(${role}) 失败：${(e as Error).message}`);
        onDone("");
      });
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
  // ★★★ forge 的三条线：默认三条（一个人做三件事必然偏向最顺手的那件 ⇒ 三条线各一人）。
  //   ★ 但 `--employees=N` **说了算**（设计者 2026-10-19：先 1 人暴露问题，再加到多员工）。
  //   ★★ 实测发现的 bug：原写 `Math.max(2, employees)` ⇒ **传 1 也起 2 条线**，
  //      与"先跑 1 人"的意图相反。现在就是 `employees`。
  // ★★★ 2026-10-20 拆分：这里原来有 `const isForge = CLUSTER !== SOURCE_CLUSTER`
  //   和一对 `?:` 三元（团队×成员 / 角度）。★ 现在**只剩 forge 这一侧** ——
  //   hunt 的那些分支在 `research/clusters/hunt/runner.ts` 里，这里不再有它们的影子。
  //
  // ★★★ forge = **团队 × 队内员工**（设计者：「多个团队、多个员工」—— 两层）
  //   ★ `--employees=N` 是**每个团队几个人**（1 或 2）。
  //   ★★ 首跑实测教训：我把「三条线」当成三个员工，结果它们各写各的、无人合成。
  //      现在每个团队至少 1 人，默认 2 人（一人提概念 / 一人连线，真的会吵）。
  const perTeam = Math.max(1, Math.min(2, employees));
  const seats = DEFAULT_TEAMS.flatMap((tk) =>
    TEAMS[tk].members.slice(0, perTeam).map((m) => ({
      key: perTeam > 1 ? `${tk}/${m.key}` : tk,
      teamKey: tk as string,
      memberKey: m.key,
      stance: TEAMS[tk].stance,
      render: () => renderTeam(tk, m.key),
    })),
  );
  /** ★ 真正要起的座位（forge = 团队 × 成员） */
  const usedAngles: { key: string; teamKey: string; stance: string; render: () => string }[] = seats;
  /** ★★ 共识门要的"全体团队" */
  const ALL_TEAMS: string[] = DEFAULT_TEAMS.filter((tk) => seats.some((s2) => s2.teamKey === tk));
  // ★★★ 观众（设计者 2026-10-19）：
  //   「加一个『观众』，最后观众**最被说服哪个观点就写哪个观点**」
  //   「所有观众都支持某个观点（或达到 9 成支持）就**结束争辩写入 book**」
  //   ★★ 观众**不生产产物**，只表态 ⇒ 它们的 role 是另一套（renderAudience）。
  //   ★ 每人有**自己的想法**（operator / skeptic / newcomer / builder）⇒ 不是橡皮图章。
  const audienceSeats = AUDIENCES.map((a) => ({ audience: a }));
  /** ★ 统一的渲染入口：两个集群各自的"多员工含义" */
  const renderSeat = (seat: { render: () => string }) => seat.render();
  const researcherByKey = new Map<string, Agent>();
  /**
   * ★★★ 本轮"长出来的"座位（**只在内存里** —— 设计者裁定：本轮有效）
   *
   * ★ 为什么不写盘：写盘并下轮读回 ⇒ 盘上的结构会变成**事实上的框架**
   *   ，只是没写在代码里 —— 那比写死更难管。
   * ★★ 本轮有效 ⇒ 每轮从同一个固定框架出发 ⇒ 不同轮的拓扑**可比**
   *   ⇒ "它长出了什么"本身成为可观测的现象。
   */
  const grownSeats: GrownSeat[] = [];
  /** ★ 长出来的座位的 run（收尾时要一起等）*/
  const grownRuns: Promise<unknown>[] = [];
  /** ★ 观众（只在 forge）—— 把它们的话送回去要用 */
  const audienceByKey = new Map<string, Agent>();

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
      // ★★★ 2026-10-20：和 `tellAudience` 同一个 bug —— `steer` 只**排队**，
      //   如果那位专家的 run 已经结束，消息就排进一次**不存在的运行**。
      //   ⇒ 投递之后补一次 `prompt`，把它叫起来。
      // ★★★ 同 `tellAudience`：用 `io.queue` 而不是 `prompt`
      //   （它忙 ⇒ 排进当前运行；它闲 ⇒ 起一次运行）。
      void target.io.queue(text).catch((e: unknown) => log("error", `投递失败：${(e as Error).message}`));
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
  // ★★★ 共识签字表（跨员工共享，且**从落盘读回** ⇒ 重启不丢）
  const signoffTable: SignOffTable = loadSignOffs(join(LAB, "work", "signoffs.jsonl"));
  /** ★ 联合实验提案表 */
  const jointTable = new Map<string, JointProposal>();
  // ★★★ 2026-10-20 · 让 agent 能在框架里**长出常驻座位**
  //
  //   设计者（逐字）：「框架不能变（规则就属于框架的一部分），变的只能是
  //     **在框架里面长东西**，比如启动 agent 等等（生长出符合框架的、
  //     **看似复杂但逻辑清晰的拓扑结构**）」
  //
  //   ★ 框架不变体现在哪（这三条在这个工具里是**硬的**，不给商量）：
  //     ① 新座位**只读** ⇒ 长出来的东西不能反过来改变框架
  //     ② 新座位**不能再长** ⇒ 不许递归长成一棵树把成本烧光
  //     ③ 团队名必须是**现有的** ⇒ 长的是座位，不是新开团队
  //
  //   ★★ 只在内存里（本轮有效）⇒ 每轮从同一个固定框架出发 ⇒ 拓扑可比。
  // ★★★ 2026-10-21 · 集群**自己写规矩**（设计者指出「没有通过 skill 的方式来优化过」）
  //
  //   ★ 和 spawn_seat 是两个不同的生长维度：
  //     · spawn_seat 长**一个席位**（拓扑多一个节点，只在内存，本轮有效）
  //     · write_skill 长**一条规矩**（拓扑不变，写进盘，下轮还在）
  //
  //   ★★★ 为什么 skill 可以落盘而座位不行（这是设计者两条裁定的一致推论）：
  //     · 座位 = 「谁来干哪件事」= **结构** ⇒ 落盘会让盘上的结构变成事实上的框架
  //     · skill = 「写小节要先给定义」= **做法** ⇒ 需要懂研究内容 ⇒ 是集群的
  //     判据（硬规则①之一）：「改它需要懂研究内容吗？」需要 ⇒ 集群的，可以落盘。
  //
  //   ★★ 写之前先看现在有哪些（防重名：一条 skill 只讲一件事）
  const writeSkill = makeWriteSkillTool({
    skillsDir: join(AGENT_DIR, "skills"),
    existing: () => {
      try {
        return readdirSync(join(AGENT_DIR, "skills")).filter((d) => !d.startsWith("."));
      } catch {
        return [];
      }
    },
    closing: () => closing,
    onWritten: async (s) => {
      log("skill", `★★ 集群写了一条新规矩：「${s.name}」→ ${s.path}`);
      log("skill", `   判据：${s.why}`);
    },
  });

  // ★★★★★ 2026-10-21 · `enforce`：集群**对某一位成员**下约束（设计者点破 skill 的弊端）
  //
  //   设计者原话：
  //     「skill 在单 agent 上有用…**但是也有弊端**。
  //      然后我们这个是 **agent 集群**，按照 skill 的作用，**会不会有更好的东西**」
  //
  //   ★★★ skill 的四个弊端，在集群上都被放大：
  //     · 静态文本 ⇒ 情况变了它还在（过时规矩比没规矩更坏）
  //     · 一律生效 ⇒ 守规矩的人也在付 token
  //     · 不追踪谁犯 ⇒ 改了谁都不知道该改谁
  //     · 不撤销 ⇒ 错误修好后它还在占地方
  //
  //   ★★★ enforce 的四点针对：
  //     ① 有对象（target 是具体成员，不是全体）
  //     ② 落在**结构**上（装进对方 `permissions.gate` ⇒ 不满足真的过不去）
  //     ③ 自带**退出条件**（until，满足就撤）
  //     ④ 每次被拦都**落盘**（能事后问"这条起效了吗"）
  //
  //   ★ 纪律㉕ 说的就是这个：**规则必须落在结构上，不能落在提示词里**。
  //     skill 在提示词层，enforce 在结构层。
  const NL2 = String.fromCharCode(10);
  const enforceLedger = join(LAB, "work", "enforce.jsonl");
  /** ★ 已装的约束（★ 每轮进程内有效；落盘的是账，不是状态） */
  const enforceRecords: EnforceRecord[] = [];

  const enforce = makeEnforceTool({
    members: () => [...researcherByKey.keys()],
    closing: () => closing,
    ledger: enforceLedger,
    log: (m) => log("enforce", m),
    install: (rec) => {
      const target = researcherByKey.get(rec.target);
      if (!target) {
        log("enforce", `★ 装不上：找不到成员「${rec.target}」`);
        return;
      }
      enforceRecords.push(rec);

      // ★★★ 真的装进对方的执行回路。
      //   ★ `permissions.gate` 是**单槽位**（后一次覆盖前一次）⇒ 必须把已有约束串起来，
      //     否则"下第二条时会把第一条冲掉" —— 那就是静默失效。
      const chain = ((target as unknown as { __enforceChain?: unknown[] }).__enforceChain ??= []);
      chain.push(rec);

      (target as unknown as {
        permissions: { gate: (fn: unknown) => void };
      }).permissions.gate(async (call: { name: string; input: unknown }) => {
        for (const r of chain as EnforceRecord[]) {
          if (r.kind !== "tool") continue;
          if (!r.tools || !r.tools.includes(call.name)) continue;

          // ★★★★★ 先看**参数**：给了 requireInInput 就只拦"内容不合格"的调用，
          //   ★ 不给就按工具名全拦（那等于禁用 —— 工具描述里已警告）
          const need = (r as EnforceRecord & { requireInInput?: string[] }).requireInInput;
          if (need?.length) {
            const blob = JSON.stringify(call.input ?? "");
            const missing = need.filter((k) => !blob.includes(k));
            if (missing.length === 0) continue; // ★ 合格 ⇒ 放行（这才是"约束"而不是"禁用"）
            try {
              appendFileSync(
                enforceLedger,
                JSON.stringify({ op: "miss", target: r.target, tool: call.name, missing, at: new Date().toISOString() }) + NL2,
              );
            } catch {
              /* 记账失败不阻断 */
            }
            return {
              block: true,
              reason:
                `⛔ 集群对你下了一道约束，这次调用**不满足**：` + NL2 +
                `   ★ 要求参数里必须有：${need.join(" · ")}` + NL2 +
                `   ★★ 你这次缺：${missing.join(" · ")}` + NL2 +
                `   ★★★ 改好再调 —— 这不是禁用这个工具，是要求它**带着依据**用。`,
            };
          }

          // ★ 记账：被拦一次写一行（★ 这样事后能答"这条约束起效了吗"）
          try {
            appendFileSync(
              enforceLedger,
              JSON.stringify({ op: "block", target: r.target, rule: r.rule, tool: call.name, at: new Date().toISOString() }) + NL2,
            );
          } catch {
            /* 记账失败不阻断（但日志里会看到） */
          }
          log("enforce", `⛔ 「${r.target}」的调用被拦：${call.name} —— ${r.rule}`);
          return {
            block: true,
            reason:
              `⛔ 集群对你下了一道约束：「${r.rule}」` + NL2 +
              `   ★ 依据：${r.evidence}` + NL2 +
              `   ★★ 什么时候解除：${r.until}` + NL2 +
              `   ★★★ 这是一道**结构上的门**，不是提醒 —— 满足条件之前，这个工具用不了。`,
          };
        }
        return undefined;
      });
      log("enforce", `✔ 已装进「${rec.target}」的执行回路（该成员现有 ${chain.length} 条约束）`);
    },
  });

  // ★★★★ 2026-10-21 · `correct`：改掉别人脑子里的错（不是发提醒）
  //
  //   ★ 为什么需要（skill 治不了的那一类）：
  //     一位成员在 30 分钟前得出一个**错的**结论，然后基于它又推了 5 步。
  //     skill 只能在它上下文里**再加一句**；而 `context.replace/erase` 能**直接改那一条**。
  //
  //   ★★ 三条硬约束（correct.ts 里）：指明 entry / 给证据 / **只抹不给对的就拒**
  const correctLedger = join(LAB, "work", "correct.jsonl");
  const correct = makeCorrectTool({
    members: () => [...researcherByKey.keys()],
    closing: () => closing,
    ledger: correctLedger,
    log: (m) => log("correct", m),
    apply: async (rec) => {
      const target = researcherByKey.get(rec.target);
      if (!target) return { ok: false, note: `找不到成员「${rec.target}」` };
      try {
        const ctx = target.context;
        // ★ 核对 entryId 真的存在（★ 不静默 no-op）
        const entries = ctx.entries();
        const hit = entries.find((e) => e.id === rec.entryId);
        if (!hit) {
          return {
            ok: false,
            note: `「${rec.target}」的上下文里没有 entry「${rec.entryId}」` +
              `（现有 ${entries.length} 条，用 context.entries() 查）`,
          };
        }
        // ★★ 核对我看到的和它现在的不一致 ⇒ 拒（防填错行改错人）
        const want = rec.originalPreview.slice(0, 24);
        if (want && !hit.preview.includes(want)) {
          return {
            ok: false,
            note: `entry「${rec.entryId}」现在的开头是「${hit.preview}」，` +
              `和你给的「${want}」对不上 —— 可能填错行了`,
          };
        }
        if (rec.erase) {
          await ctx.erase(rec.entryId);
          // ★★★ 抹掉之后**必须补一条对的** —— 否则它会用同样的推理再得出同一个错
          await ctx.replace(rec.entryId, `【集群纠正】${rec.replacement}`);
          return { ok: true, note: "已抹掉原结论并换成对的" };
        }
        await ctx.replace(rec.entryId, `【集群纠正】${rec.replacement}`);
        return { ok: true, note: "已改写那一条" };
      } catch (e) {
        return { ok: false, note: (e as Error).message };
      }
    },
  });

  // ★★★★ 2026-10-21 · `grant`：临时给某位成员加一把工具（和 spawn_seat 是一对）
  //
  //   spawn_seat 长**一个人**；grant 长**一份能力**。
  //   ★ 只能加只读工具（SAFE_TOOLS）—— 否则绕过 spawn_seat 的「新席位只读」约束。
  //   ★★ 必须给 until（★ 收尾时 runner 真的 remove，不是"记得就收"）
  const grantLedger = join(LAB, "work", "grant.jsonl");
  /** ★ 已加的能力（收尾时收回） */
  const grants: { target: string; tools: string[] }[] = [];
  const grant = makeGrantTool({
    members: () => [...researcherByKey.keys()],
    closing: () => closing,
    ledger: grantLedger,
    log: (m) => log("grant", m),
    apply: async (rec) => {
      const target = researcherByKey.get(rec.target);
      if (!target) return { ok: false, note: `找不到成员「${rec.target}」` };
      try {
        await target.permissions.allow(rec.tools);
        grants.push({ target: rec.target, tools: rec.tools });
        return { ok: true, note: "已加" };
      } catch (e) {
        return { ok: false, note: (e as Error).message };
      }
    },
  });

  const spawnSeat = makeSpawnSeat({
    teams: () => ALL_TEAMS,
    takenKeys: () => [...researcherByKey.keys()],
    closing: () => closing,
    create: async (spec) => {
      const a = await lab.createAgent({
        id: `L3-grown-${spec.key.replace("/", "-")}-${Date.now().toString(36)}`,
        model: GROWN_SEAT_MODEL,
        role: grownSeatRole(spec),
        permissions: { only: [...GROWN_SEAT_TOOLS] },
        // ★ 它能挑战别人（★ 否则它只是个读者，谁都能不理它）
        //   ★★ 注意：它**没有** spawn_seat（框架约束②：不许递归长出树）
        tools: {
          custom: [
            makeChallenge({
              deliver: deliverTo,
              selfKey: spec.key,
              peers: () => [
                ...researcherByKey.keys(),
                ...grownSeats.map((g) => g.key),
              ]
                .filter((k) => k !== spec.key)
                .map((k) => ({ key: k, stance: "" })),
            }),
          ],
        },
      });
      attachGate(a);
      spawned.push(a);
      // ★★ 接进路由：能被投递、能被共识门找到
      // ★★★ 2026-10-20：这里原来还有一行 `grownSeatAgents.set(...)`，
      //   而 **`grownSeatAgents` 这个变量根本不存在** ——
      //   ★★ 之所以一直没被发现：`tsconfig.json` 的 include 里**没有 `research/clusters/`**，
      //     所以 `tsc --noEmit` 从来没检查过集群代码（22 个错全藏在盲区里）。
      //   ⇒ 修法：删掉那行（`researcherByKey` 已经是同一份路由表，够用）。
      researcherByKey.set(spec.key, a);
      // ★ 立刻开跑（与其它常驻座位同一条纪律：
      //   "建出来" ≠ "它在跑" —— 不 prompt 的话 steer 会排在"不存在的运行"后）
      grownRuns.push(
        a.io.prompt(
          `★ 你是被同事长出来的座位 \`${spec.key}\`（本轮有效）。

` +
            `★ 你的职责：${spec.duty}
` +
            `★ 长出你的理由：${spec.why}

` +
            `★★ 你**只读** —— 写不了文件。发现问题用 \`challenge\` 找作者。
` +
            `★ 现在去 \`outbox/\` 看一圈，盯住你这一条。`,
        ).catch((e: unknown) => ({ error: (e as Error).message, text: "" })),
      );
      return a;
    },
    onGrown: (seat) => {
      grownSeats.push(seat);
      log("grow", `★ 长出新座位 ${seat.key}（${seat.team}）· 职责：${seat.duty.slice(0, 50)}`);
      log("grow", `   理由：${seat.why.slice(0, 80)}`);
      // ★★ 记账（可离线复核"这一轮到底长了什么"—— 量具与机制同批上线）
      try {
        mkdirSync(join(LAB, "work"), { recursive: true });
        appendFileSync(
          join(LAB, "work", "grown.jsonl"),
          JSON.stringify({
            at: new Date().toISOString(),
            key: seat.key,
            team: seat.team,
            duty: seat.duty,
            why: seat.why,
          }) + "\n",
        );
      } catch (e) {
        log("error", `生长账写失败：${(e as Error).message}`);
      }
    },
  });

  for (const ang of usedAngles) {
    const myKey = ang.key; // ★ forge 是 `team/member`，hunt 是角度名
    // ★ 每位员工都拿 `challenge`，但**只能挑战别人**（自己那条在工具里拦）
    //   ★★ forge 要能挑战**别的团队**（同团队内也可挑）⇒ peers 用 myKey 判
    const challenge = makeChallenge({
      deliver: deliverTo,
      selfKey: myKey,
      peers: () => [
        ...usedAngles
          .filter((x) => x.key !== myKey)
          .map((x) => ({ key: x.key, stance: x.stance || (x.teamKey ? `团队 ${x.teamKey}` : "") })),
        // ★★★ 2026-10-20：长出来的座位也是**可以被挑战的对象**
        //   ★ 否则"长出一个座位"就只是多了一个读者，谁都能不理它
        ...grownSeats
          .filter((g) => g.key !== myKey)
          .map((g) => ({ key: g.key, stance: g.team })),
      ],
    });
    // ★★★ 共识门（设计者 2026-10-19：「最后争辩出一个都认同的结果才能写进 book」）
    //   ★ 每位员工都有 `sign_off`；门要求**全体团队**都表态（沉默不算认同）。
    const signOff = makeSignOff({
      selfKey: ang.teamKey || ang.key,
      allTeams: () => ALL_TEAMS,
      recordPath: join(LAB, "work", "signoffs.jsonl"),
      table: signoffTable,
      outboxDir: join(LAB, "outbox"),
    });
    // ★★ 联合实验（设计者：「各个团队可以设计实验，或共同设计实验来验证」）
    const joint = makeJointExperiment({
      selfKey: ang.teamKey || ang.key,
      allTeams: () => ALL_TEAMS,
      recordPath: join(LAB, "work", "joint.jsonl"),
      table: jointTable,
      workDir: join(LAB, "work", "joint"),
    });
    const a = await lab.createAgent({
      id: `L3-researcher-${myKey.replace("/", "-")}-${Date.now().toString(36)}`,
      model: MODEL,
      role: role + renderSeat(ang),
      permissions: { only: [...ALL_TOOLS] },
      // ★★ forge 多两件工具：`sign_off`（共识门）+ `joint_experiment`（联合设计实验）
      // ★★★ 2026-10-20 拆分：forge 多两件工具（`sign_off` 共识门 + `joint_experiment` 联合实验）
      // ★★★ 2026-10-20：加了 `spawn_seat` —— 能在框架里**长出常驻座位**（本轮有效）
      tools: {
        custom: [consult, spawnLine, spawnSeat, writeSkill, enforce, correct, grant, challenge, signOff, joint],
      },
    });
    attachGate(a);
    spawned.push(a);
    researchers.push(a);
    researcherByKey.set(ang.key, a);
  }

  // ★★★ 起观众（只在 forge）：它们**不写产物**，只回答"谁最说服了我"
  const audiences: Agent[] = [];
  const votes: Vote[] = loadVotes(join(LAB, "work", "votes.jsonl"));
  for (const seat of audienceSeats) {
    const a = seat.audience;
    const judge = makeJudge({
      selfKey: a.key,
      recordPath: join(LAB, "work", "votes.jsonl"),
      votes,
    });
    const ag = await lab.createAgent({
      id: `L3-audience-${a.key}-${Date.now().toString(36)}`,
      model: MODEL,
      role: renderAudience(a),
      permissions: { only: [...ALL_TOOLS] },
      tools: { custom: [judge, consult] },
    });
    attachGate(ag);
    spawned.push(ag);
    audiences.push(ag);
    audienceByKey.set(a.key, ag);
  }

  const researcher = researchers[0];
  researcherRef = researcher;   // ★ 接上回流的目标（第一条意见回流给 0 号）
  log(
    "setup",
    `★ 研究席位 ${researchers.length} 个：${usedAngles.map((a) => a.key).join(" / ")}` +
      (researchers.length > 1 ? ` · ★ 辩证机制已开（challenge / sign_off / joint_experiment）` : ""),
  );
  if (audiences.length) {
    log(
      "setup",
      `★★ 观众 ${audiences.length} 位：${AUDIENCES.map((a) => a.key).join(" / ")}` +
        ` · ★★★ 观众最被谁说服就写谁的观点（门槛 ${Math.round(BOOK_THRESHOLD * 100)}%）`,
    );
  }

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
    fire,
    state,
    trace: (rule, detail) => log(`rule:${rule}`, detail),
    // ★★★ 辩证（2026-10-19）：把“去挑战同事”的**处境**送到员工面前。
    //   ★ 为什么不是给工具（实测）：第一版给了 `challenge` 工具 ⇒ **一次都没用过**。
    //   ★★ 只有多员工时才接（单员工不接 ⇒ 行为与旧版完全一致）。
    challenge: researchers.length > 1 ? deliverTo : undefined,
    peerKeys: researchers.length > 1 ? () => usedAngles.map((a) => a.key) : undefined,
    // ★★★ 观众通道（只在 forge）：请观众评"哪一方的说法最站得住"
    audience: audiences.length > 0 ? () => [...audienceByKey.keys()] : undefined,
    // ★★★ 每份产物已收到几张票（2026-10-20）
    //   ★ 为什么要它：`onAudience` 原来只判"推过没有"，而**推过 ≠ 投了**。
    //   实测 46 份里只有 15 份 4 票齐全，25 份只拿到 1 票。
    //   ★★ 这里从**已落盘的 votes** 实时算（同一个数组，judge 工具往里 push）。
    voteCoverage:
      audiences.length > 0
        ? (artifact: string) => {
            // ★★★ 2026-10-20 · 这里栽过一次（纪律⑪：判据与指令必须同源）
            //
            //   病：我按「规则里写的题目」去匹配，而规则里带反引号：
            //     `` `x.md` 这份东西该不该进书… ``  ← 规则
            //     `x.md 这份东西该不该进书…`        ← 观众实际存的（**没有反引号**）
            //   ⇒ `voteCoverage` **永远算出 0** ⇒ 同一批 3 份被**无限重推**。
            //
            //   ★ 修法：**归一化**后再比（去掉所有反引号与多余空白）。
            //   ★★ 这样无论哪边带不带反引号，都算同一道题。
            const norm = (t: string) => t.replace(/`/g, "").replace(/\s+/g, " ").trim();
            const want = norm(`${artifact} 这份东西该不该进书，哪一方的说法最站得住？`);
            return new Set(votes.filter((v) => norm(v.question) === want).map((v) => v.by)).size;
          }
        : undefined,
    // ★★★ 共识门的状态（供 onConsensus 规则判断"谁还没签字"）
    signoffState: (artifact: string) => signoffTable.get(artifact),
    allTeams: () => ALL_TEAMS,
    tellAudience:
      audiences.length > 0
        ? (key: string, text: string): { ok: boolean; reason?: string } => {
            const ag = audienceByKey.get(key);
            if (!ag) return { ok: false, reason: `没有这位观众：${key}（有：${[...audienceByKey.keys()].join("、")}）` };
            // ★★★ 2026-10-20 · 长跑实测的 bug（同类第 4 次）
            //
            //   病：`steer` 只把消息**排进** agent 的运行队列。
            //   ★★ 而观众在启动时的 prompt 里被要求「读完**然后继续等**」——
            //     「等」= 它结束了自己的 run ⇒ 之后 `steer` 排进的是**一次不存在的运行**。
            //
            //   ★★★ 实测（1500s 长跑，36 份被评）：
            //     builder 61% 有票 · skeptic 58% · operator 42% · **newcomer 33%**
            //     投递失败 **0 次** —— 消息全送到了，只是**没人被叫醒**。
            //   ⇒ 这直接导致 `usabilityGate` 把它们判成「没人问过」（24/26）。
            //
            //   ★ 修法：steer 之后**主动 prompt 一次**，把它叫起来。
            //     （与 2026-10-19 那次修法同源：投递要发生在**真的在跑**的 agent 上。）
            // ★★★ 2026-10-20（第二次）· 上面那句用 `prompt` 是**错的** ——
            //   实测报错 95 次：「agent 正在运行：请用 io.queue() 投递，或用 io.waitIdle() 等它跑完」。
            //   ⇒ `prompt` 在它**正在跑**时会失败，而观众大部分时间都在跑。
            //
            //   ★★★ 正解是 `io.queue`（本项目 `feedback.ts` 已用同一条）：
            //     · 它忙 ⇒ **排进当前这次运行**
            //     · 它闲 ⇒ **起一次运行**
            //   两条路都不会打断在飞那一轮 —— 这正是"叫醒它但要温和"的意思。
            //
            //   ★ 实测对比（42 份被评）：
            //     steer 单独     ⇒ newcomer 33%
            //     steer + prompt ⇒ 38%（且 95 次报错，靠运气）
            //     steer + queue  ⇒ 见本轮读数
            // ★★★ 量具（2026-10-20，纪律㉒）：**投递也要有回执**。
            //   病：实测 newcomer/builder 收到消息后**没投票**，而日志里**什么都没有**
            //   ⇒ 分不清"没送到"还是"送到了它没做"（这正是本项目的老毛病）。
            //   ★ 所以这里记一条 `deliver`：谁、忙不忙（决定是 followUp 还是起新 run）。
            const busy = ag.io.isRunning;
            void ag.io
              .queue(text)
              .then(() => log("deliver", `${key} ${busy ? "忙→排进当前 run" : "闲→起新 run"}`))
              .catch((e: unknown) => log("error", `观众投递失败 ${key}：${(e as Error).message}`));
            return { ok: true };
          }
        : undefined,
    // ★ 收尾态：窗口到点后不再 fire 新专家、不再送新挑战（只等现有的做完）
    closing: () => closing,
  });

  // ★★★ 2026-10-20 · 五条猜想的开关（`CLUSTER_RULES=table,silent,falsify,index,untested` 或 `all`）
  //
  //   ★ 默认全关 ⇒ tick 里那五个 `?.()` 全是 undefined ⇒ **行为与拆分后完全一致**。
  //   ★★ 纪律⑱ 单变量：一次只开一条。
  //   ★★★ 「接上了」的唯一证据是日志里出现它的名字（纪律㉖）——
  //      所以下面开一条就在 `_topology.log` 写一行，方便事后核对"它到底开没开"。
  const ON = enabledRules();
  if (ON.size) {
    log("rules", `★ 猜想规则已开：${[...ON].join(" / ")}（其余保持原样）`);
  } else {
    log("rules", `猜想规则全关（默认）· 开法：CLUSTER_RULES=table,silent,falsify,index,untested 或 all`);
  }
  const R = rules as unknown as Record<string, () => Promise<void>>;
  const gate = (name: string) => (ON.has(name as never) ? R[`on${name[0]!.toUpperCase()}${name.slice(1)}`] : undefined);
  const rulesGated = {
    ...rules,
    onTable: gate("table"),
    onSilentSeat: ON.has("silent")
      ? (R["onSilentSeat"] as (() => Promise<void>) | undefined)
      : undefined,
    onFalsify: gate("falsify"),
    // ★★★ `gate("index")` 拼出的是 `onIndex`，而函数叫 `onChapterIndex`
    //   ⇒ **这条规则从上线起就没跑过一次**（2026-10-20 由 wiring 断言抓到）。
    //   ★ 这是「写了没接上」的第 5 次 —— 而且这次是**我自己的猜想实验**。
    onChapterIndex: ON.has("index") ? (R["onChapterIndex"] as (() => Promise<void>) | undefined) : undefined,
    onUntested: gate("untested"),
  };

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
        await tick({ fire, state, trace: (r, d) => log(`rule:${r}`, d), rules: rulesGated as typeof rules });
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

  log("setup", `装置就绪 · 窗口 ${secs}s · 5 个专家（按需起）· 团队 ${ALL_TEAMS.length} 个 × 座位 ${researchers.length} 个（常驻）`);
  log(
    "setup",
    `researcher 的自定义工具：consult / spawn_line / spawn_seat（★ 本轮可长常驻座位）` +
      ` / write_skill（长规矩）· enforce（对某位下约束）· correct（改掉错结论）· grant（临时加工具）` +
      ` / challenge / sign_off / joint_experiment`,
  );

  if (dry) {
    log("dry", "只搭装置，不投递");
    researcher.dispose();
    return { dry: true };
  }

  // ── 开工：每个员工各投一次 —— 之后全由事件驱动 ──
  //   ★ 三个员工**同时开跑**（不是串行）—— 这才叫"多员工"。
  //
  //   ★★★ 2026-10-20 实测教训（本会话第 4 次同类）：
  //     「长出座位」那段提示词**只写在 `researchers.length > 1` 分支里** ⇒
  //     我用 `--employees=1` 跑了 4 分钟，**提示词根本没发出去**。
  //   ★★★ 但那**不是真因**。真因在 `prompts/researcher.ts` 的 `TOOLS_NOTE`：
  //     它写着「你有**两个**工具」，而实际给了三个 ⇒ **定义主动排除了第三个**
  //     （定义进 `role`，会话级、每次都在；比开工时的一句话强得多）。
  //   ⇒ 已改成定义里的正确陈述；**这里不再重复** —— 一个能力两处描述，
  //     迟早会分叉（“同一个机制多个入口”的老教训）。
  // ★★★ 2026-10-20 · 把**未兑现的解除条件**摆到桌面上（AGENTS §〇之三）
  //
  //   病：「条件写在那儿，但**没人去执行**」。
  //   实测：进书 29 份里有 **25 份带解除条件，共 43 条**，
  //        每条都写得可执行（"路线 A 改成含《观测单元》"、"§6 换成边际价口径"…），
  //        ★★ 但**没有任何东西在事后检查它们有没有兑现**。
  //   ⇒ 于是「有保留」退化成**永久的免责声明**：门以为在把关，其实把责任推给了未来。
  //
  //   ★ 为什么由我来算、由它来判：
  //     "哪条还挂着"是**读数**（纯函数、离线可判）；
  //     "先做哪条、怎么算兑现"是**内容判断** ⇒ 归集群（硬规则①）。
  //   ★★ 所以这里只**递清单**，不说"你先做这个"。
  const pendingTodo = (() => {
    try {
      const pub = readdirSync(join(REPO, "research/book/src/05-集群产出")).filter((f) => f.endsWith(".md"));
      const un = unresolvedDislodges(signoffTable, pub);
      if (!un.size) return "";
      const rows: string[] = [];
      let shown = 0;
      for (const [artifact, list] of un) {
        for (const r of list) {
          if (shown++ >= 12) break;
          rows.push(`· \`outbox/${artifact}\` ← **[${r.by}]** ${r.dislodge.slice(0, 120)}`);
        }
        if (shown >= 12) break;
      }
      const totalRows = [...un.values()].reduce((a, b) => a + b.length, 0);
      const L: string[] = [
        "",
        `## 📌 上一轮留下的待办（★ 有保留的解除条件，共 ${un.size} 份 / ${totalRows} 条）`,
        "",
        `★★ 这些是**你的同事上次说「可以发，但要做到这件事」**时留下的。`,
        `**到现在没人检查过它们有没有做到** —— 所以它们还挂着。`,
        "",
        ...rows,
      ];
      if (totalRows > 12) L.push(`· …还有 ${totalRows - 12} 条，见 \`work/publish.md\``);
      L.push(
        "",
        `★ 你怎么处理由你定：`,
        `· 已经做到的 → 在产物里写明「已按 X 解除」，让下一轮能核对`,
        `· 没做到的 → **做掉它**，这比再写一份新的更有价值`,
        `· 已经不该做的 → 说清为什么作废（不要默默留着）`,
        `★★★ 不许做的：装作看不见。挂在书里的未兑现条件，读者会当成「作者知道但没修」。`,
      );
      return L.join(String.fromCharCode(10));
    } catch (e) {
      // ★ 算不出来不能拖垮开工，但必须响
      log("error", `未兑现解除条件算失败：${(e as Error).message}`);
      return "";
    }
  })();
  if (pendingTodo) log("todo", "★ 上一轮的未兑现解除条件已递给研究员（清单在开工提示里）");

  // ★★★ 2026-10-20 · 「散记」清单（`antiValue` 最重那条禁令的第一个出口）
  //
  //   病：`missions.ts` 的 `antiValue` 写着
  //     「★★ 一句话：**没长出新概念的内容，不算这本教科书的内容。**」
  //   ★★ 而实测 `grep "概念|定义|模型" rules.ts` ⇒ **12 条规则里 0 条提到**
  //     ⇒ 这条禁令**零出口**（纪律㉕）。
  //
  //   ★ 实测症状（2026-10-20，62 份）：平均引用 1.6 份 · 零引用 24 份（39%）
  //
  //   ★★★★★ 2026-10-21 **更正：那个 39% 是错的，我把判据做窄了。**
  //     · 我原来只数**出度**（它引用了谁）⇒ 把「别人引用它、它不引用别人」的
  //       **源头章**也算成"散记"。
  //     · 实测（103 份）：零引用 19 份里 **16 份是被别人引用的源头**（正常），
  //       ★★ **真孤岛（出 0 且入 0）只有 3 份**。
  //     · 而且「最孤立的最长的」是**前 3 名的错觉**：
  //       真孤岛 13663 / 10660 / 5543 字，**都比平均（约 2 万）短**；
  //       最长的两份（39039 / 26298 字）是 `source`——**被别人大量引用**。
  //   ⇒ 结论：书的连接性**不是**主要问题；我之前的代理量夸大了 6 倍。
  //
  //   ★★★ 为什么**只递清单、不拦截**：
  //     判"有没有新概念"是**内容判断**（硬规则①，我不能碰）。
  //     而「零引用」只是**必要症状，不是充分条件** —— 真的新方向也可能是零引用。
  //   ★★ 所以我只报数 + 列出名单，怎么处理由集群定。
  const isolationTodo = (() => {
    try {
      const r = findIsolated(join(LAB, "outbox"));
      if (!r.all.length) return "";
      const z = r.isolated;
      // ★★★ 防刷指标（2026-10-20）：**刷了要看得见**
      //   ★ 我把"零引用"变成可见的坏指标，就等于告诉集群"塞一句文件名就能过关"。
      //   ★★ 所以同批上线 `citationQuality`：光秃秃的引用占比一涨，就是被刷了。
      //   ★ 实测基线（62 份 / 124 次提及）：**光秃秃 0 次（0%）** —— 现在没被刷。
      const cq = citationQuality(join(LAB, "outbox"));
      const L: string[] = [
        "",
        `## 📌 书的形状：${z.length}/${r.all.length} 份是**真孤岛**（★ 出 0 且入 0）`,
        "",
        `★ 读数：${renderIsolation(r)}`,
        `★★ 引用质量：${cq.total} 次提及里 **光秃秃 ${cq.bare} 次（${cq.barePct.toFixed(0)}%）**` +
          `（"光秃秃" = 那句除了文件名没有别的内容，如「参见 x.md」）`,
        `★★ 什么算"引用"：正文里**提到了另一份产物的文件名**（前 12 字）。`,
        `   不是"思想上有联系"，是**能指回具体一份**。`,
        "",
        `★★★ 为什么这件事值得你花时间：`,
        `· \`antiValue\` 写着「**没长出新概念的内容，不算这本教科书的内容**」`,
        `· 而「分散的散记」和「只做摘要/汇总」的共同症状就是**跟已有的东西没连接**`,
        `· 实测最孤立的 5 份**恰好是最长的**（1.8–3.8 万字）——`,
        `  **写得越长、越不与别处相连**，这正是"散记写得更长"的样子`,
        "",
        `## 零引用的产物（按字数降序，前 10）`,
        ...z.slice(0, 10).map((x) => `· \`outbox/${x.artifact}\`（${x.chars} 字）`),
        ...(z.length > 10 ? [`· …还有 ${z.length - 10} 份`] : []),
        "",
        `★ 你怎么处理由你定（这些都不是"必须做"，是"你得知道"）：`,
        `· 它其实在回答某份已有的东西 → **在正文里写明**（读者才知道从哪读起）`,
        `· 它和另外几份其实是一个主题 → 合并、或让其中一份当入口`,
        `· 它真的是新方向 → **说清它和现有哪几条划界**（否则读者会当成重复的一篇）`,
        `★★★ 不许做的：为了"不孤立"硬塞一句引用。那是**刷指标**，不是整合。`,
      ];
      return L.join(String.fromCharCode(10));
    } catch (e) {
      // ★ 算不出来不能拖垮开工，但必须响
      log("error", `孤立读数失败：${(e as Error).message}`);
      return "";
    }
  })();
  if (isolationTodo) {
      const rr = findIsolated(join(LAB, "outbox"));
      log("todo", `★ 孤立产物清单已递给研究员（★★ 真孤岛 ${rr.isolated.length} 份 · 只出零 ${rr.all.filter((x) => x.role === "source").length} 份是源头不算病）`);
    }

  // ★★★ 2026-10-20 · 认知顺序：**立要求**，不是替它改内容
  //
  //   设计者原话（这是这一节唯一的依据）：
  //     「主要的就是违反了人的认知规律，在学习陌生知识，
  //       **如果学过前置知识（或类似知识）就能轻松学会**」
  //     「可以试试」
  //
  //   ★★★ 为什么这次是「立要求」而不是「递清单」：
  //     上面那份「孤立产物清单」是**只报数**——因为"零引用"可能是真的新方向。
  //     ★★ 但「前置知识律」不是可选项：**读者没有前置知识就是学不会**，
  //        这和"新方向"不冲突（新方向也得从已知的东西讲起）。
  //
  //   ★ 目标怎么定（★ 不是拍阈值，是把它变成**可判死的目标**）：
  //     · 倒挂 = 0 —— "读者永远不需要先读后面"，这是**定义**，没有"多少算好"
  //     · 术语：正文用到的黑话，**首次出现处必须能查到定义**
  //     ★★ 两条都不给数字上限 —— 给的是"什么算做到"。
  //
  //   ★ 为什么由我来算、由它来改：算"哪份引用了后面"是**纯文本位置比较**；
  //     而"怎么重排、怎么改写、哪些概念先讲"是**内容判断** ⇒ 归它。
  // ★三四 2026-10-21 · 把**治理的处境**送到它面前（不是告诉它"你有三个工具"）
  //
  //   ★★★ 实测教训：我给 `enforce`/`correct`/`grant` 上线后真跑一轮 —— **0 次调用**。
  //     原因不是它不会用，是**它没有处境**：
  //       「你有三个治理工具」不等于「现在有一个人需要被治」。
  //   ⇒ 这一段把**可数的证据**摆出来，让它自己判该不该治、治谁。
  //
  //   ★★ 我只给读数和一个"如果这算异常"的指路，**不下结论**（硬规则①）。
  const govTodo = (() => {
    try {
      const b = readBehavior(join(LAB, "work", "signoffs.jsonl"));
      if (!b.teams.length) return "";
      const L: string[] = [];
      // ★★★★★ 免费改口（★ 这是**集群自己提的判据**，我只加数）
      //
      //   它的原话（`outbox/实践-签字46%不是病-…`）：
      //     「我在什么条件下改口（跑前写死，见 §7）：
      //       若 landing 的『保留 → 认同但**期间产物一个字节没动**』……」
      //
      //   ★★★ 我把它算出来了：61 次改签，**60 次产物没动（98%）**。
      try {
        const sl = readFileSync(join(LAB, "work", "signoffs.jsonl"), "utf8").split(String.fromCharCode(10));
        // ★★★ 判"那两次签字时内容一样不一样" —— **必须读 git，不能读当前 mtime**
        //
        //   ★ 我第一版用当前 mtime，得出 98% 没动；★★★ 集群说"复现不出来"，它是对的：
        //     mtime 是"现在"，不是"当时" ⇒ 之后又被写过的文件全被我判成"从没动过"。
        //   ★★ 真实读数（git blob）：44/61 动过（72%），13/61 没动（21%）。
        const blobAt = (rev: string, f: string): string => {
          try {
            return execFileSync("git", ["-c", "core.quotepath=false", "-C", LAB, "rev-parse", `${rev}:outbox/${f}`], {
              encoding: "utf8",
            }).trim();
          } catch {
            return "";
          }
        };
        const commitBefore = (t: string, f: string): string => {
          try {
            return execFileSync(
              "git",
              ["-c", "core.quotepath=false", "-C", LAB, "log", "--format=%H", "-1", `--before=${t}`, "--", `outbox/${f}`],
              { encoding: "utf8" },
            ).trim();
          } catch {
            return "";
          }
        };
        const ff = freeFlips(sl, (a, t0, t1) => {
          const c0 = commitBefore(t0, a);
          const c1 = commitBefore(t1, a);
          if (!c0 || !c1) return true; // ★ 查不到就当"动过"（宁可少报，不冤枉成员）
          const b0 = blobAt(c0, a);
          const b1 = blobAt(c1, a);
          if (!b0 || !b1) return true;
          return b0 !== b1;
        });
        if (ff.flips.length) {
          // ★★★★★ 作者自签：让"3/3 签"这个说法变诚实
          //
          //   ★ 实测：311 条签字里 **102 条（33%）是作者给自己签的**。
          //   ★★ 这不是门的漏洞（门要求全体表态，作者必然要签自己），
          //     问题是「3/3 签」看起来比实际强 —— 只有 2 票是独立判断。
          //   ★★★ 一条签字自己说过：「我是这一份的作者…若装置要求作者回避，请覆盖我这票」。
          try {
            const tbl = loadSignOffs(join(LAB, "work", "signoffs.jsonl"));
            let sgn = 0;
            let ind = 0;
            let self = 0;
            let und = 0;
            for (const [, m] of tbl) {
              const g = gateVerdict(m, ALL_TEAMS);
              if (!g.ok) continue;
              sgn += g.strength.signed;
              ind += g.strength.independent;
              self += g.strength.selfSigned;
              und += g.strength.undeclared;
            }
            if (sgn > 0) {
              const pct = Math.round((self / sgn) * 100);
              const upct = Math.round((und / sgn) * 100);
              // ★ 纪律㉖：接了就必须在日志里出现
              log("todo", `★ 门的强度已递给研究员：${sgn} 票 · 独立 ${ind} · 作者自签 ${self}（${pct}%）· ★未声明 ${und}（${upct}%）`);
              L.push("### ★★★★ 门的强度：签了不等于独立");
              L.push("");
              L.push(
                `已通过的产物合计 **${sgn} 票**：独立判断 **${ind}** 票，` +
                  `作者自签 **${self}** 票（${pct}%），` +
                  `★ **未声明** ${und} 票（${upct}%）。`,
              );
              if (und > 0) {
                L.push("");
                L.push(
                  `★★★ 那 ${und} 票是**历史签字**（isAuthor 这个字段这一轮才加）——` +
                    `**没声明 ≠ 不独立**，也**≠ 独立**。缺数据不是 0。`,
                );
              }
              L.push("");
              L.push("★★ 门要求**全体表态** ⇒ 作者必然要签自己那一票，这**不是漏洞**。");
              L.push("★★★ 但「3/3 签」听起来比实际强 —— 真正独立的只有 2 票。");
              L.push("");
              L.push("★ 所以**签字时请诚实填 `isAuthor`**（这份是你写的吗）。");
              L.push("★★ 如果你想更强：让作者那一票改成「有保留」（把自查的问题也交出来），");
              L.push("   或让第三方复算一遍再签。**要不要更强，由你判** —— 我只负责把数摆成诚实的。");
              L.push("");
            }
          } catch (e) {
            log("error", `独立票读数失败：${(e as Error).message}`);
          }

          L.push("### ★★★★★ 你自己提的那个判据，我算出来了");
          L.push("");
          L.push(
            `「有保留 → 认同」共 **${ff.flips.length}** 次；其中 **${ff.free} 次产物一个字节都没动**` +
              `（${Math.round((ff.free / ff.flips.length) * 100)}%），真改过的只有 ${ff.paid} 次。`,
          );
          L.push("");
          L.push("★ 门只读**每队最后一条**签字 ⇒ 那一改，带条件的保留就**消失了**，书里没有痕迹。");
          L.push("★★ 这次从**签字那一刻**就要求：产物没动而要改签「认同」，必须说清是什么让你改口");
          L.push("   （★ 允许改口 —— 但「再想想觉得没问题」不算，要指出哪条前提不成立了）。");
          L.push("★★★ 所以这个问题有两半，你可以两半都答，或只答对你重要的那半：");
          L.push(`   ① 那 ${ff.free} 次改签里，有没有**该被留下**的保留？`);
          L.push("   ② 已经进书的那几份，要不要回去看它们的保留是不是被「改口」冲掉的？");
          L.push("");
        }
      } catch (e) {
        log("error", `免费改口读数失败：${(e as Error).message}`);
      }

      L.push("### ★★★ 一个你必须回答的问题：这算不算病");
      L.push("");
      L.push(`签字行为：${renderBehavior(b)}`);
      L.push("");
      if (b.outlier) {
        L.push(
          `★★ 有一队明显失衡：**${b.outlier.team}** ` +
            `${b.outlier.reserved}/${b.outlier.total} = ${Math.round(b.outlier.reservedRate * 100)}% 带保留，` +
            `比另两队高 ${Math.round(b.outlier.vsOthers * 100)} 个百分点。`,
        );
      } else {
        L.push("★ 没有哪一队明显失衡（三队差不多）。");
      }
      L.push("");
      L.push("★★★ **你必须给出一个判断，二选一，都要带证据**：");
      L.push("");
      L.push("  (a) **这算病** ⇒ 说清是哪一件事、它反复造成了什么可数的后果，");
      L.push("      然后用**一个**治理工具去治（下面有分工表），并在产物里写明你治了什么。");
      L.push("  (b) **不算病** ⇒ 说清为什么（例如：负责落地的那一队本来就该最挑剔；");
      L.push("      或者这个比例正是设计意图）。★ 这条**同样算回答了**，不算漏。");
      L.push("");
      L.push("★★ 允许答 (b) —— 但**不许不答**。");
      L.push("★ 为什么这一条要你答：比例失衡**可能**只是职责差异，也可能是一个人");
      L.push("  在反复同一件事上让步/保留。**这两种只有你能分辨**，我只能数。");
      L.push("");
      L.push("★ 如果要治，分工如下（★ 选错的代价写在后面）：");
      L.push("");
      L.push("| 工具 | 治什么 | 判据 |");
      L.push("|---|---|---|");
      L.push("| `write_skill` | **全体**都有的盲点 | 你说不出具体是谁 |");
      L.push("| `enforce` | **某一位**反复做错 | 你**指名道姓**说得出来 |");
      L.push("| `correct` | 它**已经得出了错结论**还在往上推 | 你能指出它说的**哪一条**错了 |");
      L.push("| `grant` | 有人能干但**手上没工具** | 缺的是工具，不是人，也不是规矩 |");
      L.push("");
      L.push("★★★ 选错的代价：");
      L.push("  · 该 enforce 却用了 skill ⇒ 它读到了，照做与否随缘（**没有门**）");
      L.push("  · 该 correct 却用了 skill ⇒ 它脑子里那条错的**还在**，会继续污染后面 5 步");
      L.push("  · 该 grant 却用了 spawn_seat ⇒ 多了一个人，还是没工具");
      L.push("");
      L.push("★ 如果你答了 (a)，产物里要能回答：**治完以后，同一个读数会变成什么？**");
      L.push("  （例：「landing 的带保留率会从 47% 降到 30% 以下，因为它不再 X」）");
      L.push("  ★★ 说不出这个，说明你还没想清它是不是病。");
      return L.join(String.fromCharCode(10));
    } catch (e) {
      log("error", `行为读数失败：${(e as Error).message}`);
      return "";
    }
  })();
  if (govTodo) {
    const b = readBehavior(join(LAB, "work", "signoffs.jsonl"));
    log("todo", `★ 治理处境已递给研究员：${renderBehavior(b)}`);
    log("todo", `  失衡队=${b.outlier?.team ?? "(无)"} · ★ 三个治理工具的分工已随它下发`);
  }

  const orderTodo = (() => {
    try {
      const ord = readingOrder({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });
      const ut = undefinedTerms({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });
      if (ord.total === 0) return "";
      const L: string[] = [];
      L.push("");
      L.push(`## 🎯 这一轮的目标：让读者**能顺着学**`);
      L.push("");
      L.push(`★★★ 这是设计者给这本教科书的硬要求，不是建议：`);
      L.push(`> 「学习陌生知识，**如果学过前置知识（或类似知识）就能轻松学会**」`);
      L.push("");
      L.push(`### 现状（每轮重算，纯函数、0 API）`);
      L.push("");
      L.push(`· ${renderOrder(ord)}`);
      L.push(
        `· 术语：正文黑话 ${ut.totalHits} 次 / ${ut.defined.length + ut.undefined.length} 种，` +
          `**定义页没覆盖 ${ut.undefined.length} 种**`,
      );
      if (ut.undefined.length) {
        L.push(`  · 没定义的有：${ut.undefined.slice(0, 16).join(" ")}${ut.undefined.length > 16 ? " …" : ""}`);
      }
      L.push("");
      L.push(`### 目标（★ 这不是阈值，是定义）`);
      L.push("");
      L.push(`**① 前置倒挂 = 0**`);
      L.push(`   走过的每一步，只引用**读者已经读过**的东西。`);
      L.push(`   ★ 如果它必须引用后面才写的东西 ⇒ 说明**该先写后面那份**，或者把它讲在前面。`);
      if (ord.withForward > 0) {
        // ★★★ 2026-10-20 · 给**具体明细**，不只是名字。
        //
        //   ★ 为什么要给位置和跨度：光说"这份倒挂了"它还得自己去找；
        //     给了 `[0] → [27]` 它立刻知道"读者读到第 1 份，被要求懂第 28 份"。
        //   ★★ 而**怎么解**（把哪份提前、还是把引用改成"详见后文"）仍然由它定。
        const posOf = new Map(ord.rows.map((r) => [r.artifact, r.index]));
        L.push(`   ★ 现在倒挂的 ${ord.withForward} 份（★ 左边是它的位置，箭头是它引用的东西的位置）：`);
        for (const w of ord.worst.slice(0, 8)) {
          const targets = w.forward
            .map((f) => {
              const at = posOf.get(f);
              const gap = at === undefined ? "?" : at - w.index;
              return `[${at ?? "?"}] \`${f.slice(0, 28)}\`（跨 ${gap} 份）`;
            })
            .join("、");
          L.push(`   · [${w.index}] \`${w.artifact.slice(0, 36)}\` → ${targets}`);
        }
        L.push("");
        L.push(`   ★★★ 最远的一次跨 **${ord.maxJump} 份** ——`);
        L.push(`     意味着读者读到很前面的时候，就被要求懂很后面的东西。`);
        L.push(`   ★ 三种解法（你选，我不定）：`);
        L.push(`     ① 把被引用的那份**提前**（如果它确实是前置）`);
        L.push(`     ② 把被引用的那份**先写**（如果它还不存在）`);
        L.push(`     ③ 在那句引用处**就地补一句人话**，让读者不必先读后面也能往下走`);
        L.push(`   ★★ 第三种最省事，但如果同一处要补很多次，说明顺序真的错了。`);

        // ★★★★★ 2026-10-21 · 承认量具的边界（集群推翻了我的判据）
        //
        //   集群原话：「现役量具报的 9 处里，0 处是」
        //            「★★★ 「提及」是「依赖」的必要条件，不是充分条件。」
        //
        //   ★ 它给出五种来路，只有「承重」才构成往回跳。
        //   ★★★ 判「承重」要做**删章测试**（删掉被引那份，这句还成立吗）
        //       ⇒ **必须懂内容** ⇒ 是你的活，不是我的。
        //
        //   ⇒ 我这里只报**形式特征能分的**（依据/上游/地图/地址），
        //     剩下判不了的一档叫「待判」，**交给你做删章测试**。
        const cf = classifyForward({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });
        if (cf.edges.length) {
          L.push("");
          L.push(`### ★★★ 但先别急着改书：**「提及」不是「依赖」**`);
          L.push("");
          L.push(`★★ 这是你们上一轮自己指出的（\`读者-读不顺分五种\`）：一条指称有**五种来路**，`);
          L.push(`   只有**承重**那种会造成"往回跳"。`);
          L.push("");
          L.push(
            `★ 我这一版只按**行的形式特征**分类（形式特征可算，内容判断不是我的活）：`,
          );
          L.push(
            `   · **依据** ${cf.counts["依据"]} 条（行首「依据」/「## 依据」之后 / 含「详见」）`,
          );
          L.push(`   · 上游 ${cf.counts["上游"]} 条 · 地图 ${cf.counts["地图"]} 条 · 地址 ${cf.counts["地址"]} 条`);
          L.push(`   · ★★★ **待判 ${cf.counts["待判"]} 条** —— 这些**我判不了**`);
          L.push("");
          if (cf.candidates.length) {
            L.push(`**待你判的（做删章测试：把被引那份删掉，这句还成立吗？）**`);
            L.push("");
            for (const c of cf.candidates.slice(0, 8)) {
              L.push(`· \`${c.from.slice(0, 30)}\` → \`${c.to.slice(0, 28)}\``);
              L.push(`  行：「${c.line.slice(0, 60)}」`);
            }
            L.push("");
            L.push(`★★★ 判完请**留下过程**（像你们做的 \`ref-split.json\` 那样，逐行原文 + 判定），`);
            L.push(`   这样人能事后复核 —— 因为**这一步我无法独立复核**。`);
          }
          L.push("");
          L.push(`★ 判成「承重」的才需要动（把那份提前 / 先写它 / 就地补一句人话）；`);
          L.push(`★★ 判成「依据/上游/地图/地址」的**不用动**，它们本来就不要求读者先读后面。`);
        }

      L.push("");
      L.push(`**② 每个黑话，读者第一次遇到时能查到它是什么**`);
      L.push(`   ★ 不是"删掉黑话"——举证要能复查，黑话该留着。`);
      L.push(`   ★★ 是**第一次出现时给一句人话**，或者收进定义页。`);
      L.push(`   ★ 反例（现在的样子）：定义页有 \`R7\`，正文却在用 \`R3\` —— 读者无处可查。`);
      L.push("");
      L.push(`### ★★★ 不许做的`);
      L.push(`   · **为了倒挂=0 而删掉引用** —— 那是把病藏起来，不是治好`);
      L.push(`   · **为了术语而把黑话换成含糊的大词** —— 读者更不懂`);
      L.push(`   · 重排目录时**只按好看**，不按"学了 A 才能懂 B"`);
      L.push("");
      L.push(`★★ 一句话：**读者应该能从第一份一路读到最后一份，不需要往回跳、也不需要猜词。**`);

      // ★★★ 2026-10-21 · 「渐进的书」审查基准（设计者裁定）
      //
      //   设计者原话：
      //     「因为这个 book 是**渐进式**的，是**随着 hunt 集群的推进来不断完善的**，
      //      我害怕强制要求…形成不断裂的链路，**会导致后续的不断完善会有问题**」
      //   ⇒ 「按“当前这本”判，不按“理想那本”」
      //   ⇒ 「显式标记「待补」就不算缺陷」
      //   ⇒ 「**过时就算缺陷，必须更新**——审查之所以叫审查，就是要让产出符合设计的目标」
      const sc = selfConsistency({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });
      if (sc.files > 0) {
        L.push("");
        L.push(`### ★★★ 审查基准：这是**渐进的书**，按「当前这本」判`);
        L.push("");
        L.push(`★★ 你**不需要**先写完整：缺章、缺链、写到一半，都**不算缺陷**。`);
        L.push(`★ 唯一的要求是：**诚实地标出来**。`);
        L.push("");
        L.push(`**「待补」的标准写法（★ 只有这几种，写别的等于没写）**`);
        L.push(`\`待补：\` · \`本节待补\` · \`本章待补\` · \`待写：\` · \`【待补】\``);
        L.push(`   ★ 例：\`待补：合并的判定在第 6 章，本章先给三处现场\``);
        L.push(`   ★★ 为什么限定写法：如果每份用不同的词，就**查不全**，等于没有标记。`);
        L.push("");
        L.push(`### 现状（每轮重算）`);
        L.push(`· ${renderSelf(sc)}`);
        if (sc.danglingChapters.length) {
          const byN = new Map<number, number>();
          for (const c of sc.danglingChapters) byN.set(c.chapter, (byN.get(c.chapter) ?? 0) + 1);
          const list = [...byN.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
          L.push(
            `★★ **${sc.danglingChapters.length} 处引用了还不存在的章**` +
              `（${list.map(([n, c]) => `第${n}章×${c}`).join(" ")}）`,
          );
          L.push(`   ⇒ 这些**不是缺陷**，但每处都该**当场告诉读者"它还没写"**。`);
          L.push(`   ★ 加一句 \`待补：第 N 章会讲 X\` 就够了 —— 读者不会以为是漏了。`);
        }
        if (sc.excusedDangling > 0) {
          L.push(`· ★ 已标「待补」而豁免的 ${sc.excusedDangling} 处 —— 这是**做对了**的样子。`);
        } else {
          L.push(`· ★★ 现在书里 **0 处「待补」标记** —— 也就是说：读者看到的所有引用，`);
          L.push(`  都假设"那一章已经存在"。这对一本渐进的书是不诚实的。`);
        }
        L.push("");
        L.push(`### ★★★ 但有一条**没有折扣**`);
        L.push(`**内容过时就算缺陷，必须更新。**`);
        L.push(`   原因：审查之所以叫审查，就是要让产出**符合设计的目标**。`);
        L.push(`   ★ 你会拿到「\`source/\` 里哪些原料比这一章新」的清单（见下）——`);
        L.push(`     不是"必须重写"，而是"**这一章依据的东西变了，你得确认它还成立**"。`);

        // ★★★ 真的去算（★ 上面那句"见下"必须真的有"下"，否则就是空话）
        //
        //   ★ 判据：书里某章**提到了** source 里的某份原料，
        //     而那份原料的 mtime **比这一章新** ⇒ 这一章可能过时。
        //   ★★ 这不是"我觉得它过时" —— 引用关系可数、mtime 可数。
        //   ★ 局限：mtime 变新 ≠ 内容变了（可能只是重存）⇒ 只报"可能"，由它判。
        const srcDir = (() => {
          // 取最新批次
          try {
            const base = join(LAB, "source");
            const batches = readdirSync(base)
              .filter((d) => d.startsWith("batch-"))
              .sort();
            const last = batches[batches.length - 1];
            return last ? join(base, last, "outbox") : undefined;
          } catch {
            return undefined;
          }
        })();
        if (srcDir) {
          const stale = staleBySource({
            bookSrc: join(REPO, "research/book/src"),
            subdir: "05-集群产出",
            sourceDir: srcDir,
          });
          if (stale.length) {
            L.push("");
            L.push(`★★ **${stale.length} 章被新原料影响**（它引用的东西变了）：`);
            for (const x of stale.slice(0, 8)) {
              L.push(`   · \`${x.artifact.slice(0, 34)}\` ← ${x.newer.length} 份更新的原料`);
            }
            L.push(`   ★★ 这是**唯一**没有"待补"折扣的一条：过时就算缺陷，必须更新。`);
          } else {
            L.push("");
            L.push(`★ 过时检查：**0 章**被新原料影响（\`source/\` 里没有比它们更新的原料）。`);
          }
        }
      }
      }
    // ★★★★ 2026-10-21 · 「点不到」是一个**不变式**，不是一个编辑偏好
    //
    //   ★ 判据：**书里有的，必须能从目录点到**（否则读者不知道它存在）。
    //     这是结构一致性问题，不是"这一章放哪"的内容判断 —— 后者是集群的。
    //
    //   ★★ 实测（2026-10-21）：书 36 份、目录只列 29 ⇒ **10 份点不到**，
    //     其中 `00a-定义页` 被 **11 份章引用 43 次**却不在目录里。
    //     ⇒ 读者被指了 43 次「见定义页」，而那一页**点不到**。
    try {
      const sub = "05-集群产出";
      const sumMd = readFileSync(join(REPO, "research/book/src/SUMMARY.md"), "utf8");
      const listed = new Set<string>();
      for (const mm of sumMd.matchAll(new RegExp(`\]\(${sub}/([^)]+?)\)`, "g"))) listed.add(mm[1]!);
      const files = readdirSync(join(REPO, "research/book/src", sub)).filter((f) => f.endsWith(".md"));
      const unreachable = files.filter((f) => !listed.has(f) && !listed.has(f.replace(/\.md$/, "")));
      if (unreachable.length) {
        // ★ 纪律㉖：接了就必须在日志里出现（否则分不清"没接上"和"没有点不到的"）
        log("todo", `★ 目录不变式已递给研究员：${unreachable.length} 份点不到（${unreachable.map((f) => f.slice(0, 14)).join(" / ")}）`);
        L.push("");
        L.push(`### ★★★★ ${unreachable.length} 份在书里但**目录点不到**`);
        L.push("");
        L.push("★★ 这不是「该放哪」的问题（那是你定），是**不变式**：书里有的，读者必须能从目录点到。");
        L.push("");
        for (const f of unreachable.slice(0, 8)) {
          const refs = files.filter((g) => {
            if (g === f) return false;
            try {
              return readFileSync(join(REPO, "research/book/src", sub, g), "utf8").includes(f.slice(0, 8));
            } catch {
              return false;
            }
          }).length;
          L.push(`   · \`${f.slice(0, 50)}\`${refs ? ` ← ★ 被 ${refs} 份章引用，读者却找不到` : ""}`);
        }
        L.push("");
        L.push("★ **你必须二选一，都算回答**：");
        L.push("  (a) 它该在书里 ⇒ 给我一份目录补丁（`work/…/SUMMARY-补丁.md`，写清插在哪一节之后）");
        L.push("  (b) 它不该在书里 ⇒ 说清为什么（例如「它是工单不是书正文」），我按你说的撤");
        L.push("★★ 允许答 (b) —— 但不许不答：现在这个状态等于「我发了但没人找得到」。");
      } else {
        L.push("");
        L.push("★ 目录不变式：**0 份点不到**（书里每一份都能从目录点到）✔");
      }
    } catch (e) {
      log("error", `点不到读数失败：${(e as Error).message}`);
    }

      return L.join(String.fromCharCode(10));
    } catch (e) {
      log("error", `认知顺序读数失败：${(e as Error).message}`);
      return "";
    }
  })();
  if (orderTodo) {
    const o = readingOrder({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });
    log("todo", "★ 认知顺序要求已递给研究员（目标：前置倒挂=0 · 术语可查）");
    log("todo", `  现状：${renderOrder(o)}`);
    // ★★★ 纪律㉖：**接了就必须在日志里出现**
    //   ★ 上一版我加了「按来路分类」的代码，但**日志里 0 次「待判」** ⇒
    //     分不清"没接上"还是"没有待判的"，只能靠翻代码才知道。
    const cfLog = classifyForward({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });
    log(
      "todo",
      `  前向引用 ${cfLog.edges.length} 条 · 依据 ${cfLog.counts["依据"]}` +
        ` · 上游 ${cfLog.counts["上游"]} · 地图 ${cfLog.counts["地图"]} · 地址 ${cfLog.counts["地址"]}` +
        ` · ★★★ 待判 ${cfLog.counts["待判"]}（★ 交集群做删章测试）`,
    );
    // ★★★ 渐进基准的读数（设计者裁定：按「当前这本」判 · 待补豁免 · 过时必须更新）
    const scLog = selfConsistency({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });
    log("todo", `  渐进基准：${renderSelf(scLog)}`);
    if (scLog.danglingChapters.length) {
      const byN = new Map<number, number>();
      for (const c of scLog.danglingChapters) byN.set(c.chapter, (byN.get(c.chapter) ?? 0) + 1);
      log(
        "todo",
        `  ★ 引用了还不存在的章 ${scLog.danglingChapters.length} 处` +
          `（${[...byN.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `第${n}章×${c}`).join(" ")}）` +
          ` · ★ 标「待补」豁免 ${scLog.excusedDangling} 处`,
      );
    }
  }


  // ★★★ 开卷段的组装（★ 单独抽出来，才能**分段量长度** —— 纪律㉔）
  const buildKickoff = (i: number): string =>
      // ★ 告诉他们彼此存在（他们共享 outbox 与 work）——
      //   但**不要求**他们协作：会不会看别人、要不要分工，是**要观察的行为**（`P3`：不要指望模型自己分工）。
      (researchers.length > 1
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
        : researcherPrompt.KICKOFF) + pendingTodo + isolationTodo + govTodo + orderTodo;

  // ★★★ 第一次量这张表（★ 假设：治理段 0 次调用是因为**它在开卷段里被稀释了**）
  //   ★ 纪律㉔：分开记各段长度，而**不是**只记总长 —— 否则不知道是哪一段在稀释。
  {
    const segLen = (x: string) => `${(Math.round(x.length / 100) / 10).toFixed(1)}k`;
    const k0 = buildKickoff(0);
    log(
      "todo",
      `★ 开卷段长度：KICKOFF ${segLen(researcherPrompt.KICKOFF)} · 待补 ${segLen(pendingTodo)}` +
        ` · 孤立 ${segLen(isolationTodo)} · **治理 ${segLen(govTodo)}** · 认知顺序 ${segLen(orderTodo)}` +
        ` ⇒ 合计 ${segLen(k0)}`,
    );
  }

  const runs = researchers.map((a, i) =>
    a.io.prompt(buildKickoff(i)).catch((e) => ({ error: (e as Error).message, text: "" })),
  );

  // ★★★ 观众也要**开工**（2026-10-19 夜间实测 bug）：
  //   ★ 症状：`onAudience` 触发了 5 次、消息都送出去了，但**观众 0 票**。
  //   ★★ 根因：观众建出来后**从来没被 `io.prompt` 投递过** ⇒ 它们没在跑 ⇒
  //      `steer` 的消息排在「一次不存在的运行」后面 ⇒ **永远看不到**。
  //   ★ 教训（同类第 3 次）：**"我把东西给它了" ≠ "它在跑"** ——
  //     投递要发生在**已经启动的** agent 上。
  const audienceRuns = audiences.map((a, i) =>
    a
      .io.prompt(
        `★ 你是观众（${AUDIENCES[i]!.key}）。你**不写产物**，也不做研究。

` +
          `★★★ 你的唯一职责：等研究团队产出后，回答**谁最说服了我**。
` +
          `★ 三个团队（theory / practice / landing）在争同一个问题，各有立场。

` +
          `## 你现在该怎么做
` +
          `1. ★★★ **自己循环评** —— 这是你的主循环，别等别人叫你：
` +
          `   ls outbox/ 列出全部产物 → 挑**你还没评过**的一份 → 读 → 用 judge 表态 → 再挑下一份。
` +
          `   ★★ 为什么要自己循环：实测产物约 50 份，而「请评判」推送每 tick 只发 1 份
` +
          `     ⇒ **8 份「读者-*」产物从没被评过**（最讽刺的一类）。评审必须比生产快，否则永远积压。
` +
          `2. 收到「请评判 X」的消息时，**优先评那一份**（那是规则按票数排序挑出的最缺票的）。
` +
          `3. 按**你的身份**看（见你的定义里的「你怎么判断」）。
` +
          `   question 参数原样用：「文件名 这份东西该不该进书，哪一方的说法最站得住？」
` +
          `4. ★★ 全部评完了再停下来。**不要只评一两份就结束** —— 积压就是这么来的。
` +
` +
` +
          `★★ 不要客气。**「都不够」是完全有效的表态** —— 全体观众支持某一方时争辩才结束，
` +
          `   所以你的不同意见比附和重要得多。
` +
          `★ 若现在 outbox 还是空的，就等着；有东西了再用 \`judge\`。` +
        // ★★★ 2026-10-20 · 把**已经评过的清单**告诉它（结构性问题：每轮重启的观众没有记忆）
        //
        //   病（实测）：一轮里新写的 29 份产物**每份只有 1 票**。
        //   ★★ 根因：观众是**每轮新建的 agent**，它不知道自己（或上一轮的自己）评过什么
        //     ⇒ 它从头开始评 ⇒ 永远停在"浅层"（每份 1 票），深不下去。
        //   ★ 修法：把本轮的投票表**喂给它**，它就知道该往哪补。
        (() => {
          const mine = new Set(
            votes.filter((v) => v.by === AUDIENCES[i]!.key).map((v) => normQuestion(v.question)),
          );
          if (!mine.size) return "";
          const list = [...mine].slice(-40).map((q) => `  · ${q.slice(0, 60)}`);
          return (
            String.fromCharCode(10) +
            `★★ 你**已经评过**的这些（${mine.size} 份，最近 40 条），**不要重复评**：` +
            String.fromCharCode(10) +
            list.join(String.fromCharCode(10)) +
            String.fromCharCode(10)
          );
        })(),
      )
      .catch((e) => ({ error: (e as Error).message, text: "" })),
  );

  // ★ 只等窗口（不做任何"看状态/判断/起 agent"的事 —— 那都在事件规则里）
  await new Promise((r) => setTimeout(r, secs * 1000));
  log("window", `窗口到点（${Math.round((Date.now() - t0) / 1000)}s）`);
  // ★★★ 进入收尾态（多个员工时必需 —— 否则"收尾"会自激，永不收敛）
  closing = true;
  log("window", "进入收尾态：不再 fire 新专家 / 不再送新挑战，只等已在跑的做完");

  // ★★ 长出来的座位也有 run —— 收尾时要等它们做完（否则 dispose 会截断）
  if (grownRuns.length) {
    log("grow", `本轮长出 ${grownSeats.length} 个座位：${grownSeats.map((g) => g.key).join(" / ")}`);
    await Promise.allSettled(grownRuns);
  }
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

  // ★★★ 2026-10-20 · 发布门接线（★ 本轮实验抓到的第三个死代码）
  //
  //   病：`publishAndReport` 从 `tools/publish.ts` 导入，但 **runner 里 0 处调用**
  //   ⇒ 签字一直在记（上一轮 144 条），**却没有任何代码把它们变成书**。
  //   实测后果：跑了 60 分钟、有 1 份「三家全认同」的读者章，书仍是 10 份；
  //            work/publish.md 的时间戳还停在更早那一轮。
  //
  //   ★★ 离线预演（拿本轮 144 条签字 + 37 份 outbox 直接跑 `publishToBook`）：
  //      可发 24 份（含 3 份读者章）· 被拒 13 份。
  //   ★ 所以这不是猜的 —— 接线之前已经知道它会发多少。
  //
  //   ★★★ 为什么放在收尾：
  //     · 发布是**一次性动作**，不该每 tick 都做（`copyFileSync` × 24 份会拖慢 tick）
  //     · 收尾时签字表已完整，门上判定稳定（符合纪律⑩：结论对应确定的输入）
  //     · 与 `debate.jsonl` / `_lib-rev` 同批落盘，可对账
  try {
    const pub = publishAndReport({
      outboxDir: join(LAB, "outbox"),
      signoffsPath: join(LAB, "work", "signoffs.jsonl"),
      allTeams: ALL_TEAMS,
      bookSrc: join(REPO, "research/book/src"),
      subdir: "05-集群产出",
      reportPath: join(LAB, "work", "publish.md"),
      // ★★★ 第二道门：**能不能照做**（2026-10-20）
      //
      //   ★ 干跑算过代价（拿 42 份真实签字 + 真实票）：
      //     只看签字门 = 35 份可发 · 接上可用门 = **29 份**（额外挡 6 份 = 14%）。
      //   ⇒ 代价合理（不是"几乎全挡"，那是我上一轮的担心）。
      //
      //   ★★ 判据是 `usabilityGate`（纯函数）：newcomer 说「都不够」⇒ 卡；
      //     其他观众 ≥2 人说不够 ⇒ 卡；**newcomer 沉默 ⇒ 也不算通过**。
      //   ★★★ 它**不用重新调模型** —— 全部读已落盘的 votes.jsonl（0 API 成本）。
      usableCheck: (artifact: string) => {
        const q = `${artifact} 这份东西该不该进书，哪一方的说法最站得住？`;
        const u = usabilityGate({ question: q, votes });
        return { usable: u.usable, why: u.why };
      },
    });
    log(
      "publish",
      `★ 发布门：已发 ${pub.published.length} 份` +
        ` · 带保留 ${pub.withReservations.length} 份` +
        ` · 被拒 ${pub.rejected.length} 份` +
        (pub.removed.length ? ` · ★ 从书里撤下 ${pub.removed.length} 份` : "") +
        (pub.orphans?.length
          ? ` · ⚠ 引用孤儿 ${pub.orphans.length} 份（${pub.orphans.reduce((a, x) => a + x.citedBy.length, 0)} 处引用指向 404）`
          : "") +
        `（账：work/publish.md）`,
    );
    // ★ 被拒的**必须有一份能响的摘要** —— 否则“为什么它没进书”只能去翻 40KB 的账
    for (const r of pub.rejected.slice(0, 5)) {
      log("publish", `  ⛔ ${r.artifact.slice(0, 40)} → ${r.why.join("；").slice(0, 70)}`);
    }
    if (pub.rejected.length > 5) log("publish", `  …还有 ${pub.rejected.length - 5} 份被拒，见 work/publish.md`);

    // ★★★ 2026-10-20 · 目录同步（★ 结构性接线，不靠谁记得）
    //
    //   病：`publish.ts` 只做 `copyFileSync` —— **从不更新 SUMMARY.md**。
    //   实测：书里 27 份，目录只列 10 份 ⇒ **读者看不到 17 份**（等于不存在）。
    //   ★★ 这就是 AGENTS.md 里 forge 的失败形状：
    //     「**还在散记，只是写得更长**」—— 我把散记从 10 份放进书变成 27 份，**让病更重了**。
    //
    //   ★ 为什么放这里（而不是加一条规则催它）：纪律㉕ —— 规则必须落在结构上。
    //     “记得更新目录”写在文档里 = 没有规则；放在**发布路径的必经步骤**上 = 有规则。
    // ★★★ 2026-10-20 · 用**书本身**的判据（不再只看门过了几份）
    //
    //   为什么换：之前所有读数都是**门视角**（已发几份 / 被拒几份），
    //   而它回答不了最要紧的那个问题：
    //     **门砍掉 86% 之后，剩下的是"精华"还是"侥幸过关的少数"？**
    //
    //   ★★ 所以这里算书本身：目录可达、引用完整、主题聚类、研究痕迹占比。
    //   ★ 全是**纯函数、0 API**（`tools/bookreport.ts`），可离线重判。
    //
    //   ★★★ 注意这里**只报数、不判定好坏** ——
    //     "14 份理论是不是太多" 是**内容判断**，归集群（硬规则①）。
    // ★★★ 「能不能照做」的硬门槛读数（2026-10-20）
    //
    //   病：设计者的裁定是「可以**用作「工具」**」，
    //   而实测 79% 的份带 20+ 处 work/ 实验路径 ⇒ newcomer 原话：
    //   「它现在是一份给同行看的**实验报告**，不是给新人的**说明书**」。
    //
    //   ★★ 根因：`missions.ts` 写着「没长出新概念的内容，不算这本教科书的内容」，
    //     但 12 条规则里 **0 条**检查它 ⇒ 零出口（纪律㉕）。
    //
    //   ★ 这里只**报数**，不拦截 —— 拦截要落在发布门上，
    //     而那需要先看清楚读数长什么样（纪律⑦：判据跑前冻结，先看基线）。
    try {
      const allVotes = loadVotes(join(LAB, "work", "votes.jsonl"));
      // ★★★ 纪律⑩：本轮单独算一份（只有这一份能用来做改前/改后对比）
      const thisRun = allVotes.filter((v) => v.at >= runStartedAt);
      const usRun = usabilitySummary(thisRun);
      if (usRun.total > 0) {
        log(
          "usable",
          `★ 本轮（${runStartedAt.slice(11, 16)} 之后）：观众评过 ${usRun.total} 份` +
            ` · **可用 ${usRun.usable}** · 卡住 ${usRun.blocked}（没人问过 ${usRun.neverAsked}）`,
        );
      }
      const us = usabilitySummary(allVotes);
      if (us.total > 0) {
        log(
          "usable",
          `（全库累积）观众评过 ${us.total} 份 · 可用 ${us.usable} · 卡住 ${us.blocked}` +
            `（其中 ★ 没人问过 ${us.neverAsked}）`,
        );
        const who = Object.entries(us.blockers)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}×${v}`)
          .join(" ");
        if (who) log("usable", `说「都不够」的：${who}`);
      }
    } catch (e) {
      log("error", `★ 可用性读数失败：${(e as Error).message}`);
    }

    // ★★★ 认知顺序（2026-10-20）
    //
    //   设计者原话（这一节的依据）：
    //     「主要的就是违反了人的认知规律，在学习陌生知识，
    //       **如果学过前置知识（或类似知识）就能轻松学会**」
    //
    //   ★ 翻译成可算的量：**一份产物引用了排在它后面**的东西 ⇒
    //     读者必须"先读后面才能懂前面" ⇒ 违反前置知识律。
    //   ★★ 这不是内容判断：只问"提到了谁 + 谁排得晚"，不判断该不该引用、也不定该怎么排。
    const ord = readingOrder({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });
    if (ord.total > 0) {
      log("order", renderOrder(ord));
      if (ord.withForward > 0) {
        log("order", `★ ${ord.withForward} 份要求读者"先读后面" —— 不符合「学过前置才能学会」`);
        for (const w of ord.worst.slice(0, 3)) {
          log("order", `  ${w.artifact.slice(0, 40)} → 倒挂 ${w.forward.length} 处`);
        }
      }
    }

    // ★★★ 术语未定义（认知规律的另一半：第一次出现的词必须当场定义）
    const ut = undefinedTerms({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });
    if (ut.totalHits > 0) {
      log(
        "terms",
        `黑话 ${ut.totalHits} 次 · ${ut.defined.length + ut.undefined.length} 种` +
          ` · ★ 定义页没覆盖 ${ut.undefined.length} 种（${(ut.rate * 100).toFixed(0)}%）`,
      );
      if (ut.undefined.length) {
        log("terms", `未定义：${ut.undefined.slice(0, 12).join(" ")}${ut.undefined.length > 12 ? " …" : ""}`);
      }
    }

    const rep = bookReport({ bookSrc: join(REPO, "research/book/src"), subdir: "05-集群产出" });
    log("book", renderBookReport(rep));
    if (rep.unreachable > 0) {
      log("book", `★ ${rep.unreachable} 份读者点不到（目录没列）—— 它们等于不存在`);
    }
    if (rep.danglingEntries > 0) {
      log("book", `★ 目录里有 ${rep.danglingEntries} 条指向不存在的文件 —— 读者点了会 404`);
    }
    if (rep.chapters.dangling.length) {
      const pct = ((rep.chapters.lost / Math.max(rep.chapters.refs, 1)) * 100).toFixed(1);
      log(
        "book",
        `★ 悬空章号 ${rep.chapters.dangling.length} 个（${rep.chapters.dangling.map((n) => `第${n}章`).join(" ")}）` +
          ` · 引用 ${rep.chapters.refs} 次里 ${rep.chapters.lost} 次落空（${pct}%）`,
      );
    }
    // ★ 主题聚类：最大的那一簇有几份（★ 只报，不判"该不该合"）
    const top = rep.clusters[0];
    if (top && top.count > 1) {
      log("book", `主题最大的簇：${top.prefix} ${top.count} 份（读者要读这一块得读 ${top.count} 份）`);
    }

  } catch (e) {
    // ★★★ 发布门挂了**绝不能静默** —— 否则又回到“书不变但没人知道为什么”
    log("error", `★ 发布门失败：${(e as Error).message}`);
  }

  // ── 关灯（不是干涉）：让在跑的收干净 ──
  //
  // ★★★ 2026-10-20 · 先等**派活器的队列**跑空。
  //
  //   病：`fire` 现在只是「排进队列」，专家在后台跑。
  //   若不管队列直接 dispose 所有 agent ⇒ **把正跑着的专家截断**，
  //   它写的 `work/audits/` 和回流的意见全丢。
  //   ★ 实测：这个风险是改成排队制才有的（以前 `await` 天然跑完才继续）。
  const disp = rules.dispatcher;
  if (disp.busy() || disp.queued() > 0) {
    log("fire", `等派活器收干净（队列 ${disp.queued()} · 在跑 ${disp.busy() ? "1" : "0"}）`);
    // ★ 最多等 6 分钟 —— 再久就是上游挂了，不能无限等
    const deadline = Date.now() + 6 * 60_000;
    while ((disp.busy() || disp.queued() > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (disp.busy() || disp.queued() > 0) {
      log("error", `★ 派活器没能在 6 分钟内收干净（队列 ${disp.queued()}）—— 可能有专家被截断`);
    } else {
      log("fire", `派活器已收干净 · 本轮共派 ${disp.fired()} 位 · 峰值并发 ${disp.peakConcurrent()}`);
    }
  }

  await Promise.allSettled([...runs, ...spawned.map((a) => a.io.waitIdle().catch(() => {}))]);
  for (const a of spawned) {
    try {
      a.dispose();
    } catch {
      /* 已释放 */
    }
  }

  const outs = listOutbox();
  // ★★★ 收尾账**必须同时落进 `_topology.log`**（2026-10-20 实测发现）
  //   ★ 原来只 `console.log` 到 stdout ⇒ 一个只看 `_topology.log` 的新会话
  //     会以为「这轮没跑完」（其实跑完了）。
  //   ★★ 这是我自己的纪律㉖ 的反面教材：「接上了的唯一证据是日志里出现」——
  //      而我把**唯一的证据**留在了 stdout，脚本日志一删就没了。
  const closingLine = `★ 收尾：outbox ${outs.length} 份 · 起过 ${spawned.length - 1} 次专家/支线 · 判停 ${state.verdict ?? "（无）"}`;
  // ★ 同 hunt：AGENTS 教大家 grep "rule:done"，所以标签必须是 rule:done（纪律⑪ 文档与代码同源）
  log("rule:done", closingLine);
  console.log(`\n${closingLine}`);
  console.log(`★ 日志：${join(LAB, "work", "_topology.log")}`);
  return { outputs: outs.length, fired: spawned.length - 1, verdict: state.verdict };
}
