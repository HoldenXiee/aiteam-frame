// ★★★ 探针：BRIEF 薄度实验（§8.10）
//
// 目的：**定位** —— 研究员集群「不像研究员」到底是哪个部件造成的？
//   【纪律】不重搭整体。一次只动 BRIEF 的信息量，其余全同。
//
// 四臂（同一 role、同一权限、同一工具、同一模型；**只差给它多少**）：
//   P1-bare      ①你是研究员 ②仓库路径 ③DESIGN 目标一句
//   P2-env       bare + 库 API 一页 + 「成果在哪」的路径
//   P3-envgoal   env + DESIGN 目标段落逐字
//   P4-full      初版 BRIEF（对照组，已证：把它降成执行器）
//
// ★ 每臂独立目录 + 独立 git 仓库（可回退、可重跑）
// ★ 每臂同一超时；到点就掐 —— 本轮**只问"它第一件事做什么"**，不要求跑完研究
//
// 用法：
//   npx tsx research/demox/bench/probe-brief.ts --secs=600          # 四臂并行
//   npx tsx research/demox/bench/probe-brief.ts --only=P1-bare      # 只跑一臂
//   npx tsx research/demox/bench/probe-brief.ts --keep              # 不覆盖已存在的臂目录

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { labAt, MODEL } from "../env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const ROOT = join(REPO, process.env.PROBE_ROOT ?? "research/demox/lab-brief");

// ★ 四臂 —— 只有 brief 不同
const COMMON = {
  // ★ role 四臂**逐字相同** —— 别把变量混进 role
  role:
    "你是这个仓库里的**研究员**。你的工作区是 `research/demox/lab-brief/<臂名>/`，成果写进它的 `outbox/`。\n" +
    "★ 你可以读仓库里任何文件，但**不能写** `src/` `dev/` `research/demox/bench/` `research/demox/成果/`。",
  tools: ["bash", "read", "write", "edit", "grep", "find", "ls"],
} as const;

/** ① bare：只给身份 + 路径 + 目标一句 */
const BARE = `# 你是研究员

你在 \`D:/space/aiteam/test\` 这个仓库里做研究。

## 目标

\`dev/docs/DESIGN.md\` 是设计源。它说的主要方向是：

> 研究一种生产的新范式，通过代码这种极具有逻辑的方式来使用大语言模型，
> **有效且高质量地使用这成本几乎为零的智力**。要实验出一些经验、一些优质的做法。

★ **这就是你要研究的东西：DESIGN 的目标本身。**
`;

/** ② env：bare + 库在哪 / 成果在哪（路径），但**不给**目标逐字 */
const ENV = BARE + `
## 环境和历史（★ 路径给你，读什么、读多少你自己定）

| 在哪 | 是什么 |
|---|---|
| \`src/\` | ★ **agent 操控库**（唯一入口 \`src/index.ts\`）—— 你用它搭实验 |
| \`dev/docs/\` | \`DESIGN.md\`（设计源）· \`DESIGN-解读.md\` · \`FACTS.md\` · \`GUIDE.md\` |
| \`dev/examples/\` | 库的用法示例 |
| \`research/demox/\` | ★ **这个研究方向的历史** —— \`成果/\`（已有成果清单）、\`进度总表.md\`、\`研究规划.md\`、\`bench/\`（历次实验装置）、\`runs/\`（历史数据） |

★ 库里那个「观测面」\`agent.observe\` 是专门为研究造的：它能给你每一轮**真正发给模型的 messages**、每轮 token、干预生效计数。
`;

/** ③ env+goal：env + DESIGN 目标段落逐字（把 §「优质做法」的展开也给） */
const ENVGOAL = ENV + `
## 目标（DESIGN 逐字展开）

> 「优质做法」可以当作**一门学科**去研究 ——
> 具体类型该怎么设计、遇到什么问题是因为它的什么特性、因为有什么特性所以可以怎么利用、
> 遇到什么类型情况可以怎么分析、分析后又要怎么思考去优化。

以及 DESIGN 末段：

> 关于「成本几乎为零的智力」里，**人的位置**是什么：人是以新的工具去"劳动"……
> 我们这个项目就是去研究这个问题，**让人更好地利用这个工具**。
`;

// ★★★ 修缺陷一（P4 臂自己抓到的）：**自变量必须是单变量**。
//   P4-full 含大量**行为指令**（七面表/权限表/四段格式/收敛格式/"现在就开始"），
//   P1–P3 一条都没有 → 它测的是「资料 vs 指令」，不是「多少」。
//   ⇒ 拆成**两个正交轴**，各自单独比：
//      轴 A「资料量」  A1-bare < A2-env < A3-envgoal < A4-env+history   （全是资料，零指令）
//      轴 B「指令量」  B0-无指令 / B1-成果格式一句 / B2-full            （资料同，只加指令）
const A4 = ENVGOAL + `
## 已有成果目录（★ 路径，读什么你自己定）

- \`research/demox/成果/00-成果清单.md\` —— 已有 27 条成果
- \`research/demox/研究规划.md\` —— 本性表 B1–B8 · 纪律 · §0.11 两层结构
- \`research/demox/未解决问题清单.md\` —— 已知未解问题 A/B/C/D 四类
- \`research/demox/进度总表.md\` —— 430+ 轮实验索引
- \`research/demox/bench/\` —— 历次实验装置 · \`research/demox/runs/\` —— 历史数据
`;

// ★ 轴 B：资料用 A3 固定，只加指令
const FULL_TXT = readFileSync(join(REPO, "research/demox/lab-1/inbox/BRIEF-v0-full.md"), "utf8");
const DIRECTIVES = FULL_TXT.slice(FULL_TXT.indexOf("## 成果怎么写"));
const B1 = ENVGOAL + `
## 成果怎么写

` + DIRECTIVES;
const B2 = ENVGOAL + `
# 追加任务书（★ 指令）

` + FULL_TXT;

const ARMS = [
  // 轴 A：资料量（零行为指令）
  { name: "A1-bare", brief: BARE, axis: "A 资料量" },
  { name: "A2-env", brief: ENV, axis: "A 资料量" },
  { name: "A3-envgoal", brief: ENVGOAL, axis: "A 资料量" },
  { name: "A4-envhist", brief: A4, axis: "A 资料量" },
  // 轴 B：指令量（资料固定 = A3）
  { name: "B1-fmt", brief: B1, axis: "B 指令量" },
  { name: "B2-full", brief: B2, axis: "B 指令量" },
] as const;

/** 建臂目录 + 独立 git（可回退） */
function setupArm(name: string, brief: string, keep: boolean) {
  const d = join(ROOT, name);
  if (existsSync(d) && keep) return { dir: d, fresh: false };
  // ★ 修缺陷四：重跑必须清场（outbox/work 残留 = 跨轮污染）
  //   保留 .git 以便回退：只删内容，不删仓库。
  if (existsSync(d)) {
    for (const sub of ["outbox", "work", "inbox"]) {
      rmSync(join(d, sub), { recursive: true, force: true });
    }
  }
  mkdirSync(join(d, "inbox"), { recursive: true });
  mkdirSync(join(d, "outbox"), { recursive: true });
  mkdirSync(join(d, "work"), { recursive: true });
  writeFileSync(join(d, "inbox", "BRIEF.md"), brief);
  if (!existsSync(join(d, ".git"))) {
    const g = (...a: string[]) =>
      execFileSync("git", ["-C", d, ...a], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@lab`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@lab` } });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", "arm setup");
  }
  return { dir: d, fresh: true };
}

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const secs = Number(arg("secs") ?? 600);
const only = arg("only");
const keep = process.argv.includes("--keep");

const arms = only ? ARMS.filter((a) => a.name === only) : ARMS;
if (!arms.length) throw new Error(`没有这个臂：${only}`);

console.log(`★ BRIEF 薄度探针：${arms.length} 臂并行，每臂 ${secs}s 上限`);
for (const a of arms) console.log(`   ${a.name}  BRIEF ${a.brief.split("\n").length} 行 / ${a.brief.length} 字`);
console.log();

/** ★ 每臂：起 agent → 给它 BRIEF → 看它**第一件事做什么** */
async function runArm(arm: (typeof ARMS)[number]) {
  const t0 = Date.now();
  const { dir, fresh } = setupArm(arm.name, arm.brief, keep);
  const trace: { t: number; kind: string; detail: string }[] = [];
  let text = "";
  let tokens = 0;
  let error = "";

  const lab = await labAt(join(dir, "work"));
  const agent = await lab.createAgent({
    id: `PROBE-${arm.name}-${Date.now()}`,
    model: MODEL,
    role: COMMON.role.replace("<臂名>", arm.name),
    permissions: { only: [...COMMON.tools] },
  });

  // ★ 拦越权写 —— 四臂同一条规则（用代码，不用提示）
  let blocked = 0;
  agent.permissions.gate(async (call) => {
    const inp = (call.input ?? {}) as Record<string, unknown>;
    if (call.name === "bash") {
      const cmd = String(inp.command ?? "");
      const writes = /(>|>>|\btee\b|\bsed\s+-i|\brm\s|\bmv\s|\bcp\s|\btouch\b|\bmkdir\b)/.test(cmd);
      const prot = /(^|[\s"'])src\/|(^|[\s"'])dev\/|(^|[\s"'])research\/demox\/bench\/|(^|[\s"'])research\/demox\/成果\//.test(cmd);
      if (writes && prot) {
        blocked++;
        return { block: true as const, reason: "受保护路径只读。要改就复制到你的 work/ 里。" };
      }
    }
    if (call.name === "write" || call.name === "edit") {
      const p = String(inp.path ?? "").replace(/\\/g, "/");
      if (/\/src\/|\/dev\/|research\/demox\/bench\/|research\/demox\/成果\//.test(p)) {
        blocked++;
        return { block: true as const, reason: "受保护路径只读。要改就复制到你的 work/ 里。" };
      }
    }
    return undefined;
  });

  // ★ 记录工具调用序列 —— 探针的核心读数
  agent.onAny((e: any) => {
    const el = Date.now() - t0;
    // ★ 修缺陷二：pi 一条工具调用发**两个**事件（tool_call + tool_execution_start）
    //   只记一个，否则 toolCalls 翻倍。取 tool_execution_start（带完整 input）。
    if (e?.type === "tool_execution_start") {
      const n = e.name ?? e.toolName ?? "?";
      const i = e.input ?? {};
      // ★ 修缺陷二：优先取真实字段；取不到就标注（别让 {} 冒充读数）
      const d = String(i.path ?? i.command ?? i.pattern ?? i.query ?? i.url ?? "(no known field) " + JSON.stringify(i)).slice(0, 120);
      trace.push({ t: el, kind: `tool:${n}`, detail: d });
    }
  });

  const prompt =
    `# 你的任务书\n\n${arm.brief}\n\n` +
    `---\n\n★ 不要等我指示。现在就开始。`;

  // ★ 超时掐断：探针只要"第一件事"，不要它跑完
  const timer = setTimeout(() => {
    agent.io.abort().catch(() => {});
  }, secs * 1000);

  try {
    const res = await agent.io.prompt(prompt);
    if (res.error) error = res.error;
    else text = res.text ?? "";
    tokens = res.usage?.totalTokens ?? 0;
  } catch (e) {
    error = (e as Error).message;
  }
  clearTimeout(timer);
  await agent.dispose();

  // ★ 修缺陷三：截断混杂。区分"没做完"与"做不到"，并给出**归一化速率**。
  //   输入长的臂 prefill 更久 → 更容易被掐 → 捕获更少。必须让读数可比。
  const truncated = /abort/i.test(error);
  const out = {
    arm: arm.name,
    axis: (arm as any).axis ?? "?",
    truncated,
    toolCallsPerMin: +(trace.filter((x) => x.kind.startsWith("tool:")).length / Math.max(1, (Date.now() - t0) / 60000)).toFixed(1),
    tokensPerMin: Math.round(tokens / Math.max(1, (Date.now() - t0) / 60000)),
    briefLines: arm.brief.split("\n").length,
    briefChars: arm.brief.length,
    secs: Math.round((Date.now() - t0) / 1000),
    tokens,
    blocked,
    error,
    toolCalls: trace.filter((x) => x.kind.startsWith("tool:")).length,
    trace,
    text,
  };
  writeFileSync(join(dir, "work", "probe-result.json"), JSON.stringify(out, null, 2));
  writeFileSync(join(dir, "work", "probe-trace.txt"), trace.map((x) => `${String(x.t).padStart(6)}ms  ${x.kind}  ${x.detail}`).join("\n"));
  return out;
}

// ★ 四臂并行
const results = await Promise.all(arms.map((a) => runArm(a).catch((e) => ({ arm: a.name, error: String(e), trace: [], text: "", tokens: 0, blocked: 0, secs: 0, toolCalls: 0 }))));

console.log(`\n${"=".repeat(70)}\n★ 读数\n${"=".repeat(70)}\n`);
for (const r of results as any[]) {
  console.log(`── ${r.arm}  (BRIEF ${r.briefLines} 行/${r.briefChars} 字)`);
  console.log(`   ${r.secs}s · tok=${(r.tokens ?? 0).toLocaleString()} · 工具调用 ${r.toolCalls ?? 0} 次 · 被拦 ${r.blocked ?? 0}`);
  if (r.error) console.log(`   ⚠ ${r.error}`);
  console.log(`   ★ 它第一件事做的：`);
  for (const x of (r.trace ?? []).slice(0, 6)) console.log(`      ${String(x.t).padStart(6)}ms  ${x.kind}  ${x.detail}`);
  if ((r.trace ?? []).length > 6) console.log(`      … 还有 ${r.trace.length - 6} 次`);
  const head = (r.text ?? "").replace(/\s+/g, " ").slice(0, 260);
  console.log(`   ★ 它对你说的话（开头）：${head || "（空）"}`);
  console.log();
}
