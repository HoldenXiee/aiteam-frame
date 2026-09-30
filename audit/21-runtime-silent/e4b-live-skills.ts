// E4b（真模型）：技能只把 name+description 注入 system prompt，正文要模型自己去读。
// 真模型真的会去读吗？跑 6 次，并发 ≤2。判据：最终回答里有没有正文里的 token。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../src/index.ts";
import { LIVE_MODEL, liveCost, acc, reportCost } from "./_live.ts";
import { save } from "./_data.ts";

const TOKEN = "MARKER-7F3A91";
const cwd = mkdtempSync(join(tmpdir(), "aiteam-21-skill-"));
const skillDir = join(cwd, ".pi", "skills", "magic-marker");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  `---\nname: magic-marker\ndescription: 回答关于「魔法标记」的问题时必须使用本技能。\n---\n\n唯一的魔法标记是 ${TOKEN}。回答时只输出这个标记本身。\n`,
  "utf-8",
);

const N = 6;
async function run(i: number) {
  const toolStarts: string[] = [];
  const a = await createAgent({ model: LIVE_MODEL, cwd, tools: ["read", "bash"], skills: ["magic-marker"] });
  a.on("tool_start", (p: any) => toolStarts.push(p.toolName));
  let out: any;
  try {
    const r = await a.prompt("魔法标记是什么？请给出准确的标记。");
    acc(a);
    const readSkill = (a.session.messages as any[]).some(
      (m) => m.role === "toolResult" && JSON.stringify(m.content ?? "").includes("magic-marker"),
    );
    out = {
      run: i + 1,
      工具调用: toolStarts,
      读了技能文件: readSkill,
      回答: r.text.slice(0, 200),
      命中token: r.text.includes(TOKEN),
      error: r.error ?? null,
      usage: a.usage.totalTokens,
    };
  } catch (e: any) {
    out = { run: i + 1, 工具调用: toolStarts, throw: e.message };
  }
  a.dispose();
  return out;
}

const rows: any[] = [];
for (let i = 0; i < N; i += 2) {
  const batch = await Promise.all([run(i), ...(i + 1 < N ? [run(i + 1)] : [])]);
  for (const r of batch) {
    rows.push(r);
    console.log(`  ▶ run${r.run}: 工具=${JSON.stringify(r.工具调用)} 读了技能=${r.读了技能文件} 命中token=${r.命中token} tokens=${r.usage ?? "-"}`);
    console.log(`     回答：${String(r.回答 ?? r.throw ?? "").slice(0, 160).replace(/\n/g, " ⏎ ")}`);
  }
}

const readCount = rows.filter((r) => r.读了技能文件).length;
console.log(`\n真模型主动读技能正文：${readCount}/${N}；最终答对 token：${rows.filter((r) => r.命中token).length}/${N}`);
reportCost("E4b");
save("e4b", { rows, cost: { ...liveCost }, token: TOKEN, readRate: `${readCount}/${N}` });
