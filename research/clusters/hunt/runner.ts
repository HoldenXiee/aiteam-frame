// 主流程 —— 起 agent、挂事件规则、投一次、等窗口
//
// ★★★ 与本项目的根本约束一致（设计者裁定）：
//   **运行时不能干涉。**
//   · 批准的部分：起常驻 agent、挂事件规则（= 配置集群）
//   · ✗ 不做：在外面盯状态、判断、起 agent
//   ⇒ 所以这里**没有 while 循环看状态** —— 规则挂在 `agent.on(...)` 上，由事件驱动。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../../../src/index.ts";
import { acquireLock } from "./lock.ts";
import { AUTH_SOURCE, labAt } from "./env.ts";
import { deliverToResearcher, NOTE_CONSULT_ALREADY_FLOWS } from "./feedback.ts";
import { recordLibState, recordLibRevision } from "./lib-state.ts";
import { attachGate } from "./guard.ts";
import { ALL_TOOLS, LAB, MODEL, READONLY_TOOLS, REPO, WEB_TOOLS } from "./paths.ts";
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
import {
  artifactMix,
  conjectures,
  artifactLoci,
  attentionMix,
  externalUsage,
  itemGap,
  renderItemGap,
  providedUsage,
  renderExternal,
  renderProvided,
  crossCarrier,
  renderLoci,
  generalizability,
  renderCrossCarrier,
  renderAttention,
  renderGeneralizability,
  readArtifacts,
  readExperiments,
  renderExperiments,
} from "./topology/experiments.ts";
import { readProjects, renderProjects } from "./topology/projects.ts";
import { latestSnapshot, takeSnapshot } from "../snapshot.ts";
import { appendChallenge, dialecticStats, readChallenges, renderDialectic } from "./topology/dialectic.ts";
import { makePortRun } from "./tools/port-run.ts";
import {
  deepProjects,
  externalUrlShare,
  makeRecordExperiment,
  makeReviewExperiment,
  projectChains,
  readStructured,
  renderSeven,
  sevenStats,
} from "./tools/record-experiment.ts";
import { portStats, readPort, readPortTorn, renderPort } from "./tools/port-run.ts";
import { BOOK_DIR, readBookState, renderBookState } from "./topology/forge-state.ts";
import { renderDirective } from "./prompts/researcher.ts";
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

/** ★ 本轮开跑时刻（用来判 PREREG 是不是真的「跑前」）*/
const RUN_STARTED_AT = Date.now();

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
      permissions: { only: [...spec.tools, ...WEB_TOOLS] }, // ★ 只读专家仍然只读（web 是只读的）
    });
    // ★★★ 2026-10-25（libsmith 实测）：这里原来不传 policy ⇒ `guard.ts` 的 `canWriteLib` 恒为 `undefined`
    //   ⇒ **连改库者自己都写不了 `lib/`**。`prompts/index.ts` 那句「只有它能写 —— 而且只能写 lib/」
    //   就变成了「谁都不能写」—— 比原来那句空话更坏（原来是路是死的，现在是路被自己人堵死）。
    //   ★ 政策在这里落：**只有 libsmith** 能写 `lib/`；其余专家与研究员一律不能。
    attachGate(a, { canWriteLib: role === "libsmith" });
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
    const portRun = makePortRun({ lab: LAB, selfKey: myKey });
    const reviewExperiment = makeReviewExperiment({ lab: LAB, selfKey: myKey });
    const recordExperiment = makeRecordExperiment({
      lab: LAB,
      selfKey: myKey,
      // ★ 项目行号从 PROJECTS.md 读，不写死 —— 链深靠这个键
      projectIds: () => readProjects(LAB).rows.map((r) => r.id),
    });
    const challenge = makeChallenge({
      deliver: deliverTo,
      selfKey: myKey,
      peers: () =>
        usedAngles
          .filter((x) => x.key !== myKey)
          .map((x) => ({ key: x.key, stance: x.stance })),
      // ★★★ 答辩落账（DESIGN v3-1）：不落盘就没人知道同一条 claim 被审了几次
      record: (row) => {
        try {
          appendChallenge(LAB, { by: myKey, ...row });
        } catch (e) {
          log("error", `答辩落账失败：${(e as Error).message}`);
        }
      },
    });
    const a = await lab.createAgent({
      id: `L3-researcher-${myKey.replace("/", "-")}-${Date.now().toString(36)}`,
      model: MODEL,
      role: role + renderSeat(ang),
      // ★★ 白名单必须显式带上 web 工具 —— 否则扩展装了也进不来（P108 实测）
      permissions: { only: [...ALL_TOOLS, ...WEB_TOOLS] },
      tools: { custom: [consult, spawnLine, challenge, portRun, recordExperiment, reviewExperiment] },
    });
    // ★ 研究员**不能**写 `lib/`（它的路是「写成缺口报告」，见 `LIB_BLOCK_REASON`）—— 保持默认 policy。
    //   ★ 为什么显式写出来而不省略：省略会让下一个人以为「忘了传」，改错方向。
    attachGate(a, { canWriteLib: false });
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


  // ★★★★★ 立要求（**不点题**）—— DESIGN §1 / §5
  //
  //   ★ 只规定"形态"，不规定"研究什么"（设计者原话：不定格式，要立规则、立高要求）。
  //   ★★ 三条要求都**可判死**：我能对着产物核，它也能自己核。
  const requirementBody = [
    "### 这一轮只有三条**形态要求**（题目你自己选）",
    "",
    "**① 每个实验都要能被我一眼核对**",
    "   `假设`（一句能判死的话）· `装置`（能跑的代码，别人一条命令能跑）· `读数`（带数、落盘）·",
    "   `现象`（与假设不符的东西 —— 这是新假设的种子）· `结局`（活 / 死 / 挂起 / 移交，并说为什么）。",
    "   ★ **没有装置或没有读数的，不算实验。** 那叫感想，随便写，但不进账。",
    "",
    "**② 死掉的实验必须留一个可判死的死因**",
    "   ✔ 「这个谓词 arity 不可切：`judge2` 返回 2」",
    "   ✘ 「没意思」「暂时先放放」",
    "   ★ 死因是最值钱的产物之一 —— 它让下一个人不用重走。",
    "",
    "**③ 你登记在自己账上的每条缺陷，落到三种处置之一**",
    "   · **修了** ⇒ 带可核路径（`work/…` / `lib/…`），我会去查在不在盘上",
    "   · **这是边界，不是缺陷** ⇒ 说清那条边界在哪（★ 我认：装置有边界）",
    "   · **修不了** ⇒ 说清卡在哪（等谁 / 等什么）",
    "",
    "### 处境（★ 只是处境，不是任务清单）",
    "读数我全放在 `work/_处境.md` 里了：实验账 / 缺陷账 / PREREG 溯源 / 状态表吸收率。",
    "**你自己决定看哪个、看多少。** 我不指定题目。",
    "",
    "### 你可以（也都是真的）",
    // ★★★ 2026-10-25 修正：原句是「改 `lib/aiteam/` 和 `lib/pi/` —— 那是给你改的」。
    //   `guard.ts` 拦研究员写 `lib/`（只有改库者能写）⇒ 这句话是假的。
    //   ★ 修它的理由不是“措辞不准”：它是 kickoff 里唯一教它“库能改”的地方，
    //     它会照着做、被拦、再试 —— 而真路（写缺口报告）从来没在 kickoff 里出现过。
    "· 写 `outbox/`（成果）· 写 `work/`（装置与读数）—— ★ `lib/` 对你**只读**",
    "· 你觉得库缺什么 → ★ 写成**能力缺口报告**放进 `outbox/`（一条一句：现象 / 卡在哪 / 期望什么形状），改库者会读到",
    "· **推翻我立的任何判据** —— 你已经推翻过三次（mtime / 分母 / 出度），那是对的；",
    "  但这次请**先写清你在推翻哪一条**，别默默绕开",
    "· 用 `web_search` / `fetch_content` / `source_check` 去看外面的东西 ——",
    "  系统科学、信息论、控制论、统计、认知科学，哪儿都行，**只要写清借了什么、出处在哪**",
  ].join(String.fromCharCode(10));

  // ★★★★★ 2026-10-21 · 轮2：**递读数 + 逼回答三选一**
  //
  //   ★★★ 为什么换手法：轮1 我按 DESIGN 试了"只立要求、不点题"——
  //     结果**产出结构没变**：删了装置题之后，41 份新产物里 39 份还是"手段审查"，
  //     只有 `P100/P101` 两个实验；投递驱动词从 25% 掉到 0（好），但线没回来。
  //   ★ 实测有效的只有一种手法（三次都灵）：
  //     **给一个可判死的读数 + 一个具体的缺口 + 逼它三选一**。
  //     （术语未定义 51%→0 · 吸收率 55%→100% · 结账率 2%→21%，全是这一手）
  //   ★★ 所以这里不评价、不点题，只把**它自己的结构**摆出来，然后问一个问题。
  // ★★★★★ 2026-10-25 · **v3-2：续项目必须是投递的第一行**
  //
  //   ★ 实测：这条要求之前写在 89 行投递的**中段** —— 两个 window 下来
  //     `PROJECTS.md` 的 **2 行版本全是 v1**，链深 ≥3 的项目 **0**。
  //   ⇒ 正好撞上纪律㉕：**写在文档里的规则 = 没有规则**。
  //   ★★ 它不能一直当"要求"。它现在放在**最前面**（比问题还前），
  //     下一轮如果还是不涨版本，就说明"要求"这条路彻底不行，
  //     只能把它做成前置条件（不涨版本 ⇒ 新产物不算数）。
  const continueProjectBody = (() => {
    try {
      const pj = readProjects(LAB);
      if (pj.mode === "none" || pj.stats.total === 0) {
        return [
          "### 0 · 开工第一件事：**建项目账里第一行**",
          "",
          "`outbox/PROJECTS.md` 还不存在或还没有行。第一个开工的人先建它：",
          "一行 = `代号 | 一句话猜想（标「未验证」）| 版本 | 对象 | 可推广 | 边界 | 接口 | 对照读数 | 链深`。",
          "★ 一行必须带「**它怎么算被推翻**」，否则只是草稿。",
          "",
        ].join(String.fromCharCode(10));
      }
      const rows = pj.rows
        .slice(0, 6)
        .map((r) => `· \`${r.id}\` v${r.version || "?"}｜对象：${r.object || "未声明"}｜链深 ${r.chainDepth ?? 0}`)
        .join(String.fromCharCode(10));
      return [
        "### 0 · 开工第一件事（**不是建议，是本轮第一条指令**）",
        "",
        "从 `outbox/PROJECTS.md` 里**挑一行继续**，把它推进**一个版本**，并在产物里写清：",
        "**这一版改了上一版的什么**（不能写「又跑了一次」「补充了读数」——那不是改）。",
        "",
        "现在的行：",
        rows,
        "",
        `★ 链深 ≥3 的项目：**${pj.stats.deep}** —— 这个数上一轮也是 ${pj.stats.deep}。`,
        "★ 如果一行都推不动，**在产物里写清为什么推不动**（缺什么、卡在哪）—— 那也算回答。",
        "★★ 唯一不许的是**跳过去开新题**。",
        "",
      ].join(String.fromCharCode(10));
    } catch {
      return "";
    }
  })();

  const structureBody = (() => {
    try {
      const arts = readArtifacts(join(LAB, "outbox"));
      const mix = artifactMix(arts);
      const pj = readProjects(LAB);
      const cj = conjectures(arts);
      const gen = generalizability(arts);
      const pt = portStats(readPort(LAB));
      const providedDir = join(REPO, "research/docs/研究员提供的网上文章");
      const providedFiles = existsSync(providedDir)
        ? readdirSync(providedDir).filter((f) => f.endsWith(".md"))
        : [];
      const ptTorn = readPortTorn(LAB);
      const cutoff = Date.now() - 86_400_000;
      const recent = arts.filter((a) => a.mtimeMs >= cutoff);
      const rMix = artifactMix(recent);
      const x = readExperiments(LAB);
      const P: string[] = [];
      P.push("");
      P.push("### ★ 你现在的产出结构（这是读数，不是评价）");
      P.push(
        `· **编号实验 \`P*\`：${mix.experiments} 份**　` +
          `**装置/审查类：${mix.apparatus} 份**（最长一条链：\`${mix.longestChain?.prefix ?? "-"}\` ${mix.longestChain?.n ?? 0} 层）`,
      );
      P.push(
        `· 最近 24h 新产物 **${recent.length}** 份 —— 其中**实验 ${rMix.experiments} 份**，` +
          `装置/审查类 **${rMix.apparatus}** 份`,
      );
      P.push(
        `· 实验账：${x.stats.total} 个实验里**有结局的 ${x.stats.total - x.stats.byOutcome.unsaid} 个**` +
          `（活 ${x.stats.byOutcome.active} / 死 ${x.stats.byOutcome.dead} / 挂起 ${x.stats.byOutcome.parked} / 移交 ${x.stats.byOutcome.handoff}）`,
      );
      P.push(`· 外部材料引用：**${x.mix.external}** 处（\`web_search\`/\`fetch_content\` 已经在你手上）`);
      P.push("");
      // ★★★ E2：forge → hunt（DESIGN §5）—— **递处境，不递题目**
      P.push("");
      P.push("### ★ 另一边的状态（`forge` 那边，跟你的活不是一回事，只是让你知道世界多大）");
      try {
        P.push(
          renderBookState(
            readBookState({
              bookDir: join(REPO, BOOK_DIR),
              publishPath: join(REPO, "research/labfirst/forge/work/publish.md"),
              forgeWorkDir: join(REPO, "research/labfirst/forge/work"),
            }),
          ),
        );
      } catch (e) {
        P.push(`（读不到：${(e as Error).message}）`);
      }

      P.push("");
      P.push("");
      P.push("### ★ 你的灵感来源（读数，不是评价）");
      P.push(
        `· 全部 ${x.mix.total} 份产物里：**外部材料 ${x.mix.external} 份** · ` +
          `**跨学科 ${x.mix.interdisciplinary} 份** · 明写出处 ${x.mix.declared} 份`,
      );
      P.push(
        "· `web_search` / `fetch_content` / `source_check` / `get_search_content` 都在你手上" +
          "（★ 已实测能搜：一次返回 5 条，含 Springer 的条目）",
      );
      P.push("  但**外部材料引用是 0** —— 也就是说这几个工具**一次都没被用过**");
      P.push("");
      P.push("★ 不评价这件事好还是不好。只问一句：**这是有意的吗？**");

      P.push("");
      P.push("");
      // ★★★★ 轮 D：**投递换向** —— 不再指某个装置，直指"研究对象"
      //
      //   ★ 真因（`真因-研究对象被驯化了-2026-10-21.md`）：196 份里**可推广的只有 9%**，
      //     而 10-19 之后 102 份里**只有 1 份** —— 研究对象从「集群」漂移成「本 lab 的测量装置」。
      //   ★★ 而漂移的起点是**我**：我八轮都在递「你的装置有缺陷」。
      //   ⇒ 这一轮递的是"你能给别人用什么"，不是"你哪里错了"。
      P.push("");
      // ★★★ 2026-10-21：**读权限今天开了** —— 这件事它不知道，而它上一轮明确说过
      //   「三个合法对象值，我填不出两个……我读不到它」。所以这一条是**新信息**，必须递。
      // ★★★★ 2026-10-21 结构修正：**问题放最前面**。
      //
      //   ★ 实测：这一段的投递已经有 89 行 —— 上一轮我把问题写在**最后**，
      //     结果一轮下来**它没回答**（产物里 0 份提到那件事）。
      //   ★★ 而前面连问两轮都灵的那几次，问题都在**显眼处**。
      //   ⇒ 问题提到最前，读数与要求跟在它后面当依据。
      P.push("### ★★★ 这一轮请先回答下面这一个问题（其他的都是它的依据）");
      P.push("");
      P.push("### 一个问题（★ 必须回答，三选一）");
      P.push("**你现在读得到书、库正本、forge 的代码 —— 你打算读哪一个，用来做什么？**");
      P.push("");
      P.push("(a) **都不打算读** —— 说清为什么（比如：读了也不知道拿来干什么 / 现在的活更值）");
      P.push("(b) **想读，但不知道读什么** —— 说清你缺的是：**一个具体问题** / **一段该读的范围**");
      P.push("(c) **我这轮就读** —— 挑一处（书 / 库正本 / forge 的代码），");
      P.push("    在产物里**引一个绝对路径 + 一句你从里面学到的东西**，并说清它对你的项目有什么用");
      P.push("");
      P.push("★ 允许答 (a)，答了不算病。★★ 唯一不许的是**不答**。");
      P.push("★★★ 我不给题目：读哪一段、用它做什么，你自己选。");
      P.push("");

      P.push("### ★★★★★ 先纠正一件事：**你现在读得到了**");
      P.push("");
      P.push("上一轮你说「三个合法对象值我填不出两个，我读不到它」。**那是真的，但那是昨天。**");
      P.push("今天我把只读边界打开了（写边界没动：你仍然只能写自己的空间 + `lib/`）：");
      P.push("");
      P.push("| 现在可以读（**只读**）| 绝对路径 |");
      P.push("|---|---|");
      P.push("| 库正本 | `" + join(REPO, "src") + "` |");
      P.push("| 书（36 章）| `" + join(REPO, "research/book") + "` |");
      P.push("| **另一个集群的代码**（forge）| `" + join(REPO, "research/clusters/forge") + "` |");
      P.push("| 集群设计 + 实验记录 | `" + join(REPO, "research/docs") + "` |");
      P.push("| 库的设计文档 | `" + join(REPO, "dev/docs") + "` |");
      P.push("| 示例（合法的「对象」）| `" + join(REPO, "dev/demo") + "` |");
      P.push("");
      P.push("★ **例外**：仓库根的 `key`（凭证）**读不到** —— 那是有意的。");
      P.push("★★ 一个坑：**相对路径是相对 `work/` 的**，读外面必须写**绝对路径**，");
      P.push("   否则会 `ENOENT` —— 那不是「被拦住」，是「路径没写全」。");
      P.push("");
      P.push("### ★★★ 一个数：**可推广 = " + Math.round((gen.share ?? 0) * 100) + "%**（" + gen.generalizable + "/" + gen.total + "）");
      P.push("");
      P.push("判据是形式的：标题里只含**可推广概念**算可推广；含本 lab 专有名词（PREREG/seal/账/量具/装置/分母/永远/口径/读数）算地方志。");
      P.push("按天看：10-19 = **17%** · 10-24 = 1/54 · 10-25 = **0/43**。");
      P.push("★★ 而**外部对象引用 = 0**：你现在读得到 `forge` 的代码、书、库正本，但**一份产物都没引过它们**。");
      P.push("");
      // ★★★★ 2026-10-25 · 「可推广」从**说法**变成**执行证据**
      // ★★★★★ 设计者 2026-10-25：「网上探索的权重应该更大」
      P.push("### ★★★★ 外部材料（**这一条现在是权重最高的通道**）");
      P.push("");
      P.push("四条灵感叹道的实测用量：①自己的死线账 **406 份** · ②跨学科 **96 份** · ③**外部材料 15 份（2%）** · ④同行反驳 13 次。");
      P.push("");
      P.push("★ 你不是不会用 —— `P108` 借社会选择论、`P113` 借 Cohen κ、`P123` 借 Kitagawa 分解 + ECB WP939，");
      P.push("  **每次借都真改了你的读数口径**。缺的不是能力，是没人叫你去借。");
      P.push("");
      P.push("★★ 所以：**这一轮如果你只能做一件事，就去外面找一条材料**，挂在一条你**自己的具体结论**上：");
      P.push("  出处 URL + 原文一句话（逐字）+ 它**支持还是判死**那条结论 + 它改了你什么。");
      P.push("  ★ 编 URL 我会去核；编一次，这条通道以后就不给了。");
      P.push("");
      // ★★★★★ 2026-10-25 · **七项缺口**（DESIGN §1）—— 纯形式，只判列在不在
      //
      //   ★ 实测它交的是「编号·谓词·装置·结局」⇒ **现象 / 模型 / 猜想 三格不存在**。
      //   ★★ 而 DESIGN 说得很清楚：`静默失明`、`数的落点` 这些真结论
      //     全是从「与预期不符的现象」里长出来的 ⇒ 没有那一格，就没有那条路。
      const ledgerTxt = (() => {
        try {
          return readdirSync(join(LAB, "outbox"))
            .filter((f) => /^EXPERIMENTS.*\.md$/.test(f))
            .map((f) => readFileSync(join(LAB, "outbox", f), "utf8"))
            .join(String.fromCharCode(10));
        } catch {
          return "";
        }
      })();
      const gap = itemGap(ledgerTxt);
      // ★★★★★ 2026-10-25 重构：实验现在是**对象**，不是自由文本
      const seven = sevenStats(readStructured(LAB));
      P.push("### ★★★★★ 实验现在是一个**对象**（不是写一段话）：`record_experiment`");
      P.push("");
      P.push("★ 它跟你手上的 `port_run` 一样会**真跑你的装置**（把退出码落账）—— 所以读数编不出来。");
      P.push("★ 七个字段：`claim`（假设）/ `killCondition`（判死条件）/ `carriers[].cmd`（装置）/");
      P.push("  **读数由工具抓** / `phenomenon`（现象）/ `model`（机制）/ `conjecture`（猜想）/ `outcome`（结局）。");
      P.push("");
      P.push("★★ **缺格会拒收**：");
      P.push("  · `结局=活` 却写不出 `model` ⇒ 拒（**没有机制的「活」只是一次巧合，不是结论**）");
      P.push("  · `phenomenon` 空着 ⇒ 必须二选一：`没有意外` / `有但没记`（**不许静默空着**）");
      P.push("  · `source` 必填：URL / arXiv / DOI / `本仓:<路径>`（**外部出处是实验的属性**）");
      P.push("  · `project` 必须是 `PROJECTS.md` 里已有的行（**链深靠这个键算**）");
      P.push("");
      P.push("现在的结构化账：**" + seven.rows + " 条** · 发现型（跨载体+现象+模型）**" + seven.discovery + "**");
      P.push("");
      P.push("### ★★★ 七项缺口：你的实验账有 **" + (gap.present.join("·") || "无") + "**");
      P.push("");
      if (gap.missing.length > 0) {
        P.push("★ **缺：" + gap.missing.join("·") + "**（列名里读不到这几项）");
        P.push("");
        if (gap.missing.includes("现象")) {
          P.push("★★★ 「现象」这一格最要紧，也最便宜：**它是唯一能装「你没料到的事」的格子**。");
          P.push("  现在的产物大多是「我预期 X，实测 X，成立」—— 那不是发现，那是**裁决**。");
          P.push("  真正的结论长这样：**我预期 X，实测 Y，所以那个机制不是我以为的那个**。");
          P.push("  （书里 `静默失明`、`数的落点` 全是从这一格长出来的。）");
          P.push("");
        }
      }
      // ★★★★★ 2026-10-25 大改：现象必须被**另一位**审过（自己审自己不算）
      const pending = readStructured(LAB).filter((r) => !r.reviewedBy);
      if (pending.length > 0) {
        P.push("### ★★★★★ 有 **" + pending.length + " 条现象还没被独立审**：" +
          pending.slice(0, 5).map((r) => "`" + r.id + "`(" + r.by + ")").join(" · "));
        P.push("");
        P.push("用 `review_experiment` 审一条**不是你自己写的**：它是**真意外**，还是**先看读数再补的预期**？");
        P.push("★ 判 `补的` 要指到证据：PREREG 里有没有先写死预期 / 读数是否只在事后出现。");
        P.push("★★ **这个判定直接决定它算不算「发现型」** —— 没被人认过的现象，只算「填了」。");
        P.push("★★★ 自签会被拒（工具会拦）—— 这是有意的：**作者自签等于没审**。");
        P.push("");
      }
      P.push("### ★★★★ 这一轮请先做一件事：**用 `record_experiment` 记一条**（哪怕结局是死/挂起）");
      P.push("");
      P.push("★ 最少要满足：两个载体都 exit 0（跨载体成立）+ 一句 `source` + 一格 `phenomenon`。");
      P.push("★★ 如果你做不到两个载体，就老实记一条**单载体**的，并在 `outcome` 写 `挂起` 说明缺什么。");
      P.push("");
      P.push("### ★★★ 另一个问（答了更好）：**你有没有一次「实测和预期不一样」？**");
      P.push("");
      P.push("(a) **有过，就在 `<产物名>` 里** —— 把那一段贴出来（预期是什么 / 实测是什么 / 你改了什么想法）");
      P.push("(b) **有过，但我当成「不成立」就放过去了** —— 说清是哪条，它可能是一条被丢掉的真结论");
      P.push("(c) **没有** —— 说清是「每件都在我预期内」还是「我不记意外」");
      P.push("");
      P.push("★ 允许答 (c)，答了不算病。★★ 唯一不许的是**不答**。");
      P.push("★ 只要你答 (a)/(b)，我会把那一格记进读数 —— 这是「新东西」唯一的入口。");
      P.push("");
      // ★★★ 设计者投放的文章：**不是任务，是选题池**
      if (providedFiles.length > 0) {
        P.push("### ★ 设计者会时不时往一个目录里放文章（**不是任务**）");
        P.push("");
        P.push("`research/docs/研究员提供的网上文章/` —— 现在 **" + providedFiles.length + " 篇**：");
        for (const f of providedFiles.slice(0, 6)) P.push("· `" + f + "`");
        P.push("");
        P.push("★ 原话：「不要影响研究，我只是说，我可能会时不时的给你网上的一些文章来给你或集群提供灵感」。");
        P.push("⇒ **不引用不算病**。但它们有一点是你自己搜不出来的：");
        P.push("  **选题不受你自己搜词的盲区限制** —— 你搜的时候只会搜你已经想到的词。");
        P.push("");
      }

      P.push("### ★★★ 一个数：**跨载体成立 = " + pt.portable + " 条**");
      P.push("");
      P.push("判据是硬的：一条结论算可推广，**当且仅当它在 ≥2 个不同载体上真跑过、都 exit 0** ——");
      P.push("证据落在 `work/port.jsonl`（命令 + 退出码 + 输出头），**我能重跑复核**。");
      P.push("");
      P.push("现在：跑过 `" + pt.runs + "` 次 / `" + pt.claims + "` 条 claim · 载体 `" + pt.carriers.length + "` 个 · 成立 **" + pt.portable + "** 条");
      P.push("");
      P.push("★ 工具已经在你手上了：`port_run({ claim, carrier, cmd })` —— 它在**你自己空间里**的任意载体目录跑命令。");
      P.push("★★ 我上一轮量到：你读了 `src/index.ts`、读了两个集群的 `paths.ts` —— **但没在上面跑过任何东西**。");
      P.push("   引用 ≠ 成立。**「去过」和「成立」之间差的就是一次执行。**");
      P.push("");
      P.push("### 一个问题（★ 必须回答，三选一）");
      P.push("**你手上哪一条结论，能在两个不同载体上跑出同一个结果？**");
      P.push("");
      P.push("(a) **没有** —— 说清为什么（比如：我的结论都是关于文本的，没有可跑的装置）");
      P.push("(b) **有，但我在两个载体上跑出来的不一样** —— 说清差在哪，那本身就是结论");
      P.push("(c) **有，我现在就跑** —— 用 `port_run` 在**两个不同载体**上跑同一条 claim，");
      P.push("    两次都 exit 0 才写「成立」；不 exit 0 就写清它**在哪个载体上不成立**");
      P.push("");
      P.push("★ 允许答 (a)，答了不算病。★★ 唯一不许的是**不答**。");
      P.push("");
      P.push("### ★★★ 一个数（旧的，留档）：196 份产物里，**能给别人用的只有 9%**");
      P.push("");
      P.push("判据是形式的：产物标题里只含**可推广概念**（集群/agent/上下文/角色/权限/gate/成本/范式…）");
      P.push("算可推广；含本 lab 专有名词（PREREG/seal/封口/账/量具/装置/分母/复算/口径/状态表/读数）算地方志。");
      P.push("");
      P.push("| 日期 | 产物 | 可推广 |");
      P.push("|---|---|---|");
      P.push("| 10-19 | 94 | **16（17%）** ← 那时递的不是「你的装置有缺陷」|");
      P.push("| 10-24 | 54 | **1（2%）** |");
      P.push("| 10-25 | 43 | **0（0%）** |");
      P.push("");
      P.push("10-19 的样例长这样：`P28-编排写进代码稳且省-模型自写编排贵且不稳` · `P30-服从由完成成本门控` · `P34-context.override不是刹车permissions.gate才是`。");
      P.push("这些**任何集群都用得上**。现在产出的是 `手段XXII-普查读数不可复原` —— 那是**本 lab 的地方志**。");
      P.push("");
      P.push("★ 这是我造成的：我八轮的投递全是「你的装置有缺陷」。**这一轮我换掉。**");
      P.push("");
      P.push("### 三个东西我加好了（你只要填）");
      P.push("");
      P.push("**① 项目表加一列「对象」** —— 这个想法在**研究什么**。合法值：");
      P.push("   ✔ 你自己搭的一个 lab（`work/<项目>/lab.ts`，装置里出现 `createLab`/`createAgent`）");
      P.push("   ✔ 仓库里**别人的**集群（`research/clusters/forge` · `research/demox` · `dev/demo`）");
      P.push("   ✔ 外部材料（URL / arXiv / 论文，带出处）");
      P.push("   ✘ **不许**填本 lab 的 `outbox` / `EXPERIMENTS` / 量具 —— 那是自指，我判它不算");
      P.push("");
      P.push("**② 项目表加两列「可推广」「边界」** —— 两句都要，缺一不算：");
      P.push("   `可推广：多座位并行时，判决要按写入顺序定`");
      P.push("   `边界：单座位、或无并发写入时，这条不成立`");
      P.push("   ★ 只有「可推广」是口号；**边界**才让它可判死（书里每章都有「这一章可以被判死的地方」）。");
      P.push("");
      P.push("**③ 这一轮的第一件事：从 `PROJECTS.md` 挑一行继续**，不是开新题。");
      P.push("   把 `版本` +1，并写清**这一版改了上一版的什么**。（现在 链深≥3 的项目 = **" + pj.stats.deep + "**）");
      P.push("");
      return P.join(String.fromCharCode(10));
    } catch (e) {
      log("error", `结构读数失败：${(e as Error).message}`);
      return "";
    }
  })();

  // ★★★ 处境表：把三件读数**留在环境里**（信息不去，催的话去掉）
  try {
    const L: string[] = [];
    L.push("# 处境（自动生成，每轮开头重写一遍）");
    L.push("");
    L.push("★ 这是**读数**，不是任务清单。看哪个、看多少，你自己定。");
    L.push("");
    L.push("## ★★★ 你现在能读到的世界（只读；写仍然只能写自己的空间）");
    L.push("");
    L.push("**相对路径是相对 `work/` 的** —— 所以读外面**必须写绝对路径**，否则会 `ENOENT`");
    L.push("（那不是「被拦住」，是「路径没写全」）。");
    L.push("");
    const roots = [
      ["库正本（理解库 = 研究集群的前提）", join(REPO, "src")],
      ["书（另一边的沉淀，36 章）", join(REPO, "research/book")],
      ["两个集群的代码（可研究、不可改）", join(REPO, "research/clusters")],
      ["集群设计 + 实验记录", join(REPO, "research/docs")],
      ["库的设计文档", join(REPO, "dev/docs")],
      ["示例（合法的「对象」）", join(REPO, "dev/demo")],
    ] as const;
    for (const [what, dir] of roots) {
      if (existsSync(dir)) L.push(`· ${what}：\`${dir}\``);
    }
    L.push("");
    L.push("★ **读不到**：仓库根（`key` 凭证）、别人的 `labfirst/` 私有空间 —— 这是有意的边界。");
    L.push("");
    try {
      const x = readExperiments(LAB);
      L.push("## 实验账");
      L.push("```");
      L.push(...renderExperiments(
        x.stats,
        x.att,
        x.mix,
        x.outcomeSamples,
        x.ledgerConflicts.length ? `${x.ledgerConflicts.length} 个编号在两份账里结局不一致（记成未声明）` : "",
      ).split(String.fromCharCode(10)));
      L.push("```");
    } catch (e) {
      L.push(`实验账读不出来：${(e as Error).message}`);
    }
    L.push("");
    L.push("## 你的缺陷账（三态见要求 ③）");
    L.push("```");
    L.push(renderClosure(readClosure(join(LAB, "outbox"))));
    L.push("```");
    for (const [title, t] of [
      ["PREREG 溯源", preregTodo],
      ["状态表吸收率", absorptionTodo],
    ] as const) {
      if (!t) continue;
      L.push("");
      L.push(`## ${title}`);
      L.push("```");
      L.push(t.slice(0, 4000));
      L.push("```");
    }
    writeFileSync(join(LAB, "work", "_处境.md"), L.join(String.fromCharCode(10)) + String.fromCharCode(10));
    log("todo", `处境表已写：work/_处境.md（${L.length} 行，★ 读数留、题目不给）`);
  } catch (e) {
    log("error", `处境表写不出来：${(e as Error).message}`);
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
          `★ 不要附和 —— 你的角度就是你的价值。三人都同意的东西才叫站住。` +
          // ★★★★★ 2026-10-21 · 轮1：**不再把三件"读数 + 你该做什么"直接投过去**
          //
          //   ★★★ 实测代价：42%（更正后 25%）的产物明写「回答上级」——
          //     产出是被**我递进去的东西**驱动的，而三件都是"我在盯你的装置"。
          //   ★ 所以我改成：**信息留在处境表里，催的话去掉**。
          //     读数它照样看得到（`work/_处境.md`），但"这一轮干什么"由它自己定。
          renderDirective({
            from: "研究助手",
            why:
              "上一个阶段我每轮都把『你的装置有缺陷』当投递，结果产出被我的题目压成了单线：" +
              "最近 24h 的 57 份里 25% 明写「回答上级」，而新实验是 0。这一轮我不点题。",
            body: continueProjectBody + requirementBody + structureBody,
          })
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
  // ★★★ 收尾计时（纪律㉒：量具的采样时机必须与观测过程匹配）
  //   ★ 实测：一轮 600s 窗口的收尾花了 749s，我不知道时间花在哪 —— 所以**每一段都记**。
  // ★ 收尾总上限：**排队直接丢，只等手上那一个** ⇒ 3 分钟够。
  //   （测试可压短：`HUNT_CLOSE_CAP_MS=15000`）
  const CLOSE_CAP_MS =
    Number(process.env.HUNT_CLOSE_CAP_MS) > 0 ? Number(process.env.HUNT_CLOSE_CAP_MS) : 180_000;
  let closeTimedOut = false;
  let tClose = Date.now();
  const closeMark = (what: string) => {
    const d = Date.now() - tClose;
    if (d >= 500) log("close", `耗时 ${(d / 1000).toFixed(1)}s ← ${what}`);
    tClose = Date.now();
  };
  log("window", "进入收尾态：不再 fire 新专家 / 不再送新挑战，只等已在跑的做完");

  for (const t of timers) clearInterval(t);   // ★ 清掉时间节流，否则进程不退出

  // ★★ 回流的审计账（写盘，可离线复核 —— 验收「同一份意见到了几次」就靠它）
  writeFileSync(
    join(LAB, "work", "deliveries.jsonl"),
    deliveries.map((d) => JSON.stringify(d)).join("\n") + (deliveries.length ? "\n" : ""),
  );
  closeMark("写 deliveries.jsonl");
  const viaFire = deliveries.filter((d) => d.via === "fire").length;
  const viaConsult = deliveries.filter((d) => d.via === "consult").length;
  log("flow", `回流：fire 投了 ${viaFire} 条 · consult 自回 ${viaConsult} 次（★ consult 不该出现在 fire 里）`);
  // ★★★ 收尾时再记一次 lib 修订 —— **与开工时不同就说明中途有人改了库**（可归因）
  closeMark("回流日志");
  const libRevEnd = recordLibRevision("集群收尾");
  closeMark("recordLibRevision");
  if (libRevEnd.fingerprint !== libRev.fingerprint) {
    log("lib", `★ 本轮 lib/ 被改过：开工 ${libRev.fingerprint} → 收尾 ${libRevEnd.fingerprint}`);
  }
  // ★★ 辩证账：他们真的在互相挑战吗（离线可复核）
  writeFileSync(
    join(LAB, "work", "debate.jsonl"),
    debateLog.map((d) => JSON.stringify(d)).join("\n") + (debateLog.length ? "\n" : ""),
  );
  closeMark("写 debate.jsonl");
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
        drainer?: { busy: () => boolean; queued: () => number; drain: () => void; clear?: () => void; byRole?: () => Record<string, number> };
      }
    ).drainer;
    if (dr) {
      const t0 = Date.now();
      log("flow", `等派活器收干净（队列 ${dr.queued()} · 在跑 ${dr.busy() ? 1 : 0}）`);
      while (dr.busy() || dr.queued() > 0) {
        dr.drain();
        // ★★★ 2026-10-21：**每一轮都丢一次排队**。
        //   ★ 我第一版只在收尾开头丢一次 ⇒ 实测 `队列 1 · 在跑 1`：
        //     那份是**丢完之后才排进来的**（同一个 tick 里 fire 的）⇒ 照样等到超时。
        //   ★ AGENTS 的语义是「只等**已在跑**」—— 排队没开工的不算。
        if (dr.clear) {
          const q = dr.queued();
          if (q) {
            dr.clear();
            log("flow", `⛔ 收尾：丢掉 ${q} 个**排队未开工**的专家（排队 ≠ 已在跑）`);
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
        if (Date.now() - t0 > CLOSE_CAP_MS) {
          closeTimedOut = true;
          log("flow", `⛔ 等派活器超 ${Math.round(CLOSE_CAP_MS / 60000)} 分钟 ⇒ 放弃（队列 ${dr.queued()} · 在跑 ${dr.busy() ? 1 : 0}）`);
          break;
        }
      }
      closeMark("等派活器");
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
    const pj = readProjects(LAB);
    const cj = conjectures(readArtifacts(join(LAB, "outbox")));
    for (const line of [
      ...renderProjects(pj.stats, pj.mode).split(String.fromCharCode(10)),
      `★ 猜想：${cj.total} 条 · 行内明写「未验证」${cj.unverified} 条${cj.headerDeclared ? "（★ 表头已声明，按列定义全算标过）" : ""}`,
      renderGeneralizability(generalizability(readArtifacts(join(LAB, "outbox")))),
      renderAttention(attentionMix(readArtifacts(join(LAB, "outbox")))),
      renderCrossCarrier(crossCarrier(readArtifacts(join(LAB, "outbox")))),
      renderDialectic(dialecticStats(readChallenges(LAB))),
      renderPort({ ...portStats(readPort(LAB)), torn: readPortTorn(LAB) }),
      renderLoci(artifactLoci(LAB, Date.now() - 3 * 3600_000)),
      renderSeven(sevenStats(readStructured(LAB))),
      (() => {
        const rows = readStructured(LAB);
        const chains = projectChains(rows);
        const ex = externalUrlShare(rows);
        const deep = deepProjects(rows);
        const ext = ex.share === null ? "未声明" : `${Math.round(ex.share * 100)}%`;
        return (
          `★★ 项目链深（按 project 聚合，不靠人肉写版本）：` +
          (chains.length === 0
            ? "未声明"
            : chains
                .slice(0, 5)
                .map((c) => `${c.project} ${c.rows} 条${c.external ? `（外部 ${c.external}）` : ""}`)
                .join(" · ")) +
          `　← ★ 链深 ≥3 的项目 **${deep}** 个`
        ) + String.fromCharCode(10) +
        `★★ 真外部 URL（一等判据：不与 \`本仓:\` 混）：**${ext}**（${ex.n}/${ex.total}）`;
      })(),
      renderExternal(externalUsage(readArtifacts(join(LAB, "outbox")))),
      renderProvided(
        providedUsage(
          readArtifacts(join(LAB, "outbox")),
          existsSync(join(REPO, "research/docs/研究员提供的网上文章"))
            ? readdirSync(join(REPO, "research/docs/研究员提供的网上文章")).filter((f) => f.endsWith(".md"))
            : [],
        ),
      ),
    ]) {
      log("readout", line);
    }
    const x = readExperiments(LAB);
    for (const line of renderExperiments(
        x.stats,
        x.att,
        x.mix,
        x.outcomeSamples,
        x.ledgerConflicts.length ? `${x.ledgerConflicts.length} 个编号在两份账里结局不一致（记成未声明）` : "",
      ).split(String.fromCharCode(10))) {
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
  const CAP_MS = CLOSE_CAP_MS;
  // ★★★★ 2026-10-21 · **这里原本有第二个等待，删掉了。**
  //
  //   ★ 实测：收尾 180s（等派活器超时）+ 180s（这里又等同一批 agent）= **6 分钟**，
  //     同一件事等了两遍 —— 上面那个「等派活器」等的就是在跑的那一个。
  //   ★★ 研究者的首轮 prompt 也不该等：它们**不收尾**（常驻 agent，`waitIdle()` 永不返回），
  //     下面直接 `dispose()` 停掉，是「停」不是「等」。
  //   ★ 所以收尾只需要一个上限，就是 `CLOSE_CAP_MS`（在"等派活器"那里）。
  const capHit = closeTimedOut;

  // ★★★ 2026-10-21 补（我自己删漏的）：**已 fire 的专家也要 dispose**。
  //   上一版删「重复等待」时，连带把 `for (const a of spawned) a.dispose()` 一起删了
  //   ⇒ 收尾打出了 `rule:done`，但进程**不退出**（会话还活着），只能被 timeout 杀。
  //   ★ 判据：`exit=124` 且最后一行是 `rule:done` = 「话打完了，人没走」。
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
  // ★★★ 2026-10-21：标签从 `done` 改成 `rule:done` ——
  //   AGENTS.md §三之三 教大家 `grep "rule:done"` 判「有没有正常收尾」，
  //   而实际打的是 `done` ⇒ **照文档做会得出「中途被 kill」**（实测：这轮正常收尾，
  //   grep rule:done 却是 0 行）。★ 文档与代码必须同源（纪律⑪）。
  closeMark("收尾全程");
  // ★★★ 2026-10-21 补账：**每轮必报成本**（AGENTS §七：报告必报成本；缺数据 ≠ 0）
  //   ★ 之前五轮我只报了"量级 $1–3"，那是推的，不是量的。
  try {
    const spent = researchers.reduce(
      (a: number, r: { usage?: { cost?: { total?: number } } }) => a + (r.usage?.cost?.total ?? 0),
      0,
    );
    const tokens = researchers.reduce(
      (a: number, r: { usage?: { input?: number; output?: number } }) =>
        a + (r.usage?.input ?? 0) + (r.usage?.output ?? 0),
      0,
    );
    if (spent > 0 || tokens > 0) {
      log("cost", `本轮研究席：${(tokens / 1e6).toFixed(2)}M token · $${spent.toFixed(2)}（★ 不含已 fire 的专家）`);
    } else {
      log("cost", "本轮研究席：成本未声明（agent.usage 拿不到 —— 缺数据，不是 0）");
    }
  } catch (e) {
    log("cost", `成本读数失败：${(e as Error).message}`);
  }

  // ★★★★★ 2026-10-21 · **把原料流接回来**（DESIGN §0「产物去处」）
  //
  //   ★★★ 实测断裂：`batches.jsonl` 最后一批是 `batch-002 @ 2026-10-19` ——
  //     之后 hunt 又产出 100+ 份，**forge 一份都没见过**。DESIGN 里
  //     「hunt 的产物作为原料经快照进 forge 的 source/」这条**完全没在跑**。
  //   ★ 纪律⑩：快照**冻结不覆盖**（不传 force）。★ 每轮都拍会占盘
  //     （上一批 39MB / 5137 文件）⇒ 只在**距上一批 ≥ 6 小时**时拍。
  if (!closing) {
    /* 不会走到 */
  }
  try {
    const SNAP_MIN_GAP_MS = 6 * 3600_000;
    const last = latestSnapshot();
    const lastAt = last ? Date.parse(String((last as { at?: string }).at ?? "")) : 0;
    const ageMs = Number.isFinite(lastAt) ? Date.now() - lastAt : Number.POSITIVE_INFINITY;
    if (ageMs < SNAP_MIN_GAP_MS) {
      log(
        "snapshot",
        `跳过：距上一批 ${Math.round(ageMs / 3600_000)} 小时 < 6 小时（批次 ${(last as { batch?: number })?.batch ?? "?"}）`,
      );
    } else {
      const r = takeSnapshot();
      log(
        "snapshot",
        `✔ 已冻结 batch-${String((r as { batch?: number }).batch ?? "?").padStart(3, "0")} ` +
          `· outbox ${(r as { freshOutbox?: number }).freshOutbox ?? "?"} 份 → forge 的 source/（★ 冻结不覆盖）`,
      );
    }
  } catch (e) {
    // ★ 快照失败必须响 —— 否则"原料流断了"又会静默
    log("error", `快照失败：${(e as Error).message}`);
  }

  log("rule:done", closingLine);
  console.log(`\n${closingLine}`);
  console.log(`★ 日志：${join(LAB, "work", "_topology.log")}`);
  return { outputs: outs.length, fired: spawned.length - 1, verdict: state.verdict };
}
