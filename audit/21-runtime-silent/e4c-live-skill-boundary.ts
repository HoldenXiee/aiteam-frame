// E4c（真模型）：技能描述不够显眼时，模型还会不会去读正文？——静默不生效的边界。
// 技能正文里藏着一条硬性写作规范，任务本身不提技能。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../src/index.ts";
import { LIVE_MODEL, liveCost, acc, reportCost } from "./_live.ts";
import { save } from "./_data.ts";

const cwd = mkdtempSync(join(tmpdir(), "aiteam-21-style-"));
const skillDir = join(cwd, ".pi", "skills", "house-style");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  `---\nname: house-style\ndescription: 本项目的写作规范，输出英文前必须查阅。\n---\n\n硬性规范：所有英文输出必须为全大写（专有名词除外）。不得有例外。\n`,
  "utf-8",
);

const N = 3;
const rows: any[] = [];
async function run(i: number) {
  const toolStarts: string[] = [];
  const a = await createAgent({ model: LIVE_MODEL, cwd, tools: ["read", "bash"], skills: ["house-style"] });
  a.on("tool_start", (p: any) => toolStarts.push(p.toolName));
  let out: any;
  try {
    const r = await a.prompt("把「今天天气不错」翻译成英文，只要译文。");
    acc(a);
    const readSkill = (a.session.messages as any[]).some((m) => m.role === "toolResult" && JSON.stringify(m.content ?? "").includes("house-style"));
    out = { run: i + 1, 工具调用: toolStarts, 读了技能: readSkill, 回答: r.text.slice(0, 120), 遵守全大写规范: /^[^a-z]*$/.test(r.text), usage: a.usage.totalTokens };
  } catch (e: any) {
    out = { run: i + 1, 工具调用: toolStarts, throw: e.message };
  }
  a.dispose();
  return out;
}
for (let i = 0; i < N; i += 2) {
  for (const r of await Promise.all([run(i), ...(i + 1 < N ? [run(i + 1)] : [])])) {
    rows.push(r);
    console.log(`  ▶ run${r.run}: 工具=${JSON.stringify(r.工具调用)} 读了技能=${r.读了技能} 全大写=${r.遵守全大写规范}`);
    console.log(`     回答：${String(r.回答 ?? r.throw).slice(0, 120).replace(/\n/g, " ⏎ ")}`);
  }
}
console.log(`\n主动读技能：${rows.filter((r) => r.读了技能).length}/${N}；遵守正文规范：${rows.filter((r) => r.遵守全大写规范).length}/${N}`);
reportCost("E4c");
save("e4c", { rows, cost: { ...liveCost } });
