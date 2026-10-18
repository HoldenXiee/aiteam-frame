// v4：决定性的一格 —— nameless **不给 ls**（= P5 的真实条件）
import { lab, MODEL } from "../env.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const PROBE = join(lab.cwd, "abandon4");
rmSync(PROBE, { recursive: true, force: true });
mkdirSync(PROBE, { recursive: true });
writeFileSync(join(PROBE, "notes-rev-C-final2.md"), "答案：7 组。\n");
for (let i = 1; i <= 15; i++) writeFileSync(join(PROBE, `misc${i}.txt`), `无关旁枝 ${i}。\n`);

for (const [tag, tools] of [["有 ls", ["read","write","ls"]], ["无 ls", ["read","write"]]] as const) {
  const a = await lab.createAgent({ id: `ab4-${tag}`, model: MODEL, role: "助手。", permissions: { only: [...tools] } });
  let calls = 0;
  a.on("tool_call", () => { calls++; });
  const t0 = Date.now();
  let text = "";
  try {
    const r = await Promise.race([
      a.io.prompt("abandon4/ 里有一份笔记，里面写了答案（一个数字）。请找到它并告诉我答案。"),
      new Promise((_, j) => setTimeout(() => j(new Error("300s")), 300000)),
    ]);
    text = (r as any).text ?? "";
  } catch (e) { text = `[异常] ${(e as Error).message}`; }
  console.log(`${tag.padEnd(6)} 调用=${String(calls).padStart(3)}  秒=${((Date.now()-t0)/1000).toFixed(0).padStart(3)}  ${JSON.stringify(text.slice(0,60))}`);
  await a.dispose();
}
process.exit(0);
