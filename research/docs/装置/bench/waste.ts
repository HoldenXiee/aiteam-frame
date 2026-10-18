// ★★ 触发 3：把「浪费」当自变量 —— DESIGN 说「有效且**高质量**」，而我把零成本当成限制
//
// ★ 为什么要做（见 `research/demox/重读DESIGN-新触发.md`）
//   DESIGN：「**有效且高质量地**使用这成本几乎为零的智力」——**两个要求**。
//   而我十几轮实验判据全是「对不对」，从没量过「这份产物拿去做事够不够」。
//
//   ★ `DESIGN-解读.md §7.4` 我自己承认过：
//     「**把「零成本」当成限制**（所以只能拿 token 当代理），
//       而它其实是**范式的前提**（结构上完全不同的做法会因此成立，比如**冗余、多版本、反复重跑**）」
//
// ★ 自变量：**算力预算**（可以浪费多少）
//   x1     1 个分身，一次机会
//   x3     3 个分身独立做，**全交上来让人挑**（不做交集 —— P7 说交集治不了系统性错误）
//   x6     6 个分身独立做，全交上来
//   x3v    3 个分身，**每人交 2 版**（自我复核一次）
//
// ★ 因变量（★ 关键：**两个都要**）
//   有效：`verdict.ok`（对不对 —— 现成判据）
//   高质量：`artifactQuality().score`（★★ 新判据：人拿到手能不能用）
//
// ★ 判据纪律：质量判据纯函数、不看模型说了什么、不泄露 ground truth
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { Meter } from "./measure.ts";
import { artifactQuality } from "./artifact.ts";
import type { Task } from "./tasks.ts";

type Deps = {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
  READ_WRITE: string[];
};

export function wasteSystem(deps: Deps) {
  const { lab, MODEL, READ_WRITE } = deps;
  return {
    id: "waste",
    what: "触发3 · 把「浪费」当自变量：多份独立产物 × 产物质量判据",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      const mode = String(params.mode ?? "x1"); // x1 | x3 | x6 | x3v
      const copies = mode === "x6" ? 6 : mode === "x1" ? 1 : 3;
      const versions = mode === "x3v" ? 2 : 1;

      const list = task.corpus.map((d) => d.id).join("、");
      const ask =
        `corpus/ 里有 ${task.corpus.length} 份材料（${list}），其中一些在讲同一件事。\n` +
        `找出所有重复组。**产物必须是合法 JSON**，形如 {"duplicates":[["M1","M2"]],"irrelevant":[]}。\n` +
        `写进 ${task.artifact}。`;

      // ★ 每个分身写自己的文件 —— 全部保留，让人挑（不做交集）
      const outDir = join(cwd, "variants");
      mkdirSync(outDir, { recursive: true });
      for (const f of existsSync(outDir) ? readdirSync(outDir) : []) {
        try {
          unlinkSync(join(outDir, f));
        } catch {
          /* */
        }
      }

      let crashed: string | undefined;
      for (let c = 0; c < copies; c++) {
        for (let v = 0; v < versions; v++) {
          if (progress) progress.step = `${mode} · 第 ${c + 1}/${copies} 份${versions > 1 ? `·第 ${v + 1} 版` : ""}`;
          const agent = await lab.createAgent({
            id: `W-${mode}-${c}-${v}-${Date.now()}`,
            model: MODEL,
            role: "你负责去重：读材料，找出讲同一件事的那些。",
            permissions: { only: READ_WRITE },
          });
          meter.watch(agent, { role: `w${c}${v}`, depth: 1 });
          const extra = v > 0 ? "\n\n★ 这是你的第二版：**自己复核一遍上一版**，把不确定的重新读一遍。" : "";
          try {
            // ★ 每份写到**自己的文件**（不覆盖）—— 这就是"浪费"，但让人有得挑
            const target = v === 0 ? task.artifact : task.artifact.replace(/\.json$/, "") + `.v${v + 1}.json`;
            const res = await agent.io.prompt(`${ask}\n★ 你的产物写到 \`${target}\`。${extra}`);
            if (res.error) crashed = `${mode} 第 ${c} 份失败：${res.error}`;
          } catch (e) {
            crashed = `${mode} 崩了：${(e as Error).message}`;
          }
          if (crashed) break;
        }
        if (crashed) break;
      }

      meter.settle();
      // ★ 质量：对**主产物**判（人先看的那份）
      const p = join(cwd, task.artifact);
      const text = existsSync(p) ? readFileSync(p, "utf8") : null;
      const q = artifactQuality(text, task, { expect: task.corpus.length });
      // 附加：有几份产物可供人挑
      const variantFiles = existsSync(outDir) ? readdirSync(outDir).length : 0;
      meter.dispose();
      return {
        meter,
        text,
        structured: { _waste: { mode, copies, versions, quality: q.score, wounds: q.wounds, variants: variantFiles } },
        crashed,
      };
    },
  };
}
