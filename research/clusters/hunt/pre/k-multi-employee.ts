// ══════════════════════════════════════════════════════════════════
// 预实验 K —— **同一身份多员工**（真模型 · 小规模 · pilot）
//
// ★ 判据跑前冻结在 `research/docs/实验/PREREG-预实验K-同身份多员工.md`
//   本文件只负责「跑 + 记账」，**不改判据**。
//
// ★★★ 设计者交办的问题：
//     现在  身份（researcher）= 员工（the researcher）      ← 一个身份 ↔ 一个活人
//     要问  身份可以支持多个员工，细节不同 ⇒ 不同角度
//
// ★★ 而且在问「要不要多员工」之前，先得问「多了之后怎么合并」——
//    因为集群自己实测过（P46）：**K 次冗余买质量，但并集会被霰弹成员毒化**。
//
// ★ 类型：**预实验**。只求方向，不求显著。样本小是设计，不是缺陷。
//
// ══════════════════════════════════════════════════════════════════
// ★★★★ 安全约束（2026-10-19 事故后加，**这是血的教训**）
//
//   ★ 事故：微实验 E 的 `reset()` 删了 `work/` 里的文件 —— 而那时真集群正在长跑，
//     两者共用同一个空间 ⇒ **微实验把研究员的真实工作删了**（靠 git 才恢复）。
//   ★★★ 根因：微实验本来就不应该碰真集群的空间。
//   ⇒ 本实验：**每个臂自己开一个目录**（`pre/_sandbox/`），
//     `assertSandbox()` 安全阀——任何要删的路径**必须**含 `_sandbox`。
// ══════════════════════════════════════════════════════════════════

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// ★★ lib 与 crossTask **都在集群空间里**（`research/labfirst/lab-3b/`）——
//   · lib/aiteam：研究员可写的那份库（★ 它改过，本实验就用它改过的那份）
//   · work/crossTask.ts：研究员自己写的任务生成器 + 判据（判据不是我现编的）
import { createLab } from "../../../labfirst/hunt/lib/aiteam/index.ts";
import { buildCrossTask, parseFindings } from "../../../labfirst/hunt/work/crossTask.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX = join(HERE, "_sandbox");
const RUNS = join(HERE, "runs");
// ★★ 只读的凭证目录（材料区）。★ 红线：整台机器只允许下面这一个型号。
const AGENT_DIR = "D:/space/aiteam/test/research/docs/装置/agent";
const MODEL = "opencode-go/deepseek-v4.1-flash";

/** ★★★ 安全阀：只允许动 `_sandbox` 里的东西 */
export function assertSandbox(p: string): void {
  if (!p.replace(/\\/g, "/").includes("_sandbox")) {
    throw new Error(`★ 拒绝操作 ${p}\n  凡"会删除/覆盖"的动作，路径必须含 _sandbox（血的教训）。`);
  }
}

// ── 规模（★ 预实验：缩小。原 60/18）────────────────────────
const MODULES = 20;
const DEFECTS = 6;
const SEED = 20261019;

// ── 产物契约（★★★ 逐字沿用任务自己的）──────────────────────
//
//   ★ 为什么不能自己另编一套：**判据与指令必须同源**（本项目纪律⑪）。
//   ★★ 我第一版把产物写成"裸 JSON 数组" → **离线自检当场发现**
//      `judge()` 恒返回 findingsReported=0（**连喂标准答案也是 0**）。
//      ⇒ 判据只认 `{"findings":[...]}`（见 `crossTask.ts` 的 `parseFindings`）。
const ARTIFACT = "review.json";
const SHARED_DUTY = [
  "你是代码审查员。找出 `src/` 下所有**真实缺陷**，把结果写成 `" + ARTIFACT + "`。",
  "缺陷的定义：某个模块里 `HARD_LIMIT` 的值 **不等于** 它自己的 `<name>-config.js` 里写的值。",
  "★ 干净模块的数字恰好相等 —— 所以你必须**看到两份文件**才能判定。",
  "",
  "产物格式（逐字照写，不要别的字段）：",
  '{"findings": [{"file": "src/a.js", "what": "一句话说明"}]}',
].join("\n");

// ── 三种「角度」（★ 本实验的核心操作）──────────────────────
//   ★★ 不是三种性格，是三种**可执行的下手顺序**。
//      依据 P3/B2：**不要指望模型自己分工** —— 角度必须写在指令里。
const ANGLES: { id: string; how: string }[] = [
  { id: "R-A", how: "★ 先**全量对照**：逐个模块读；每读完一个模块，立刻去读它的 `<name>-config.js` 对照。" },
  { id: "R-B", how: "★ 先**建立反常清单**：先把所有模块里的 `HARD_LIMIT` 数值抄成一张表，再看谁和自己的配置对不上。" },
  { id: "R-C", how: "★ 先**从配置出发**：先把所有 `<name>-config.js` 读一遍，再反过来找引用它的模块核对。" },
];

const TOOLS = ["read", "write", "ls", "grep", "find"];

function normFile(v: unknown): string {
  return String(v ?? "").replace(/^\.?\//, "").replace(/\\/g, "/");
}

// ══════════════════════════════════════════════════════════════════
// 落语料到磁盘（每个臂一份独立的 cwd）
// ══════════════════════════════════════════════════════════════════
function writeCorpus(dir: string, corpus: { id: string; text: string }[]): void {
  assertSandbox(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const d of corpus) writeFileSync(join(dir, d.id), d.text);
}

// ══════════════════════════════════════════════════════════════════
// 一个员工跑一次 → 返回它报出的文件集合
// ══════════════════════════════════════════════════════════════════
interface EmployeeResult {
  angle: string;
  reported: string[];
  text: string;
  tokens: number;
  cost: number;
  turns: number;
  error?: string;
}

async function runEmployee(
  cwd: string,
  brief: string,
  angle: { id: string; how: string },
): Promise<EmployeeResult> {
  const lab = await createLab({
    agentDir: AGENT_DIR,
    cwd,
    modelNetwork: true,
    // ★★★ 红线：只允许这一个型号（钉在库层，绕不过）
    modelAllow: [MODEL],
    defaultModel: MODEL,
  });
  const a = await lab.createAgent({
    id: `preK-${angle.id}-${Date.now().toString(36)}`,
    model: MODEL,
    role: `${SHARED_DUTY}\n\n${angle.how}`,
    permissions: { only: TOOLS },
  });
  let text = "";
  let error: string | undefined;
  try {
    const res = await a.io.prompt(brief);
    text = res.text ?? "";
    error = res.error;
  } catch (e) {
    error = (e as Error).message;
  }
  // ★ 产物在磁盘上（契约）：读 review.json，而不是抠对话文本
  let findings: string[] = [];
  const artifactPath = join(cwd, ARTIFACT);
  if (existsSync(artifactPath)) {
    const hit = parseFindings(readFileSync(artifactPath, "utf8"), null);
    if (hit) findings = hit.findings.map((f) => normFile((f as { file?: unknown }).file));
  }
  // ★ 兜底：没写文件就从对话里抠（同一个 parseFindings ⇒ 同源）
  if (findings.length === 0) {
    const hit = parseFindings(text, null);
    if (hit) findings = hit.findings.map((f) => normFile((f as { file?: unknown }).file));
  }
  // ★ 量具形状（dump 过，不猜）：
  //   `agent.usage` = { input, output, cost:{input,output,cacheRead,cacheWrite,total} }
  //   `observe.turns` **是数组**（每轮 {n,input,output,...}）⇒ `.length` 才是轮数
  //   `observe.totalTokens` = 所有轮总 token
  const u = a.usage;
  const out: EmployeeResult = {
    angle: angle.id,
    reported: findings.filter(Boolean),
    text: text.slice(0, 4000),
    tokens: a.observe.totalTokens || u.input + u.output,
    cost: u.cost?.total ?? 0,
    turns: a.observe.turns.length,
    error,
  };
  a.dispose();
  return out;
}

// ══════════════════════════════════════════════════════════════════
// 合并策略
// ══════════════════════════════════════════════════════════════════
function union(lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}
function vote(lists: string[][], threshold: number): string[] {
  const c = new Map<string, number>();
  for (const l of lists) for (const f of new Set(l)) c.set(f, (c.get(f) ?? 0) + 1);
  return [...c.entries()].filter(([, n]) => n >= threshold).map(([f]) => f);
}
/** 两两 Jaccard 相似度均值 —— ★ DV3 重合度 */
function jaccardAvg(lists: string[][]): number {
  if (lists.length < 2) return 1;
  const sims: number[] = [];
  for (let i = 0; i < lists.length; i++) {
    for (let j = i + 1; j < lists.length; j++) {
      const A = new Set(lists[i]);
      const B = new Set(lists[j]);
      const inter = [...A].filter((x) => B.has(x)).length;
      const uni = new Set([...A, ...B]).size;
      sims.push(uni === 0 ? 1 : inter / uni);
    }
  }
  return sims.reduce((s, x) => s + x, 0) / sims.length;
}

// ══════════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════════
interface ArmRow {
  arm: string;
  n: number;
  merge: string;
  reported: number;
  tp: number;
  fp: number;
  recall: number;
  precision: number;
  overlap: number;
  tokens: number;
  cost: number;
  turns: number;
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const ONLY = onlyArg ? onlyArg.slice(7) : undefined;
  const task = buildCrossTask(MODULES, DEFECTS, SEED);

  console.log(`预实验 K · 同身份多员工（真模型 pilot）`);
  console.log(`  语料 ${MODULES} 模块 / ${DEFECTS} 缺陷 / ${task.corpus.length} 文件`);
  console.log(`  真缺陷：${task.hidden.defects.map((d) => d.file).join(", ")}`);
  console.log(`  模型：${MODEL}\n`);

  mkdirSync(RUNS, { recursive: true });
  const rows: ArmRow[] = [];

  /** ★★ 评分用任务自己的判据（`judge` 内置 tp/fp）—— 判据与指令同源 */
  const score = (reported: string[]) => {
    const v = task.judge(null, { findings: reported.map((f) => ({ file: f, what: "x" })) });
    return { tp: v.readings.truePositives, fp: v.readings.falsePositives };
  };

  // ── 臂 A1：1 个员工（基线）──────────────────────────
  if (!ONLY || ONLY === "A1") {
    const cwd = join(SANDBOX, "A1");
    writeCorpus(cwd, task.corpus);
    const r = await runEmployee(cwd, task.brief, ANGLES[0]);
    const { tp, fp } = score(r.reported);
    rows.push({
      arm: "A1", n: 1, merge: "-", reported: r.reported.length, tp, fp,
      recall: tp / DEFECTS, precision: r.reported.length ? tp / r.reported.length : 0,
      overlap: 1, tokens: r.tokens, cost: r.cost, turns: r.turns,
    });
    console.log(`  A1  n=1  tp=${tp}/${DEFECTS} fp=${fp} tok=${r.tokens} turns=${r.turns} cost=$${r.cost.toFixed(4)}${r.error ? " !" + r.error : ""}`);
    console.log(`     报出：${r.reported.join(", ") || "（空）"}`);
    writeFileSync(join(RUNS, "preK-A1.txt"), r.text);
  }

  // ── 臂 A3-*：3 个员工（★ 只跑一次，三种合并方式共用）────
  if (!ONLY || ONLY.startsWith("A3")) {
    const cwd = join(SANDBOX, "A3");
    writeCorpus(cwd, task.corpus);
    // ★ 三个员工**并行**（同 cwd；都写 review.json ⇒ 会互相覆盖，
    //   所以每人写到自己的子目录，见 runEmployee 前的临时 cwd 处理）
    const results: EmployeeResult[] = [];
    for (const ang of ANGLES) {
      const sub = join(cwd, ang.id);
      writeCorpus(sub, task.corpus);
      results.push(await runEmployee(sub, task.brief, ang));
    }
    const lists = results.map((r) => r.reported);
    const tokens = results.reduce((s, r) => s + r.tokens, 0);
    const cost = results.reduce((s, r) => s + r.cost, 0);
    const turns = results.reduce((s, r) => s + r.turns, 0);
    const ov = jaccardAvg(lists);

    console.log(`\n  ── 三个员工各自（★ 看角度是否真的生效）──`);
    for (const r of results) {
      const { tp, fp } = score(r.reported);
      console.log(`     ${r.angle}  tp=${tp}/${DEFECTS} fp=${fp} 报了 ${r.reported.length} tok=${r.tokens} turns=${r.turns} cost=$${r.cost.toFixed(4)}${r.error ? " !" + r.error : ""}`);
      console.log(`        报出：${r.reported.join(", ") || "（空）"}`);
    }
    console.log(`  ★★ 重合度(DV3) = ${ov.toFixed(3)}   <- H3 要 < 1.0 才算角度生效\n`);

    const merges: [string, string[]][] = [
      ["A3-union", union(lists)],
      ["A3-vote", vote(lists, 3)],   // ★ 全员同意（最保守）
      ["A3-vote2", vote(lists, 2)],  // ★ 多数同意（对照）
    ];
    for (const [name, merged] of merges) {
      if (ONLY && ONLY !== name) continue;
      const { tp, fp } = score(merged);
      rows.push({
        arm: name, n: 3, merge: name.replace("A3-", ""), reported: merged.length, tp, fp,
        recall: tp / DEFECTS, precision: merged.length ? tp / merged.length : 0,
        overlap: ov, tokens, cost, turns,
      });
      console.log(`  ${name.padEnd(10)} tp=${tp}/${DEFECTS} fp=${fp} 报了 ${merged.length} tok=${tokens} cost=$${cost.toFixed(4)}`);
    }
    writeFileSync(join(RUNS, "preK-A3-angles.json"), JSON.stringify(results, null, 2));
  }

  // ── 落账 ────────────────────────────────────────────
  const p = join(RUNS, "preK.jsonl");
  for (const r of rows) appendFileSync(p, JSON.stringify(r) + "\n");
  console.log(`\n落账 -> ${p}`);
}

await main();
