// 单元测试：拿**真实的失败报告**验证 enforceGroups 能不能把散开的组并回去。
//
// 跑法：node demom/labB-workflow/.scratch-enforce.ts
//
// 为什么先做这个：一次真跑 25 分钟，而强制合并是纯代码 —— 能在几毫秒里验证，
// 就不该花 25 分钟去赌它。

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "../env.ts";
import { enforceGroups } from "./stages.ts";
import { judgeText, DRAFT_DIR, REPORT_FILE } from "../bench/task.ts";
import { DUPLICATE_GROUPS } from "../bench/corpus.ts";

// 真实产物：**所有**存了 reportText 的记录。
// 这样既能看到 enforcer 修好了哪些，也能看到它有没有把**本来通过的报告弄坏**（回归）。

const files = readdirSync("demom/runs").filter((f) => f.endsWith(".jsonl") && !/-(pre|pre2)-/.test(f));
const cases: { name: string; report: string }[] = [];
for (const f of files) {
  const recs = readFileSync("demom/runs/" + f, "utf8")
    .split("\n")
    .filter((x) => x.trim())
    .map((l) => JSON.parse(l));
  recs.forEach((r: { reportText: string | null }, i: number) => {
    if (r.reportText) cases.push({ name: `${f.slice(0, 24)}#${i + 1}`, report: r.reportText });
  });
}

mkdirSync(join(cwd, DRAFT_DIR), { recursive: true });
// 分组用**真值**（这里只测机制；真跑时分组由 S2 的模型判断产出）
writeFileSync(
  join(cwd, DRAFT_DIR, "S2-groups.json"),
  JSON.stringify(DUPLICATE_GROUPS.map((ids) => ({ ids, topic: "?", fact: "?" }))),
  "utf8",
);

let fixed = 0;
let broke = 0;
console.log(`${cases.length} 份报告；用**真值分组**跑 enforcer：\n`);
for (const c of cases) {
  writeFileSync(join(cwd, REPORT_FILE), c.report, "utf8");
  const before = judgeText(c.report);
  const log = enforceGroups();
  const after = judgeText(readFileSync(join(cwd, REPORT_FILE), "utf8"));

  const d = (v: typeof before) => v.dedupDetail.map((x) => x.group.join("≡") + (x.ok ? "✓" : "✗")).join(" ");
  const flag = !before.deduped && after.deduped ? "★修好" : before.deduped && !after.deduped ? "✗弄坏了" : before.deduped ? "  原本就好" : "  没修动";
  if (flag === "★修好") fixed++;
  if (flag === "✗弄坏了") broke++;
  console.log(`${c.name.padEnd(28)} ${flag}  去重 ${before.deduped ? "✗" : "✗"}→${after.deduped ? "✓" : "✗"}`);
  if (!before.deduped) console.log(`      前: ${d(before)}\n      后: ${d(after)}`);
  if (log !== "无需强制合并：没有发现散开的重复组") console.log(`      ${log}`);
  if (after.failed.length !== before.failed.filter((f) => !f.includes("重复")).length + (after.deduped ? 0 : 1)) {
    console.log(`      ⚠ 其他项变了：${before.failed.join("；")} → ${after.failed.join("；")}`);
  }
}
console.log(`\n合计：修好 ${fixed} 份，弄坏 ${broke} 份。`);

