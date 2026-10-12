// 实验室 B 的运行入口：跑一次固定流程，落一行 JSONL。
//
// 跑法：
//   node demom/bench/prep.ts                先铺现场
//   node demom/labB-workflow/run.ts         跑一次
//   node demom/labB-workflow/run.ts --repeat 5

import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL, cwd } from "../env.ts";
import { checkScene, resetScene } from "../bench/prep.ts";
import { STAGES, topoBatches, stagesFor } from "./stages.ts";
import { runWorkflow } from "./runner.ts";
import { DRAFT_DIR } from "../bench/task.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(dirname(here), "runs");

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const TAG = arg("--tag", "B")!;
const REPEAT = Number(arg("--repeat", "1"));
/** 变体：base / preserve（preserve = 要求 S4 保留 S2 的合并分组，见 stages.ts） */
const VARIANT = arg("--variant", "base")!;

mkdirSync(RUNS_DIR, { recursive: true });

resetScene(); // 先清掉上一轮的残留，再检查现场
const scene = checkScene();
if (!scene.ok) {
  console.log("[B] 现场没就绪，先跑 node demom/bench/prep.ts");
  for (const l of scene.lines) console.log(l);
  process.exit(1);
}

console.log(`[B] 固定流程 × ${REPEAT} 次，tag=${TAG}，variant=${VARIANT}`);
console.log(`    模型 ${MODEL}（与 A 必须同一个）`);
console.log(`    这张图（跑之前就画得出来 —— 这是 B 与 A 最本质的差别）：`);
const stages = stagesFor(VARIANT);
for (const [i, batch] of topoBatches(stages).entries()) {
  console.log(`      批次 ${i + 1}：${batch.map((s) => s.id + (s.kind === "code" ? "（代码）" : "")).join(" ‖ ")}`);
}

// ★ 每跑完一轮立即追加一行（与 A 同一条纪律：中断时不能丢数据）★
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(RUNS_DIR, `B-${TAG}-${stamp}.jsonl`);

const rows = [];
for (let i = 1; i <= REPEAT; i++) {
  process.stdout.write(`    [${i}/${REPEAT}] 跑… `);
  const rec = await runWorkflow(i, TAG, VARIANT);
  rows.push(rec);
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8"); // ← 立即落盘
  console.log(
    `${rec.secs.toFixed(1)}s  ${rec.agentCount} 个 agent（= 起 agent 的阶段数）  ${rec.verdict.ok ? "✓ ok" : "✗ " + rec.verdict.failed[0]}`,
  );
  if (rec.guarded) console.log(`        ⛔ 护栏触发：${rec.guarded.join("、")} 工具调用超限，已中止`);
  for (const c of rec.codeStages ?? []) console.log(`        [code] ${c.id}：${c.result}`);
}

console.log(`\n[B] 逐阶段读数（agent 数 = 起 agent 的阶段数；代码阶段不起 agent，不计数）`);
for (const r of rows) {
  console.log(`    ${r.agentCount} 个 agent，工具调用 ${r.toolCalls} 次，${r.totalTokens} tokens，${r.secs.toFixed(1)}s`);
  for (const a of r.agents) {
    console.log(`      ${a.role}(${a.id}) 工具[${a.distinctTools.join(",") || "无"}]`);
  }
  if (r.crashed) console.log(`      ✗ ${r.crashed}`);
}

const okCount = rows.filter((r) => r.verdict.ok).length;
console.log(`\n[B] ${okCount}/${rows.length} 次 ok；平均 ${(rows.reduce((n, r) => n + r.secs, 0) / rows.length).toFixed(1)}s`);
console.log(`    产物：runs/${out.split(/[\\/]/).pop()}`);

// 草稿留档：中间产物是「它怎么一步步做出来的」的直接证据（产物全文已在 JSONL 里）
try {
  const dir = join(cwd, DRAFT_DIR);
  const body = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `\n===== ${f} =====\n${readFileSync(join(dir, f), "utf8")}`)
    .join("\n");
  const draftDump = join(RUNS_DIR, `B-${TAG}-${stamp}-drafts.txt`);
  writeFileSync(draftDump, body, "utf8");
  console.log(`    草稿留档：runs/${draftDump.split(/[\\/]/).pop()}`);
} catch {
  console.log(`    （draft/ 里什么都没有 —— 上游阶段没落盘）`);
}
