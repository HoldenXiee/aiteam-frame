// ══════════════════════════════════════════════════════════════════════════
// ★★★ 实验：onConsensus 的 find/return 卡死 bug
//
//   设计者问：「你是设计了几个实验，还是说是组合成一个实验了」
//   ⇒ 本轮按纪律⑱做成**一个单变量实验**：
//
//     改前读数（本文件 `--before`）→ 改 2 行（rules.ts）→ 改后读数（`--after`）
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么这个实验能**零成本确定性**判定
//
//   `onConsensus` 的选取逻辑是**纯函数**：
//     输入：outbox 里的文件名列表 + 签字表
//     输出：这一 tick 会请谁签字
//   它不需要模型、不需要事件序列 —— **真实数据就是输入**。
//
//   ★ 所以可以拿**上一轮真实的 24 份产物 + 真实签字表**直接跑，
//     得到「旧逻辑请到几份 / 新逻辑请到几份」的**确定数**。
//
// ══════════════════════════════════════════════════════════════════════════
// 跑法：
//   npx tsx research/clusters/forge/micro/experiment-consensus.ts --before
//   npx tsx research/clusters/forge/micro/experiment-consensus.ts --after
//   npx tsx research/clusters/forge/micro/experiment-consensus.ts --compare
// ══════════════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const OUTBOX = join(REPO, "research/labfirst/forge/outbox");
const SIGNOFFS = join(REPO, "research/labfirst/forge/work/signoffs.jsonl");

const TEAMS = ["theory", "practice", "landing"];

type SignTable = Map<string, Set<string>>;

/** ★ 读真实签字表：产物 → 已表态的团队集合 */
function loadSignTable(): SignTable {
  const t: SignTable = new Map();
  let raw = "";
  try {
    raw = readFileSync(SIGNOFFS, "utf8");
  } catch {
    return t; // 没有签字表 = 全都没表态
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { artifact?: string; by?: string };
      if (!r.artifact || !r.by) continue;
      (t.get(r.artifact) ?? t.set(r.artifact, new Set()).get(r.artifact)!).add(r.by);
    } catch {
      /* 跳过坏行 */
    }
  }
  return t;
}

/**
 * ★ **旧逻辑**（rules.ts 改前，逐字复刻）
 *
 *   const target = outs.find((f) => 有团队没签);
 *   if (!target || signedAsked.includes(target)) return;   ← ★ 卡死点
 *
 * ★★ 关键在于：`find` 每次返回**同一份**（第一份没签全的），
 *    而它一旦进了 `signedAsked`，`return` 就把它永久挡住 ⇒ 后面的永远轮不到。
 */
function simulateBefore(outs: string[], signs: SignTable, ticks: number): string[] {
  const signedAsked: string[] = [];
  const asked: string[] = [];
  for (let i = 0; i < ticks; i++) {
    const target = outs.find((f) => TEAMS.some((t) => !signs.get(f)?.has(t)));
    if (!target || signedAsked.includes(target)) continue; // ★ 旧逻辑：直接 return
    signedAsked.push(target);
    asked.push(target);
  }
  return asked;
}

/**
 * ★ **新逻辑**（改后）
 *
 *   const target = outs.find((f) => 有团队没签 && !signedAsked.includes(f));
 *   if (!target) return;
 *
 * ★★ 唯一改变的是：把「已请过」放进 `find` 的条件里，
 *    而不是找到之后才判 —— 这样它**继续往后找**。
 */
function simulateAfter(outs: string[], signs: SignTable, ticks: number): string[] {
  const asked: string[] = [];
  for (let i = 0; i < ticks; i++) {
    const target = outs.find((f) => TEAMS.some((t) => !signs.get(f)?.has(t)) && !asked.includes(f));
    if (!target) break; // ★ 新逻辑：找不到就真的没有了
    asked.push(target);
  }
  return asked;
}

// ─────────────── 读数 ───────────────

type Reading = {
  side: string;
  /** ★ 被请过签字的产物数 */
  asked: number;
  /** ★ 其中 landing 的（这是本实验的核心指标）*/
  askedLanding: number;
  /** ★ outbox 里 landing 的产物总数 */
  landingTotal: number;
  /** 请的顺序（前 5 个）*/
  order: string[];
};

function measure(side: string, outs: string[], signs: SignTable, sim: (a: string[], b: SignTable, c: number) => string[]): Reading {
  // ★ tick 次数 = 产物数（每 tick 最多请 1 份，所以这是能请到的上限）
  const asked = sim(outs, signs, outs.length);
  const landingTotal = outs.filter((f) => f.startsWith("读者-")).length;
  return {
    side,
    asked: asked.length,
    askedLanding: asked.filter((f) => f.startsWith("读者-")).length,
    landingTotal,
    order: asked.slice(0, 5),
  };
}

// ─────────────── main ───────────────

const isMain =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("experiment-consensus.ts");

if (isMain) {
  const outs = readdirSync(OUTBOX).filter((f) => f.endsWith(".md")).sort();
  const signs = loadSignTable();

  // ★ 已验证过的：这一轮真实状态里有 8 份被请过签字（logs 记 8 次 onConsensus 触发）
  const before = measure("改前（旧逻辑）", outs, signs, simulateBefore);
  const after = measure("改后（新逻辑）", outs, signs, simulateAfter);

  const show = (r: Reading) => {
    console.log(`── ${r.side} ──`);
    console.log(`   被请签字的产物：${r.asked} / ${outs.length} 份`);
    console.log(`   ★ 其中 landing（读者）的：${r.askedLanding} / ${r.landingTotal} 份`);
    console.log(`   顺序（前 5）：${r.order.map((f) => f.slice(0, 18)).join("、") || "（无）"}`);
    console.log(``);
  };

  console.log(`\n═══ onConsensus 卡死 bug · 离线确定性实验（0 API）═══\n`);
  console.log(`输入：真实 outbox ${outs.length} 份产物 · 真实签字表 ${signs.size} 份有记录\n`);

  if (process.argv.includes("--before")) {
    show(before);
  } else if (process.argv.includes("--after")) {
    show(after);
  } else {
    show(before);
    show(after);
    console.log(`═══ 判定 ═══`);
    console.log(`被请签字：${before.asked} → ${after.asked} 份（+${after.asked - before.asked}）`);
    console.log(`★ landing：${before.askedLanding} → ${after.askedLanding} 份（共 ${before.landingTotal} 份）`);
    const pass = after.asked > before.asked && after.askedLanding > before.askedLanding;
    console.log(
      pass
        ? `\n✔ **认定成立**：漏请是因为 find/return，不是"没东西可签"。`
        : `\n✘ **认定不成立**：改成新逻辑也没多请到 —— 那 bug 不是主因，要另找。`,
    );
    if (pass && after.askedLanding >= 5) {
      console.log(`✔ 且达到设计文档的判活线（landing 被请 ≥5 份）。`);
    }
    console.log(``);
  }
}
