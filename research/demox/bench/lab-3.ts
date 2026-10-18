// ★★★ 研究员集群 · 触发拓扑（重设计版）
//
// ★★★ 根本约束（设计者裁定）：
//   **运行时不能干涉。要干涉只能重设计集群。**
//   ✗ 不许有"我在外面盯状态 / 我判断 / 我起 agent"的循环
//   ✓ 触发必须是**集群自身结构的一部分** —— 挂在 agent 上的事件规则
//
// ★★★ 两类触发，各管一半（设计者裁定：有些情况代码触发远优于 agent 触发）
//
//   【代码触发】★ 它躲不掉，用于：
//     · 审查        —— 若它自己触发，它可以不触发（P13），甚至只在自己觉得没事时触发
//     · 重审目标    —— B6：它沉浸在局部，看不见"该重审了"这件事
//     · 创新/换视角 —— P22：它默认顺着当前的路走，"该换个角度"不是它能自知的
//     · 判停        —— C7：疲劳与沉没成本在它身上，它判不了自己
//     实现：`agent.on("agent_settled")` 等事件 → 规则表 → 起专家 agent（干净上下文）
//
//   【agent 触发】★ 它自己拉，用于：
//     · 问专家      —— 它知道自己卡在哪，代码只能猜
//     · 派支线探索  —— 它掌握上下文与判断
//     实现：自定义工具 `consult` / `spawn_line`
//     ★★ 传的是「角色 + 处境 + 地盘」，**不是一句话**（问一句话达不到干净上下文的效果）
//
// 用法：
//   npx tsx research/demox/bench/lab-3.ts --secs=1800
//   npx tsx research/demox/bench/lab-3.ts --secs=600 --dry    # 只搭装置不投递（自检）

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, statSync } from "node:fs";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { labAt, MODEL } from "../env.ts";
import type { ToolGate } from "../../../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const LAB = join(REPO, "research/demox/lab-3b");

const ALL = ["bash", "read", "write", "edit", "grep", "find", "ls"];
const READONLY = ["bash", "read", "grep", "find", "ls"];

// ═══════════════════════ 基础设施 ═══════════════════════

function log(kind: string, detail: string) {
  const line = `${new Date().toISOString()}  ${kind.padEnd(11)} ${detail}\n`;
  mkdirSync(join(LAB, "work"), { recursive: true });
  appendFileSync(join(LAB, "work", "_topology.log"), line);
  process.stdout.write(`  ${kind.padEnd(11)} ${detail}\n`);
}

/** 判断一次调用是不是"写本文件夹之外的地方" */
function outsideWrite(name: string, input: Record<string, unknown>): string | null {
  const root = LAB.replace(/\\/g, "/");
  const norm = (s: string) => s.replace(/\\/g, "/");
  const inside = (p: string) => norm(p).startsWith(root);

  if (name === "write" || name === "edit") {
    const p = String(input.path ?? "");
    return inside(p) ? null : p;
  }
  if (name === "bash") {
    const cmd = String(input.command ?? "");
    // ★ 白名单只读重定向（血教训：2>/dev/null 曾被误判成写）
    const stripped = cmd.replace(/2\s*>\s*\/dev\/null/g, "").replace(/2\s*>&\s*1/g, "");
    const writes = /(^|[^0-9])>(?!>)|>>|\btee\b|\bsed\s+-i|\brm\s|\bmv\s|\bcp\s|\btouch\b|\bmkdir\b/.test(stripped);
    if (!writes) return null;
    if (norm(cmd).includes(root)) return null;              // 命令行里出现本文件夹 → 放行
    const m = stripped.match(/(?:>|>>|\btee\b\s+|\brm\s+|\bmv\s+|\bcp\s+|touch\s+|mkdir\s+)\s*"?([^\s"';|]+)/);
    if (m) {
      const t = norm(m[1]!);
      if (!/^[a-zA-Z]:\//.test(t) && !t.startsWith("/")) return null;  // 相对路径 = 它的 work/
      return inside(t) ? null : t;
    }
    return "(bash 写操作，目标不明)";
  }
  return null;
}

/** ★★★ 按 P12：拦住时必须给"路"（只拦不给路，它撞墙 26 次、0 成功） */
const BLOCK_REASON =
  "这个路径只读（仓库主体不归你改）。★ 但**路是有的**：\n" +
  "· 想改库 → `lib/aiteam/` 和 `lib/pi/` 里各有一份**你可以随便改**的拷贝，" +
  "改完在 `lib/PATCHES.md` 记「改了什么 / 带来什么好处」\n" +
  "· 想改实验装置 → 复制到你的 `work/` 里改\n" +
  "· 想要仓库里别的东西变 → 写进 `outbox/`，研究助手去做\n" +
  "★ 不要反复试这条路，它不会通。";

function attachGate(agent: { permissions: { gate: (fn: ToolGate) => void } }) {
  const g: ToolGate = async (call) => {
    const inp = (call.input ?? {}) as Record<string, unknown>;
    const bad = outsideWrite(call.name, inp);
    return bad ? { block: true as const, reason: BLOCK_REASON } : undefined;
  };
  agent.permissions.gate(g);
}

// ═══════════════════════ 专家名册（代码里的表 —— 不走模型的"选择"）═══════════════════════

const EXPERTS = {
  inspector: {
    tools: READONLY,
    brief: (why: string, focus: string) =>
      `你是这个研究员集群的**审查者与鼓励者**。★ 你看的是产物本身，不是它的推导过程。\n\n` +
      `## 为什么叫你来\n${why}\n\n` +
      `## 你的地盘\n` +
      `· 产物在 \`${LAB}/outbox/\` · 它的探索痕迹在 \`${LAB}/work/\`\n` +
      `· 研究手册在 \`${LAB}/inbox/研究手册.md\` · 设计源在 \`${REPO}/dev/docs/DESIGN.md\`\n` +
      `★ **自己去读、去核实** —— 不要只凭别人转述。${focus}\n\n` +
      `## 你要做的三件事\n` +
      `① ★★ **鼓励**：明确说出它做对了什么、哪里在朝目标走、哪里有创新苗头。**不要省这一节。**\n` +
      `② ★ **纠正**：每条以 \`DEFECT: \` 开头，一行一条。只纠这四类：\n` +
      `   · 偏离 DESIGN 目标    · 分析形式上有错（超证据 / 没对照 / 替代解释没排除）\n` +
      `   · 装置（量具）缺陷 —— 你量的是不是你想量的？   · 假探索（转圈、重复、不做实验）\n` +
      `★★ 不要因为「没有重大成果」而批评它 —— 探索本身就是产出。\n` +
      `③ ★★ 若被要求判停：最后一行必须是 \`VERDICT: STOP\` 或 \`VERDICT: CONTINUE\`。`,
  },
  archivist: {
    tools: READONLY,
    brief: (why: string, focus: string) =>
      `你是这个研究员集群的**复审者**。★ 你的活不是做新实验，是**用探索后的眼界重看目标**。\n\n` +
      `## 为什么叫你来\n${why}\n\n` +
      `## 你的地盘\n` +
      `· 它的全部产物 \`${LAB}/outbox/\` · 探索痕迹 \`${LAB}/work/\`\n` +
      `· ★ 仓库里已有成果 \`${REPO}/research/demox/成果/\`（清单 + 各条）\n` +
      `· ★ 设计源 \`${REPO}/dev/docs/DESIGN.md\`\n${focus}\n\n` +
      `## 你要做的\n` +
      `★ 重读 DESIGN 的目标，然后问：**还能不能生出它没做过的新问题？**\n` +
      `· 逐条列出候选新问题，每条说明**为什么现在值得做**\n` +
      `★★ 它沉浸在局部，上下文装不下全局 —— 你补这一块。`,
  },
  inspirer: {
    tools: READONLY,
    brief: (why: string, focus: string) =>
      `你是这个研究员集群的**跨学科启发者**。\n\n` +
      `## 为什么叫你来\n${why}\n\n` +
      `## 你的地盘\n` +
      `· 它当前在做的东西 \`${LAB}/work/\` · 产物 \`${LAB}/outbox/\`\n` +
      `· 研究方向的历史 \`${REPO}/research/demox/\`（尤其 \`G0/G1/G3\` 那几组）${focus}\n\n` +
      `## 你要做的\n` +
      `★★ 从**其他学科**找能借的框架 —— 尤其**系统科学**（序参量 / 相变 / 级联 / 反馈延迟）\n` +
      `和**信息论**（信道容量 / 压缩 / 给定值信道）。\n` +
      `· 逐条给出：借什么概念 / 它对应这里的什么现象 / **能怎么用它设计一个实验**\n` +
      `★★ 只给**能落成实验**的借用，不给泛泛的类比。`,
  },
  libsmith: {
    tools: ALL,
    brief: (why: string, focus: string) =>
      `你是这个研究员集群的**改库者**。\n\n` +
      `## 为什么叫你来\n${why}\n\n` +
      `## 你的地盘\n` +
      `· ★ **可写的库**：\`${LAB}/lib/aiteam/\`（agent 操控库）和 \`${LAB}/lib/pi/\`（pi sdk 源码）\n` +
      `· 它的报告与撞墙痕迹：\`${LAB}/outbox/\`、\`${LAB}/work/\`\n${focus}\n\n` +
      `## 你要做的\n` +
      `· 先搞清它到底缺什么（读它的代码/笔记，必要时 **dump 真实形状 —— 别猜**）\n` +
      `· ★ 真的去改 \`lib/\` 里的库\n` +
      `· ★ 改完写 \`${LAB}/lib/PATCHES.md\`：**改了什么 / 带来什么好处**\n` +
      `★★ 如果发现「其实不用改库，换个用法就行」，那也是好结论 —— 写下来。`,
  },
  watchdog: {
    tools: READONLY,
    brief: (why: string, focus: string) =>
      `你是这个研究员集群的**看门狗**。\n\n` +
      `## 为什么叫你来\n${why}\n\n` +
      `## 你的地盘\n` +
      `· \`${LAB}/work/\`（最新文件时间、它的脚本、JOURNAL）· \`${LAB}/outbox/\`${focus}\n\n` +
      `## 你要判断的\n` +
      `★ 它在**真探索**，还是在**转圈 / 卡住**？\n` +
      `★★ 关键：本项目的实测说**成本在「定位」不在「写」** ——\n` +
      `   反复跑测试、读文件是**正常的研究方式**，不是卡住。\n` +
      `· 真该报警的是：同一个文件反复读、同一条命令反复跑、写出来的东西没有新内容\n` +
      `★ 输出：① 它在干什么（事实）② 判断 ③ 如果是转圈，建议怎么破`,
  },
} as const;

type ExpertName = keyof typeof EXPERTS;

// ═══════════════════════ ★★★ 代码触发：事件 → 规则表 ═══════════════════════
//
// ★★ 没有 while、没有 sleep、没有"我在外面看" —— 事件来了，规则跑。

type TriggerCtx = {
  lab: Awaited<ReturnType<typeof labAt>>;
  /** 起一个专家，等它出结论，然后**把结论投回研究员** */
  fire: (role: ExpertName, why: string, focus?: string, opts?: { await_?: boolean }) => Promise<string>;
  state: { outputs: number; lastAuditOutputs: number; roundsSinceNew: number; firedAt: Record<string, number>; verdict?: string };
};

function makeTrigger(ctx: TriggerCtx) {
  return {
    /** 情况 A：一轮结算了 —— 看有没有新产物 */
    async onSettled() {
      const outs = listOutbox();
      if (outs.length > ctx.state.lastAuditOutputs) {
        ctx.state.lastAuditOutputs = outs.length;
        const conv = outs.some((f) => /CONVERGED/i.test(f));
        const why = conv
          ? `研究员写了收敛声明（\`outbox/CONVERGED.md\`），且 outbox 现有 ${outs.length} 份成果。`
          : `研究员刚产出新东西（outbox 现有 ${outs.length} 份）。`;
        const focus = conv
          ? `\n★★ **它宣布收敛了** —— 请额外判停：\n` +
            `  a. 它说的"够了"是真探索完了，还是想收工 / 累了 / 卡住了？\n` +
            `  b. 它列的"没排除的替代解释"，真的排除了吗？\n` +
            `  c. ★ **你自己去读 DESIGN + 它的全部成果**，能不能生出一个它没提过的新问题？能 → 写一条 DEFECT 并判 CONTINUE。\n`
          : "";
        const out = await ctx.fire("inspector", why, focus);
        // ★★★ 审查意见**回流**（修复旧版的断链：上次只记了 token，把正文丢了）
        const v = out.match(/VERDICT:\s*(STOP|CONTINUE)/i);
        if (v) {
          ctx.state.verdict = v[1]!.toUpperCase();
          log("verdict", `${ctx.state.verdict}（研究员自己声明了收敛）`);
        }
        if (conv && ctx.state.verdict === "STOP") return;
      }
    },

    /** 情况 B：它写了"能力缺口"类产物 → 起改库者 */
    async onCapabilityGap() {
      const outs = listOutbox();
      const gaps = outs.filter((f) => /缺口|提案|撞墙|做不到|capability/i.test(f));
      if (!gaps.length) return;
      await ctx.fire(
        "libsmith",
        `研究员报告了底层能力缺口：${gaps.map((g) => `\`outbox/${g}\``).join("、")}`,
        "",
      );
    },

    /** 情况 C：连续 M 轮没有新东西 → 换视角 */
    async onPlateau() {
      if (ctx.state.roundsSinceNew < 3) return;
      if (Date.now() - (ctx.state.firedAt["inspirer"] ?? 0) < 20 * 60_000) return; // 别刷屏
      ctx.state.firedAt["inspirer"] = Date.now();
      await ctx.fire(
        "inspirer",
        `研究员已经连续 ${ctx.state.roundsSinceNew} 轮没有产出新东西了。` +
          `★ 可能是它陷在某条路里 —— 请给它一个**别的学科**能借的框架。`,
      );
      await ctx.fire(
        "archivist",
        `研究员连续 ${ctx.state.roundsSinceNew} 轮没有新产出。★ 请做一次**阶段性复审**。`,
      );
      ctx.state.roundsSinceNew = 0;
    },
  };
}

function listOutbox(): string[] {
  const d = join(LAB, "outbox");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : [];
}

// ═══════════════════════ 主流程 ═══════════════════════

export async function runCluster(secs: number, dry = false) {
  mkdirSync(join(LAB, "outbox"), { recursive: true });
  mkdirSync(join(LAB, "work"), { recursive: true });
  writeFileSync(join(LAB, "work", "_topology.log"), "");   // 每轮清空日志
  const t0 = Date.now();

  const lab = await labAt(join(LAB, "work"));
  const manual = readFileSync(join(LAB, "inbox/研究手册.md"), "utf8");

  // ── 专家：起一个 agent，跑它的地盘，返回它的结论 ──
  const experts: { role: ExpertName; agent: Awaited<ReturnType<typeof lab.createAgent>> }[] = [];
  const fire = async (role: ExpertName, why: string, focus = "", opts: { await_?: boolean } = {}) => {
    const spec = EXPERTS[role];
    const a = await lab.createAgent({
      id: `L3-${role}-${Date.now().toString(36)}`,
      model: MODEL,
      role: spec.brief(why, focus),
      permissions: { only: [...spec.tools] },     // ★ 只读专家还是只读
    });
    attachGate(a);
    experts.push({ role, agent: a });
    log("fire", `${role} ← ${why.slice(0, 60)}`);
    const res = await a.io.prompt(
      `★ 你的处境已写在上面（你的角色描述里）。自己动手：读你地盘里的东西，然后给出结论。\n` +
      `★ 不要问我问题 —— 你可以读的一切都在上面写了路径。`,
    );
    const text = res.text ?? "";
    log("result", `${role} · ${text.length} 字${res.error ? " ⚠" + res.error : ""}`);
    // ★★★ 回流：结论写进 outbox/_audits/ 并投回研究员
    const ad = join(LAB, "outbox", "_audits");
    mkdirSync(ad, { recursive: true });
    writeFileSync(join(ad, `${String(expertSeq++).padStart(2, "0")}-${role}.md`), `# ${role}\n\n为什么叫它来：${why}\n\n${text}\n`);
    return text;
  };
  let expertSeq = 1;

  // ── ★★★ researcher 的自定义工具（agent 触发：求助）──
  //
  // ★★ 传的是「角色 + 处境 + 地盘」，**不是一句话** —— 它自己写为什么、要专家看什么。
  const consult = defineTool({
    name: "consult",
    label: "Consult",
    description:
      "请一位专家来帮你。★ 它的上下文是干净的（看不到你的推导过程），它会**自己去读**你指定的地盘。" +
      "你要写清：为什么叫它来、要它看什么。",
    parameters: Type.Object({
      role: Type.Union([Type.Literal("inspector"), Type.Literal("archivist"), Type.Literal("inspirer"), Type.Literal("watchdog")]),
      why: Type.String({ description: "为什么叫它来 —— 你的处境、你卡在哪、你想知道什么" }),
      focus: Type.Optional(Type.String({ description: "要它特别看什么（路径 / 具体问题）" })),
    }),
    execute: async (_id, p) => {
      const text = await fire(p.role as ExpertName, `[研究员主动求助] ${p.why}`, p.focus ?? "");
      return { content: [{ type: "text" as const, text }], details: {} };
      // ★★ execute 的返回值**自动进它的上下文** —— 这就是回流
    },
  });

  const spawnLine = defineTool({
    name: "spawn_line",
    label: "SpawnLine",
    description:
      "派一条**探索支线**：起一个子研究员去试一条路，只把结论带回来。★ 子 agent 不继承你的上下文 —— 你要把够它独立开工的信息写进 task。",
    parameters: Type.Object({
      task: Type.String({ description: "这条支线要干什么（自包含：背景 + 要什么结论）" }),
      read: Type.Optional(Type.Array(Type.String(), { description: "允许它读的路径" })),
    }),
    execute: async (_id, p) => {
      const child = await lab.createAgent({
        id: `L3-line-${Date.now().toString(36)}`,
        model: MODEL,
        role:
          "你是一条**探索支线**上的子研究员。★ 你只看到这条任务，没有别上下文。\n" +
          "★ 把活干完，把**结论**交回来（不是过程）。有证据就带证据 id。",
        permissions: { only: READONLY },
      });
      attachGate(child);
      log("spawn_line", p.task.slice(0, 70));
      const res = await child.io.prompt(
        `${p.task}\n\n★ 你可以读：${(p.read ?? [REPO]).join(", ")}`,
      );
      child.dispose();
      const text = res.text ?? "(空)";
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  // ── researcher（唯一的常驻）──
  const researcher = await lab.createAgent({
    id: `L3-researcher-${Date.now().toString(36)}`,
    model: MODEL,
    role:
      "你是这个仓库里的**研究员**。你研究的对象见 `inbox/研究手册.md` —— ★ **先读它**。\n" +
      "★★ 你的价值就在于研究本身：无论是否有重大成果。**沉浸在研究里。**\n" +
      "★ 不是执行任务 —— 是你自己去搞清楚那件事。",
    permissions: { only: ALL },
    tools: { custom: [consult, spawnLine] },
  });
  attachGate(researcher);

  const state: TriggerCtx["state"] = { outputs: 0, lastAuditOutputs: 0, roundsSinceNew: 0, firedAt: {} };
  const trig = makeTrigger({ lab, fire, state });

  // ═══ ★★★ 事件规则（集群的骨架，配置时挂好 —— 之后不再动它）═══
  //
  // ★ 这是"集群自身的结构"，不是"我在外面干涉"。

  researcher.on("agent_settled", () => {
    // ★ 注意：事件回调里不能 await（回调是同步语义），所以 fire-and-forget + 自己记日志
    void (async () => {
      try {
        const before = listOutbox().length;
        if (before > state.outputs) {
          state.outputs = before;
          state.roundsSinceNew = 0;
        } else {
          state.roundsSinceNew++;
        }
        await trig.onSettled();
        await trig.onCapabilityGap();
        await trig.onPlateau();
      } catch (e) {
        log("error", `规则跑挂了：${(e as Error).message}`);
      }
    })();
  });

  log("setup", `装置就绪 · 窗口 ${secs}s · 专家 5 个（按需起）· researcher 1 个（常驻）`);
  log("setup", `researcher 的自定义工具：consult / spawn_line`);

  if (dry) {
    log("dry", "只搭装置，不投递");
    researcher.dispose();
    return { dry: true };
  }

  // ── 开工：投一次就够 —— 之后由事件驱动 ──
  const kick =
    `以下是你的研究空间：\`${LAB}\`。\n` +
    `· 你的研究手册在 \`inbox/研究手册.md\`（★ 先读）\n` +
    `· 你的工作区 \`work/\` · 成果 \`outbox/\` · **可写的库** \`lib/\`\n` +
    `· 仓库其他地方**只读**\n` +
    `· ★ 你有两个工具：\`consult\`（请专家）· \`spawn_line\`（派探索支线）\n\n` +
    `★ 不要等我指示。现在就开始。`;

  const run = researcher.io.prompt(kick).catch((e) => ({ error: (e as Error).message, text: "" }));

  // ★ 只等窗口 —— 不做任何"看状态/判断/起 agent"的事（那都在事件规则里）
  await new Promise((r) => setTimeout(r, secs * 1000));
  log("window", `窗口到点（${Math.round((Date.now() - t0) / 1000)}s）`);

  // 收尾：让在跑的收干净（这不叫干涉，叫关灯）
  await Promise.allSettled([run, ...experts.map((e) => e.agent.io.waitIdle().catch(() => {}))]);
  const totalTokens = 0;
  researcher.dispose();
  for (const e of experts) e.agent.dispose();

  const outs = listOutbox();
  console.log(`\n★ 收尾：outbox ${outs.length} 份 · 专家起过 ${experts.length} 次 · 判停 ${state.verdict ?? "（无）"}`);
  console.log(`★ 日志：${join(LAB, "work", "_topology.log")}`);
  return { outputs: outs.length, experts: experts.length, verdict: state.verdict, tokens: totalTokens };
}

// ═══════════════════════ CLI ═══════════════════════

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("lab-3.ts")) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const secs = Number(arg("secs") ?? 1800);
  const dry = process.argv.includes("--dry");
  console.log(`★ 研究员集群（触发拓扑版）· 窗口 ${secs}s${dry ? " · 自检" : ""}`);
  await runCluster(secs, dry);
}
