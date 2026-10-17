// O3 的第二问：**多 agent 流水线**里，成本形状是不是雪球？
// 对比：单 agent 一次性做完 vs 三棒流水线（每棒都从零开始重新读）
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { lab, MODEL } from "../env.ts";
const cwd = join(process.cwd(), "research/demox/work-obs");
mkdirSync(join(cwd, "corpus"), { recursive: true });
for (let i = 1; i <= 10; i++) writeFileSync(join(cwd, `corpus/M${i}.md`), `笔记 ${i}\n\n第 ${i} 份材料的正文。\n`);

const run = async (label: string, stages: string[]) => {
  const all: { role: string; turns: number[]; total: number; msgCounts: number[] }[] = [];
  for (const [i, role] of stages.entries()) {
    const a = await lab.createAgent({ id: `${label}-${i}`, model: MODEL, role, permissions: { only: ["ls","read","write"] } });
    const list = Array.from({length:10},(_,k)=>`M${k+1}`).join("、");
    await a.io.prompt(`corpus/ 下有 ${list}。${role}`);
    all.push({ role: `S${i+1}`, turns: a.observe.turns.map(t=>t.total), total: a.observe.totalTokens, msgCounts: a.observe.wire.map(w=>w.count) });
    a.dispose();
  }
  const grand = all.reduce((s,x)=>s+x.total,0);
  console.log(`\n=== ${label} ===  总 ${grand} token`);
  for (const x of all) console.log(`  ${x.role}: 轮数=${x.turns.length} 每轮=[${x.turns.join(",")}] 消息数=[${x.msgCounts.join(",")}] 本棒=${x.total}`);
};

const list = Array.from({length:10},(_,k)=>`M${k+1}`).join("、");
await run("单agent", [`请用 read 逐份读完 ${list}，然后写一句话总结到 out.txt。`]);
await run("三棒流水线", [
  `请用 read 逐份读完 ${list}，把每份的大意写进 draft/survey.md。`,
  `请读 draft/survey.md，然后**自己用 read 逐份核对** ${list}，把结论写进 draft/groups.json。`,
  `请读 draft/groups.json，写一句话总结到 out.txt。`,
]);
process.exit(0);
