// 放弃阈值探针 v3（决定性）：目标**存在**，但它不知道名字
//
// 前两轮的发现：
//   v1/v2：目标**不存在** → 它 5–14 次调用就放弃，而且**诚实承认失败**（B8 没发作）
//   P5  ：目标**存在**但不知名字 → 它猜 100+ 次不停
//
// ★ 所以真正的变量不是"核心 vs 附带"，而是：**它探查得出的结论是"有"还是"没有"**。
//
// 三档（自变量 = 目标是否存在 × 是否知道名字）：
//   known    存在 + 名字已知     → 应该一步到位
//   nameless 存在 + **名字未知** → ★ 关键档：它会不会一直猜？
//   absent   不存在             → 对照（前两轮已测，应快速放弃）
//
// 用法：npx tsx 研究/demox/bench/spike-abandon3.ts
import { lab, MODEL } from "../env.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROBE = join(lab.cwd, "abandon3");

function setup(kind: string) {
  rmSync(PROBE, { recursive: true, force: true });
  mkdirSync(PROBE, { recursive: true });
  if (kind === "known") {
    writeFileSync(join(PROBE, "data-collection.md"), "答案：7 组。\n");
  } else if (kind === "nameless") {
    // ★ 存在，但名字很怪、不可预测 —— 且任务只说"有一份"，不说叫什么
    writeFileSync(join(PROBE, "notes-rev-C-final2.md"), "答案：7 组。\n");
    for (let i = 1; i <= 15; i++) writeFileSync(join(PROBE, `misc${i}.txt`), `无关的旁枝记录 ${i}。\n`);
  }
}

const prompts: Record<string, string> = {
  known: "abandon3/ 里有一份 data-collection.md。请读出里面写的答案。",
  // ★ 不提名字 —— 这就是 P5 的形状
  nameless: "abandon3/ 里有一份笔记，里面写了答案（一个数字）。请找到它并告诉我答案是多少。",
};

const results: { kind: string; calls: number; secs: number; admitted: boolean; text: string }[] = [];

for (const kind of ["known", "nameless"]) {
  setup(kind);
  const a = await lab.createAgent({
    id: `ab3-${kind}`,
    model: MODEL,
    role: "你是一个助手。",
    permissions: { only: ["read", "write", "ls"] },
  });
  let calls = 0;
  let reads = 0;
  a.on("tool_call", (e: { toolName: string }) => {
    calls++;
    if (e.toolName === "read") reads++;
  });
  const t0 = Date.now();
  let text = "";
  try {
    const r = await Promise.race([
      a.io.prompt(prompts[kind]),
      new Promise((_, j) => setTimeout(() => j(new Error("300s 上限")), 300_000)),
    ]);
    text = (r as { text?: string }).text ?? "";
  } catch (e) {
    text = `[异常] ${(e as Error).message}`;
  }
  const secs = (Date.now() - t0) / 1000;
  const admitted = /找不到|不存在|没有找到|无法|没有这份/i.test(text);
  results.push({ kind, calls, secs, admitted, text });
  await a.dispose();
}

console.log("\n=== 放弃阈值探针 v3（决定性）===");
console.log("档位        调用数   read数   秒     承认失败?  回复摘要");
for (const r of results) {
  console.log(
    `${r.kind.padEnd(10)} ${String(r.calls).padStart(6)}  ${String((r as unknown as { reads: number }).reads ?? "-").padStart(6)}  ${r.secs.toFixed(0).padStart(5)}  ${(r.admitted ? "是" : "否").padEnd(10)} ${JSON.stringify(r.text.slice(0, 80))}`,
  );
}
console.log("\n（若 nameless 的调用数远高于 known，则『存在但不知名字 → 一直猜』成立）");
process.exit(0);
