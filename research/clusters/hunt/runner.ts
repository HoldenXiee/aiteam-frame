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
import { recordLibState, recordLibRevision } from "./lib-state.ts";
import { attachGate } from "./guard.ts";
import { ALL_TOOLS, LAB, MODEL, REPO } from "./paths.ts";
import { EXPERTS, type ExpertName } from "./prompts/index.ts";
import * as researcherPrompt from "./prompts/researcher.ts";
// ★★★ 同一身份多员工：角度的定义（设计者交办 2026-10-19）
import { ANGLES, renderAngle } from "./prompts/angles.ts";
// ★★★ 两个集群的"多员工"含义完全不同（2026-10-19）：
//   · hunt ：三个**角度**（同一种活=探索的三种偏好）⇒ 多员工 = 找盲区
//   · forge：三条**工作线**（三种不同的活）⇒ 多员工 = 一条产不出教科书
import { DEFAULT_TEAMS, TEAMS, renderTeam, AUDIENCES, renderAudience, BOOK_THRESHOLD } from "./prompts/lines.ts";
import { makeJudge, loadVotes, writeVerdicts, type Vote } from "./tools/judge.ts";
import { CLUSTER } from "./paths.ts";
import { SOURCE_CLUSTER } from "./prompts/missions.ts";
import { listOutbox, makeRules, newState, tick, THROTTLE_N, THROTTLE_MS } from "./topology/rules.ts";
import { makeConsult } from "./tools/consult.ts";
// ★★★ 辩证机制：一个员工挑战另一个员工的产物（设计者提示 2026-10-19）
import { makeChallenge } from "./tools/challenge.ts";
import { makeSignOff, loadSignOffs, writeAgreedIndex, gateVerdict, renderSignOff, type SignOffTable } from "./tools/signoff.ts";
import { makeJointExperiment, type JointProposal } from "./tools/joint.ts";
import { publishAndReport } from "./tools/publish.ts";
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
  // ★★★ forge 的三条线：默认三条（一个人做三件事必然偏向最顺手的那件 ⇒ 三条线各一人）。
  //   ★ 但 `--employees=N` **说了算**（设计者 2026-10-19：先 1 人暴露问题，再加到多员工）。
  //   ★★ 实测发现的 bug：原写 `Math.max(2, employees)` ⇒ **传 1 也起 2 条线**，
  //      与"先跑 1 人"的意图相反。现在就是 `employees`。
  const isForge = CLUSTER !== SOURCE_CLUSTER;
  // ★★★ forge = **团队 × 队内员工**（设计者：「多个团队、多个员工」—— 两层）
  //   ★ `--employees=N` 现在是**每个团队几个人**（1 或 2）。
  //   ★★ 首跑实测教训：我把「三条线」当成三个员工，结果它们各写各的、无人合成。
  //      现在每个团队至少 1 人，默认 2 人（一人提概念 / 一人连线，真的会吵）。
  const perTeam = Math.max(1, Math.min(2, employees));
  const seats = isForge
    ? DEFAULT_TEAMS.flatMap((tk) =>
        TEAMS[tk].members.slice(0, perTeam).map((m) => ({
          key: perTeam > 1 ? `${tk}/${m.key}` : tk,
          teamKey: tk as string,
          memberKey: m.key,
          stance: TEAMS[tk].stance,
          render: () => renderTeam(tk, m.key),
        })),
      )
    : ANGLES.slice(0, employees).map((a) => ({
        key: a.key,
        teamKey: "",
        memberKey: "",
        stance: a.stance,
        render: () => renderAngle(a),
      }));
  /** ★ 真正要起的座位（forge 是 团队×成员，hunt 是 角度） */
  const usedAngles: { key: string; teamKey: string; stance: string; render: () => string }[] = seats;
  /** ★★ 共识门要的"全体团队"（forge 按团队算，hunt 按员工算） */
  const ALL_TEAMS: string[] = isForge
    ? DEFAULT_TEAMS.filter((tk) => seats.some((s2) => s2.teamKey === tk))
    : usedAngles.map((s2) => s2.key);
  // ★★★ 观众（设计者 2026-10-19）：
  //   「加一个『观众』，最后观众**最被说服哪个观点就写哪个观点**」
  //   「所有观众都支持某个观点（或达到 9 成支持）就**结束争辩写入 book**」
  //   ★★ 观众**不生产产物**，只表态 ⇒ 它们的 role 是另一套（renderAudience）。
  //   ★ 每人有**自己的想法**（operator / skeptic / newcomer / builder）⇒ 不是橡皮图章。
  const audienceSeats = isForge ? AUDIENCES.map((a) => ({ audience: a })) : [];
  /** ★ 统一的渲染入口：两个集群各自的"多员工含义" */
  const renderSeat = (seat: { render: () => string }) => seat.render();
  const researcherByKey = new Map<string, Agent>();
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
  // ★★★ 共识签字表（跨员工共享，且**从落盘读回** ⇒ 重启不丢）
  const signoffTable: SignOffTable = loadSignOffs(join(LAB, "work", "signoffs.jsonl"));
  /** ★ 联合实验提案表 */
  const jointTable = new Map<string, JointProposal>();
  for (const ang of usedAngles) {
    const myKey = ang.key; // ★ forge 是 `team/member`，hunt 是角度名
    // ★ 每位员工都拿 `challenge`，但**只能挑战别人**（自己那条在工具里拦）
    //   ★★ forge 要能挑战**别的团队**（同团队内也可挑）⇒ peers 用 myKey 判
    const challenge = makeChallenge({
      deliver: deliverTo,
      selfKey: myKey,
      peers: () =>
        usedAngles
          .filter((x) => x.key !== myKey)
          .map((x) => ({ key: x.key, stance: x.stance || (x.teamKey ? `团队 ${x.teamKey}` : "") })),
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
      tools: { custom: isForge ? [consult, spawnLine, challenge, signOff, joint] : [consult, spawnLine, challenge] },
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
  if (isForge && audiences.length) {
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
    // ★★★ 共识门的状态（供 onConsensus 规则判断"谁还没签字"）
    signoffState: (artifact: string) => signoffTable.get(artifact),
    allTeams: () => ALL_TEAMS,
    tellAudience:
      audiences.length > 0
        ? (key: string, text: string): { ok: boolean; reason?: string } => {
            const ag = audienceByKey.get(key);
            if (!ag) return { ok: false, reason: `没有这位观众：${key}（有：${[...audienceByKey.keys()].join("、")}）` };
            void ag.io.steer(text).catch((e: unknown) => log("error", `观众投递失败：${(e as Error).message}`));
            return { ok: true };
          }
        : undefined,
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

  log("setup", `装置就绪 · 窗口 ${secs}s · 5 个专家（按需起）· ${isForge ? `团队 ${ALL_TEAMS.length} 个 × 座位 ${researchers.length} 个` : `研究员 ${researchers.length} 个`}（常驻）`);
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
          `1. 先看 \`outbox/\` 里有什么（\`ls outbox/\`），挑最近的读。
` +
          `2. 读的时候按**你的身份**看（见你的定义里的「你怎么判断」）。
` +
          `3. 读完用 \`judge\` 工具表一个态。
` +
          `4. 然后**继续等**（会有新产物送过来）。

` +
          `★★ 不要客气。**「都不够」是完全有效的表态** —— 全体观众支持某一方时争辩才结束，
` +
          `   所以你的不同意见比附和重要得多。
` +
          `★ 若现在 outbox 还是空的，就等着；有东西了再用 \`judge\`。`,
      )
      .catch((e) => ({ error: (e as Error).message, text: "" })),
  );

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
