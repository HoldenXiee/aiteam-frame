// ★★★ lab-3：研究员集群的两个版本对照
//
//   lab-3a —— 第 2 稿：**六个常驻角色**，固定拓扑
//   lab-3b —— 第 3 稿：**一个根 + 按"情况"长出来的分支**（代码监听情况）
//
// ★ 两版共用：研究手册（同一份）、模型、工具白名单、gate 判据、lib/ 可写
// ★ 两版只差：**角色怎么出现**
//
// 用法：
//   npx tsx research/demox/bench/lab-3.ts --arm=a --secs=1800
//   npx tsx research/demox/bench/lab-3.ts --arm=b --secs=1800
//   npx tsx research/demox/bench/lab-3.ts --arm=both --secs=1800

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { labAt, MODEL } from "../env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");

const TOOLS = ["bash", "read", "write", "edit", "grep", "find", "ls"];
const READONLY = ["bash", "read", "grep", "find", "ls"];

export type Arm = "a" | "b";
export type Switch = {
  arm: Arm;
  /** ★ 窗口秒数（不是"轮数"—— 按 C6/C7，循环不再是流程） */
  secs?: number;
  /** 连续多少秒没有新产物就触发看门狗 */
  idleSecs?: number;
};

// ═══════════════ 路径与守卫（★ 用代码立规矩；按 P12 同时给"路"）═══════════════

function labDir(arm: Arm) {
  return join(REPO, "research/demox", `lab-3${arm}`);
}

/** 判断一次调用是不是"写本文件夹之外的地方" */
function outsideWrite(arm: Arm, name: string, input: Record<string, unknown>): string | null {
  const root = labDir(arm).replace(/\\/g, "/");
  const norm = (s: string) => s.replace(/\\/g, "/");
  const inside = (p: string) => norm(p).startsWith(root) || norm(p).startsWith(root.replace("D:/", "/d/"));

  if (name === "write" || name === "edit") {
    const p = String(input.path ?? "");
    return inside(p) ? null : p;
  }
  if (name === "bash") {
    const cmd = String(input.command ?? "");
    // ★ 白名单只读重定向（上一轮的血教训：2>/dev/null 被误判成写）
    const stripped = cmd.replace(/2\s*>\s*\/dev\/null/g, "").replace(/2\s*>&\s*1/g, "");
    const writes = /(^|[^0-9])>(?!>)|>>|\btee\b|\bsed\s+-i|\brm\s|\bmv\s|\bcp\s|\btouch\b|\bmkdir\b/.test(stripped);
    if (!writes) return null;
    // ★ 写了哪里？只要命令行里出现本文件夹之外的路径，就算越界
    const anyInside = norm(cmd).includes(root);
    if (anyInside) return null;
    // ★ 带绝对路径写别处
    const m = stripped.match(/(?:>|>>|\btee\b\s+|\brm\s+|\bmv\s+|\bcp\s+|touch\s+|mkdir\s+)\s*"?([^\s"';|]+)/);
    if (m) {
      const t = norm(m[1]!);
      // 相对路径 = 在 cwd（它自己的 work/）里 → 放行
      if (!/^[a-zA-Z]:\//.test(t) && !t.startsWith("/")) return null;
      return inside(t) ? null : t;
    }
    return "(bash 写操作，目标不明)";
  }
  return null;
}

/** ★★★ 按 P12：拦住时必须给"路" */
const BLOCK_REASON =
  "这个路径只读（仓库主体不归你改）。★ 但**路是有的**：\n" +
  "· 想改库 → `lib/aiteam/` 和 `lib/pi/` 里各有一份**你可以随便改**的拷贝，改完在 `lib/PATCHES.md` 记「改了什么 / 带来什么好处」\n" +
  "· 想改实验装置 → 复制到你的 `work/` 里改\n" +
  "· 想要仓库里别的东西变 → 写进 `outbox/`，研究助手去做\n" +
  "★ 不要反复试这条路，它不会通。";

function makeGate(arm: Arm) {
  let blocked = 0;
  const gate = async (call: { name: string; input?: unknown }) => {
    const inp = (call.input ?? {}) as Record<string, unknown>;
    const bad = outsideWrite(arm, call.name, inp);
    if (bad) {
      blocked++;
      return { block: true as const, reason: BLOCK_REASON };
    }
    return undefined;
  };
  return { gate, count: () => blocked };
}

// ═══════════════ 角色定义 ═══════════════

const RESEARCHER_ROLE =
  "你是这个仓库里的**研究员**。你研究的对象见 `inbox/研究手册.md` —— ★ **先读它**。\n" +
  "★★ 你的价值就在于研究本身：无论是否有重大成果。**沉浸在研究里。**\n" +
  "★ 不是执行任务 —— 是你自己去搞清楚那件事。";

const INSPECTOR_ROLE =
  "你是这个研究员集群的**审查者与鼓励者**。\n" +
  "★ 你没看过它的推导过程 —— 你只看它的产物。\n\n" +
  "你要做三件事：\n" +
  "① ★★ **鼓励**：明确说出它做对了什么、哪里在朝目标走、哪里有创新苗头。**不要省这一节。**\n" +
  "② ★ **纠正**：每条以 `DEFECT: ` 开头，一行一条。只纠这四类：\n" +
  "   · 偏离 DESIGN 目标（做的东西和目标没关系了）\n" +
  "   · 分析形式上有错（结论超证据 / 没对照 / 替代解释没排除）\n" +
  "   · ★ 装置（量具）缺陷 —— 你量的是不是你想量的？\n" +
  "   · 假探索（转圈、重复劳动、不做实验）\n" +
  "★★ 不要因为它「没有重大成果」而批评它 —— 探索本身就是产出。\n" +
  "③ ★★ **判停**：它如果写了 `outbox/CONVERGED.md`，你来判它该不该停。\n" +
  "   判三个问题：\n" +
  "     a. 它说“够了”，是真的探索完了，还是想收工 / 累了 / 卡住了？\n" +
  "     b. 它列的“没排除的替代解释”，真的排除了吗？\n" +
  "     c. ★ **你自己去读 DESIGN 目标 + 它的全部成果**，能不能生出一个它没提过的新问题？\n" +
  "        能 → 写一条 `DEFECT:` 说清新问题是什么，并且判「继续」。\n" +
  "   最后一行必须是 `VERDICT: STOP` 或 `VERDICT: CONTINUE`。";

const ARCHIVIST_ROLE =
  "你是这个研究员集群的**复审者**。★ 你的职责不是做新实验，是**用探索后的眼界重看目标**。\n" +
  "· 读它的全部产物 + 探索痕迹 + 仓库里已有成果\n" +
  "· ★★ 然后重读 `dev/docs/DESIGN.md` 的目标，问：**还能不能生出它没做过的新问题？**\n" +
  "· 逐条列出候选新问题，并说明每条**为什么现在值得做**\n" +
  "★★ 这是“阶段性复审目标”—— 它沉浸在局部，装不下全局，你补这一块。";

const INSPIRER_ROLE =
  "你是这个研究员集群的**跨学科启发者**。\n" +
  "· 读它当前在做的东西（`work/` 里的设计与数据）\n" +
  "· ★★ 然后从**其他学科**找能借的框架 —— 尤其**系统科学**（序参量/相变/级联/反馈延迟）\n" +
  "  和**信息论**（信道容量/压缩/给定值信道）\n" +
  "· 逐条给出：借什么概念 / 它对应这里的什么现象 / 能怎么用它设计实验\n" +
  "★★ 只给**能落成实验**的借用，不给泛泛的类比。";

const LIBSMITH_ROLE =
  "你是这个研究员集群的**改库者**。\n" +
  "★ 研究员撞到了「底层能力不够」。你的活是**真的去改库**：\n" +
  "· 库在 `lib/aiteam/` 和 `lib/pi/`（★ **都可以改**）\n" +
  "· 先搞清它到底缺什么（读它的 `work/`，必要时 dump 真实形状 —— 别猜）\n" +
  "· ★ 改完写 `lib/PATCHES.md`：**改了什么 / 带来什么好处**（研究助手会读，价值高的会同步进本仓库）\n" +
  "★★ 如果发现“其实不用改库，换个用法就行”，那也是好结论 —— 写下来。";

const WATCHDOG_ROLE =
  "你是这个研究员集群的**看门狗**。\n" +
  "★ 从它的痕迹判断：它在**真探索**，还是在**转圈/卡住**？\n" +
  "· 看 `work/` 的最新文件时间、工具调用痕迹、JOURNAL\n" +
  "· ★★ 关键：**本项目的实测说成本在“定位”不在“写”** —— \n" +
  "  反复跑测试、读文件是**正常的研究方式**，不是卡住。\n" +
  "· 真该报警的是：**同一个文件反复读、同一条命令反复跑、写的东西没有新内容**\n" +
  "★ 输出：① 它在干什么（事实）② 判断：真探索 / 转圈 ③ 如果是转圈，建议怎么破";

// ═══════════════ 两版的核心差别 ═══════════════

type Spawn = { kind: string; role: string; tools: string[]; task: string };

/**
 * ★ A 版（第 2 稿）：**六个角色同时起**，固定拓扑。
 */
function planA(lab: string): Spawn[] {
  const ctx =
    `以下是这个研究员集群当前的空间：\`${lab}\`。\n` +
    `· 研究手册在 \`inbox/研究手册.md\` · 研究员的工作区在 \`work/\` · 成果在 \`outbox/\`\n` +
    `★ 现在还没有任何产物（集群刚建立）。`;
  return [
    { kind: "researcher", role: RESEARCHER_ROLE, tools: TOOLS, task: `${ctx}\n\n★ 你是这个集群的核心。开始你的研究。` },
    { kind: "inspector", role: INSPECTOR_ROLE, tools: READONLY, task: `${ctx}\n\n★ 现在还没有产物可审。请先**读研究手册和 DESIGN 目标**，建立你自己的判断标准；等研究员产出后你会被再次叫醒。` },
    { kind: "archivist", role: ARCHIVIST_ROLE, tools: READONLY, task: `${ctx}\n\n★ 请先复审：重读 DESIGN 目标 + 仓库已有成果（\`research/demox/成果/\`），列出**当前最值得做的 3–5 个新问题**。` },
    { kind: "inspirer", role: INSPIRER_ROLE, tools: READONLY, task: `${ctx}\n\n★ 请扫一遍这个研究方向的历史（\`research/demox/\`），给出**能借其他学科框架**的 3–5 条具体建议。` },
    { kind: "libsmith", role: LIBSMITH_ROLE, tools: TOOLS, task: `${ctx}\n\n★ 现在还没有「撞墙」报告。请先**熟悉 \`lib/\` 里的两份库**（结构与入口），并准备好在研究员撞墙时动手。` },
    { kind: "watchdog", role: WATCHDOG_ROLE, tools: READONLY, task: `${ctx}\n\n★ 现在还没有动静。请先熟悉 \`observe\` 面与「探索 vs 转圈」的区分标准。` },
  ];
}

/**
 * ★★★ B 版（第 3 稿）：**只有 researcher 常驻**；其余按"情况"由代码长出来。
 *   情况来自对 researcher 的**真实观测**（文件时间 / 产物 / 撞墙计数），不是时钟。
 */
function planB(_lab: string): Spawn[] {
  return []; // ★ 先只起根；分支在 runArmB 里按情况长
}

export const CONDITIONS = {
  /** 情况 1：写出了成果 → 起审查者 */
  wroteOutput: { role: INSPECTOR_ROLE, tools: READONLY, kind: "inspector" },
  /** 情况 2：撞到"库做不到"（同一堵墙反复撞）→ 起改库者 */
  hitWall: { role: LIBSMITH_ROLE, tools: TOOLS, kind: "libsmith" },
  /** 情况 3：要跨学科 → 起启发者 */
  needsDiscipline: { role: INSPIRER_ROLE, tools: READONLY, kind: "inspirer" },
  /** 情况 4：长时无产出 → 起看门狗 */
  idle: { role: WATCHDOG_ROLE, tools: READONLY, kind: "watchdog" },
  /** 情况 5：复审目标（由 idle 或产出累积触发）→ 起复审者 */
  review: { role: ARCHIVIST_ROLE, tools: READONLY, kind: "archivist" },
} as const;

// ═══════════════ 观测：读它现在的状态（★ 这是"情况"的来源）═══════════════

type State = {
  outputs: number;
  newestOutput: number;   // mtime ms
  newestAnything: number;
  wallHits: number;       // 归因到"库做不到"的能力缺口文档数
  lastSeenOutputs: number;
  secondsSinceNew: number;
};

function readState(lab: string, lastSeenOutputs: number, lastActivity: number): State {
  const outDir = join(lab, "outbox");
  const workDir = join(lab, "work");
  const list = (d: string) =>
    existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile() || e.isDirectory()) : [];
  const outs = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".md")) : [];
  const outsAll = list(outDir);
  const works = list(workDir);

  let newestAnything = 0;
  const seen = (p: string, st: import("node:fs").Stats) => {
    if (st.mtimeMs > newestAnything) newestAnything = st.mtimeMs;
  };
  try {
    for (const e of [...outsAll, ...works]) seen(e.name, require("node:fs").statSync(join(outDir, e.name)));
  } catch {
    /* 竞态：文件正在被写 */
  }

  const wallHits = outs.filter((f) => /缺口|提案|撞墙|做不到|capability/i.test(f)).length;
  return {
    outputs: outs.length,
    newestOutput: newestAnything,
    newestAnything,
    wallHits,
    lastSeenOutputs: lastSeenOutputs,
    secondsSinceNew: Math.round((Date.now() - lastActivity) / 1000),
  };
}

// ═══════════════ 运行 ═══════════════

type Log = { t: number; kind: string; detail: string };

async function runArm(sw: Switch) {
  const arm = sw.arm;
  const secs = sw.secs ?? 1800;
  const idleSecs = sw.idleSecs ?? 420;
  const lab = labDir(arm);
  const t0 = Date.now();
  const log: Log[] = [];
  const rec = (kind: string, detail: string) => log.push({ t: Math.round((Date.now() - t0) / 1000), kind, detail });

  mkdirSync(join(lab, "work"), { recursive: true });
  mkdirSync(join(lab, "outbox"), { recursive: true });
  // ★ 实例独立工作区（并发缺陷的修法）
  const inst = `i${process.pid}-${Date.now().toString(36)}`;
  const workDir = join(lab, "work");
  mkdirSync(workDir, { recursive: true });

  const labo = await labAt(workDir);
  const manual = readFileSync(join(lab, "inbox/研究手册.md"), "utf8");

  const agents: { kind: string; a: Awaited<ReturnType<typeof labo.createAgent>>; started: number }[] = [];
  let tokens = 0;

  async function spawn(s: Spawn) {
    const { gate, count } = makeGate(arm);
    const a = await labo.createAgent({
      id: `L3${arm}-${s.kind}-${Date.now()}`,
      model: MODEL,
      role: s.role,
      permissions: { only: s.tools },
    });
    a.permissions.gate(gate);
    agents.push({ kind: s.kind, a, started: Date.now() });
    rec("spawn", `${s.kind}（工具 ${s.tools.length}）`);
    // ★ 不 await 完 —— 让它跑着，主循环继续观察（这是"情况驱动"的关键）
    const p = a.io
      .prompt(`# 你的研究手册\n\n${manual}\n\n---\n\n${s.task}`)
      .then((r) => {
        tokens += r.usage?.totalTokens ?? 0;
        rec("done", `${s.kind} · tok=${(r.usage?.totalTokens ?? 0).toLocaleString()}${r.error ? " ⚠" + r.error : ""}`);
      })
      .catch((e) => rec("fail", `${s.kind} · ${(e as Error).message}`));
    return { a, p, blocked: count };
  }

  // ★ 起根
  const rootTask =
    `以下是你的研究空间：\`${lab}\`。\n` +
    `· 你的研究手册在 \`inbox/研究手册.md\`（★ 先读）\n` +
    `· 你的工作区 \`work/\` · 成果 \`outbox/\` · **可写的库** \`lib/\`\n` +
    `· 仓库其他地方**只读**\n\n` +
    `★ 不要等我指示。现在就开始。`;

  const root = await spawn({
    kind: "researcher",
    role: RESEARCHER_ROLE,
    tools: TOOLS,
    task: rootTask,
  });

  // ★ A 版：其余五个角色**同时**起（固定拓扑）
  if (arm === "a") {
    for (const s of planA(lab)) {
      if (s.kind === "researcher") continue;
      await spawn(s);
    }
  }

  // ═══ 主观察循环：★ 按"情况"驱动，不按轮次 ═══
  let lastOutputs = 0;
  let lastActivity = Date.now();
  let spawned = new Set(["researcher", ...(arm === "a" ? ["inspector", "archivist", "inspirer", "libsmith", "watchdog"] : [])]);
  const deadline = Date.now() + secs * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000)); // 每 15s 看一次状态
    const cur = readState(lab, lastOutputs, lastActivity);

    // ① 情况：写出了**新**成果
    if (cur.outputs > lastOutputs) {
      lastOutputs = cur.outputs;
      lastActivity = Date.now();
      rec("condition", `新成果 ×${cur.outputs}`);
      // ★ A 版已经有 inspector 常驻 → 只是叫它再审；B 版才"长出来"
      if (arm === "a") {
        const insp = agents.find((x) => x.kind === "inspector");
        if (insp) {
          rec("wake", "inspector 复审新成果");
          await insp.a.io.queue(`outbox/ 有新产物（共 ${cur.outputs} 份）。请按你的三个职责审一遍。`).catch(() => {});
        }
      } else {
        await spawn({
          kind: "inspector",
          role: INSPECTOR_ROLE,
          tools: READONLY,
          task:
            `研究员刚写出了成果（\`${lab}/outbox/\` 现有 ${cur.outputs} 份 .md）。\n` +
            `★ 请按你的三个职责审它：① 鼓励 ② 纠正（DEFECT: 行）③ 判停（VERDICT: 行）。\n` +
            `★ 你可以读它的 \`work/\` 和仓库里的任何文件来核实。`,
        });
      }
    }

    // ② 情况：撞到"库做不到"（出现能力缺口/提案类产物）
    if (cur.wallHits > 0 && !spawned.has("libsmith-hit")) {
      spawned.add("libsmith-hit");
      rec("condition", `撞到"库做不到" ×${cur.wallHits}`);
      await spawn({
        kind: "libsmith",
        role: LIBSMITH_ROLE,
        tools: TOOLS,
        task: `研究员报告了底层能力缺口（见 \`${lab}/outbox/\` 里的相关文档 + 它的 \`work/\`）。\n★ 请真的去改 \`lib/\` 里的库，并写 \`lib/PATCHES.md\`。`,
      });
    }

    // ③ 情况：长时无产出
    if (cur.secondsSinceNew > idleSecs) {
      lastActivity = Date.now(); // 复位，避免重复触发
      rec("condition", `${cur.secondsSinceNew}s 无新产物`);
      if (arm === "b") {
        await spawn({
          kind: "watchdog",
          role: WATCHDOG_ROLE,
          tools: READONLY,
          task: `研究员已经 ${cur.secondsSinceNew} 秒没有写出新东西了。\n★ 请判断：它在**真探索**，还是**转圈/卡住**？\n★ 别忘本项目的实测：反复跑测试、读文件是**正常研究方式**（成本在定位不在写）。`,
        });
        await spawn({
          kind: "archivist",
          role: ARCHIVIST_ROLE,
          tools: READONLY,
          task: `研究员已经 ${cur.secondsSinceNew} 秒没有新产出。\n★ 请做一次**阶段性复审**：重读 DESIGN 目标 + 它的全部成果，列出**它可能没想到的新问题**。`,
        });
      }
    }
  }

  // 收尾：等还在跑的
  await Promise.allSettled(agents.map((x) => x.a.io.waitIdle()));
  for (const x of agents) x.a.dispose();

  const res = {
    arm,
    secs: Math.round((Date.now() - t0) / 1000),
    tokens,
    agents: agents.map((x) => x.kind),
    blocked: 0,
    log,
  };
  writeFileSync(join(lab, "work", "_run-log.json"), JSON.stringify(res, null, 2));
  writeFileSync(join(lab, "work", "_run-trace.txt"), log.map((l) => `${String(l.t).padStart(6)}s  ${l.kind.padEnd(9)} ${l.detail}`).join("\n"));
  return res;
}

// ═══════════════ CLI ═══════════════

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("lab-3.ts")) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const which = arg("arm") ?? "both";
  const secs = Number(arg("secs") ?? 1800);
  const arms: Arm[] = which === "both" ? ["a", "b"] : [which as Arm];
  console.log(`★ lab-3 对照：${arms.join(" / ")} · 每臂 ${secs}s 窗口`);
  const results = await Promise.all(arms.map((a) => runArm({ arm: a, secs })));
  for (const r of results) {
    console.log(`\n── lab-3${r.arm}  ${r.secs}s  tok=${r.tokens.toLocaleString()}`);
    console.log(`   起了 ${r.agents.length} 个吗：${r.agents.join(", ")}`);
    for (const l of r.log.filter((x) => x.kind === "condition" || x.kind === "spawn")) {
      console.log(`     ${String(l.t).padStart(5)}s  ${l.kind}  ${l.detail}`);
    }
  }
}
