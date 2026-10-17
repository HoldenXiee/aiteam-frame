// keep vs shrink 各跑 4 次：相变点是随机的吗？
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { lab, MODEL } from "../env.ts";
const cwd = join(process.cwd(), "research/demox/work-obs");
mkdirSync(join(cwd, "corpus"), { recursive: true });
for (let i = 1; i <= 10; i++) writeFileSync(join(cwd, `corpus/M${i}.md`), `笔记 ${i}\n\n第 ${i} 份材料的正文，讲的是某个观点，有若干字。\n`);
const list = Array.from({length:10},(_,k)=>`M${k+1}`).join("、");
for (const mode of ["keep","shrink"]) {
  const rows: string[] = [];
  for (let rep=1; rep<=4; rep++) {
    const a = await lab.createAgent({ id: `f2-${mode}-${rep}`, model: MODEL, role: "你负责逐份阅读并总结。", permissions: { only: ["ls","read","write"] } });
    if (mode==="shrink") a.tools.onResult((r:{content?:{type:string;text?:string}[]}) => {
      const orig=(r?.content??[]).map(c=>c.text??"").join(""); const m=/笔记\s*(\d+)/.exec(orig);
      if(!m) return undefined as never;
      const one=orig.split("\n").filter(x=>x.trim())[1]??orig.slice(0,80);
      return {content:[{type:"text" as const,text:`[M${m[1]}] ${one}`}]} as never;
    });
    await a.io.prompt(`请用 read 逐份读完 corpus/ 下的 ${list}，然后写总结到 out.txt。`);
    rows.push(`rep${rep}: 轮=${a.observe.turns.length} 总=${a.observe.totalTokens} 峰值=${Math.max(...a.observe.turns.map(x=>x.total))}`);
    a.dispose();
  }
  console.log(`\n=== ${mode} ===`); rows.forEach(r=>console.log("  "+r));
}
process.exit(0);
